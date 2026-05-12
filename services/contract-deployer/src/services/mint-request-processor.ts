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

export class MintRequestProcessor {
  constructor(private readonly deltaVerifierClient: DeltaVerifierClient) {}

  async process(message: MintRequestMessage): Promise<MintRequestSettlement> {
    const modelId = BigInt(message.model_id_uint);
    const payload = this.buildPayload(message, modelId);
    const contributors = this.buildContributors(message);
    const result = await this.deltaVerifierClient.submitMintRequest(modelId, payload, contributors);

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
