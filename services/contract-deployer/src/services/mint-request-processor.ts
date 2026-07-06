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
import { PayoutIntentStore } from './payout-intent-store';
import { DirectMintSettlementClient } from './direct-mint-settlement-client';
import { logger } from '../utils/logger';

export class MintRequestProcessor {
  constructor(
    private readonly deltaVerifierClient: DeltaVerifierClient,
    // Optional: when configured, the authorized payout is recorded before submit so
    // the DeltaOne detector can reconcile on-chain recipients against intent
    // (HOK-2223). Undefined leaves behavior unchanged.
    private readonly payoutIntentStore?: PayoutIntentStore,
    private readonly directMintSettlementClient?: DirectMintSettlementClient,
  ) {}

  async process(message: MintRequestMessage): Promise<MintRequestSettlement> {
    const modelId = BigInt(message.model_id_uint);
    const payload = this.buildPayload(message);
    const contributors = this.buildContributors(message);

    // Record authorized intent BEFORE submitting, so a matching record exists by the
    // time the detector sees the on-chain mint. Fail-soft: a write failure must not
    // block minting (it surfaces later as a detector alert, not a stuck mint). Revisit
    // to fail-closed once auto-pause is armed on the reconciliation rule.
    await this.recordPayoutIntent(message);

    const result = await this.deltaVerifierClient.submitMintRequest(
      modelId,
      payload,
      contributors,
      message.attester_signatures,
      { modelName: message.model_id },
    );
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

    if (result.status === 'minted' && result.decodedReceipt && this.directMintSettlementClient) {
      await this.directMintSettlementClient.postSettlements(message, result.decodedReceipt);
    } else if (result.status === 'minted' && this.directMintSettlementClient) {
      logger.warn(
        'Minted request did not include decoded receipt metadata; auth settlement skipped',
        {
          idempotencyKey: message.idempotency_key,
          txHash: result.txHash,
        },
      );
    }

    // Statistical metadata is validated and audit-logged for observability, but not sent
    // on-chain and not persisted in the settlement envelope.
    logger.info('MintRequest processed', {
      idempotencyKey: message.idempotency_key,
      modelId: message.model_id,
      totalSamples: payload.totalSamples,
      deadline: payload.deadline,
      baselineCommitment: payload.baselineCommitment,
      candidateCommitment: payload.candidateCommitment,
      attesterSignatureCount: message.attester_signatures.length,
      ...this.buildStatisticalMetadata(message),
    });

    return settlement;
  }

  private async recordPayoutIntent(message: MintRequestMessage): Promise<void> {
    if (!this.payoutIntentStore) {
      return;
    }
    try {
      await this.payoutIntentStore.putIntent({
        idempotencyKey: message.idempotency_key,
        recipients: message.contributors.map((contributor) => contributor.wallet_address),
        modelId: message.model_id_uint,
      });
    } catch (error) {
      logger.warn('Failed to record payout intent; proceeding with mint (detector may flag it)', {
        idempotencyKey: message.idempotency_key,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Public so the conformance tests pin the REAL fixture→calldata mapping, not a hand-copied twin.
  buildPayload(message: MintRequestMessage): MintRequestPayloadInput {
    return {
      pipelineRunId: message.eval_id,
      baselineScoreBps: message.evaluation.baseline_score_bps,
      candidateScoreBps: message.evaluation.new_score_bps,
      maxCostUsdMicro: message.evaluation.max_cost_usd_micro,
      actualCostUsdMicro: message.evaluation.actual_cost_usd_micro,
      totalSamples: message.totalSamples,
      anchors: {
        benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes(message.benchmark_spec_id)),
        datasetHash: message.dataset_hash,
        attestationHash: message.attestation_hash,
        idempotencyKey: message.idempotency_key,
        metricName: message.evaluation.metric_name,
        metricFamily: message.evaluation.metric_family,
      },
      baselineCommitment: message.baseline_commitment,
      candidateCommitment: message.candidate_commitment,
      deadline: message.deadline,
    };
  }

  buildContributors(message: MintRequestMessage): DeltaVerifierContributor[] {
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
