import {
  classifyFailure,
  parseDlqEntry,
  summarizeEntry,
  validateForReplay,
} from '../../../src/queue/dlq-inspector';
import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';

const validMessage: MintRequestMessage = {
  message_type: 'mint_request',
  schema_version: '1.0',
  message_id: 'msg-dlq-1',
  timestamp: '2026-06-10T12:00:00.000Z',
  model_id: 'sales-outreach-v1',
  model_id_uint: '21',
  eval_id: 'eval-dlq-1',
  benchmark_spec_id: 'bench-dlq-1',
  dataset_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  baseline_commitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
  candidate_commitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
  attester_signatures: [
    '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
  ],
  totalSamples: 140,
  evaluation: {
    metric_name: 'sales:revenue_per_1000_messages',
    metric_family: 'zero_inflated_continuous',
    baseline_score_bps: 5000,
    new_score_bps: 7500,
    max_cost_usd_micro: 1000,
    actual_cost_usd_micro: 500,
    sample_size_baseline: 120,
    sample_size_candidate: 140,
  },
  contributors: [
    {
      wallet_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
      weight_bps: 10000,
    },
  ],
};

describe('dlq-inspector', () => {
  test('parses canonical entries and summarizes them', () => {
    const raw = JSON.stringify({
      originalMessage: validMessage,
      error: 'budget_exhausted (retries=24): MintBudgetExceeded',
      reason: 'budget_exhausted (retries=24): MintBudgetExceeded',
      failureClass: 'transient',
      timestamp: '2026-06-10T13:00:00.000Z',
      queue: 'hokusai:mint_requests',
    });

    const parsed = parseDlqEntry(raw);
    expect('kind' in parsed).toBe(false);
    if ('kind' in parsed) {
      return;
    }

    const summary = summarizeEntry(parsed, 60 * 60 * 1000, 3);
    expect(summary.id).toBe('#3');
    expect(summary.idempotencyKey).toBe(validMessage.idempotency_key);
    expect(summary.rewardHint).toBe('500');
    expect(summary.failureTag).toBe('budget_exhausted');
  });

  test('tolerates non-json originalMessage and broken top-level JSON', () => {
    const stringOriginalRaw = JSON.stringify({
      originalMessage: 'not-json',
      reason: '"attester_signatures" must contain at least 1 items',
    });
    const parsed = parseDlqEntry(stringOriginalRaw);
    expect('kind' in parsed).toBe(false);
    expect(summarizeEntry(parsed, null, 0).failureTag).toBe('schema_reject');

    expect(parseDlqEntry('totally broken')).toEqual({ kind: 'unparseable', raw: 'totally broken' });
  });

  test.each([
    ['budget_exhausted (retries=24): MintBudgetExceeded', 'budget_exhausted'],
    ['MintRequest transaction outcome unknown after submit: ECONNRESET', 'outcome_unknown'],
    ['SignerNotAttester', 'signer_not_attester'],
    ['permanent: Model not registered', 'model_inactive'],
    ['execution reverted: mint rejected', 'permanent_revert'],
    ['"attester_signatures" must contain at least 1 items', 'schema_reject'],
    ['some unrelated failure', 'other'],
  ] as const)('classifies %s as %s', (reason, expected) => {
    expect(classifyFailure(reason)).toBe(expected);
  });

  test('validateForReplay accepts a valid replay', () => {
    const result = validateForReplay(validMessage, {
      processed: false,
      weightHead: validMessage.baseline_commitment,
      budgetRemaining: 10n,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.sanitizedMessage._retryCount).toBeUndefined();
  });

  test('validateForReplay refuses already-processed keys', () => {
    const result = validateForReplay(validMessage, {
      processed: true,
      weightHead: validMessage.baseline_commitment,
      budgetRemaining: 10n,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('already processed'),
    });
  });

  test('validateForReplay refuses lineage mismatch', () => {
    const result = validateForReplay(validMessage, {
      processed: false,
      weightHead: '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
      budgetRemaining: 10n,
    });

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('Model lineage advanced'),
    });
  });

  test('validateForReplay refuses tampered payloads and missing on-chain state defensively', () => {
    const tampered = {
      ...validMessage,
      attester_signatures: [],
    };

    expect(
      validateForReplay(tampered, {
        processed: false,
        weightHead: validMessage.baseline_commitment,
        budgetRemaining: 10n,
      }),
    ).toEqual({
      ok: false,
      reason: expect.stringContaining('Schema validation failed'),
    });

    expect(validateForReplay(validMessage, {})).toEqual({
      ok: false,
      reason: 'Missing on-chain processed state',
    });
  });
});
