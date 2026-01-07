/**
 * TypeScript type definitions for DeltaOne simulation tool
 */

export interface Metrics {
  accuracy: number;   // In basis points (10000 = 100%)
  precision: number;  // In basis points
  recall: number;     // In basis points
  f1: number;        // In basis points
  auroc: number;     // In basis points
}

export interface EvaluationData {
  pipelineRunId: string;
  baselineMetrics: Metrics;
  newMetrics: Metrics;
  contributor: string;
  contributorWeight: number;  // In basis points (10000 = 100%)
  contributedSamples: number;
  totalSamples: number;
}

export interface MetricBreakdown {
  baseline: number;      // Percentage (e.g., 85.4)
  new: number;          // Percentage (e.g., 88.4)
  improvement: number;  // Percentage points (e.g., 3.0)
}

export interface SimulationResult {
  simulation: {
    deltaOneScore: number;          // In basis points
    deltaOnePercentage: string;     // Formatted percentage (e.g., "3.87%")
    rewardAmount: string;           // Token amount as string
    rewardFormatted: string;        // With thousands separators
    breakdown: {
      accuracy: MetricBreakdown;
      precision: MetricBreakdown;
      recall: MetricBreakdown;
      f1: MetricBreakdown;
      auroc: MetricBreakdown;
    };
    parameters: {
      tokensPerDeltaOne: number;
      contributorWeight: string;     // Formatted percentage
      contributedSamples: number;
      totalSamples: number;
      contributionRatio: string;     // Formatted percentage
    };
  };
  metadata: {
    modelId: string;
    pipelineRunId: string;
    contributor: string;
    network: string;
    timestamp: string;
  };
  status: 'simulated' | 'executed' | 'error';
}

export interface ExecutionResult extends SimulationResult {
  execution: {
    txHash: string;
    blockNumber: number;
    gasUsed: string;
    status: 'success' | 'failed';
    tokensMinted: string;
    recipient: string;
    explorerUrl: string;
  };
}

export interface ErrorResult {
  error: {
    code: string;
    message: string;
    details: Record<string, any>;
  };
  simulation?: Partial<SimulationResult['simulation']>;
  status: 'error';
}

export interface SimulatorConfig {
  rpcUrl: string;
  deltaVerifierAddress: string;
  tokenManagerAddress: string;
  network: 'sepolia' | 'mainnet';
}

export interface ExecutorConfig extends SimulatorConfig {
  privateKey?: string;
  useMetaMask?: boolean;
}
