import { ParsedDlqEntry, rewardAmountFromMessage } from './dlq-entry';
import { validateMintRequestMessage } from '../schemas/mint-request-schema';

export interface OnChainMintStatus {
  processed: boolean;
  mintBudgetRemaining: bigint;
  modelWeightHead: string;
  signaturesValid: boolean;
  signatureError?: string;
}

export type ReplayRefusalReason =
  | 'unparseable'
  | 'schema_invalid'
  | 'already_processed'
  | 'lineage_stale'
  | 'budget_empty'
  | 'signature_invalid'
  | 'security_triage'
  | 'not_replayable';

export type ReplayDecision =
  | {
      allowed: true;
      warnings: string[];
      rewardAmount: bigint;
    }
  | {
      allowed: false;
      reason: ReplayRefusalReason;
      message: string;
      warnings: string[];
      rewardAmount?: bigint;
    };

export function decideReplay(entry: ParsedDlqEntry, onChain: OnChainMintStatus): ReplayDecision {
  if (entry.parsed === null || entry.message === null) {
    return {
      allowed: false,
      reason: 'unparseable',
      message: 'DLQ entry is not a parsed MintRequest message; discard after manual triage.',
      warnings: [],
    };
  }

  const validation = validateMintRequestMessage(entry.message);
  if (validation.error) {
    return {
      allowed: false,
      reason: 'schema_invalid',
      message: `MintRequest no longer validates: ${validation.error.message}`,
      warnings: [],
    };
  }

  const message = validation.value;
  const rewardAmount = rewardAmountFromMessage(message);

  if (entry.reasonClass === 'forgery_suspect' || entry.reasonClass === 'schema_reject') {
    return {
      allowed: false,
      reason: 'security_triage',
      message: `Refusing ${entry.reasonClass}; route to security triage instead of replaying.`,
      warnings: [],
      rewardAmount,
    };
  }

  if (entry.reasonClass !== 'budget_exhausted' && entry.reasonClass !== 'unknown_outcome') {
    return {
      allowed: false,
      reason: 'not_replayable',
      message: `Failure class ${entry.reasonClass} is not replayable by this tool.`,
      warnings: [],
      rewardAmount,
    };
  }

  if (onChain.processed) {
    return {
      allowed: false,
      reason: 'already_processed',
      message: 'Idempotency key is already processed on-chain; discard after recording reason.',
      warnings: [],
      rewardAmount,
    };
  }

  if (!onChain.signaturesValid) {
    return {
      allowed: false,
      reason: 'signature_invalid',
      message: `Attester signatures are invalid for the current payload: ${
        onChain.signatureError ?? 'authorization threshold not met'
      }.`,
      warnings: [],
      rewardAmount,
    };
  }

  if (onChain.modelWeightHead.toLowerCase() !== message.baseline_commitment.toLowerCase()) {
    return {
      allowed: false,
      reason: 'lineage_stale',
      message: `Lineage is stale: baseline ${message.baseline_commitment} does not match current head ${onChain.modelWeightHead}.`,
      warnings: [],
      rewardAmount,
    };
  }

  if (entry.reasonClass === 'budget_exhausted' && onChain.mintBudgetRemaining === 0n) {
    return {
      allowed: false,
      reason: 'budget_empty',
      message: 'Mint budget is still zero; wait for Safe top-up confirmation before replaying.',
      warnings: [],
      rewardAmount,
    };
  }

  const warnings: string[] = [];
  if (entry.reasonClass === 'budget_exhausted' && onChain.mintBudgetRemaining < rewardAmount) {
    warnings.push(
      `Mint budget ${onChain.mintBudgetRemaining.toString()} is below estimated reward ${rewardAmount.toString()}; replay may retry again if RPC is fresh.`,
    );
  }

  return {
    allowed: true,
    warnings,
    rewardAmount,
  };
}
