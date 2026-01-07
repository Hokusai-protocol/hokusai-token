/**
 * Core simulation logic - read-only DeltaOne calculations
 */

import { ethers } from 'ethers';
import {
  Metrics,
  EvaluationData,
  SimulationResult,
  ErrorResult,
  SimulatorConfig
} from './types';
import {
  formatPercentage,
  formatTokenAmount,
  formatTokenAmountWithCommas,
  createMetricsBreakdown,
  formatWithCommas,
  bpsToPercentage
} from './formatters';
import DeltaVerifierABI from '../abis/DeltaVerifier.json';

export class Simulator {
  private provider: ethers.Provider;
  private deltaVerifier: ethers.Contract;
  private config: SimulatorConfig;

  constructor(config: SimulatorConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.deltaVerifier = new ethers.Contract(
      config.deltaVerifierAddress,
      DeltaVerifierABI.abi,
      this.provider
    );
  }

  /**
   * Simulate DeltaOne calculation without executing transaction
   */
  async simulate(
    modelId: string,
    evaluationData: EvaluationData
  ): Promise<SimulationResult | ErrorResult> {
    try {
      // Step 1: Calculate DeltaOne score (average improvement across metrics)
      const deltaOneScore = await this.calculateDeltaOne(
        evaluationData.baselineMetrics,
        evaluationData.newMetrics
      );

      // Step 2: Check if improvement meets minimum threshold
      const minImprovement = await this.deltaVerifier.minImprovementBps();
      if (deltaOneScore < minImprovement) {
        return this.createErrorResult(
          'INSUFFICIENT_IMPROVEMENT',
          `DeltaOne score (${deltaOneScore} bps) below minimum threshold (${minImprovement} bps)`,
          {
            actualDelta: Number(deltaOneScore),
            requiredDelta: Number(minImprovement),
            improvement: formatPercentage(Number(deltaOneScore))
          }
        );
      }

      // Step 3: Calculate reward amount
      let rewardAmount: bigint;
      let tokensPerDeltaOne: bigint;

      try {
        // Try dynamic calculation first (requires deployed token)
        rewardAmount = await this.calculateRewardDynamic(
          modelId,
          deltaOneScore,
          evaluationData.contributorWeight,
          evaluationData.contributedSamples
        );
        tokensPerDeltaOne = await this.getTokensPerDeltaOne(modelId);
      } catch (error) {
        // Fallback to static calculation if token not deployed
        rewardAmount = await this.calculateRewardStatic(
          deltaOneScore,
          evaluationData.contributorWeight,
          evaluationData.contributedSamples
        );
        tokensPerDeltaOne = await this.deltaVerifier.baseRewardRate();
      }

      // Step 4: Get parameters for display (already set above)

      // Step 5: Format results
      return this.createSimulationResult(
        modelId,
        evaluationData,
        Number(deltaOneScore),
        rewardAmount,
        Number(tokensPerDeltaOne)
      );

    } catch (error: any) {
      return this.createErrorResult(
        'SIMULATION_ERROR',
        error.message || 'Unknown error during simulation',
        { error: error.toString() }
      );
    }
  }

  /**
   * Calculate DeltaOne score (average improvement)
   */
  private async calculateDeltaOne(
    baselineMetrics: Metrics,
    newMetrics: Metrics
  ): Promise<bigint> {
    return await this.deltaVerifier.calculateDeltaOne(
      baselineMetrics,
      newMetrics
    );
  }

  /**
   * Calculate reward using dynamic parameters (requires deployed token)
   */
  private async calculateRewardDynamic(
    modelId: string,
    deltaScore: bigint,
    contributorWeight: number,
    contributedSamples: number
  ): Promise<bigint> {
    return await this.deltaVerifier.calculateRewardDynamic(
      modelId,
      deltaScore,
      contributorWeight,
      contributedSamples
    );
  }

  /**
   * Calculate reward using static parameters (fallback)
   */
  private async calculateRewardStatic(
    deltaScore: bigint,
    contributorWeight: number,
    contributedSamples: number
  ): Promise<bigint> {
    return await this.deltaVerifier.calculateReward(
      deltaScore,
      contributorWeight,
      contributedSamples
    );
  }

  /**
   * Get tokensPerDeltaOne from HokusaiParams
   */
  private async getTokensPerDeltaOne(modelId: string): Promise<bigint> {
    try {
      // Try to read from params contract via DeltaVerifier
      return await this.deltaVerifier.getTokensPerDeltaOne(modelId);
    } catch (error) {
      // Fallback to baseRewardRate if params not available
      return await this.deltaVerifier.baseRewardRate();
    }
  }

  /**
   * Create formatted simulation result
   */
  private createSimulationResult(
    modelId: string,
    evaluationData: EvaluationData,
    deltaOneScore: number,
    rewardAmount: bigint,
    tokensPerDeltaOne: number
  ): SimulationResult {
    const breakdown = createMetricsBreakdown(
      evaluationData.baselineMetrics,
      evaluationData.newMetrics
    );

    const contributionRatio = (evaluationData.contributedSamples / evaluationData.totalSamples) * 100;

    return {
      simulation: {
        deltaOneScore,
        deltaOnePercentage: formatPercentage(deltaOneScore),
        rewardAmount: formatTokenAmount(rewardAmount),
        rewardFormatted: formatTokenAmountWithCommas(rewardAmount),
        breakdown,
        parameters: {
          tokensPerDeltaOne,
          contributorWeight: formatPercentage(evaluationData.contributorWeight),
          contributedSamples: evaluationData.contributedSamples,
          totalSamples: evaluationData.totalSamples,
          contributionRatio: `${contributionRatio.toFixed(2)}%`
        }
      },
      metadata: {
        modelId,
        pipelineRunId: evaluationData.pipelineRunId,
        contributor: evaluationData.contributor,
        network: this.config.network,
        timestamp: new Date().toISOString()
      },
      status: 'simulated'
    };
  }

  /**
   * Create formatted error result
   */
  private createErrorResult(
    code: string,
    message: string,
    details: Record<string, any>
  ): ErrorResult {
    return {
      error: {
        code,
        message,
        details
      },
      status: 'error'
    };
  }
}
