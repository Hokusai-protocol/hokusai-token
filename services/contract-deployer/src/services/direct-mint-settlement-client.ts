import { ethers } from 'ethers';
import { DecodedMintReceipt } from '../blockchain/delta-verifier-client';
import { MintRequestMessage } from '../schemas/mint-request-schema';
import { logger } from '../utils/logger';

export interface DirectMintSettlementClientConfig {
  authServiceUrl: string;
  internalToken: string;
  networkName?: string;
  chainId?: number;
  deltaVerifierAddress?: string;
  modelRegistryAddress?: string;
  tokenManagerAddress?: string;
  timeoutMs?: number;
}

export interface DirectMintSettlementPayload {
  reward_id: string;
  submission_id: string;
  user_id: string;
  model_id: string;
  token_symbol: string;
  token_address: string;
  amount: string;
  recipient_address: string;
  claim_tx_hash: string;
  claim_reference: string;
  claimed_at: string;
  immediate_amount?: string;
  vested_amount?: string;
  vesting_schedule?: {
    schedule_id: string;
    vault_address: string;
    token_address: string;
    beneficiary_address: string;
    total_amount: string;
    claimed_amount: string;
    start_at?: string;
    end_at?: string;
    duration_seconds?: number;
    cliff_seconds?: number;
  };
  deployment: Record<string, string | number>;
  metadata: Record<string, string | number>;
}

export class DirectMintSettlementError extends Error {
  readonly failureClass = 'permanent' as const;

  constructor(message: string) {
    super(message);
    this.name = 'DirectMintSettlementError';
  }
}

export class DirectMintSettlementClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: DirectMintSettlementClientConfig) {
    this.endpoint = `${config.authServiceUrl.replace(/\/+$/, '')}/api/v1/internal/rewards/settlements/direct-mint`;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  async postSettlements(message: MintRequestMessage, receipt: DecodedMintReceipt): Promise<void> {
    const rows = this.buildRows(message, receipt);
    if (rows.length === 0) {
      logger.info('No wallet contributors eligible for direct mint settlement', {
        idempotencyKey: message.idempotency_key,
      });
      return;
    }

    for (const row of rows) {
      await this.postSettlement(row);
    }
  }

  buildRows(
    message: MintRequestMessage,
    receipt: DecodedMintReceipt,
  ): DirectMintSettlementPayload[] {
    if (!receipt.txHash) {
      throw new DirectMintSettlementError('direct mint settlement requires tx hash');
    }
    if (!receipt.tokenAddress) {
      throw new DirectMintSettlementError('direct mint settlement requires token address');
    }
    if (!receipt.tokenSymbol) {
      throw new DirectMintSettlementError('direct mint settlement requires token symbol');
    }

    const totalReward = BigInt(receipt.totalReward);
    if (totalReward <= 0n) {
      return [];
    }

    return message.contributors.flatMap((contributor) => {
      if ((contributor.recipientKind ?? 'wallet') !== 'wallet') {
        return [];
      }

      const userId = normalizeIdentity(contributor.contributorId);
      const submissionId = normalizeIdentity(contributor.submissionId);
      if (!userId || !submissionId) {
        logger.warn('Skipping direct mint settlement row with missing contributor identity', {
          idempotencyKey: message.idempotency_key,
          walletAddress: contributor.wallet_address,
          hasContributorId: Boolean(userId),
          hasSubmissionId: Boolean(submissionId),
        });
        return [];
      }

      const recipientSettlement = receipt.recipientSettlements?.find(
        (settlement) =>
          settlement.recipientAddress.toLowerCase() === contributor.wallet_address.toLowerCase(),
      );
      const amount = recipientSettlement?.totalReward
        ? BigInt(recipientSettlement.totalReward)
        : splitByWeight(totalReward, contributor.weight_bps);
      const immediateAmount =
        recipientSettlement?.immediateAmount !== undefined
          ? BigInt(recipientSettlement.immediateAmount)
          : receipt.immediateAmount !== undefined
            ? splitByWeight(BigInt(receipt.immediateAmount), contributor.weight_bps)
            : undefined;
      const vestedAmount =
        recipientSettlement?.vestedAmount !== undefined
          ? BigInt(recipientSettlement.vestedAmount)
          : receipt.vestedAmount !== undefined
            ? splitByWeight(BigInt(receipt.vestedAmount), contributor.weight_bps)
            : undefined;
      const vestingSchedule =
        recipientSettlement?.vestingSchedule ??
        (receipt.recipientSettlements?.length ? undefined : receipt.vestingSchedule);
      const rewardId = `${message.idempotency_key}:${userId}`;

      return [
        {
          reward_id: rewardId,
          submission_id: submissionId,
          user_id: userId,
          model_id: message.model_id,
          token_symbol: receipt.tokenSymbol!,
          token_address: receipt.tokenAddress!,
          amount: formatTokenAmount(amount),
          recipient_address: contributor.wallet_address,
          claim_tx_hash: receipt.txHash,
          claim_reference: `${receipt.txHash}:${message.idempotency_key}:${userId}`,
          claimed_at: new Date().toISOString(),
          immediate_amount:
            immediateAmount !== undefined ? formatTokenAmount(immediateAmount) : undefined,
          vested_amount: vestedAmount !== undefined ? formatTokenAmount(vestedAmount) : undefined,
          vesting_schedule:
            vestingSchedule && vestedAmount !== undefined
              ? {
                  schedule_id: vestingSchedule.scheduleId,
                  vault_address: vestingSchedule.vaultAddress,
                  token_address: vestingSchedule.tokenAddress || receipt.tokenAddress!,
                  beneficiary_address: contributor.wallet_address,
                  total_amount: formatTokenAmount(vestedAmount),
                  claimed_amount: formatTokenAmount(BigInt(vestingSchedule.claimedAmount)),
                  start_at: vestingSchedule.startAt,
                  end_at: vestingSchedule.endAt,
                  duration_seconds: vestingSchedule.durationSeconds,
                  cliff_seconds: vestingSchedule.cliffSeconds,
                }
              : undefined,
          deployment: this.buildDeployment(receipt),
          metadata: {
            source: 'contract_deployer_direct_mint_settlement',
            mint_request_id: message.message_id,
            mint_idempotency_key: message.idempotency_key,
            external_submission_id: submissionId,
            contribution_batch_id: contributor.contributionBatchId ?? '',
            model_id_uint: message.model_id_uint,
            eval_id: message.eval_id,
            attestation_hash: message.attestation_hash,
            recipient_wallet: contributor.wallet_address,
            weight_bps: contributor.weight_bps,
          },
        },
      ];
    });
  }

  private async postSettlement(row: DirectMintSettlementPayload): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.internalToken}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': row.reward_id,
        },
        body: JSON.stringify(removeUndefined(row as unknown as JsonObject)),
        signal: controller.signal,
      });

      if (response.ok || response.status === 409) {
        logger.info('Direct mint settlement posted to auth', {
          rewardId: row.reward_id,
          statusCode: response.status,
        });
        return;
      }

      const responseBody = await response.text();
      logger.error('Direct mint settlement auth request failed', {
        rewardId: row.reward_id,
        statusCode: response.status,
        responseBody: responseBody.slice(0, 500),
      });
      throw new DirectMintSettlementError(
        `auth direct mint settlement failed (${response.status}): ${responseBody.slice(0, 500)}`,
      );
    } catch (error) {
      if (error instanceof DirectMintSettlementError) {
        throw error;
      }
      throw new DirectMintSettlementError(
        `auth direct mint settlement request failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildDeployment(receipt: DecodedMintReceipt): Record<string, string | number> {
    return removeUndefined({
      network: this.config.networkName,
      chain_id: this.config.chainId,
      delta_verifier: this.config.deltaVerifierAddress,
      model_registry: this.config.modelRegistryAddress,
      token_manager: this.config.tokenManagerAddress,
      token_address: receipt.tokenAddress,
      vesting_vault: receipt.vestingVault,
      block_number: receipt.blockNumber,
    }) as Record<string, string | number>;
  }
}

function splitByWeight(total: bigint, weightBps: number): bigint {
  return (total * BigInt(weightBps)) / 10000n;
}

function formatTokenAmount(value: bigint): string {
  return ethers.formatUnits(value, 18);
}

function normalizeIdentity(value: string | null | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

type JsonObject = Record<string, unknown>;

function removeUndefined(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== ''),
  );
}
