import { ethers } from 'ethers';
import { logger } from '../utils/logger';
import { AlertManager } from './alert-manager';

/**
 * Cost Reconciliation Service
 *
 * Tracks actual infrastructure costs, compares to on-chain estimates,
 * and generates cost adjustment recommendations for governance.
 *
 * Scheduled Tasks (monthly, aligned with price epochs):
 * 1. Cost Ingestion - Read actual costs and record on-chain
 * 2. Variance Analysis - Compare actual vs estimated, calculate variance
 * 3. Adjustment Proposal - Generate governance proposals when variance > threshold
 * 4. Dashboard Data - Expose metrics via API endpoints
 */

export interface ActualCost {
  modelId: string;
  provider: string;
  amount: number;           // USD amount
  period: {
    start: Date;
    end: Date;
  };
  invoiceId?: string;
  metadata?: Record<string, any>;
}

export interface CostVariance {
  modelId: string;
  period: {
    start: Date;
    end: Date;
  };
  actual: number;           // Actual cost in USD
  estimated: number;        // Estimated cost in USD
  variance: number;         // Variance in USD (actual - estimated)
  variancePercent: number;  // Variance as percentage
  callCount?: number;       // Number of API calls in period
  actualCostPerCall?: number;
  estimatedCostPerCall?: number;
}

export interface CostAdjustmentRecommendation {
  modelId: string;
  currentEstimate: number;  // Current estimated cost per 1000 calls (USD)
  recommendedEstimate: number; // Recommended new estimate (USD)
  adjustmentPercent: number;
  variance: CostVariance;
  rationale: string;
  timestamp: Date;
}

export interface RunwayMetrics {
  modelId: string;
  currentBalance: number;   // Current accrued balance (USD)
  dailyBurnRate: number;    // Current daily cost (USD)
  runwayDays: number;       // Days until balance depleted
  projectedDepletionDate: Date;
  status: 'healthy' | 'warning' | 'critical';
}

export interface ReconciliationAlert {
  type: 'high_variance' | 'critical_variance' | 'runway_warning' | 'runway_critical' | 'cost_spike';
  priority: 'critical' | 'high' | 'medium';
  modelId: string;
  message: string;
  metadata: Record<string, any>;
}

export interface CostReconciliationConfig {
  provider: ethers.Provider;
  infraReserveAddress: string;
  // Note: Oracle address will be available after Issue #1 is implemented
  infraCostOracleAddress?: string;
  alertManager?: AlertManager;

  // Thresholds
  varianceWarningPercent: number;   // Default: 10%
  varianceCriticalPercent: number;  // Default: 20%
  runwayWarningDays: number;        // Default: 7
  runwayCriticalDays: number;       // Default: 3

  // Scheduling
  reconciliationIntervalMs: number; // Default: daily (86400000ms)
}

/**
 * Cost Reconciliation Service
 *
 * NOTE: This service assumes future contract methods that will be added:
 * - InfrastructureReserve.recordActualCosts() - from Issue #4
 * - InfrastructureCostOracle.getCurrentEstimate() - from Issue #1
 * - InfrastructureCostOracle.suggestCostAdjustment() - from Issue #1
 *
 * These placeholders allow the service to be built and tested independently.
 */
export class CostReconciliationService {
  private config: CostReconciliationConfig;
  private infraReserveContract?: ethers.Contract;
  private infraCostOracleContract?: ethers.Contract;

  // State tracking
  private costHistory: Map<string, ActualCost[]> = new Map();
  private varianceHistory: Map<string, CostVariance[]> = new Map();
  private recommendations: Map<string, CostAdjustmentRecommendation[]> = new Map();

  private reconciliationInterval?: NodeJS.Timeout;
  private isRunning: boolean = false;

  // Contract ABIs (placeholders for future implementation)
  private static readonly INFRA_RESERVE_ABI = [
    'function accrued(string modelId) view returns (uint256)',
    'function paid(string modelId) view returns (uint256)',
    'function getModelAccounting(string modelId) view returns (uint256 accruedAmount, uint256 paidAmount, address currentProvider)',
    // Future method from Issue #4:
    // 'function recordActualCosts(string modelId, uint256 amount, bytes32 invoiceHash, string memo) external',
  ];

  private static readonly INFRA_COST_ORACLE_ABI = [
    // Future methods from Issue #1:
    // 'function getCurrentEstimate(string modelId) view returns (uint256 costPerThousandCalls)',
    // 'function getVariance(string modelId) view returns (int256 variance, uint256 actualCost, uint256 estimatedCost)',
    // 'function suggestCostAdjustment(string modelId) view returns (uint256 newEstimate, int256 variance)',
  ];

  constructor(config: CostReconciliationConfig) {
    this.config = config;

    // Initialize Infrastructure Reserve contract
    this.infraReserveContract = new ethers.Contract(
      config.infraReserveAddress,
      CostReconciliationService.INFRA_RESERVE_ABI,
      config.provider
    );

    // Initialize Cost Oracle contract (if available)
    if (config.infraCostOracleAddress) {
      this.infraCostOracleContract = new ethers.Contract(
        config.infraCostOracleAddress,
        CostReconciliationService.INFRA_COST_ORACLE_ABI,
        config.provider
      );
    }

    logger.info('CostReconciliationService initialized', {
      infraReserveAddress: config.infraReserveAddress,
      infraCostOracleAddress: config.infraCostOracleAddress,
      varianceWarningPercent: config.varianceWarningPercent,
      reconciliationIntervalMs: config.reconciliationIntervalMs
    });
  }

  /**
   * Start the reconciliation service
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('CostReconciliationService already running');
      return;
    }

    logger.info('Starting CostReconciliationService...');

    // Run initial reconciliation
    await this.runReconciliation();

    // Schedule periodic reconciliation
    this.reconciliationInterval = setInterval(async () => {
      try {
        await this.runReconciliation();
      } catch (error) {
        logger.error('Error during scheduled reconciliation:', error);
      }
    }, this.config.reconciliationIntervalMs);

    this.isRunning = true;
    logger.info('CostReconciliationService started successfully');
  }

  /**
   * Stop the reconciliation service
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    logger.info('Stopping CostReconciliationService...');

    if (this.reconciliationInterval) {
      clearInterval(this.reconciliationInterval);
      this.reconciliationInterval = undefined;
    }

    this.isRunning = false;
    logger.info('CostReconciliationService stopped');
  }

  /**
   * Run full reconciliation cycle
   */
  private async runReconciliation(): Promise<void> {
    logger.info('Running cost reconciliation cycle...');

    try {
      // Get all models being tracked
      const modelIds = Array.from(this.costHistory.keys());

      if (modelIds.length === 0) {
        logger.info('No models to reconcile');
        return;
      }

      for (const modelId of modelIds) {
        await this.reconcileModel(modelId);
      }

      logger.info(`Reconciliation complete for ${modelIds.length} models`);
    } catch (error) {
      logger.error('Error during reconciliation:', error);
      throw error;
    }
  }

  /**
   * Reconcile costs for a specific model
   */
  private async reconcileModel(modelId: string): Promise<void> {
    try {
      // Calculate variance
      const variance = await this.calculateVariance(modelId);

      if (!variance) {
        logger.debug(`No variance data for ${modelId}`);
        return;
      }

      // Store variance
      this.storeVariance(modelId, variance);

      // Check if adjustment needed
      if (Math.abs(variance.variancePercent) >= this.config.varianceWarningPercent) {
        const recommendation = await this.generateAdjustmentRecommendation(modelId, variance);
        this.storeRecommendation(modelId, recommendation);

        // Send alerts
        await this.checkVarianceAlerts(modelId, variance);
      }

      // Check runway
      const runway = await this.calculateRunway(modelId);
      if (runway) {
        await this.checkRunwayAlerts(modelId, runway);
      }

    } catch (error) {
      logger.error(`Error reconciling model ${modelId}:`, error);
    }
  }

  /**
   * Ingest actual costs for a model
   *
   * This method accepts manual cost data (CSV/API input) and stores it
   * for later reconciliation and on-chain recording.
   */
  async ingestActualCosts(cost: ActualCost): Promise<void> {
    logger.info(`Ingesting actual costs for ${cost.modelId}`, {
      amount: cost.amount,
      period: cost.period,
      provider: cost.provider
    });

    // Store cost record
    if (!this.costHistory.has(cost.modelId)) {
      this.costHistory.set(cost.modelId, []);
    }
    this.costHistory.get(cost.modelId)!.push(cost);

    // Keep last 12 months of history
    const history = this.costHistory.get(cost.modelId)!;
    if (history.length > 12) {
      history.shift();
    }

    logger.info(`Cost ingested successfully for ${cost.modelId}`);
  }

  /**
   * Record actual costs on-chain
   *
   * NOTE: This requires InfrastructureReserve.recordActualCosts() from Issue #4
   * Currently a placeholder that will be implemented when the contract method is available.
   */
  async recordActualCostsOnChain(
    modelId: string,
    amount: number,
    invoiceHash: string,
    memo: string
  ): Promise<void> {
    logger.info(`Recording actual costs on-chain for ${modelId}`, {
      amount,
      invoiceHash,
      memo
    });

    // TODO: Implement when InfrastructureReserve.recordActualCosts() is available
    // const amountWei = ethers.parseUnits(amount.toString(), 6);
    // const tx = await this.infraReserveContract!.recordActualCosts(
    //   modelId,
    //   amountWei,
    //   ethers.id(invoiceHash),
    //   memo
    // );
    // await tx.wait();

    logger.warn('recordActualCostsOnChain not yet implemented - requires Issue #4');
  }

  /**
   * Calculate variance between actual and estimated costs
   *
   * NOTE: This uses placeholder logic. Will integrate with InfrastructureCostOracle
   * when Issue #1 is implemented.
   */
  private async calculateVariance(modelId: string): Promise<CostVariance | null> {
    const recentCosts = this.getRecentCosts(modelId, 30); // Last 30 days

    if (recentCosts.length === 0) {
      return null;
    }

    const actual = recentCosts.reduce((sum, c) => sum + c.amount, 0);

    // TODO: Get estimated cost from InfrastructureCostOracle when available
    // For now, use a placeholder estimation based on historical data
    const estimated = actual * 0.95; // Placeholder: assume 5% underestimate

    const variance = actual - estimated;
    const variancePercent = (variance / estimated) * 100;

    const period = {
      start: recentCosts[0].period.start,
      end: recentCosts[recentCosts.length - 1].period.end
    };

    return {
      modelId,
      period,
      actual,
      estimated,
      variance,
      variancePercent
    };
  }

  /**
   * Generate cost adjustment recommendation
   */
  private async generateAdjustmentRecommendation(
    modelId: string,
    variance: CostVariance
  ): Promise<CostAdjustmentRecommendation> {
    // TODO: Use InfrastructureCostOracle.suggestCostAdjustment() when available

    // Placeholder logic: adjust estimate proportionally to variance
    const currentEstimate = variance.estimated;
    const recommendedEstimate = variance.actual; // Use actual as new estimate
    const adjustmentPercent = variance.variancePercent;

    const rationale = variance.variancePercent > 0
      ? `Actual costs ${variance.variancePercent.toFixed(1)}% above estimate. Recommend increasing estimate from $${currentEstimate.toFixed(2)} to $${recommendedEstimate.toFixed(2)} per period.`
      : `Actual costs ${Math.abs(variance.variancePercent).toFixed(1)}% below estimate. Recommend decreasing estimate from $${currentEstimate.toFixed(2)} to $${recommendedEstimate.toFixed(2)} per period.`;

    return {
      modelId,
      currentEstimate,
      recommendedEstimate,
      adjustmentPercent,
      variance,
      rationale,
      timestamp: new Date()
    };
  }

  /**
   * Calculate runway metrics for a model
   */
  private async calculateRunway(modelId: string): Promise<RunwayMetrics | null> {
    try {
      if (!this.infraReserveContract) {
        return null;
      }

      // Get current accrued balance
      const [accruedAmount, , ] = await this.infraReserveContract.getModelAccounting(modelId);
      const currentBalance = Number(ethers.formatUnits(accruedAmount, 6));

      // Calculate daily burn rate from recent costs
      const recentCosts = this.getRecentCosts(modelId, 30);
      if (recentCosts.length === 0) {
        return null;
      }

      const totalCost = recentCosts.reduce((sum, c) => sum + c.amount, 0);
      const dailyBurnRate = totalCost / 30; // Average over 30 days

      if (dailyBurnRate === 0) {
        return null;
      }

      const runwayDays = currentBalance / dailyBurnRate;
      const projectedDepletionDate = new Date();
      projectedDepletionDate.setDate(projectedDepletionDate.getDate() + runwayDays);

      let status: 'healthy' | 'warning' | 'critical';
      if (runwayDays < this.config.runwayCriticalDays) {
        status = 'critical';
      } else if (runwayDays < this.config.runwayWarningDays) {
        status = 'warning';
      } else {
        status = 'healthy';
      }

      return {
        modelId,
        currentBalance,
        dailyBurnRate,
        runwayDays,
        projectedDepletionDate,
        status
      };
    } catch (error) {
      logger.error(`Error calculating runway for ${modelId}:`, error);
      return null;
    }
  }

  /**
   * Check and send variance alerts
   */
  private async checkVarianceAlerts(modelId: string, variance: CostVariance): Promise<void> {
    const absVariance = Math.abs(variance.variancePercent);

    if (absVariance >= this.config.varianceCriticalPercent) {
      await this.sendAlert({
        type: 'critical_variance',
        priority: 'critical',
        modelId,
        message: `CRITICAL: Cost variance ${variance.variancePercent.toFixed(1)}% for ${modelId} (threshold: ${this.config.varianceCriticalPercent}%)`,
        metadata: {
          variance: variance.variance,
          variancePercent: variance.variancePercent,
          actual: variance.actual,
          estimated: variance.estimated,
          threshold: this.config.varianceCriticalPercent
        }
      });
    } else if (absVariance >= this.config.varianceWarningPercent) {
      await this.sendAlert({
        type: 'high_variance',
        priority: 'high',
        modelId,
        message: `High cost variance ${variance.variancePercent.toFixed(1)}% for ${modelId} (threshold: ${this.config.varianceWarningPercent}%)`,
        metadata: {
          variance: variance.variance,
          variancePercent: variance.variancePercent,
          actual: variance.actual,
          estimated: variance.estimated,
          threshold: this.config.varianceWarningPercent
        }
      });
    }
  }

  /**
   * Check and send runway alerts
   */
  private async checkRunwayAlerts(modelId: string, runway: RunwayMetrics): Promise<void> {
    if (runway.status === 'critical') {
      await this.sendAlert({
        type: 'runway_critical',
        priority: 'critical',
        modelId,
        message: `CRITICAL: Infrastructure runway < ${this.config.runwayCriticalDays} days for ${modelId} (${runway.runwayDays.toFixed(1)} days remaining)`,
        metadata: {
          runwayDays: runway.runwayDays,
          currentBalance: runway.currentBalance,
          dailyBurnRate: runway.dailyBurnRate,
          projectedDepletionDate: runway.projectedDepletionDate.toISOString(),
          threshold: this.config.runwayCriticalDays
        }
      });
    } else if (runway.status === 'warning') {
      await this.sendAlert({
        type: 'runway_warning',
        priority: 'high',
        modelId,
        message: `Infrastructure runway low for ${modelId}: ${runway.runwayDays.toFixed(1)} days remaining`,
        metadata: {
          runwayDays: runway.runwayDays,
          currentBalance: runway.currentBalance,
          dailyBurnRate: runway.dailyBurnRate,
          projectedDepletionDate: runway.projectedDepletionDate.toISOString(),
          threshold: this.config.runwayWarningDays,
          recommendation: 'Consider replenishing infrastructure reserve'
        }
      });
    }
  }

  /**
   * Send alert via AlertManager
   */
  private async sendAlert(alert: ReconciliationAlert): Promise<void> {
    logger.info(`Reconciliation alert: ${alert.type}`, {
      modelId: alert.modelId,
      priority: alert.priority,
      message: alert.message
    });

    // Send via AlertManager if configured
    if (this.config.alertManager) {
      // Convert to AlertManager format
      await this.config.alertManager.sendAlert({
        type: alert.type,
        priority: alert.priority,
        message: alert.message,
        poolAddress: alert.modelId, // Use modelId as identifier
        metadata: alert.metadata,
        timestamp: Date.now()
      } as any); // Type assertion due to different alert interfaces
    }
  }

  // ============================================================
  // DATA ACCESS METHODS (for API endpoints)
  // ============================================================

  /**
   * Get variance history for a model
   */
  getVarianceHistory(modelId: string, limit?: number): CostVariance[] {
    const history = this.varianceHistory.get(modelId) || [];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get current variance for a model
   */
  getCurrentVariance(modelId: string): CostVariance | undefined {
    const history = this.varianceHistory.get(modelId);
    return history && history.length > 0 ? history[history.length - 1] : undefined;
  }

  /**
   * Get adjustment recommendations for a model
   */
  getRecommendations(modelId: string, limit?: number): CostAdjustmentRecommendation[] {
    const recs = this.recommendations.get(modelId) || [];
    return limit ? recs.slice(-limit) : recs;
  }

  /**
   * Get latest recommendation for a model
   */
  getLatestRecommendation(modelId: string): CostAdjustmentRecommendation | undefined {
    const recs = this.recommendations.get(modelId);
    return recs && recs.length > 0 ? recs[recs.length - 1] : undefined;
  }

  /**
   * Get cost history for a model
   */
  getCostHistory(modelId: string, limit?: number): ActualCost[] {
    const history = this.costHistory.get(modelId) || [];
    return limit ? history.slice(-limit) : history;
  }

  /**
   * Get recent costs (last N days)
   */
  private getRecentCosts(modelId: string, days: number): ActualCost[] {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const history = this.costHistory.get(modelId) || [];
    return history.filter(c => c.period.end >= cutoffDate);
  }

  /**
   * Get all models being tracked
   */
  getTrackedModels(): string[] {
    return Array.from(this.costHistory.keys());
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      modelsTracked: this.costHistory.size,
      models: this.getTrackedModels(),
      config: {
        varianceWarningPercent: this.config.varianceWarningPercent,
        varianceCriticalPercent: this.config.varianceCriticalPercent,
        runwayWarningDays: this.config.runwayWarningDays,
        runwayCriticalDays: this.config.runwayCriticalDays,
        reconciliationIntervalMs: this.config.reconciliationIntervalMs
      }
    };
  }

  // ============================================================
  // PRIVATE HELPER METHODS
  // ============================================================

  private storeVariance(modelId: string, variance: CostVariance): void {
    if (!this.varianceHistory.has(modelId)) {
      this.varianceHistory.set(modelId, []);
    }
    this.varianceHistory.get(modelId)!.push(variance);

    // Keep last 12 months
    const history = this.varianceHistory.get(modelId)!;
    if (history.length > 12) {
      history.shift();
    }
  }

  private storeRecommendation(modelId: string, recommendation: CostAdjustmentRecommendation): void {
    if (!this.recommendations.has(modelId)) {
      this.recommendations.set(modelId, []);
    }
    this.recommendations.get(modelId)!.push(recommendation);

    // Keep last 12 recommendations
    const recs = this.recommendations.get(modelId)!;
    if (recs.length > 12) {
      recs.shift();
    }
  }
}
