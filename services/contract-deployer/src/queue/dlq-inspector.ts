import { MintRequestMessage, validateMintRequestMessage } from '../schemas/mint-request-schema';

const IDEMPOTENCY_KEY_REGEX = /^0x[0-9a-f]{64}$/;
const JOI_REASON_PATTERN =
  /(".*?" (is required|must .*|is not allowed)|must include a positive integer sample_size_candidate)/i;

export type FailureTag =
  | 'budget_exhausted'
  | 'outcome_unknown'
  | 'schema_reject'
  | 'permanent_revert'
  | 'signer_not_attester'
  | 'model_inactive'
  | 'other';

export interface DlqEntry {
  originalMessage: unknown;
  error?: string;
  reason: string;
  failureClass?: 'transient' | 'permanent';
  timestamp?: string;
  queue?: string;
}

export interface UnparseableDlqEntry {
  kind: 'unparseable';
  raw: string;
}

export interface DlqSummary {
  id: string;
  index: number;
  idempotencyKey: string | null;
  modelId: string | null;
  rewardHint: string | null;
  failureTag: FailureTag;
  ageHours: number | null;
  retryCount: number | null;
  securitySensitive: boolean;
}

export interface ReplayOnChainState {
  processed?: boolean;
  weightHead?: string;
  budgetRemaining?: bigint;
}

export type ReplayValidationResult =
  | { ok: true; sanitizedMessage: MintRequestMessage }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMintRequestMessage(value: unknown): value is MintRequestMessage {
  return isRecord(value);
}

export function isValidIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_REGEX.test(value);
}

export function parseDlqEntry(raw: string): DlqEntry | UnparseableDlqEntry {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || typeof parsed.reason !== 'string') {
      return { kind: 'unparseable', raw };
    }

    return {
      originalMessage: parsed.originalMessage,
      error: typeof parsed.error === 'string' ? parsed.error : undefined,
      reason: parsed.reason,
      failureClass:
        parsed.failureClass === 'transient' || parsed.failureClass === 'permanent'
          ? parsed.failureClass
          : undefined,
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      queue: typeof parsed.queue === 'string' ? parsed.queue : undefined,
    };
  } catch {
    return { kind: 'unparseable', raw };
  }
}

export function classifyFailure(reason: string): FailureTag {
  if (reason.startsWith('budget_exhausted (retries=')) {
    return 'budget_exhausted';
  }
  if (reason.includes('MintRequest transaction outcome unknown after submit')) {
    return 'outcome_unknown';
  }
  if (reason.includes('SignerNotAttester')) {
    return 'signer_not_attester';
  }
  if (reason.includes('Model not registered') || reason.includes('Model is deactivated')) {
    return 'model_inactive';
  }
  if (
    reason.includes('MintRequest transaction reverted') ||
    reason.includes('execution reverted')
  ) {
    return 'permanent_revert';
  }
  if (JOI_REASON_PATTERN.test(reason)) {
    return 'schema_reject';
  }

  return 'other';
}

export function summarizeEntry(
  entry: DlqEntry | UnparseableDlqEntry,
  ageMs: number | null,
  index = 0,
): DlqSummary {
  const id = `#${index}`;
  if ('kind' in entry) {
    return {
      id,
      index,
      idempotencyKey: null,
      modelId: null,
      rewardHint: null,
      failureTag: 'schema_reject',
      ageHours: ageMs === null ? null : ageMs / (60 * 60 * 1000),
      retryCount: null,
      securitySensitive: false,
    };
  }

  const originalMessage = isMintRequestMessage(entry.originalMessage)
    ? entry.originalMessage
    : null;
  const failureTag = classifyFailure(entry.reason);
  return {
    id,
    index,
    idempotencyKey:
      typeof originalMessage?.idempotency_key === 'string' ? originalMessage.idempotency_key : null,
    modelId: typeof originalMessage?.model_id === 'string' ? originalMessage.model_id : null,
    rewardHint:
      typeof originalMessage?.evaluation === 'object' &&
      originalMessage.evaluation !== null &&
      typeof (originalMessage.evaluation as { actual_cost_usd_micro?: unknown })
        .actual_cost_usd_micro === 'number'
        ? String(
            (originalMessage.evaluation as { actual_cost_usd_micro: number }).actual_cost_usd_micro,
          )
        : null,
    failureTag,
    ageHours: ageMs === null ? null : ageMs / (60 * 60 * 1000),
    retryCount:
      typeof originalMessage?._retryCount === 'number' ? originalMessage._retryCount : null,
    securitySensitive: failureTag === 'signer_not_attester',
  };
}

function sanitizeReplayMessage(message: MintRequestMessage): MintRequestMessage {
  const { _retryCount: _unusedRetryCount, ...rest } = message;
  void _unusedRetryCount;
  return rest;
}

export function validateForReplay(
  message: unknown,
  onChainState: ReplayOnChainState,
): ReplayValidationResult {
  const validation = validateMintRequestMessage(message);
  if (validation.error) {
    return { ok: false, reason: `Schema validation failed: ${validation.error.message}` };
  }

  const validatedMessage = validation.value;
  if (!isValidIdempotencyKey(validatedMessage.idempotency_key)) {
    return { ok: false, reason: 'Invalid idempotency key format' };
  }
  if (typeof onChainState.processed !== 'boolean') {
    return { ok: false, reason: 'Missing on-chain processed state' };
  }
  if (typeof onChainState.weightHead !== 'string') {
    return { ok: false, reason: 'Missing on-chain modelWeightHead state' };
  }
  if (typeof onChainState.budgetRemaining !== 'bigint') {
    return { ok: false, reason: 'Missing on-chain mintBudgetRemaining state' };
  }
  if (onChainState.processed) {
    return {
      ok: false,
      reason: `Idempotency key ${validatedMessage.idempotency_key} is already processed on-chain`,
    };
  }
  if (
    onChainState.weightHead.toLowerCase() !== validatedMessage.baseline_commitment.toLowerCase()
  ) {
    return {
      ok: false,
      reason: `Model lineage advanced: on-chain head ${onChainState.weightHead} does not match baseline ${validatedMessage.baseline_commitment}`,
    };
  }

  return {
    ok: true,
    sanitizedMessage: sanitizeReplayMessage(validatedMessage),
  };
}
