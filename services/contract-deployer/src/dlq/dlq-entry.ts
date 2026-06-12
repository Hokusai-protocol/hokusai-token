import { createHash } from 'crypto';
import { MintRequestMessage } from '../schemas/mint-request-schema';

export type FailureClass = string;

export type DlqReasonClass =
  | 'budget_exhausted'
  | 'unknown_outcome'
  | 'schema_reject'
  | 'forgery_suspect'
  | 'model_inactive'
  | 'other_permanent'
  | 'other';

export interface DlqEnvelope {
  originalMessage: unknown;
  error?: string;
  reason?: string;
  failureClass?: FailureClass;
  timestamp?: string;
  queue?: string;
}

export interface ParsedDlqEntry {
  id: string;
  raw: string;
  parsed: DlqEnvelope | null;
  parseError?: string;
  message: MintRequestMessage | null;
  reason: string;
  failureClass: FailureClass;
  reasonClass: DlqReasonClass;
  timestamp?: string;
  sourceQueue?: string;
}

export function computeEntryId(rawEntry: string): string {
  return createHash('sha256').update(rawEntry).digest('hex').slice(0, 12);
}

export function classifyDlqReason(
  reason: string | undefined,
  failureClass: FailureClass | undefined,
): DlqReasonClass {
  const normalizedReason = (reason ?? '').toLowerCase();
  const normalizedFailureClass = (failureClass ?? '').toLowerCase();

  if (normalizedReason.startsWith('budget_exhausted')) {
    return 'budget_exhausted';
  }

  if (normalizedReason.includes('transaction outcome unknown after submit')) {
    return 'unknown_outcome';
  }

  if (
    normalizedReason.includes('signernotattester') ||
    normalizedReason.includes('not authorized') ||
    normalizedReason.includes('not an attester')
  ) {
    return 'forgery_suspect';
  }

  if (
    normalizedReason.includes('invalid json') ||
    normalizedReason.includes('is required') ||
    normalizedReason.includes('is not allowed') ||
    normalizedReason.includes('fails to match') ||
    normalizedReason.includes('must be') ||
    normalizedReason.includes('joi')
  ) {
    return 'schema_reject';
  }

  if (
    normalizedReason.includes('model not registered') ||
    normalizedReason.includes('model is deactivated')
  ) {
    return 'model_inactive';
  }

  if (normalizedFailureClass === 'permanent') {
    return 'other_permanent';
  }

  return 'other';
}

export function parseDlqEntry(rawEntry: string): ParsedDlqEntry {
  const id = computeEntryId(rawEntry);

  try {
    const parsed = JSON.parse(rawEntry) as DlqEnvelope;
    const reason =
      typeof parsed.reason === 'string'
        ? parsed.reason
        : typeof parsed.error === 'string'
          ? parsed.error
          : '';
    const failureClass = parsed.failureClass ?? 'permanent';
    const message =
      parsed.originalMessage !== null &&
      typeof parsed.originalMessage === 'object' &&
      !Array.isArray(parsed.originalMessage)
        ? (parsed.originalMessage as MintRequestMessage)
        : null;

    return {
      id,
      raw: rawEntry,
      parsed,
      message,
      reason,
      failureClass,
      reasonClass: classifyDlqReason(reason, failureClass),
      timestamp: typeof parsed.timestamp === 'string' ? parsed.timestamp : undefined,
      sourceQueue: typeof parsed.queue === 'string' ? parsed.queue : undefined,
    };
  } catch (error) {
    return {
      id,
      raw: rawEntry,
      parsed: null,
      parseError: error instanceof Error ? error.message : 'Invalid JSON',
      message: null,
      reason: 'Invalid JSON',
      failureClass: 'permanent',
      reasonClass: 'schema_reject',
    };
  }
}

export function stripRetryScratch(message: MintRequestMessage): MintRequestMessage {
  const { _retryCount, ...withoutRetryCount } = message;
  void _retryCount;
  return withoutRetryCount;
}

export function rewardAmountFromMessage(message: MintRequestMessage): bigint {
  const scoreDelta = message.evaluation.new_score_bps - message.evaluation.baseline_score_bps;
  if (scoreDelta <= 0) {
    return 0n;
  }

  return BigInt(scoreDelta) * BigInt(message.totalSamples);
}

export function summarizeId(value: string | undefined, visibleChars = 10): string {
  if (!value) {
    return '-';
  }

  if (value.length <= visibleChars * 2 + 5) {
    return value;
  }

  return `${value.slice(0, visibleChars)}...${value.slice(-visibleChars)}`;
}
