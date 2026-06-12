import {
  classifyDlqReason,
  computeEntryId,
  parseDlqEntry,
  rewardAmountFromMessage,
  stripRetryScratch,
} from '../../../src/dlq/dlq-entry';
import { buildDlqEntry, validMintRequest } from './test-helpers';

describe('dlq-entry helpers', () => {
  test('computes deterministic short IDs from raw entry bytes', () => {
    const raw = buildDlqEntry();

    expect(computeEntryId(raw)).toMatch(/^[0-9a-f]{12}$/);
    expect(computeEntryId(raw)).toBe(computeEntryId(raw));
    expect(computeEntryId(`${raw}\n`)).not.toBe(computeEntryId(raw));
  });

  test.each([
    ['budget_exhausted (retries=24): MintBudgetExceeded', 'transient', 'budget_exhausted'],
    [
      'permanent: MintRequest transaction outcome unknown after submit: ECONNRESET',
      'permanent',
      'unknown_outcome',
    ],
    ['permanent: execution reverted: SignerNotAttester', 'permanent', 'forgery_suspect'],
    [
      '"idempotency_key" with value "bad" fails to match required pattern',
      'permanent',
      'schema_reject',
    ],
    ['permanent: Model is deactivated', 'permanent', 'model_inactive'],
    ['permanent: transaction reverted', 'permanent', 'other_permanent'],
    ['temporary rpc error', 'transient', 'other'],
  ])('classifies %s', (reason, failureClass, expected) => {
    expect(classifyDlqReason(reason, failureClass)).toBe(expected);
  });

  test('parses DLQ envelopes and preserves malformed entries as non-replayable', () => {
    const parsed = parseDlqEntry(buildDlqEntry());
    expect(parsed.message?.idempotency_key).toBe(validMintRequest.idempotency_key);
    expect(parsed.reasonClass).toBe('budget_exhausted');
    expect(parsed.sourceQueue).toBe('hokusai:mint_requests');

    const malformed = parseDlqEntry('{not-json');
    expect(malformed.parsed).toBeNull();
    expect(malformed.message).toBeNull();
    expect(malformed.reasonClass).toBe('schema_reject');
  });

  test('strips retry scratch without changing signed payload fields', () => {
    const withRetry = { ...validMintRequest, _retryCount: 24 };
    const stripped = stripRetryScratch(withRetry);

    expect(stripped).not.toHaveProperty('_retryCount');
    expect(stripped.idempotency_key).toBe(validMintRequest.idempotency_key);
    expect(stripped.baseline_commitment).toBe(validMintRequest.baseline_commitment);
    expect(stripped.candidate_commitment).toBe(validMintRequest.candidate_commitment);
    expect(stripped.attester_signatures).toEqual(validMintRequest.attester_signatures);
    expect(stripped.contributors).toEqual(validMintRequest.contributors);
  });

  test('estimates reward from positive score delta and total samples', () => {
    expect(rewardAmountFromMessage(validMintRequest)).toBe(350000n);
    expect(
      rewardAmountFromMessage({
        ...validMintRequest,
        evaluation: {
          ...validMintRequest.evaluation,
          baseline_score_bps: 7500,
          new_score_bps: 5000,
        },
      }),
    ).toBe(0n);
  });
});
