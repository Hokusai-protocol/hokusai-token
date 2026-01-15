import { logger } from '../utils/logger';
import { TradeEvent, FeeEvent } from './event-listener';
import { PoolState } from './state-tracker';

/**
 * Metrics Collector
 *
 * Collects and aggregates metrics from pool state and events:
 * - Per-pool metrics (volume, trades, unique traders, fees)
 * - System-wide metrics (TVL, total volume, total fees)
 * - Time-based metrics (24h volume, 1h volume)
 *
 * Stores metrics in memory (Phase 1). Can be extended to persist to DB.
 */

export interface PoolMetrics {
  poolAddress: string;
  modelId: string;

  // Trading activity
  totalBuyVolume: number;          // Cumulative buy volume in USD
  totalSellVolume: number;         // Cumulative sell volume in USD
  totalTradeCount: number;         // Total number of trades
  buyCount: number;                // Number of buy trades
  sellCount: number;               // Number of sell trades

  // Trader analytics
  uniqueTraders: Set<string>;      // Unique trader addresses
  uniqueTraderCount: number;       // Cached count

  // Fee metrics
  totalFeesCollected: number;      // Total fees in USD
  totalFeesDeposited: number;      // Total fees deposited to pool

  // Recent activity (24h rolling window)
  volume24h: number;               // 24h trading volume
  trades24h: number;               // 24h trade count
  uniqueTraders24h: Set<string>;   // 24h unique traders

  // Current state (from last state update)
  currentReserveUSD: number;
  currentPriceUSD: number;
  currentSupply: number;
  currentMarketCapUSD: number;

  // Timestamps
  firstTradeTime?: number;         // First trade timestamp
  lastTradeTime?: number;          // Last trade timestamp
  lastUpdateTime: number;          // Last metrics update
}

export interface SystemMetrics {
  // Aggregate metrics across all pools
  totalTVL: number;                // Total value locked (sum of all reserves)
  totalVolume24h: number;          // 24h volume across all pools
  totalTrades24h: number;          // 24h trades across all pools
  totalPoolCount: number;          // Number of active pools
  totalUniqueTraders24h: number;   // Unique traders across all pools (24h)
  totalFeesCollected24h: number;   // Total fees collected (24h)

  // Per-pool breakdown
  poolMetrics: Map<string, PoolMetrics>;

  // Timestamps
  lastUpdateTime: number;
}

interface TradeRecord {
  timestamp: number;
  volumeUSD: number;
  trader: string;
  type: 'buy' | 'sell';
}

export class MetricsCollector {
  private poolMetrics: Map<string, PoolMetrics> = new Map();
  private recentTrades: Map<string, TradeRecord[]> = new Map(); // poolAddress -> trades
  private readonly trade24hWindowMs = 24 * 60 * 60 * 1000; // 24 hours

  constructor() {
    // Start cleanup interval for old trades (every hour)
    setInterval(() => {
      this.cleanupOldTrades();
    }, 60 * 60 * 1000);
  }

  /**
   * Initialize metrics for a new pool
   */
  initializePool(poolAddress: string, modelId: string): void {
    if (this.poolMetrics.has(poolAddress)) {
      logger.warn(`Metrics already initialized for pool ${poolAddress}`);
      return;
    }

    const metrics: PoolMetrics = {
      poolAddress,
      modelId,
      totalBuyVolume: 0,
      totalSellVolume: 0,
      totalTradeCount: 0,
      buyCount: 0,
      sellCount: 0,
      uniqueTraders: new Set(),
      uniqueTraderCount: 0,
      totalFeesCollected: 0,
      totalFeesDeposited: 0,
      volume24h: 0,
      trades24h: 0,
      uniqueTraders24h: new Set(),
      currentReserveUSD: 0,
      currentPriceUSD: 0,
      currentSupply: 0,
      currentMarketCapUSD: 0,
      lastUpdateTime: Date.now()
    };

    this.poolMetrics.set(poolAddress, metrics);
    this.recentTrades.set(poolAddress, []);

    logger.info(`Metrics initialized for ${modelId} (${poolAddress})`);
  }

  /**
   * Record a trade event
   */
  recordTrade(event: TradeEvent): void {
    let metrics = this.poolMetrics.get(event.poolAddress);
    if (!metrics) {
      logger.warn(`Metrics not initialized for pool ${event.poolAddress}, initializing now`);
      this.initializePool(event.poolAddress, event.modelId);
      metrics = this.poolMetrics.get(event.poolAddress)!;
    }

    // Update cumulative metrics
    if (event.type === 'buy') {
      metrics.totalBuyVolume += event.reserveAmountUSD;
      metrics.buyCount++;
    } else {
      metrics.totalSellVolume += event.reserveAmountUSD;
      metrics.sellCount++;
    }

    metrics.totalTradeCount++;
    metrics.totalFeesCollected += event.feeAmountUSD;
    metrics.uniqueTraders.add(event.trader);
    metrics.uniqueTraderCount = metrics.uniqueTraders.size;

    // Update timestamps
    if (!metrics.firstTradeTime) {
      metrics.firstTradeTime = event.timestamp;
    }
    metrics.lastTradeTime = event.timestamp;
    metrics.lastUpdateTime = Date.now();

    // Update recent trades
    const tradeRecord: TradeRecord = {
      timestamp: event.timestamp,
      volumeUSD: event.reserveAmountUSD,
      trader: event.trader,
      type: event.type
    };

    const trades = this.recentTrades.get(event.poolAddress) || [];
    trades.push(tradeRecord);
    this.recentTrades.set(event.poolAddress, trades);

    // Recalculate 24h metrics
    this.update24hMetrics(event.poolAddress);

    logger.debug(`Trade recorded for ${metrics.modelId}: ${event.type} $${event.reserveAmountUSD.toFixed(2)}`);
  }

  /**
   * Record a fee deposit event
   */
  recordFeeDeposit(event: FeeEvent): void {
    let metrics = this.poolMetrics.get(event.poolAddress);
    if (!metrics) {
      logger.warn(`Metrics not initialized for pool ${event.poolAddress}`);
      this.initializePool(event.poolAddress, event.modelId);
      metrics = this.poolMetrics.get(event.poolAddress)!;
    }

    metrics.totalFeesDeposited += event.amountUSD;
    metrics.lastUpdateTime = Date.now();

    logger.debug(`Fee deposit recorded for ${metrics.modelId}: $${event.amountUSD.toFixed(2)}`);
  }

  /**
   * Update pool metrics from state
   */
  updatePoolState(state: PoolState): void {
    let metrics = this.poolMetrics.get(state.poolAddress);
    if (!metrics) {
      logger.warn(`Metrics not initialized for pool ${state.poolAddress}`);
      this.initializePool(state.poolAddress, state.modelId);
      metrics = this.poolMetrics.get(state.poolAddress)!;
    }

    metrics.currentReserveUSD = state.reserveUSD;
    metrics.currentPriceUSD = state.priceUSD;
    metrics.currentSupply = state.supplyFormatted;
    metrics.currentMarketCapUSD = state.marketCapUSD;
    metrics.lastUpdateTime = Date.now();
  }

  /**
   * Update 24h metrics for a pool
   */
  private update24hMetrics(poolAddress: string): void {
    const metrics = this.poolMetrics.get(poolAddress);
    if (!metrics) return;

    const trades = this.recentTrades.get(poolAddress) || [];
    const now = Date.now() / 1000; // Convert to seconds
    const cutoff = now - (this.trade24hWindowMs / 1000);

    // Filter trades from last 24h
    const recent = trades.filter(t => t.timestamp >= cutoff);

    // Calculate 24h metrics
    metrics.volume24h = recent.reduce((sum, t) => sum + t.volumeUSD, 0);
    metrics.trades24h = recent.length;

    metrics.uniqueTraders24h = new Set(recent.map(t => t.trader));

    logger.debug(`24h metrics updated for ${metrics.modelId}: $${metrics.volume24h.toFixed(2)} volume, ${metrics.trades24h} trades`);
  }

  /**
   * Cleanup old trades (>24h)
   */
  private cleanupOldTrades(): void {
    const now = Date.now() / 1000;
    const cutoff = now - (this.trade24hWindowMs / 1000);

    for (const [poolAddress, trades] of this.recentTrades) {
      const filtered = trades.filter(t => t.timestamp >= cutoff);
      this.recentTrades.set(poolAddress, filtered);

      logger.debug(`Cleaned up old trades for pool ${poolAddress}: ${trades.length - filtered.length} removed`);
    }
  }

  /**
   * Get metrics for a specific pool
   */
  getPoolMetrics(poolAddress: string): PoolMetrics | undefined {
    return this.poolMetrics.get(poolAddress);
  }

  /**
   * Get system-wide metrics
   */
  getSystemMetrics(): SystemMetrics {
    let totalTVL = 0;
    let totalVolume24h = 0;
    let totalTrades24h = 0;
    let totalFeesCollected24h = 0;
    const allTraders24h = new Set<string>();

    // Aggregate metrics from all pools
    for (const metrics of this.poolMetrics.values()) {
      totalTVL += metrics.currentReserveUSD;
      totalVolume24h += metrics.volume24h;
      totalTrades24h += metrics.trades24h;

      // Add unique traders (24h)
      metrics.uniqueTraders24h.forEach(trader => allTraders24h.add(trader));

      // Calculate 24h fees (approximate from recent trades)
      const trades = this.recentTrades.get(metrics.poolAddress) || [];
      const now = Date.now() / 1000;
      const cutoff = now - (this.trade24hWindowMs / 1000);
      const recent24hTrades = trades.filter(t => t.timestamp >= cutoff);

      // Assume fee rate from total fees / total volume (rough approximation)
      const feeRate = metrics.totalTradeCount > 0 ?
        metrics.totalFeesCollected / (metrics.totalBuyVolume + metrics.totalSellVolume) :
        0;

      const volume24h = recent24hTrades.reduce((sum, t) => sum + t.volumeUSD, 0);
      totalFeesCollected24h += volume24h * feeRate;
    }

    return {
      totalTVL,
      totalVolume24h,
      totalTrades24h,
      totalPoolCount: this.poolMetrics.size,
      totalUniqueTraders24h: allTraders24h.size,
      totalFeesCollected24h,
      poolMetrics: this.poolMetrics,
      lastUpdateTime: Date.now()
    };
  }

  /**
   * Get all pool metrics as array
   */
  getAllPoolMetrics(): PoolMetrics[] {
    return Array.from(this.poolMetrics.values());
  }

  /**
   * Get metrics summary for logging
   */
  getMetricsSummary(): string {
    const systemMetrics = this.getSystemMetrics();

    let summary = '\n' + '='.repeat(70);
    summary += '\nHokusai AMM Metrics Summary\n';
    summary += '='.repeat(70) + '\n';
    summary += `Total TVL:              $${systemMetrics.totalTVL.toLocaleString()}\n`;
    summary += `24h Volume:             $${systemMetrics.totalVolume24h.toLocaleString()}\n`;
    summary += `24h Trades:             ${systemMetrics.totalTrades24h}\n`;
    summary += `24h Unique Traders:     ${systemMetrics.totalUniqueTraders24h}\n`;
    summary += `24h Fees Collected:     $${systemMetrics.totalFeesCollected24h.toLocaleString()}\n`;
    summary += `Active Pools:           ${systemMetrics.totalPoolCount}\n`;
    summary += '='.repeat(70) + '\n';

    // Per-pool breakdown
    summary += 'Per-Pool Metrics:\n';
    for (const metrics of this.getAllPoolMetrics()) {
      summary += `\n  ${metrics.modelId}:\n`;
      summary += `    Reserve:        $${metrics.currentReserveUSD.toLocaleString()}\n`;
      summary += `    Price:          $${metrics.currentPriceUSD.toFixed(6)}\n`;
      summary += `    Market Cap:     $${metrics.currentMarketCapUSD.toLocaleString()}\n`;
      summary += `    Total Trades:   ${metrics.totalTradeCount} (${metrics.buyCount} buys, ${metrics.sellCount} sells)\n`;
      summary += `    Total Volume:   $${(metrics.totalBuyVolume + metrics.totalSellVolume).toLocaleString()}\n`;
      summary += `    24h Volume:     $${metrics.volume24h.toLocaleString()}\n`;
      summary += `    24h Trades:     ${metrics.trades24h}\n`;
      summary += `    Unique Traders: ${metrics.uniqueTraderCount} (all-time), ${metrics.uniqueTraders24h.size} (24h)\n`;
      summary += `    Fees Collected: $${metrics.totalFeesCollected.toLocaleString()}\n`;
    }

    summary += '='.repeat(70) + '\n';

    return summary;
  }

  /**
   * Reset metrics for a pool (useful for testing)
   */
  resetPoolMetrics(poolAddress: string): void {
    const metrics = this.poolMetrics.get(poolAddress);
    if (metrics) {
      this.poolMetrics.delete(poolAddress);
      this.recentTrades.delete(poolAddress);
      logger.info(`Metrics reset for pool ${poolAddress}`);
    }
  }

  /**
   * Reset all metrics
   */
  resetAllMetrics(): void {
    this.poolMetrics.clear();
    this.recentTrades.clear();
    logger.info('All metrics reset');
  }
}
