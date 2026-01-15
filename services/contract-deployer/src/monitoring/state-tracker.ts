import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { PoolConfig, AlertThresholds } from '../config/monitoring-config';

/**
 * State Tracker
 *
 * Polls AMM pool state every 12 seconds (1 block on mainnet) and:
 * - Tracks reserve balance, spot price, token supply
 * - Detects anomalies (reserve drops, price spikes, supply mismatches)
 * - Maintains history for trend analysis
 * - Triggers alerts when thresholds exceeded
 */

export interface PoolState {
  poolAddress: string;
  modelId: string;
  timestamp: number;
  blockNumber: number;

  // Core state
  reserveBalance: bigint;      // USDC in pool (6 decimals)
  spotPrice: bigint;           // Current price (6 decimals)
  tokenSupply: bigint;         // Total token supply (18 decimals)
  paused: boolean;             // Emergency pause state

  // Derived metrics
  reserveUSD: number;          // Reserve in USD (formatted)
  priceUSD: number;            // Price in USD (formatted)
  supplyFormatted: number;     // Supply in tokens (formatted)
  marketCapUSD: number;        // Approximate market cap
  reserveRatio: number;        // Actual reserve ratio (vs theoretical CRR)

  // Contract balances
  contractUSDCBalance: bigint; // Actual USDC held by contract
  treasuryFees: bigint;        // Fees not yet withdrawn
}

export interface StateAlert {
  type: 'reserve_drop' | 'price_spike' | 'supply_mismatch' | 'paused' | 'low_reserve' | 'high_fees';
  priority: 'critical' | 'high' | 'medium';
  poolAddress: string;
  modelId: string;
  message: string;
  currentState: PoolState;
  previousState?: PoolState;
  metadata?: Record<string, any>;
}

export interface StateTrackerCallbacks {
  onStateUpdate?: (state: PoolState) => Promise<void>;
  onAlert?: (alert: StateAlert) => Promise<void>;
}

export class StateTracker {
  private provider: ethers.Provider;
  private thresholds: AlertThresholds;
  private callbacks: StateTrackerCallbacks;

  private poolStates: Map<string, PoolState[]> = new Map(); // poolAddress -> history
  private maxHistoryLength: number = 300; // ~1 hour at 12s intervals

  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private isTracking: boolean = false;

  // AMM Pool ABI
  private static readonly POOL_ABI = [
    'function reserveBalance() view returns (uint256)',
    'function spotPrice() view returns (uint256)',
    'function hokusaiToken() view returns (address)',
    'function paused() view returns (bool)',
    'function crr() view returns (uint256)',
    'function modelId() view returns (string)'
  ];

  // ERC20 Token ABI
  private static readonly TOKEN_ABI = [
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)'
  ];

  // USDC ABI
  private static readonly USDC_ABI = [
    'function balanceOf(address) view returns (uint256)'
  ];

  constructor(
    provider: ethers.Provider,
    thresholds: AlertThresholds,
    callbacks: StateTrackerCallbacks = {}
  ) {
    this.provider = provider;
    this.thresholds = thresholds;
    this.callbacks = callbacks;
  }

  /**
   * Start tracking a pool
   */
  async startTracking(poolConfig: PoolConfig, pollingIntervalMs: number = 12000): Promise<void> {
    const { ammAddress, modelId } = poolConfig;

    if (this.pollingIntervals.has(ammAddress)) {
      logger.warn(`Already tracking pool ${modelId} at ${ammAddress}`);
      return;
    }

    logger.info(`Starting state tracking for ${modelId} (${ammAddress}), interval: ${pollingIntervalMs}ms`);

    // Initial poll
    await this.pollPoolState(poolConfig);

    // Set up polling interval
    const interval = setInterval(async () => {
      try {
        await this.pollPoolState(poolConfig);
      } catch (error) {
        logger.error(`Failed to poll state for ${modelId}:`, error);
      }
    }, pollingIntervalMs);

    this.pollingIntervals.set(ammAddress, interval);
    this.isTracking = true;

    logger.info(`State tracking started for ${modelId}`);
  }

  /**
   * Stop tracking a pool
   */
  stopTracking(poolAddress: string): void {
    const interval = this.pollingIntervals.get(poolAddress);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(poolAddress);
      logger.info(`Stopped tracking pool ${poolAddress}`);
    }
  }

  /**
   * Stop tracking all pools
   */
  stopAllTracking(): void {
    for (const [poolAddress, interval] of this.pollingIntervals) {
      clearInterval(interval);
      logger.info(`Stopped tracking pool ${poolAddress}`);
    }
    this.pollingIntervals.clear();
    this.isTracking = false;
    logger.info('All state tracking stopped');
  }

  /**
   * Poll pool state
   */
  private async pollPoolState(poolConfig: PoolConfig): Promise<void> {
    const { ammAddress, modelId, crr } = poolConfig;

    try {
      // Get current block
      const blockNumber = await this.provider.getBlockNumber();
      const timestamp = Math.floor(Date.now() / 1000);

      // Create contract instances
      const pool = new ethers.Contract(ammAddress, StateTracker.POOL_ABI, this.provider);

      // Get pool state
      const [reserveBalance, spotPrice, tokenAddress, paused] = await Promise.all([
        pool.reserveBalance(),
        pool.spotPrice(),
        pool.hokusaiToken(),
        pool.paused()
      ]);

      // Get token state
      const token = new ethers.Contract(tokenAddress, StateTracker.TOKEN_ABI, this.provider);
      const tokenSupply = await token.totalSupply();

      // Get USDC balance
      const usdcAddress = await this.getUSDCAddress(poolConfig);
      const usdc = new ethers.Contract(usdcAddress, StateTracker.USDC_ABI, this.provider);
      const contractUSDCBalance = await usdc.balanceOf(ammAddress);

      // Calculate derived metrics
      const reserveUSD = Number(ethers.formatUnits(reserveBalance, 6));
      const priceUSD = Number(ethers.formatUnits(spotPrice, 6));
      const supplyFormatted = Number(ethers.formatEther(tokenSupply));

      // Market cap approximation: reserve / (CRR / 1000000)
      const marketCapUSD = reserveUSD / (crr / 1000000);

      // Reserve ratio: (reserve * 1e18) / (price * supply)
      // This should match CRR if bonding curve is working correctly
      let reserveRatio = 0;
      if (spotPrice > 0n && tokenSupply > 0n) {
        reserveRatio = Number(reserveBalance) * 1e18 / (Number(spotPrice) * Number(tokenSupply));
      }

      // Treasury fees = contract balance - tracked reserve
      const treasuryFees = contractUSDCBalance - reserveBalance;

      // Create state snapshot
      const state: PoolState = {
        poolAddress: ammAddress,
        modelId,
        timestamp,
        blockNumber,
        reserveBalance,
        spotPrice,
        tokenSupply,
        paused,
        reserveUSD,
        priceUSD,
        supplyFormatted,
        marketCapUSD,
        reserveRatio,
        contractUSDCBalance,
        treasuryFees
      };

      // Store state
      this.addStateToHistory(ammAddress, state);

      // Check for anomalies
      await this.checkAnomalies(state, poolConfig);

      // Notify callback
      if (this.callbacks.onStateUpdate) {
        await this.callbacks.onStateUpdate(state);
      }

    } catch (error) {
      logger.error(`Failed to poll state for ${modelId} at ${ammAddress}:`, error);
      throw error;
    }
  }

  /**
   * Add state to history and maintain max length
   */
  private addStateToHistory(poolAddress: string, state: PoolState): void {
    let history = this.poolStates.get(poolAddress);
    if (!history) {
      history = [];
      this.poolStates.set(poolAddress, history);
    }

    history.push(state);

    // Trim history if needed
    if (history.length > this.maxHistoryLength) {
      history.shift();
    }
  }

  /**
   * Check for anomalies and trigger alerts
   */
  private async checkAnomalies(currentState: PoolState, poolConfig: PoolConfig): Promise<void> {
    const history = this.poolStates.get(currentState.poolAddress);
    if (!history || history.length < 2) {
      return; // Need at least 2 states to compare
    }

    const alerts: StateAlert[] = [];

    // Check if paused
    if (currentState.paused) {
      const pausedDuration = this.getPausedDuration(currentState.poolAddress);
      if (pausedDuration > this.thresholds.pausedDurationHours * 60 * 60 * 1000) {
        alerts.push({
          type: 'paused',
          priority: 'critical',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Pool has been paused for ${(pausedDuration / (60 * 60 * 1000)).toFixed(1)} hours`,
          currentState,
          metadata: { pausedDurationMs: pausedDuration }
        });
      }
    }

    // Check reserve drop
    const reserveDropAlert = this.checkReserveDrop(currentState, history);
    if (reserveDropAlert) alerts.push(reserveDropAlert);

    // Check low reserve
    if (currentState.reserveUSD < this.thresholds.minReserveUSD) {
      alerts.push({
        type: 'low_reserve',
        priority: 'high',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Reserve below minimum: $${currentState.reserveUSD.toFixed(2)} < $${this.thresholds.minReserveUSD}`,
        currentState
      });
    }

    // Check price volatility
    const priceAlert = this.checkPriceVolatility(currentState, history);
    if (priceAlert) alerts.push(priceAlert);

    // Check supply changes
    const supplyAlert = this.checkSupplyAnomaly(currentState, history);
    if (supplyAlert) alerts.push(supplyAlert);

    // Check high treasury fees
    const treasuryFeesUSD = Number(ethers.formatUnits(currentState.treasuryFees, 6));
    if (treasuryFeesUSD > this.thresholds.treasuryFeesThresholdUSD) {
      alerts.push({
        type: 'high_fees',
        priority: 'medium',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `High treasury fees: $${treasuryFeesUSD.toFixed(2)} (threshold: $${this.thresholds.treasuryFeesThresholdUSD})`,
        currentState,
        metadata: { treasuryFeesUSD }
      });
    }

    // Send alerts
    for (const alert of alerts) {
      if (this.callbacks.onAlert) {
        await this.callbacks.onAlert(alert);
      }
    }
  }

  /**
   * Check for reserve drops
   */
  private checkReserveDrop(currentState: PoolState, history: PoolState[]): StateAlert | null {
    const windowMs = this.thresholds.reserveDropWindowMs;
    const cutoffTime = currentState.timestamp - (windowMs / 1000);

    // Find state from ~1 hour ago
    const oldState = history.find(s => s.timestamp >= cutoffTime);
    if (!oldState) return null;

    const oldReserve = Number(oldState.reserveBalance);
    const currentReserve = Number(currentState.reserveBalance);

    if (oldReserve === 0) return null; // Avoid division by zero

    const dropPercentage = ((oldReserve - currentReserve) / oldReserve) * 100;

    if (dropPercentage > this.thresholds.reserveDropPercentage) {
      return {
        type: 'reserve_drop',
        priority: 'critical',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Reserve dropped ${dropPercentage.toFixed(1)}% in ${windowMs / (60 * 60 * 1000)}h: $${oldState.reserveUSD.toFixed(2)} → $${currentState.reserveUSD.toFixed(2)}`,
        currentState,
        previousState: oldState,
        metadata: { dropPercentage, oldReserveUSD: oldState.reserveUSD, newReserveUSD: currentState.reserveUSD }
      };
    }

    return null;
  }

  /**
   * Check for price volatility
   */
  private checkPriceVolatility(currentState: PoolState, history: PoolState[]): StateAlert | null {
    const oneHourAgo = currentState.timestamp - 3600;
    const oldState = history.find(s => s.timestamp >= oneHourAgo);
    if (!oldState) return null;

    const oldPrice = Number(oldState.spotPrice);
    const currentPrice = Number(currentState.spotPrice);

    if (oldPrice === 0) return null;

    const changePercentage = Math.abs(((currentPrice - oldPrice) / oldPrice) * 100);

    if (changePercentage > this.thresholds.priceChange1hPercentage) {
      return {
        type: 'price_spike',
        priority: 'high',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Price changed ${changePercentage.toFixed(1)}% in 1h: $${oldState.priceUSD.toFixed(6)} → $${currentState.priceUSD.toFixed(6)}`,
        currentState,
        previousState: oldState,
        metadata: { changePercentage, oldPriceUSD: oldState.priceUSD, newPriceUSD: currentState.priceUSD }
      };
    }

    return null;
  }

  /**
   * Check for supply anomalies
   */
  private checkSupplyAnomaly(currentState: PoolState, history: PoolState[]): StateAlert | null {
    const oneHourAgo = currentState.timestamp - 3600;
    const oldState = history.find(s => s.timestamp >= oneHourAgo);
    if (!oldState) return null;

    const oldSupply = Number(oldState.tokenSupply);
    const currentSupply = Number(currentState.tokenSupply);

    if (oldSupply === 0) return null;

    const changePercentage = Math.abs(((currentSupply - oldSupply) / oldSupply) * 100);

    if (changePercentage > this.thresholds.supplyChange1hPercentage) {
      return {
        type: 'supply_mismatch',
        priority: 'high',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Supply changed ${changePercentage.toFixed(1)}% in 1h: ${oldState.supplyFormatted.toFixed(0)} → ${currentState.supplyFormatted.toFixed(0)} tokens`,
        currentState,
        previousState: oldState,
        metadata: { changePercentage, oldSupply: oldState.supplyFormatted, newSupply: currentState.supplyFormatted }
      };
    }

    return null;
  }

  /**
   * Get paused duration in milliseconds
   */
  private getPausedDuration(poolAddress: string): number {
    const history = this.poolStates.get(poolAddress) || [];

    // Find when pool was first paused
    for (let i = history.length - 1; i >= 0; i--) {
      if (!history[i].paused) {
        // Found first non-paused state, calculate duration since then
        const pausedSince = history[i + 1];
        if (pausedSince) {
          return Date.now() - (pausedSince.timestamp * 1000);
        }
      }
    }

    // If all history is paused, use oldest timestamp
    if (history.length > 0 && history[0].paused) {
      return Date.now() - (history[0].timestamp * 1000);
    }

    return 0;
  }

  /**
   * Get USDC address (helper method, should come from config)
   */
  private async getUSDCAddress(_poolConfig: PoolConfig): Promise<string> {
    // This should be passed from config, hardcoding for now
    // Mainnet USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
    // This will be provided by monitoring config
    const chainId = (await this.provider.getNetwork()).chainId;
    return chainId === 1n ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' : '0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3'; // Sepolia MockUSDC
  }

  /**
   * Get current state for a pool
   */
  getCurrentState(poolAddress: string): PoolState | undefined {
    const history = this.poolStates.get(poolAddress);
    return history?.[history.length - 1];
  }

  /**
   * Get state history for a pool
   */
  getStateHistory(poolAddress: string, maxStates?: number): PoolState[] {
    const history = this.poolStates.get(poolAddress) || [];
    if (maxStates && history.length > maxStates) {
      return history.slice(-maxStates);
    }
    return [...history];
  }

  /**
   * Get tracking status
   */
  isTrackingPool(poolAddress: string): boolean {
    return this.pollingIntervals.has(poolAddress);
  }

  /**
   * Get number of tracked pools
   */
  getTrackedPoolCount(): number {
    return this.pollingIntervals.size;
  }
}
