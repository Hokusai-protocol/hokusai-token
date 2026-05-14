import { ethers } from 'ethers';
import {
  DeltaVerifierClient,
  DeltaVerifierContributor,
  MintRequestPayloadInput,
} from '../blockchain/delta-verifier-client';
import {
  MintRequestMessage,
  MintRequestSettlement,
  createMintRequestSettlement,
} from '../schemas/mint-request-schema';
import { logger } from '../utils/logger';

export class MintRequestProcessor {
  constructor(private readonly deltaVerifierClient: DeltaVerifierClient) {}

  async process(message: MintRequestMessage): Promise<MintRequestSettlement> {
    const modelId = BigInt(message.model_id_uint);

    // Derive totalSamples using precedence: top-level > sample_size_candidate > sample_size_baseline > 0
    const totalSamples = message.total_samples
      ?? message.evaluation.sample_size_candidate
      ?? message.evaluation.sample_size_baseline
      ?? 0;

    const payload = this.buildPayload(message, modelId, totalSamples);
    const contributors = this.buildContributors(message);
    const result = await this.deltaVerifierClient.submitMintRequest(modelId, payload, contributors);

    // Emit audit log for evaluation metadata (observability-only; not on-chain/not in settlement)
    logger.info('MintRequest evaluation metadata', {
      idempotency_key: message.idempotency_key,
      model_id: message.model_id,
      eval_id: message.eval_id,
      total_samples: totalSamples,
      sample_size_baseline: message.evaluation.sample_size_baseline ?? null,
      sample_size_candidate: message.evaluation.sample_size_candidate ?? null,
      ci_low_bps: message.evaluation.ci_low_bps ?? null,
      ci_high_bps: message.evaluation.ci_high_bps ?? null,
      p_value: message.evaluation.p_value ?? null,
      effect_size_bps: message.evaluation.effect_size_bps ?? null,
      statistical_method: message.evaluation.statistical_method ?? null,
      statistical_reason: message.evaluation.statistical_reason ?? null,
    });

    return createMintRequestSettlement({
      idempotency_key: message.idempotency_key,
      attestation_hash: message.attestation_hash,
      model_id: message.model_id,
      model_id_uint: message.model_id_uint,
      eval_id: message.eval_id,
      tx_hash: result.txHash,
      block_number: result.blockNumber,
      status: result.status,
      reward_amount: result.rewardAmount,
      gas_used: result.gasUsed,
    });
  }

  private buildPayload(message: MintRequestMessage, modelId: bigint, totalSamples: number): MintRequestPayloadInput {
    const benchmarkSpecHash =
      typeof message.benchmark_spec_id === 'string' && message.benchmark_spec_id.length > 0
        ? ethers.keccak256(ethers.toUtf8Bytes(message.benchmark_spec_id))
        : ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(
              ['uint256', 'string'],
              [modelId, message.evaluation.metric_name],
            ),
          );

    return {
      pipelineRunId: message.eval_id,
      baselineScoreBps: message.evaluation.baseline_score_bps,
      candidateScoreBps: message.evaluation.new_score_bps,
      maxCostUsdMicro: message.evaluation.max_cost_usd_micro,
      actualCostUsdMicro: message.evaluation.actual_cost_usd_micro,
      totalSamples,
      anchors: {
        benchmarkSpecHash,
        datasetHash: message.dataset_hash ?? ethers.ZeroHash,
        attestationHash: message.attestation_hash,
        idempotencyKey: message.idempotency_key,
        metricName: message.evaluation.metric_name,
        metricFamily: message.evaluation.metric_family,
      },
    };
  }

  private buildContributors(message: MintRequestMessage): DeltaVerifierContributor[] {
    return message.contributors.map((contributor) => ({
      walletAddress: contributor.wallet_address,
      weight: contributor.weight_bps,
    }));
  }
}
