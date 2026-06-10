export type FailureClass = 'transient' | 'permanent';

export interface RetryPolicyConfig {
  baseMs: number;
  maxMs: number;
  multiplier: number;
}

const PERMANENT_CODES = new Set(['CALL_EXCEPTION', 'INVALID_ARGUMENT']);
const TRANSIENT_CODES = new Set([
  'TIMEOUT',
  'NETWORK_ERROR',
  'SERVER_ERROR',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'REPLACEMENT_UNDERPRICED',
  'NONCE_EXPIRED',
]);
const PERMANENT_MESSAGE_PATTERNS = [
  'model not registered',
  'model is deactivated',
  'mintrequest transaction reverted',
];
const TRANSIENT_MESSAGE_PATTERNS = [
  'mintbudgetexceeded',
  'timeout',
  'temporarily unavailable',
  'socket hang up',
  'connection reset',
  'connection refused',
  'nonce has already been used',
  'replacement transaction underpriced',
  'header not found',
];

export function classifyError(error: unknown): FailureClass {
  if (getFailureClass(error) !== undefined) {
    return getFailureClass(error)!;
  }

  if (hasUnknownOnChainOutcome(error)) {
    return 'permanent';
  }

  const code = getErrorCode(error);
  if (code !== undefined && PERMANENT_CODES.has(code)) {
    return 'permanent';
  }
  if (code !== undefined && TRANSIENT_CODES.has(code)) {
    return 'transient';
  }

  const message = getErrorMessage(error).toLowerCase();
  if (PERMANENT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern))) {
    return 'permanent';
  }
  if (
    TRANSIENT_MESSAGE_PATTERNS.some((pattern) => message.includes(pattern)) ||
    message.includes('redis') ||
    message.includes('gas price') ||
    message.includes('fee data') ||
    message.includes('failed to detect network')
  ) {
    return 'transient';
  }

  return 'transient';
}

function getFailureClass(error: unknown): FailureClass | undefined {
  if (typeof error === 'object' && error !== null && 'failureClass' in error) {
    const failureClass = (error as { failureClass?: unknown }).failureClass;
    if (failureClass === 'transient' || failureClass === 'permanent') {
      return failureClass;
    }
  }
  return undefined;
}

function hasUnknownOnChainOutcome(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'onChainOutcomeUnknown' in error) {
    return (error as { onChainOutcomeUnknown?: unknown }).onChainOutcomeUnknown === true;
  }
  return false;
}

export function computeBackoffMs(retryCount: number, config: RetryPolicyConfig): number {
  if (retryCount <= 0 || config.maxMs === 0) {
    return 0;
  }

  const exponentialDelay = config.baseMs * Math.pow(config.multiplier, Math.max(0, retryCount - 1));
  const cappedDelay = Math.min(exponentialDelay, config.maxMs);

  return Math.floor(Math.random() * (cappedDelay + 1));
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
