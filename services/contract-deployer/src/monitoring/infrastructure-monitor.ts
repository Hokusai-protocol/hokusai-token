import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { PoolConfig } from '../config/monitoring-config';

/**
 * Infrastructure Reserve Monitor
 *
 * Monitors the Infrastructure Cost Accrual System:
 * - Tracks infrastructure accrual balances per model
 * - Monitors payment history and runway
 * - Detects low runway situations (<7 days)
 * - Tracks infrastructure/profit split ratios
 * - Alerts on critical infrastructure conditions
 *
 * Integration with existing monitoring:
 * - Uses same provider and alert system as AMM monitoring
 * - Extends state tracking with infrastructure metrics
 * - Complements fee tracking with infrastructure split visibility
 */

export interface InfrastructureState {
  modelId: string;
  timestamp: number;
  blockNumber: number;

  // Reserve balances
  accrued: bigint;                    // Net infrastructure accrued (after payments)
  paid: bigint;                       // Cumulative paid to providers
  provider: string;                   // Current infrastructure provider address

  // Derived metrics
  accruedUSD: number;                 // Accrued in USD
  paidUSD: number;                    // Total paid in USD
  netAccrualUSD: number;              // Net accrual (accrued - paid)

  // Accrual rate (from HokusaiParams)
  infrastructureAccrualBps: number;   // Current split (e.g., 8000 = 80%)
  profitShareBps: number;             // Profit to token holders (e.g., 2000 = 20%)

  // Runway calculation
  dailyBurnRateUSD?: number;          // Estimated daily infrastructure cost
  runwayDays?: number;                // Days until accrual depleted
}

export interface InfrastructureAlert {
  type: 'critical_runway' | 'low_runway' | 'large_payment' | 'split_change' | 'no_provider' | 'payment_failed';
  priority: 'critical' | 'high' | 'medium';
  modelId: string;
  message: string;
  currentState: InfrastructureState;
  metadata?: Record<string, any>;
}

export interface InfrastructureMonitorCallbacks {
  onStateUpdate?: (state: InfrastructureState) => Promise<void>;
  onAlert?: (alert: InfrastructureAlert) => Promise<void>;
}

export interface InfrastructureThresholds {
  // Runway alerts
  criticalRunwayDays: number;         // Critical alert if runway < X days (default: 3)
  lowRunwayDays: number;              // Warning alert if runway < X days (default: 7)

  // Payment monitoring
  largePaymentPercentage: number;     // Alert if payment > X% of accrued (default: 50)

  // Accrual rate changes
  alertOnSplitChange: boolean;        // Alert governance when split changes

  // Provider monitoring
  alertNoProvider: boolean;           // Alert if provider not set
}

export class InfrastructureMonitor {
  private provider: ethers.Provider;
  private infraReserveAddress: string;
  private thresholds: InfrastructureThresholds;
  private callbacks: InfrastructureMonitorCallbacks;

  private modelStates: Map<string, InfrastructureState[]> = new Map(); // modelId -> history
  private maxHistoryLength: number = 300; // ~1 hour at 12s intervals

  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isMonitoring: boolean = false;

  // Cache for contract instances
  private infraReserveContract?: ethers.Contract;
  private paramsContracts: Map<string, ethers.Contract> = new Map(); // modelId -> HokusaiParams

  // InfrastructureReserve ABI
  private static readonly INFRA_RESERVE_ABI = [
    'function accrued(string modelId) view returns (uint256)',
    'function paid(string modelId) view returns (uint256)',
    'function provider(string modelId) view returns (address)',
    'function getAccrualRunway(string modelId, uint256 dailyBurnRate) view returns (uint256)',
    'function getModelAccounting(string modelId) view returns (uint256 accruedAmount, uint256 paidAmount, address currentProvider)',
    'function totalAccrued() view returns (uint256)',
    'function totalPaid() view returns (uint256)',
    // Events
    'event InfrastructureDeposited(string indexed modelId, uint256 amount, uint256 newAccruedBalance, address indexed depositor)',
    'event InfrastructureCostPaid(string indexed modelId, address indexed payee, uint256 amount, bytes32 indexed invoiceHash, string memo)',
    'event ProviderSet(string indexed modelId, address indexed oldProvider, address indexed newProvider)'
  ];

  // HokusaiParams ABI
  private static readonly PARAMS_ABI = [
    'function infrastructureAccrualBps() view returns (uint16)',
    'function getProfitShareBps() view returns (uint16)',
    'event InfrastructureAccrualBpsSet(uint16 indexed oldBps, uint16 indexed newBps, address indexed updatedBy)'
  ];

  constructor(
    provider: ethers.Provider,
    infraReserveAddress: string,
    thresholds: InfrastructureThresholds = {
      criticalRunwayDays: 3,
      lowRunwayDays: 7,
      largePaymentPercentage: 50,
      alertOnSplitChange: true,
      alertNoProvider: true
    },
    callbacks: InfrastructureMonitorCallbacks = {}
  ) {
    this.provider = provider;
    this.infraReserveAddress = infraReserveAddress;
    this.thresholds = thresholds;
    this.callbacks = callbacks;

    this.infraReserveContract = new ethers.Contract(
      infraReserveAddress,
      InfrastructureMonitor.INFRA_RESERVE_ABI,
      provider
    );
  }

  /**
   * Start monitoring infrastructure for a model
   */
  async startMonitoring(
    modelId: string,
    paramsAddress: string,
    pollingIntervalMs: number = 60000, // 1 minute default
    dailyBurnRateUSD?: number
  ): Promise<void> {
    if (this.pollingIntervals.has(modelId)) {
      logger.warn(`Already monitoring infrastructure for ${modelId}`);
      return;
    }

    logger.info(`Starting infrastructure monitoring for ${modelId}`, {
      paramsAddress,
      pollingIntervalMs,
      dailyBurnRateUSD
    });

    // Cache params contract
    const paramsContract = new ethers.Contract(
      paramsAddress,
      InfrastructureMonitor.PARAMS_ABI,
      this.provider
    );
    this.paramsContracts.set(modelId, paramsContract);

    // Initial state fetch
    await this.pollInfrastructureState(modelId, dailyBurnRateUSD);

    // Set up event listeners for real-time updates
    this.setupEventListeners(modelId);

    // Periodic polling as fallback
    const interval = setInterval(async () => {
      try {
        await this.pollInfrastructureState(modelId, dailyBurnRateUSD);
      } catch (error) {
        logger.error(`Error polling infrastructure state for ${modelId}:`, error);
      }
    }, pollingIntervalMs);

    this.pollingIntervals.set(modelId, interval);
    this.isMonitoring = true;
  }

  /**
   * Stop monitoring a model
   */
  async stopMonitoring(modelId: string): Promise<void> {
    const interval = this.pollingIntervals.get(modelId);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(modelId);
      logger.info(`Stopped infrastructure monitoring for ${modelId}`);
    }

    // Remove event listeners
    const paramsContract = this.paramsContracts.get(modelId);
    if (paramsContract) {
      paramsContract.removeAllListeners();
      this.paramsContracts.delete(modelId);
    }

    if (this.infraReserveContract) {
      // Remove model-specific listeners
      this.infraReserveContract.removeAllListeners(`InfrastructureDeposited(${modelId})`);
      this.infraReserveContract.removeAllListeners(`InfrastructureCostPaid(${modelId})`);
    }

    if (this.pollingIntervals.size === 0) {
      this.isMonitoring = false;
    }
  }

  /**
   * Stop all monitoring
   */
  async stopAll(): Promise<void> {
    const modelIds = Array.from(this.pollingIntervals.keys());
    for (const modelId of modelIds) {
      await this.stopMonitoring(modelId);
    }

    if (this.infraReserveContract) {
      this.infraReserveContract.removeAllListeners();
    }

    logger.info('Stopped all infrastructure monitoring');
  }

  /**
   * Poll infrastructure state for a model
   */
  private async pollInfrastructureState(modelId: string, dailyBurnRateUSD?: number): Promise<void> {
    try {
      const blockNumber = await this.provider.getBlockNumber();

      // Fetch infrastructure state
      const [accruedAmount, paidAmount, currentProvider] =
        await this.infraReserveContract!.getModelAccounting(modelId);

      // Get accrual rate from params
      const paramsContract = this.paramsContracts.get(modelId);
      if (!paramsContract) {
        logger.warn(`No params contract cached for ${modelId}`);
        return;
      }

      const infrastructureAccrualBps = await paramsContract.infrastructureAccrualBps();
      const profitShareBps = 10000 - infrastructureAccrualBps;

      // Calculate runway if daily burn rate provided
      let runwayDays: number | undefined;
      if (dailyBurnRateUSD && dailyBurnRateUSD > 0) {
        const dailyBurnRateWei = ethers.parseUnits(dailyBurnRateUSD.toString(), 6);
        runwayDays = Number(await this.infraReserveContract!.getAccrualRunway(modelId, dailyBurnRateWei));
      }

      const state: InfrastructureState = {
        modelId,
        timestamp: Date.now(),
        blockNumber,
        accrued: accruedAmount,
        paid: paidAmount,
        provider: currentProvider,
        accruedUSD: Number(ethers.formatUnits(accruedAmount, 6)),
        paidUSD: Number(ethers.formatUnits(paidAmount, 6)),
        netAccrualUSD: Number(ethers.formatUnits(accruedAmount, 6)),
        infrastructureAccrualBps,
        profitShareBps,
        dailyBurnRateUSD,
        runwayDays
      };

      // Store state
      this.storeState(modelId, state);

      // Check for alerts
      await this.checkAlerts(state);

      // Callback
      if (this.callbacks.onStateUpdate) {
        await this.callbacks.onStateUpdate(state);
      }

    } catch (error) {
      logger.error(`Error fetching infrastructure state for ${modelId}:`, error);
    }
  }

  /**
   * Setup event listeners for real-time updates
   */
  private setupEventListeners(modelId: string): void {
    if (!this.infraReserveContract) return;

    // Listen for deposits
    this.infraReserveContract.on(
      this.infraReserveContract.filters.InfrastructureDeposited(modelId),
      async (modelIdEvent, amount, newBalance, depositor, event) => {
        logger.info(`Infrastructure deposited for ${modelId}: $${ethers.formatUnits(amount, 6)}`, {
          newBalance: ethers.formatUnits(newBalance, 6),
          depositor
        });
        await this.pollInfrastructureState(modelId);
      }
    );

    // Listen for payments
    this.infraReserveContract.on(
      this.infraReserveContract.filters.InfrastructureCostPaid(modelId),
      async (modelIdEvent, payee, amount, invoiceHash, memo, event) => {
        logger.info(`Infrastructure paid for ${modelId}: $${ethers.formatUnits(amount, 6)}`, {
          payee,
          invoiceHash,
          memo
        });

        // Check if this is a large payment
        const currentState = this.getCurrentState(modelId);
        if (currentState) {
          const paymentPercent = (Number(amount) / Number(currentState.accrued + amount)) * 100;
          if (paymentPercent > this.thresholds.largePaymentPercentage) {
            await this.sendAlert({
              type: 'large_payment',
              priority: 'high',
              modelId,
              message: `Large infrastructure payment: $${ethers.formatUnits(amount, 6)} (${paymentPercent.toFixed(1)}% of accrued balance)`,
              currentState,
              metadata: {
                amount: ethers.formatUnits(amount, 6),
                payee,
                invoiceHash,
                memo,
                percentOfAccrued: paymentPercent
              }
            });
          }
        }

        await this.pollInfrastructureState(modelId);
      }
    );

    // Listen for provider changes
    this.infraReserveContract.on(
      this.infraReserveContract.filters.ProviderSet(modelId),
      async (modelIdEvent, oldProvider, newProvider, event) => {
        logger.info(`Provider changed for ${modelId}`, {
          oldProvider,
          newProvider
        });
        await this.pollInfrastructureState(modelId);
      }
    );

    // Listen for split changes
    const paramsContract = this.paramsContracts.get(modelId);
    if (paramsContract && this.thresholds.alertOnSplitChange) {
      paramsContract.on(
        'InfrastructureAccrualBpsSet',
        async (oldBps, newBps, updatedBy, event) => {
          const currentState = this.getCurrentState(modelId);
          if (currentState) {
            await this.sendAlert({
              type: 'split_change',
              priority: 'medium',
              modelId,
              message: `Infrastructure split changed from ${oldBps / 100}% to ${newBps / 100}% by governance`,
              currentState,
              metadata: {
                oldBps,
                newBps,
                updatedBy,
                oldSplit: `${oldBps / 100}/${(10000 - oldBps) / 100}`,
                newSplit: `${newBps / 100}/${(10000 - newBps) / 100}`
              }
            });
          }
          await this.pollInfrastructureState(modelId);
        }
      );
    }
  }

  /**
   * Check for alert conditions
   */
  private async checkAlerts(state: InfrastructureState): Promise<void> {
    // Critical runway alert (<3 days)
    if (state.runwayDays !== undefined && state.runwayDays < this.thresholds.criticalRunwayDays) {
      await this.sendAlert({
        type: 'critical_runway',
        priority: 'critical',
        modelId: state.modelId,
        message: `CRITICAL: Infrastructure runway < ${this.thresholds.criticalRunwayDays} days (${state.runwayDays} days remaining)`,
        currentState: state,
        metadata: {
          runwayDays: state.runwayDays,
          accruedUSD: state.accruedUSD,
          dailyBurnRateUSD: state.dailyBurnRateUSD
        }
      });
    }
    // Low runway warning (<7 days)
    else if (state.runwayDays !== undefined && state.runwayDays < this.thresholds.lowRunwayDays) {
      await this.sendAlert({
        type: 'low_runway',
        priority: 'high',
        modelId: state.modelId,
        message: `Infrastructure runway low: ${state.runwayDays} days remaining`,
        currentState: state,
        metadata: {
          runwayDays: state.runwayDays,
          accruedUSD: state.accruedUSD,
          dailyBurnRateUSD: state.dailyBurnRateUSD,
          recommendation: 'Consider increasing infrastructure accrual rate or reducing costs'
        }
      });
    }

    // No provider set
    if (this.thresholds.alertNoProvider && state.provider === ethers.ZeroAddress) {
      await this.sendAlert({
        type: 'no_provider',
        priority: 'medium',
        modelId: state.modelId,
        message: `No infrastructure provider set for ${state.modelId}`,
        currentState: state,
        metadata: {
          accruedUSD: state.accruedUSD,
          recommendation: 'Set provider address via infraReserve.setProvider()'
        }
      });
    }
  }

  /**
   * Send alert
   */
  private async sendAlert(alert: InfrastructureAlert): Promise<void> {
    if (this.callbacks.onAlert) {
      await this.callbacks.onAlert(alert);
    }
  }

  /**
   * Store state in history
   */
  private storeState(modelId: string, state: InfrastructureState): void {
    if (!this.modelStates.has(modelId)) {
      this.modelStates.set(modelId, []);
    }

    const history = this.modelStates.get(modelId)!;
    history.push(state);

    // Trim history
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  /**
   * Get current state for a model
   */
  getCurrentState(modelId: string): InfrastructureState | undefined {
    const history = this.modelStates.get(modelId);
    return history && history.length > 0 ? history[history.length - 1] : undefined;
  }

  /**
   * Get state history for a model
   */
  getStateHistory(modelId: string): InfrastructureState[] {
    return this.modelStates.get(modelId) || [];
  }

  /**
   * Get all current states
   */
  getAllCurrentStates(): Map<string, InfrastructureState> {
    const states = new Map<string, InfrastructureState>();
    for (const [modelId, history] of this.modelStates.entries()) {
      if (history.length > 0) {
        states.set(modelId, history[history.length - 1]);
      }
    }
    return states;
  }

  /**
   * Get monitoring status
   */
  getStatus() {
    return {
      isMonitoring: this.isMonitoring,
      modelsMonitored: this.pollingIntervals.size,
      models: Array.from(this.pollingIntervals.keys())
    };
  }
}
