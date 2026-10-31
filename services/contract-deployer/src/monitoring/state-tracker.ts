import { ethers } from 'ethers';
import { IncidentStore } from './incident-store';
import { normalizePhase, reserveRatio, anchoredReserveRatio } from './curve-invariant';
import { logger } from '../utils/logger';
import { PoolConfig, AlertThresholds } from '../config/monitoring-config';

/**
 * State Tracker (OPTIMIZED)
 *
 * Event-driven state tracking with fallback polling:
 * - Updates state immediately when Buy/Sell/FeesDeposited events occur (zero polling overhead)
 * - Fallback polling every 5 minutes (vs old 12s) to catch missed events
 * - Tracks reserve balance, spot price, token supply
 * - Detects anomalies (reserve drops, price spikes, supply mismatches)
 * - Maintains history for trend analysis
 * - Triggers alerts when thresholds exceeded
 *
 * RPC Optimization:
 * - Event-driven updates: ~95% reduction in polling calls
 * - Batched state reads: All pool state in single Promise.all
 * - Address caching: Immutable addresses fetched once
 */

export interface PoolState {
  poolAddress: string;
  modelId: string;
  timestamp: number;
  blockNumber: number;

  // Core state
  reserveBalance: bigint; // USDC in pool (6 decimals)
  spotPrice: bigint; // Current price (6 decimals)
  curveSupply?: bigint;
  expectedReserveRatio?: number;
  tokenSupply: bigint; // Total token supply (18 decimals)
  paused: boolean; // Emergency pause state

  // Phase information
  pricingPhase: 0 | 1; // 0 = FLAT_PRICE, 1 = BONDING_CURVE
  flatCurveThreshold: bigint; // Reserve threshold for phase transition
  flatCurvePrice: bigint; // Fixed price during flat phase

  // Derived metrics
  reserveUSD: number; // Reserve in USD (formatted)
  priceUSD: number; // Price in USD (formatted)
  supplyFormatted: number; // Supply in tokens (formatted)
  marketCapUSD: number; // Approximate market cap
  reserveRatio: number; // Actual reserve ratio (vs theoretical CRR)

  // Contract balances
  contractUSDCBalance: bigint; // Actual USDC held by contract
  treasuryFees: bigint; // Fees not yet withdrawn
}

export interface StateAlert {
  type:
    | 'reserve_drop'
    | 'price_spike'
    | 'supply_anomaly'
    | 'true_supply_mismatch'
    | 'paused'
    | 'condition_recovered'
    | 'low_reserve'
    | 'high_fees'
    // HOK-1698: monitor-level ingestion health (not pool-specific; carries no currentState).
    | 'stale_ingestion'
    | 'ingestion_recovered'
    | 'rpc_primary_recovered';
  priority: 'critical' | 'high' | 'medium' | 'info';
  poolAddress: string;
  modelId: string;
  message: string;
  currentState?: PoolState;
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
  private poolContracts: Map<string, ethers.Contract> = new Map(); // NEW: Store contracts for event cleanup
  private isTracking: boolean = false;

  // Cache for immutable pool data (reduces RPC calls)
  private tokenAddressCache: Map<string, string> = new Map(); // poolAddress -> tokenAddress
  private usdcAddressCache: Map<string, string> = new Map(); // poolAddress -> usdcAddress
  private flatCurveThresholdCache: Map<string, bigint> = new Map(); // poolAddress -> threshold
  private flatCurvePriceCache: Map<string, bigint> = new Map(); // poolAddress -> flatPrice

  // Statistics for suppressed alerts
  private suppressedAlertCount: number = 0;
  private suppressedAlertsByType: Map<string, number> = new Map();

  // Track active alert conditions to prevent duplicate alerts
  // Key: poolAddress:alertType, Value: timestamp when alert became active
  private activeAlerts: Map<string, number> = new Map();
  private hydrated = new Set<string>();
  private inFlight = new Set<string>();
  private pauseFirstObserved = new Map<string, number>();
  private recoveries: Array<{ poolAddress: string; condition: string }> = [];

  // AMM Pool ABI
  private static readonly POOL_ABI = [
    'function getReserves() view returns (uint256 reserve, uint256 supply)',
    'function graduationSupply() view returns (uint256)',
    'function anchorBasisSupply() view returns (uint256)',
    'function reserveBalance() view returns (uint256)',
    'function spotPrice() view returns (uint256)',
    'function hokusaiToken() view returns (address)',
    'function paused() view returns (bool)',
    'function crr() view returns (uint256)',
    'function modelId() view returns (string)',
    // Phase detection functions
    'function getCurrentPhase() view returns (uint8)',
    'function getPhaseInfo() view returns (uint8 phase, uint256 threshold, uint256 flatPrice, uint256 reserve, uint256 supply)',
    'function FLAT_CURVE_THRESHOLD() view returns (uint256)',
    'function FLAT_CURVE_PRICE() view returns (uint256)',
    // Events for event-driven updates
    'event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 fee, uint256 spotPrice)',
    'event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 fee, uint256 spotPrice)',
    'event FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance, uint256 newSpotPrice)',
    'event PhaseTransition(uint8 indexed fromPhase, uint8 indexed toPhase, uint256 reserveBalance, uint256 timestamp)',
  ];

  // ERC20 Token ABI
  private static readonly TOKEN_ABI = [
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];

  // USDC ABI
  private static readonly USDC_ABI = ['function balanceOf(address) view returns (uint256)'];

  constructor(
    provider: ethers.Provider,
    thresholds: AlertThresholds,
    callbacks: StateTrackerCallbacks = {},
    private store = new IncidentStore('local'),
    private confirmations = 2,
    private requireAnchoredCurve = false,
  ) {
    this.provider = provider;
    this.thresholds = thresholds;
    this.callbacks = callbacks;
  }

  /** Rebind future calls and subscriptions to a replacement provider. */
  setProvider(provider: ethers.Provider): void {
    this.stopAllTracking();
    this.provider = provider;
  }

  /**
   * Start tracking a pool
   * NEW: Event-driven updates instead of aggressive polling
   */
  async startTracking(poolConfig: PoolConfig, pollingIntervalMs: number = 12000): Promise<void> {
    const { ammAddress, modelId } = poolConfig;

    if (this.pollingIntervals.has(ammAddress)) {
      logger.warn(`Already tracking pool ${modelId} at ${ammAddress}`);
      return;
    }

    logger.info(
      `Starting state tracking for ${modelId} (${ammAddress}), mode: event-driven + periodic fallback`,
    );

    // Initial state fetch
    await this.pollPoolState(poolConfig);

    // NEW: Event-driven updates - update state when events occur
    // This replaces the aggressive 12s polling with on-demand updates
    const pool = new ethers.Contract(ammAddress, StateTracker.POOL_ABI, this.provider);

    const updateState = (): void => {
      void this.pollPoolState(poolConfig).catch((error) => {
        logger.error(`Failed to update state for ${modelId}:`, error);
      });
    };

    // Listen for trade events that change state
    void pool.on('Buy', updateState);
    void pool.on('Sell', updateState);
    void pool.on('FeesDeposited', updateState);

    // Store listeners for cleanup
    this.poolContracts.set(ammAddress, pool);

    // Fallback: Periodic polling at much longer interval (5 minutes instead of 12s)
    // This catches any state changes we might have missed
    const fallbackIntervalMs = Math.max(pollingIntervalMs, 5 * 60 * 1000); // Min 5 minutes
    const interval = setInterval(() => {
      void this.pollPoolState(poolConfig).catch((error) => {
        logger.error(`Failed to poll state for ${modelId}:`, error);
      });
    }, fallbackIntervalMs);

    this.pollingIntervals.set(ammAddress, interval);
    this.isTracking = true;

    logger.info(
      `State tracking started for ${modelId} (event-driven + ${fallbackIntervalMs}ms fallback)`,
    );
  }

  /**
   * Stop tracking a pool
   */
  stopTracking(poolAddress: string): void {
    // Stop polling interval
    const interval = this.pollingIntervals.get(poolAddress);
    if (interval) {
      clearInterval(interval);
      this.pollingIntervals.delete(poolAddress);
    }

    // Clean up event listeners
    const pool = this.poolContracts.get(poolAddress);
    if (pool) {
      void pool.removeAllListeners();
      this.poolContracts.delete(poolAddress);
    }

    // Clear all active alerts for this pool
    const alertTypes = [
      'reserve_drop',
      'price_spike',
      'supply_anomaly',
      'low_reserve',
      'paused',
      'high_fees',
      'true_supply_mismatch',
    ];
    for (const alertType of alertTypes) {
      this.clearAlert(poolAddress, alertType);
    }

    logger.info(`Stopped tracking pool ${poolAddress}`);
  }

  /**
   * Stop tracking all pools
   */
  stopAllTracking(): void {
    // Stop all polling intervals
    for (const [poolAddress, interval] of this.pollingIntervals) {
      clearInterval(interval);
      logger.info(`Stopped tracking pool ${poolAddress}`);
    }
    this.pollingIntervals.clear();

    // Clean up all event listeners
    for (const [poolAddress, pool] of this.poolContracts) {
      void pool.removeAllListeners();
      logger.info(`Cleaned up event listeners for pool ${poolAddress}`);
    }
    this.poolContracts.clear();

    this.isTracking = false;
    logger.info('All state tracking stopped');
  }

  /**
   * Poll pool state
   */
  private async pollPoolState(poolConfig: PoolConfig): Promise<void> {
    const { ammAddress, modelId } = poolConfig;
    if (this.inFlight.has(ammAddress)) {
      return;
    }
    this.inFlight.add(ammAddress);
    try {
      if (!this.hydrated.has(ammAddress)) {
        const saved = await this.store.get<{ active: Array<[string, number]>; pause?: number }>(
          `state:${ammAddress}`,
        );
        for (const [key, value] of saved?.active || []) {
          this.activeAlerts.set(key, value);
        }
        if (saved?.pause) {
          this.pauseFirstObserved.set(ammAddress, saved.pause);
        }
        this.hydrated.add(ammAddress);
      }
      // Get current block
      const blockNumber = Math.max(
        0,
        (await this.provider.getBlockNumber()) - this.confirmations + 1,
      );
      const blockTag = { blockTag: blockNumber };
      const sampledBlock = await this.provider.getBlock(blockNumber);
      if (!sampledBlock) {
        throw new Error('State block unavailable');
      }
      const timestamp = sampledBlock.timestamp;

      // Create contract instances
      const pool = new ethers.Contract(ammAddress, StateTracker.POOL_ABI, this.provider);

      // Get pool state with null checks
      const reserveBalanceFn = pool.reserveBalance;
      const spotPriceFn = pool.spotPrice;
      const tokenFn = pool.hokusaiToken;
      const pausedFn = pool.paused;

      if (!reserveBalanceFn || !spotPriceFn || !tokenFn || !pausedFn) {
        throw new Error('Pool contract methods not found');
      }

      // Get token address from cache or fetch once
      let tokenAddress: string = this.tokenAddressCache.get(ammAddress) || '';
      if (!tokenAddress) {
        const fetchedAddress = await tokenFn();
        if (!fetchedAddress) {
          throw new Error('Token address is undefined');
        }
        tokenAddress = fetchedAddress;
        this.tokenAddressCache.set(ammAddress, tokenAddress);
        logger.debug(`Cached token address for ${modelId}: ${tokenAddress}`);
      }

      // Get USDC address from cache or fetch once (do this before state reads)
      let usdcAddress: string = this.usdcAddressCache.get(ammAddress) || '';
      if (!usdcAddress) {
        const fetchedUsdcAddress = await this.getUSDCAddress(poolConfig);
        if (!fetchedUsdcAddress) {
          throw new Error('USDC address is undefined');
        }
        usdcAddress = fetchedUsdcAddress;
        this.usdcAddressCache.set(ammAddress, usdcAddress);
        logger.debug(`Cached USDC address for ${modelId}: ${usdcAddress}`);
      }

      // Get phase parameters from cache or fetch once
      let flatCurveThreshold = this.flatCurveThresholdCache.get(ammAddress);
      let flatCurvePrice = this.flatCurvePriceCache.get(ammAddress);

      // Get phase detection functions with null checks
      const getCurrentPhaseFn = pool.getCurrentPhase;
      const getThresholdFn = pool.FLAT_CURVE_THRESHOLD;
      const getPriceFn = pool.FLAT_CURVE_PRICE;

      if (!getCurrentPhaseFn || !getThresholdFn || !getPriceFn) {
        throw new Error('Phase detection methods not found on pool contract');
      }

      // OPTIMIZED: Batch all state reads into a single Promise.all (reduces RPC calls)
      const token = new ethers.Contract(tokenAddress, StateTracker.TOKEN_ABI, this.provider);
      const usdc = new ethers.Contract(usdcAddress, StateTracker.USDC_ABI, this.provider);

      const totalSupplyFn = token.totalSupply;
      const balanceOfFn = usdc.balanceOf;

      if (!totalSupplyFn || !balanceOfFn) {
        throw new Error('Token contract methods not found');
      }

      const [
        reserveBalance,
        spotPrice,
        paused,
        tokenSupply,
        contractUSDCBalance,
        currentPhase,
        fetchedThreshold,
        fetchedPrice,
      ] = await Promise.all([
        reserveBalanceFn(blockTag),
        spotPriceFn(blockTag),
        pausedFn(blockTag),
        totalSupplyFn(blockTag),
        balanceOfFn(ammAddress, blockTag),
        getCurrentPhaseFn(blockTag),
        flatCurveThreshold ? Promise.resolve(flatCurveThreshold) : getThresholdFn(blockTag),
        flatCurvePrice ? Promise.resolve(flatCurvePrice) : getPriceFn(blockTag),
      ]);

      // Cache immutable phase parameters
      if (!flatCurveThreshold) {
        this.flatCurveThresholdCache.set(ammAddress, fetchedThreshold);
        flatCurveThreshold = fetchedThreshold;
        logger.debug(
          `Cached flat curve threshold for ${modelId}: ${ethers.formatUnits(fetchedThreshold, 6)} USDC`,
        );
      }
      if (!flatCurvePrice) {
        this.flatCurvePriceCache.set(ammAddress, fetchedPrice);
        flatCurvePrice = fetchedPrice;
        logger.debug(
          `Cached flat curve price for ${modelId}: $${ethers.formatUnits(fetchedPrice, 6)}`,
        );
      }

      const reserves = await pool.getFunction('getReserves')(blockTag);
      const curveSupply = BigInt(reserves[1]);
      // getPhaseInfo and getReserves use the manager's redeemable supply, excluding locked allocations.
      const anchorResults = await Promise.allSettled([
        pool.getFunction('graduationSupply')(blockTag),
        pool.getFunction('anchorBasisSupply')(blockTag),
      ]);
      for (const result of anchorResults) {
        if (
          result.status === 'rejected' &&
          (this.requireAnchoredCurve || !ethers.isError(result.reason, 'CALL_EXCEPTION'))
        ) {
          throw result.reason;
        }
      }
      const anchorsPresent = anchorResults.every((r) => r.status === 'fulfilled');
      const phase = normalizePhase(currentPhase);
      const liveCrr = Number(await pool.getFunction('crr')(blockTag));
      const expectedReserveRatio = anchorsPresent
        ? anchoredReserveRatio(
            curveSupply,
            BigInt((anchorResults[0] as PromiseFulfilledResult<bigint>).value),
            BigInt((anchorResults[1] as PromiseFulfilledResult<bigint>).value),
            liveCrr,
          )
        : liveCrr / 1_000_000;
      const reserveUSD = Number(ethers.formatUnits(reserveBalance, 6));
      const priceUSD = Number(ethers.formatUnits(spotPrice, 6));
      const supplyFormatted = Number(ethers.formatEther(tokenSupply));
      const marketCapUSD = priceUSD * supplyFormatted;
      const actualReserveRatio = reserveRatio(
        BigInt(reserveBalance),
        BigInt(spotPrice),
        curveSupply,
      );

      // Treasury fees = contract balance - tracked reserve
      const treasuryFees = BigInt(contractUSDCBalance) - BigInt(reserveBalance);

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
        pricingPhase: phase,
        curveSupply,
        expectedReserveRatio,
        flatCurveThreshold: flatCurveThreshold!,
        flatCurvePrice: flatCurvePrice!,
        reserveUSD,
        priceUSD,
        supplyFormatted,
        marketCapUSD,
        reserveRatio: actualReserveRatio,
        contractUSDCBalance,
        treasuryFees,
      };

      // Store state
      this.addStateToHistory(ammAddress, state);

      // Roll back transition state when notification delivery fails, so the next sample retries.
      const activeBefore = new Map(this.activeAlerts);
      try {
        await this.checkAnomalies(state, poolConfig);
      } catch (error) {
        this.activeAlerts = activeBefore;
        throw error;
      }

      await this.store.put(`state:${ammAddress}`, {
        active: [...this.activeAlerts].filter(([key]) => key.startsWith(`${ammAddress}:`)),
        pause: this.pauseFirstObserved.get(ammAddress),
      });
      // Notify callback
      if (this.callbacks.onStateUpdate) {
        await this.callbacks.onStateUpdate(state);
      }
    } catch (error) {
      logger.error(`Failed to poll state for ${modelId} at ${ammAddress}:`, error);
      throw error;
    } finally {
      this.inFlight.delete(ammAddress);
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
   * Check if an alert condition is already active
   */
  private isAlertActive(poolAddress: string, alertType: string): boolean {
    const key = `${poolAddress}:${alertType}`;
    const last = this.activeAlerts.get(key);
    return last !== undefined && Date.now() - last < 6 * 3600_000;
  }

  /**
   * Mark an alert condition as active
   */
  private setAlertActive(poolAddress: string, alertType: string): void {
    const key = `${poolAddress}:${alertType}`;
    this.activeAlerts.set(key, Date.now());
  }

  /**
   * Clear an alert condition (no longer active)
   */
  private clearAlert(poolAddress: string, alertType: string): void {
    const key = `${poolAddress}:${alertType}`;
    if (this.activeAlerts.delete(key)) {
      this.recoveries.push({ poolAddress, condition: alertType });
    }
  }

  /**
   * Check for anomalies and trigger alerts
   */
  private async checkAnomalies(currentState: PoolState, poolConfig: PoolConfig): Promise<void> {
    const history = this.poolStates.get(currentState.poolAddress);
    if (!history) {
      return;
    }

    const alerts: StateAlert[] = [];
    const isBootstrapPhase = currentState.pricingPhase === 0; // FLAT_PRICE

    // Log phase for debugging
    logger.debug(`Checking anomalies for ${currentState.modelId}`, {
      phase: isBootstrapPhase ? 'FLAT_PRICE' : 'BONDING_CURVE',
      reserveUSD: currentState.reserveUSD,
      threshold: Number(ethers.formatUnits(currentState.flatCurveThreshold, 6)),
    });

    // ALWAYS CHECK: Critical security alerts (all phases)

    // Check if paused
    const pausedAlertType = 'paused';
    if (currentState.paused) {
      if (!this.pauseFirstObserved.has(currentState.poolAddress)) {
        this.pauseFirstObserved.set(currentState.poolAddress, Date.now());
      }
      const firstObserved = this.pauseFirstObserved.get(currentState.poolAddress)!;
      const pausedDuration = Date.now() - firstObserved;
      const maintenanceUntil = await this.store.get<number>(
        `maintenance:${currentState.poolAddress}`,
      );
      const isPausedConditionMet =
        (!maintenanceUntil || maintenanceUntil <= Date.now()) &&
        pausedDuration > this.thresholds.pausedDurationHours * 60 * 60 * 1000;

      if (isPausedConditionMet && !this.isAlertActive(currentState.poolAddress, pausedAlertType)) {
        this.setAlertActive(currentState.poolAddress, pausedAlertType);
        alerts.push({
          type: pausedAlertType,
          priority: 'critical',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Pool observed paused for ${(pausedDuration / 3600_000).toFixed(1)} hours (first observed ${new Date(firstObserved).toISOString()})`,
          currentState,
          metadata: { pausedDurationMs: pausedDuration, firstObservedAt: firstObserved },
        });
      }
    } else {
      this.pauseFirstObserved.delete(currentState.poolAddress);
      // No longer paused, clear alert
      this.clearAlert(currentState.poolAddress, pausedAlertType);
    }

    // ALWAYS CHECK: Supply invariant (detects unauthorized minting/burning)
    const supplyInvariantAlert = this.checkSupplyInvariant(currentState, poolConfig);
    if (supplyInvariantAlert) {
      alerts.push(supplyInvariantAlert);
    }

    const reserveDropAlert = this.checkReserveDrop(currentState, history);
    if (reserveDropAlert) {
      alerts.push(reserveDropAlert);
    }
    // PHASE-AWARE: Only check percentage-based alerts in bonding curve phase
    if (!isBootstrapPhase) {
      logger.debug(`Running bonding curve phase alerts for ${currentState.modelId}`);

      // Check low reserve (absolute minimum)
      const lowReserveAlertType = 'low_reserve';
      const isLowReserveConditionMet =
        currentState.reserveUSD < this.thresholds.minReserveUSD &&
        this.thresholds.minReserveUSD > 0;

      if (isLowReserveConditionMet) {
        if (!this.isAlertActive(currentState.poolAddress, lowReserveAlertType)) {
          this.setAlertActive(currentState.poolAddress, lowReserveAlertType);
          alerts.push({
            type: lowReserveAlertType,
            priority: 'high',
            poolAddress: currentState.poolAddress,
            modelId: currentState.modelId,
            message: `Reserve below minimum: $${currentState.reserveUSD.toFixed(2)} < $${this.thresholds.minReserveUSD}`,
            currentState,
          });
        }
      } else {
        this.clearAlert(currentState.poolAddress, lowReserveAlertType);
      }

      // Check price volatility
      const priceAlert = this.checkPriceVolatility(currentState, history);
      if (priceAlert) {
        alerts.push(priceAlert);
      }

      // Check supply anomaly (renamed from supply_mismatch)
      const supplyAlert = this.checkSupplyAnomaly(currentState, history);
      if (supplyAlert) {
        alerts.push(supplyAlert);
      }
    } else {
      // Bootstrap phase: Count which alerts were suppressed
      logger.debug(`Suppressing percentage-based alerts for ${currentState.modelId} (flat phase)`);

      const potentialAlerts = ['price_spike', 'supply_anomaly', 'low_reserve'];
      for (const alertType of potentialAlerts) {
        this.suppressedAlertCount++;
        this.suppressedAlertsByType.set(
          alertType,
          (this.suppressedAlertsByType.get(alertType) || 0) + 1,
        );
      }
    }

    // Check high treasury fees (all phases, but medium priority)
    const highFeesAlertType = 'high_fees';
    const treasuryFeesUSD = Number(ethers.formatUnits(currentState.treasuryFees, 6));
    const isHighFeesConditionMet = treasuryFeesUSD > this.thresholds.treasuryFeesThresholdUSD;

    if (isHighFeesConditionMet) {
      if (!this.isAlertActive(currentState.poolAddress, highFeesAlertType)) {
        this.setAlertActive(currentState.poolAddress, highFeesAlertType);
        alerts.push({
          type: highFeesAlertType,
          priority: 'medium',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `High treasury fees: $${treasuryFeesUSD.toFixed(2)} (threshold: $${this.thresholds.treasuryFeesThresholdUSD})`,
          currentState,
          metadata: { treasuryFeesUSD },
        });
      }
    } else {
      this.clearAlert(currentState.poolAddress, highFeesAlertType);
    }

    const resolved = this.recoveries.filter((r) => r.poolAddress === currentState.poolAddress);
    this.recoveries = this.recoveries.filter((r) => r.poolAddress !== currentState.poolAddress);
    for (const recovery of resolved) {
      alerts.push({
        type: 'condition_recovered',
        priority: 'info',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        currentState,
        message: `Recovered: ${recovery.condition} on model ${currentState.modelId}`,
        metadata: { condition: recovery.condition },
      });
    }
    // Send alerts
    for (const alert of alerts) {
      alert.metadata = {
        ...alert.metadata,
        incidentStartedAt:
          this.activeAlerts.get(`${alert.poolAddress}:${alert.type}`) ?? Date.now(),
      };
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
    const cutoffTime = currentState.timestamp - windowMs / 1000;

    // Find state from ~1 hour ago
    const oldState = history.find((s) => s.timestamp >= cutoffTime);
    if (!oldState) {
      return null;
    }

    const oldReserve = Number(oldState.reserveBalance);
    const currentReserve = Number(currentState.reserveBalance);

    if (oldReserve === 0) {
      return null;
    } // Avoid division by zero

    const dropPercentage = ((oldReserve - currentReserve) / oldReserve) * 100;

    const alertType = 'reserve_drop';
    const isConditionMet = dropPercentage > this.thresholds.reserveDropPercentage;

    if (isConditionMet) {
      // Only send alert if not already active
      if (!this.isAlertActive(currentState.poolAddress, alertType)) {
        this.setAlertActive(currentState.poolAddress, alertType);
        return {
          type: alertType,
          priority: 'critical',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Reserve dropped ${dropPercentage.toFixed(1)}% in ${windowMs / (60 * 60 * 1000)}h: $${oldState.reserveUSD.toFixed(2)} → $${currentState.reserveUSD.toFixed(2)}`,
          currentState,
          previousState: oldState,
          metadata: {
            dropPercentage,
            oldReserveUSD: oldState.reserveUSD,
            newReserveUSD: currentState.reserveUSD,
          },
        };
      }
    } else {
      // Condition no longer met, clear the alert
      this.clearAlert(currentState.poolAddress, alertType);
    }

    return null;
  }

  /**
   * Check for price volatility
   */
  private checkPriceVolatility(currentState: PoolState, history: PoolState[]): StateAlert | null {
    const oneHourAgo = currentState.timestamp - 3600;
    const oldState = history.find((s) => s.timestamp >= oneHourAgo);
    if (!oldState) {
      return null;
    }

    const oldPrice = Number(oldState.spotPrice);
    const currentPrice = Number(currentState.spotPrice);

    if (oldPrice === 0) {
      return null;
    }

    const changePercentage = Math.abs(((currentPrice - oldPrice) / oldPrice) * 100);

    const alertType = 'price_spike';
    const isConditionMet = changePercentage > this.thresholds.priceChange1hPercentage;

    if (isConditionMet) {
      // Only send alert if not already active
      if (!this.isAlertActive(currentState.poolAddress, alertType)) {
        this.setAlertActive(currentState.poolAddress, alertType);
        return {
          type: alertType,
          priority: 'high',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Price changed ${changePercentage.toFixed(1)}% in 1h: $${oldState.priceUSD.toFixed(6)} → $${currentState.priceUSD.toFixed(6)}`,
          currentState,
          previousState: oldState,
          metadata: {
            changePercentage,
            oldPriceUSD: oldState.priceUSD,
            newPriceUSD: currentState.priceUSD,
          },
        };
      }
    } else {
      // Condition no longer met, clear the alert
      this.clearAlert(currentState.poolAddress, alertType);
    }

    return null;
  }

  /**
   * Check for supply anomalies
   */
  private checkSupplyAnomaly(currentState: PoolState, history: PoolState[]): StateAlert | null {
    const oneHourAgo = currentState.timestamp - 3600;
    const oldState = history.find((s) => s.timestamp >= oneHourAgo);
    if (!oldState) {
      return null;
    }

    const oldSupply = Number(oldState.tokenSupply);
    const currentSupply = Number(currentState.tokenSupply);

    if (oldSupply === 0) {
      return null;
    }

    const changePercentage = Math.abs(((currentSupply - oldSupply) / oldSupply) * 100);

    const alertType = 'supply_anomaly';
    const isConditionMet = changePercentage > this.thresholds.supplyChange1hPercentage;

    if (isConditionMet) {
      // Only send alert if not already active
      if (!this.isAlertActive(currentState.poolAddress, alertType)) {
        this.setAlertActive(currentState.poolAddress, alertType);
        return {
          type: alertType,
          priority: 'high',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Supply changed ${changePercentage.toFixed(1)}% in 1h: ${oldState.supplyFormatted.toFixed(0)} → ${currentState.supplyFormatted.toFixed(0)} tokens`,
          currentState,
          previousState: oldState,
          metadata: {
            changePercentage,
            oldSupply: oldState.supplyFormatted,
            newSupply: currentState.supplyFormatted,
          },
        };
      }
    } else {
      // Condition no longer met, clear the alert
      this.clearAlert(currentState.poolAddress, alertType);
    }

    return null;
  }

  /**
   * Check if actual supply matches expected supply based on bonding curve math
   *
   * This detects:
   * - Unauthorized minting/burning outside AMM
   * - Contract bugs that violate curve invariants
   * - Exploits that manipulate supply/reserve relationship
   *
   * Approach: Validate reserve ratio matches CRR
   * Formula: actualRatio = (reserve * 1e18) / (price * supply)
   * Expected: actualRatio ≈ CRR (within tolerance)
   */
  private checkSupplyInvariant(currentState: PoolState, poolConfig: PoolConfig): StateAlert | null {
    const { pricingPhase, reserveBalance, tokenSupply, spotPrice } = currentState;
    const { crr } = poolConfig;
    const alertType = 'true_supply_mismatch';

    // Skip check if essential values are zero (pool not initialized yet)
    if (reserveBalance === 0n || tokenSupply === 0n || spotPrice === 0n) {
      this.clearAlert(currentState.poolAddress, alertType);
      return null;
    }

    if (pricingPhase === 0 || !currentState.curveSupply) {
      this.clearAlert(currentState.poolAddress, alertType);
      return null;
    }
    const expectedRatio = currentState.expectedReserveRatio ?? crr / 1_000_000;
    const actualRatio = currentState.reserveRatio; // Already calculated in PoolState

    // Tolerance: 5% deviation allowed
    // This accounts for:
    // - Rounding in power function calculations
    // - Small precision losses in fixed-point math
    // - Fee accumulation edge cases
    const tolerance = Math.max(0.05, 1 / Number(spotPrice));

    const deviation = Math.abs(actualRatio - expectedRatio) / expectedRatio;

    if (deviation > tolerance) {
      // Only send alert if not already active
      if (!this.isAlertActive(currentState.poolAddress, alertType)) {
        this.setAlertActive(currentState.poolAddress, alertType);
        logger.warn(`Supply invariant violation detected for ${currentState.modelId}`, {
          expectedRatio,
          actualRatio,
          deviationPercent: (deviation * 100).toFixed(2),
          reserveUSD: currentState.reserveUSD,
          supplyFormatted: currentState.supplyFormatted,
          priceUSD: currentState.priceUSD,
        });

        return {
          type: alertType,
          priority: 'critical',
          poolAddress: currentState.poolAddress,
          modelId: currentState.modelId,
          message: `Supply/reserve ratio deviates from bonding curve: actual ${actualRatio.toFixed(4)} vs expected ${expectedRatio.toFixed(4)} (${(deviation * 100).toFixed(1)}% deviation). Curve pricing/accounting inconsistency detected.`,
          currentState,
          metadata: {
            expectedRatio,
            actualRatio,
            deviationPercent: deviation * 100,
            crr,
            reserveBalance: reserveBalance.toString(),
            tokenSupply: tokenSupply.toString(),
            spotPrice: spotPrice.toString(),
          },
        };
      }
    } else {
      // Condition no longer met, clear the alert
      this.clearAlert(currentState.poolAddress, alertType);
    }

    // Invariant validated
    logger.debug(`Supply invariant OK for ${currentState.modelId}`, {
      expectedRatio: expectedRatio.toFixed(4),
      actualRatio: actualRatio.toFixed(4),
      deviation: (deviation * 100).toFixed(2) + '%',
    });

    return null;
  }

  /**
   * Get USDC address (helper method, should come from config)
   */
  private async getUSDCAddress(_poolConfig: PoolConfig): Promise<string> {
    // This should be passed from config, hardcoding for now
    // Mainnet USDC: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
    // This will be provided by monitoring config
    const chainId = (await this.provider.getNetwork()).chainId;
    return chainId === 1n
      ? '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
      : '0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3'; // Sepolia MockUSDC
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
   * Get overall tracking status
   */
  getIsTracking(): boolean {
    return this.isTracking;
  }

  /**
   * Get number of tracked pools
   */
  getTrackedPoolCount(): number {
    return this.pollingIntervals.size;
  }

  /**
   * Get suppressed alert statistics
   */
  getSuppressedAlertStats() {
    return {
      total: this.suppressedAlertCount,
      byType: Object.fromEntries(this.suppressedAlertsByType),
    };
  }
}
