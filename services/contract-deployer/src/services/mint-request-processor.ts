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
    const payload = this.buildPayload(message, modelId);
    const contributors = this.buildContributors(message);
    const result = await this.deltaVerifierClient.submitMintRequest(modelId, payload, contributors);
    const settlement = createMintRequestSettlement({
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

    // Statistical metadata is validated and audit-logged for observability, but not sent
    // on-chain and not persisted in the settlement envelope.
    logger.info('MintRequest processed', {
      idempotencyKey: message.idempotency_key,
      modelId: message.model_id,
      totalSamples: payload.totalSamples,
      ...this.buildStatisticalMetadata(message),
    });

    return settlement;
  }

  private buildPayload(message: MintRequestMessage, modelId: bigint): MintRequestPayloadInput {
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
      totalSamples: message.totalSamples,
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

  private buildStatisticalMetadata(message: MintRequestMessage): Record<string, number | string> {
    const statisticalMetadata: Record<string, number | string> = {};
    const {
      ci_low_bps,
      ci_high_bps,
      p_value,
      effect_size_bps,
      statistical_method,
      statistical_reason,
      sample_size_baseline,
      sample_size_candidate,
    } = message.evaluation;

    if (ci_low_bps !== null && ci_low_bps !== undefined) {
      statisticalMetadata.ciLowBps = ci_low_bps;
    }
    if (ci_high_bps !== null && ci_high_bps !== undefined) {
      statisticalMetadata.ciHighBps = ci_high_bps;
    }
    if (p_value !== null && p_value !== undefined) {
      statisticalMetadata.pValue = p_value;
    }
    if (effect_size_bps !== null && effect_size_bps !== undefined) {
      statisticalMetadata.effectSizeBps = effect_size_bps;
    }
    if (statistical_method !== null && statistical_method !== undefined) {
      statisticalMetadata.statisticalMethod = statistical_method;
    }
    if (statistical_reason !== null && statistical_reason !== undefined) {
      statisticalMetadata.statisticalReason = statistical_reason;
    }
    if (sample_size_baseline !== null && sample_size_baseline !== undefined) {
      statisticalMetadata.sampleSizeBaseline = sample_size_baseline;
    }
    if (sample_size_candidate !== null && sample_size_candidate !== undefined) {
      statisticalMetadata.sampleSizeCandidate = sample_size_candidate;
    }

    return statisticalMetadata;
  }
}
