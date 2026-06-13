import { RedisClientType } from 'redis';
import { runDlqCli } from '../../../scripts/dlq';
import { createMockRedisClient, createMockRedisMulti } from '../../mocks/redis-mock';

const validMessage = {
  message_type: 'mint_request',
  schema_version: '1.0',
  message_id: 'msg-dlq-cli-1',
  timestamp: '2026-06-10T12:00:00.000Z',
  model_id: 'sales-outreach-v1',
  model_id_uint: '21',
  eval_id: 'eval-dlq-cli-1',
  benchmark_spec_id: 'bench-dlq-cli-1',
  dataset_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  baseline_commitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
  candidate_commitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
  attester_signatures: [
    '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
  ],
  totalSamples: 140,
  deadline: 4102444800,
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

function createDlqEntry(
  overrides?: Partial<{
    reason: string;
    originalMessage: unknown;
    failureClass: 'transient' | 'permanent';
  }>,
) {
  return JSON.stringify({
    originalMessage: overrides?.originalMessage ?? validMessage,
    error: overrides?.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
    reason: overrides?.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
    failureClass: overrides?.failureClass ?? 'transient',
    timestamp: '2026-06-10T13:00:00.000Z',
    queue: 'hokusai:mint_requests',
  });
}

function createDeps(dlqEntries: string[]) {
  const redis = createMockRedisClient();
  const multi = createMockRedisMulti();
  const stdout: string[] = [];
  const stderr: string[] = [];
  redis.lRange.mockResolvedValue(dlqEntries);
  redis.multi.mockReturnValue(multi as any);

  return {
    redis,
    multi,
    stdout,
    stderr,
    deps: {
      redis: redis as Pick<RedisClientType, 'lRange' | 'multi' | 'disconnect' | 'connect'>,
      deltaVerifier: {
        processedIdempotencyKeys: jest.fn().mockResolvedValue(false),
        modelWeightHead: jest.fn().mockResolvedValue(validMessage.baseline_commitment),
        mintBudgetRemaining: jest.fn().mockResolvedValue(10n),
      },
      recordStore: {
        get: jest.fn().mockResolvedValue(null),
      },
      env: {
        REDIS_HOST: 'localhost',
        REDIS_PORT: 6379,
        RPC_URL: 'http://localhost:8545',
        MODEL_REGISTRY_ADDRESS: '0x1111111111111111111111111111111111111111',
        DELTA_VERIFIER_ADDRESS: '0x2222222222222222222222222222222222222222',
        MINT_REQUEST_QUEUE: 'hokusai:mint_requests',
        MINT_REQUEST_DLQ: 'hokusai:mint_requests:dlq',
        MINT_DLQ_AUDIT_KEY: 'hokusai:mint_requests:dlq:audit',
      },
      stdout: { write: (message: string) => stdout.push(message) },
      stderr: { write: (message: string) => stderr.push(message) },
      now: () => new Date('2026-06-12T12:00:00.000Z'),
    },
  };
}

describe('dlq CLI', () => {
  test('list formats summaries and applies --class filters', async () => {
    const budgetEntry = createDlqEntry();
    const securityEntry = createDlqEntry({
      reason: 'permanent: SignerNotAttester',
      failureClass: 'permanent',
    });
    const { deps, stdout } = createDeps([budgetEntry, securityEntry]);

    expect(await runDlqCli(['list'], deps as any)).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('INDEX');
    expect(output).toContain('budget_exhausted');
    expect(output).toContain('SECURITY signer_not_attester');

    stdout.length = 0;
    expect(await runDlqCli(['list', '--class', 'budget_exhausted'], deps as any)).toBe(0);
    expect(stdout.join('')).toContain('budget_exhausted');
    expect(stdout.join('')).not.toContain('signer_not_attester');
  });

  test('inspect returns full payload plus on-chain status and flags signer_not_attester loudly', async () => {
    const entry = createDlqEntry({
      reason: 'permanent: SignerNotAttester',
      failureClass: 'permanent',
    });
    const { deps, stdout } = createDeps([entry]);
    deps.deltaVerifier.processedIdempotencyKeys = jest.fn().mockResolvedValue(true);
    deps.recordStore.get = jest.fn().mockResolvedValue({ status: 'error' });

    expect(await runDlqCli(['inspect', '#0'], deps as any)).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('SECURITY signer_not_attester');
    expect(output).toContain('"processed": true');
    expect(output).toContain('"budgetRemaining": "10"');
  });

  test('replay dry-run prints planned MULTI ops', async () => {
    const { deps, stdout, multi } = createDeps([createDlqEntry()]);

    expect(await runDlqCli(['replay', '#0'], deps as any)).toBe(0);
    const output = stdout.join('');
    expect(output).toContain('LPUSH hokusai:mint_requests');
    expect(output).toContain('LREM hokusai:mint_requests:dlq 1');
    expect(output).toContain('LPUSH hokusai:mint_requests:dlq:audit');
    expect(output).toContain('dry-run: pass --execute to apply');
    expect(multi.exec).not.toHaveBeenCalled();
  });

  test('replay --execute issues the expected MULTI and strips _retryCount', async () => {
    const replayable = JSON.stringify({
      ...JSON.parse(createDlqEntry()),
      originalMessage: {
        ...validMessage,
        _retryCount: 24,
      },
    });
    const { deps, multi } = createDeps([replayable]);

    expect(await runDlqCli(['replay', '#0', '--execute'], deps as any)).toBe(0);
    expect(multi.lPush).toHaveBeenNthCalledWith(1, 'hokusai:mint_requests', expect.any(String));
    const replayPayload = JSON.parse(multi.lPush.mock.calls[0][1] as string) as Record<
      string,
      unknown
    >;
    expect(replayPayload._retryCount).toBeUndefined();
    expect(multi.lRem).toHaveBeenCalledWith('hokusai:mint_requests:dlq', 1, replayable);
    expect(multi.lPush).toHaveBeenNthCalledWith(
      2,
      'hokusai:mint_requests:dlq:audit',
      expect.stringContaining('"action":"replay"'),
    );
    expect(multi.exec).toHaveBeenCalledTimes(1);
  });

  test('replay refuses already-processed, lineage-stale, Joi-invalid, and signer_not_attester entries', async () => {
    const processed = createDeps([createDlqEntry()]);
    processed.deps.deltaVerifier.processedIdempotencyKeys = jest.fn().mockResolvedValue(true);
    expect(await runDlqCli(['replay', '#0', '--execute'], processed.deps as any)).toBe(1);
    expect(processed.multi.exec).not.toHaveBeenCalled();

    const stale = createDeps([createDlqEntry()]);
    stale.deps.deltaVerifier.modelWeightHead = jest
      .fn()
      .mockResolvedValue('0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff');
    expect(await runDlqCli(['replay', '#0', '--execute'], stale.deps as any)).toBe(1);
    expect(stale.multi.exec).not.toHaveBeenCalled();

    const tampered = createDeps([
      createDlqEntry({
        originalMessage: { ...validMessage, attester_signatures: [] },
        reason: 'permanent: bad payload',
        failureClass: 'permanent',
      }),
    ]);
    expect(await runDlqCli(['replay', '#0', '--execute'], tampered.deps as any)).toBe(1);
    expect(tampered.multi.exec).not.toHaveBeenCalled();

    const forged = createDeps([
      createDlqEntry({
        reason: 'permanent: SignerNotAttester',
        failureClass: 'permanent',
      }),
    ]);
    expect(await runDlqCli(['replay', '#0', '--execute'], forged.deps as any)).toBe(1);
    expect(forged.stdout.join('')).toContain('classified as signer_not_attester');
  });

  test('discard requires a reason and audits instead of re-enqueueing', async () => {
    const missingReason = createDeps([createDlqEntry()]);
    expect(await runDlqCli(['discard', '#0', '--execute'], missingReason.deps as any)).toBe(2);
    expect(missingReason.stderr.join('')).toContain('discard requires --reason');

    const withReason = createDeps([createDlqEntry()]);
    expect(
      await runDlqCli(
        ['discard', '#0', '--reason', 'lineage advanced', '--execute'],
        withReason.deps as any,
      ),
    ).toBe(0);
    expect(withReason.multi.lRem).toHaveBeenCalledWith(
      'hokusai:mint_requests:dlq',
      1,
      expect.any(String),
    );
    expect(withReason.multi.lPush).toHaveBeenCalledWith(
      'hokusai:mint_requests:dlq:audit',
      expect.stringContaining('"action":"discard"'),
    );
  });
});
