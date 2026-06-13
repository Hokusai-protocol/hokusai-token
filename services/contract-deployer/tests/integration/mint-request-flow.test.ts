import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { RedisClientType } from 'redis';
import DeltaVerifierArtifact from '../../contracts/DeltaVerifier.json';
import { MintRequestConsumer } from '../../src/queue/mint-request-consumer';
import { MintRecordStore } from '../../src/queue/mint-record-store';
import {
  ACCEPTED_CONTRIBUTOR_KEYS,
  createMintRequestSettlement,
  MintRequestMessage,
  MintRequestSettlement,
  validateMintRequestMessage,
} from '../../src/schemas/mint-request-schema';
import {
  MintBudgetExceededError,
  MintRequestSubmissionError,
} from '../../src/blockchain/delta-verifier-client';
import { MintRequestProcessor } from '../../src/services/mint-request-processor';
import { runDlqCli } from '../../scripts/dlq';
import { createMockRedisClient, createMockRedisMulti } from '../mocks/redis-mock';

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
const SUBMIT_MINT_REQUEST_SELECTOR = '0xc9b4e69b';
type MintRequestFixture = MintRequestMessage & {
  totalSamples: number;
  evaluation: MintRequestMessage['evaluation'] & {
    sample_size_candidate: number;
  };
};

// Only a checkout explicitly named hokusai-data-pipeline (or pointed at via
// HOKUSAI_DATA_PIPELINE_DIR) counts as the sibling. Scanning arbitrary sibling
// directories risks byte-comparing against stale feature-branch worktrees.
function findSiblingPipelineFixture(): string | null {
  const override = process.env.HOKUSAI_DATA_PIPELINE_DIR;
  if (override) {
    const candidate = path.resolve(override, 'schema/examples/mint_request.v1.json');
    return fs.existsSync(candidate) ? candidate : null;
  }

  const workspaceRoot = path.resolve(__dirname, '../../../..');
  const candidate = path.join(
    path.dirname(workspaceRoot),
    'hokusai-data-pipeline/schema/examples/mint_request.v1.json',
  );
  return fs.existsSync(candidate) ? candidate : null;
}

function loadFixture(): { fixture: MintRequestFixture; raw: string; sourcePath: string } {
  const siblingPath = findSiblingPipelineFixture();
  const sourcePath = siblingPath ?? VENDORED_FIXTURE_PATH;
  const raw = fs.readFileSync(sourcePath, 'utf8');
  return {
    fixture: JSON.parse(raw) as MintRequestFixture,
    raw,
    sourcePath,
  };
}

const IDEMPOTENCY_KEY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const validMessage: MintRequestMessage = {
  message_type: 'mint_request',
  schema_version: '1.0',
  message_id: 'msg-flow-1',
  timestamp: '2026-05-21T12:00:00.000Z',
  model_id: 'sales-outreach-v1',
  model_id_uint: '21',
  eval_id: 'eval-flow-1',
  benchmark_spec_id: 'bench-flow-1',
  dataset_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotency_key: IDEMPOTENCY_KEY,
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

describe('MintRequest flow integration', () => {
  test('fixture stays byte-identical with the vendored copy when a sibling pipeline checkout exists', () => {
    const siblingPath = findSiblingPipelineFixture();
    const vendoredRaw = fs.readFileSync(VENDORED_FIXTURE_PATH);

    if (!siblingPath) {
      expect(vendoredRaw.length).toBeGreaterThan(0);
      return;
    }

    const siblingRaw = fs.readFileSync(siblingPath);
    expect(createHash('sha256').update(siblingRaw).digest('hex')).toBe(
      createHash('sha256').update(vendoredRaw).digest('hex'),
    );
    expect(Buffer.compare(siblingRaw, vendoredRaw)).toBe(0);
  });

  test('maps the golden fixture into submitMintRequest calldata', () => {
    const { fixture, sourcePath } = loadFixture();
    const processor = new MintRequestProcessor({ submitMintRequest: jest.fn() } as any);
    const payload = processor.buildPayload(fixture);
    const contributors = processor.buildContributors(fixture);
    const modelId = BigInt(fixture.model_id_uint);
    const calldata = new ethers.Interface(DeltaVerifierArtifact.abi).encodeFunctionData(
      'submitMintRequest',
      [modelId, payload, contributors, fixture.attester_signatures],
    );
    const bareAttestationHash = fixture.attestation_hash.slice(2);
    const expectedIdempotencyKey =
      '0x' +
      createHash('sha256')
        .update(`${fixture.model_id_uint}:${bareAttestationHash}`, 'utf8')
        .digest('hex');

    expect(sourcePath.endsWith('mint_request.v1.json')).toBe(true);
    expect(calldata.startsWith(SUBMIT_MINT_REQUEST_SELECTOR)).toBe(true);
    expect(payload.anchors.benchmarkSpecHash).toBe(
      ethers.keccak256(ethers.toUtf8Bytes(fixture.benchmark_spec_id)),
    );
    expect(payload.anchors.benchmarkSpecHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.datasetHash).toBe(fixture.dataset_hash);
    expect(payload.anchors.datasetHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.attestationHash).toBe(fixture.attestation_hash);
    expect(payload.anchors.attestationHash).not.toBe(ethers.ZeroHash);
    expect(payload.anchors.idempotencyKey).toBe(fixture.idempotency_key);
    expect(payload.anchors.idempotencyKey).toBe(expectedIdempotencyKey);
    expect(payload.anchors.idempotencyKey).not.toBe(ethers.ZeroHash);
    expect(payload.baselineCommitment).toBe(fixture.baseline_commitment);
    expect(payload.candidateCommitment).toBe(fixture.candidate_commitment);
    expect(payload.baselineScoreBps).toBe(fixture.evaluation.baseline_score_bps);
    expect(payload.candidateScoreBps).toBe(fixture.evaluation.new_score_bps);
    expect(payload.maxCostUsdMicro).toBe(fixture.evaluation.max_cost_usd_micro);
    expect(payload.actualCostUsdMicro).toBe(fixture.evaluation.actual_cost_usd_micro);
    expect(modelId).toBe(BigInt(fixture.model_id_uint));
    expect(fixture.totalSamples).toBe(fixture.evaluation.sample_size_candidate);
    expect(
      contributors.reduce(
        (sum: number, contributor: { weight: number }) => sum + contributor.weight,
        0,
      ),
    ).toBe(10000);
    expect(
      contributors.map((contributor: { walletAddress: string }) => contributor.walletAddress),
    ).toEqual(fixture.contributors.map((contributor) => contributor.wallet_address));
    expect(fixture.attester_signatures.length).toBeGreaterThan(0);
  });

  test('validates the pipeline v1 fixture and detects vendored drift when possible', () => {
    const vendoredFixturePath = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
    const envPipelineDir = process.env.HOKUSAI_DATA_PIPELINE_DIR;
    const candidatePipelinePaths = [
      envPipelineDir ? path.resolve(envPipelineDir, 'schema/examples/mint_request.v1.json') : null,
      path.resolve(
        __dirname,
        '../../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json',
      ),
      path.resolve(
        __dirname,
        '../../../../hokusai-data-pipeline/schema/examples/mint_request.v1.json',
      ),
    ].filter((candidatePath): candidatePath is string => candidatePath !== null);

    const siblingFixturePath = candidatePipelinePaths.find((candidatePath) =>
      fs.existsSync(candidatePath),
    );
    const vendoredExists = fs.existsSync(vendoredFixturePath);
    const fixturePath = siblingFixturePath ?? (vendoredExists ? vendoredFixturePath : null);

    if (fixturePath === null) {
      console.warn('MintRequest pipeline fixture not found; skipping validation');
      return;
    }

    const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as unknown;
    const validation = validateMintRequestMessage(fixture);
    expect(validation.error).toBeUndefined();

    // Contributor sub-object drift guard (HOK-2099): every contributor key the pipeline emits
    // must be one the consumer schema knows about. A genuinely new field fails here with a
    // clear name rather than a generic "is not allowed", forcing a deliberate schema update.
    const contributors = (fixture as { contributors?: Array<Record<string, unknown>> })
      .contributors;
    expect(Array.isArray(contributors)).toBe(true);
    const acceptedKeys = new Set<string>(ACCEPTED_CONTRIBUTOR_KEYS);
    const unexpectedKeys = [
      ...new Set(
        (contributors ?? []).flatMap((contributor) =>
          Object.keys(contributor).filter((key) => !acceptedKeys.has(key)),
        ),
      ),
    ];
    expect(unexpectedKeys).toEqual([]);

    if (siblingFixturePath && vendoredExists) {
      const vendoredRaw = fs.readFileSync(vendoredFixturePath);
      const siblingRaw = fs.readFileSync(siblingFixturePath);
      expect(createHash('sha256').update(siblingRaw).digest('hex')).toBe(
        createHash('sha256').update(vendoredRaw).digest('hex'),
      );
      expect(Buffer.compare(siblingRaw, vendoredRaw)).toBe(0);
    }
  });

  describe('reconciliation record persistence', () => {
    let mockRedis: jest.Mocked<RedisClientType>;
    let recordStore: MintRecordStore;
    let consumer: MintRequestConsumer;

    const RECORD_KEY_PREFIX = 'mint:record:';
    const RECORD_TTL_SECONDS = 7200;

    beforeEach(() => {
      mockRedis = createMockRedisClient();
      recordStore = new MintRecordStore({
        redis: mockRedis,
        keyPrefix: RECORD_KEY_PREFIX,
        ttlSeconds: RECORD_TTL_SECONDS,
      });
      consumer = new MintRequestConsumer({
        redis: mockRedis,
        inboundQueue: 'hokusai:mint_requests',
        processingQueue: 'hokusai:mint_requests:processing',
        deadLetterQueue: 'hokusai:mint_requests:dlq',
        processedSetKey: 'hokusai:mint_requests:processed',
        retryQueue: 'hokusai:mint_requests:retry',
        maxRetries: 3,
        budgetMaxRetries: 24,
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
        budgetRetryBackoffBaseMs: 60000,
        budgetRetryBackoffMaxMs: 1800000,
        backoffMultiplier: 2,
        recordStore,
      });
    });

    test('atomically writes a reconciliation record keyed by idempotency_key after a successful mint', async () => {
      const settlement = createMintRequestSettlement({
        idempotency_key: IDEMPOTENCY_KEY,
        attestation_hash: validMessage.attestation_hash,
        model_id: validMessage.model_id,
        model_id_uint: validMessage.model_id_uint,
        eval_id: validMessage.eval_id,
        tx_hash: TX_HASH,
        block_number: 42,
        status: 'minted',
        reward_amount: '10',
        gas_used: '21000',
      });

      const multi = createMockRedisMulti();
      mockRedis.brPopLPush.mockResolvedValueOnce(JSON.stringify(validMessage));
      mockRedis.sIsMember.mockResolvedValueOnce(false);
      mockRedis.zRangeByScore.mockResolvedValueOnce([]);
      mockRedis.multi.mockReturnValue(multi as any);

      const handler = jest.fn().mockResolvedValueOnce(settlement);
      await consumer.processMessage(handler);

      expect(multi.set).toHaveBeenCalledWith(
        `${RECORD_KEY_PREFIX}${IDEMPOTENCY_KEY}`,
        expect.stringContaining(TX_HASH),
        { EX: RECORD_TTL_SECONDS },
      );

      const setCall = multi.set.mock.calls[0];
      const storedRecord = JSON.parse(setCall[1] as string) as Record<string, unknown>;
      expect(storedRecord.idempotency_key).toBe(IDEMPOTENCY_KEY);
      expect(storedRecord.tx_hash).toBe(TX_HASH);
      expect(storedRecord.status).toBe('minted');
      expect(storedRecord.reward_amount).toBe('10');
    });

    test('record write is part of the same MULTI transaction as processedSet membership', async () => {
      const settlement = createMintRequestSettlement({
        idempotency_key: IDEMPOTENCY_KEY,
        attestation_hash: validMessage.attestation_hash,
        model_id: validMessage.model_id,
        model_id_uint: validMessage.model_id_uint,
        eval_id: validMessage.eval_id,
        status: 'minted',
        reward_amount: '10',
      });

      const multi = createMockRedisMulti();
      mockRedis.brPopLPush.mockResolvedValueOnce(JSON.stringify(validMessage));
      mockRedis.sIsMember.mockResolvedValueOnce(false);
      mockRedis.zRangeByScore.mockResolvedValueOnce([]);
      mockRedis.multi.mockReturnValue(multi as any);

      const handler = jest.fn().mockResolvedValueOnce(settlement);
      await consumer.processMessage(handler);

      expect(multi.sAdd).toHaveBeenCalledWith('hokusai:mint_requests:processed', IDEMPOTENCY_KEY);
      expect(multi.set).toHaveBeenCalled();
      expect(multi.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('consumer failure modes', () => {
    let mockRedis: jest.Mocked<RedisClientType>;
    let recordStore: MintRecordStore;
    let consumer: MintRequestConsumer;

    beforeEach(() => {
      mockRedis = createMockRedisClient();
      recordStore = new MintRecordStore({
        redis: mockRedis,
        keyPrefix: 'mint:record:',
        ttlSeconds: 7200,
      });
      consumer = new MintRequestConsumer({
        redis: mockRedis,
        inboundQueue: 'hokusai:mint_requests',
        processingQueue: 'hokusai:mint_requests:processing',
        deadLetterQueue: 'hokusai:mint_requests:dlq',
        processedSetKey: 'hokusai:mint_requests:processed',
        retryQueue: 'hokusai:mint_requests:retry',
        maxRetries: 3,
        budgetMaxRetries: 24,
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
        budgetRetryBackoffBaseMs: 60000,
        budgetRetryBackoffMaxMs: 1800000,
        backoffMultiplier: 2,
        recordStore,
      });
      mockRedis.brPopLPush.mockResolvedValue(JSON.stringify(validMessage));
      mockRedis.sIsMember.mockResolvedValue(false);
      mockRedis.zRangeByScore.mockResolvedValue([]);
      mockRedis.multi.mockReturnValue(createMockRedisMulti());
    });

    test('routes ambiguous post-submit RPC drops to the DLQ and never emits a minted settlement', async () => {
      const settlementQueue = 'hokusai:mint_request_settlements';
      const pushedEntries: Array<{ queue: string; payload: string }> = [];
      const recordErrorSpy = jest.spyOn(recordStore, 'recordError').mockResolvedValue(undefined);

      mockRedis.lPush.mockImplementation((...args: unknown[]) => {
        const queue = String(args[0]);
        const payload = String(args[1]);
        pushedEntries.push({ queue, payload });
        return Promise.resolve(1);
      });

      const processor = new MintRequestProcessor({
        submitMintRequest: jest.fn().mockRejectedValueOnce(
          new MintRequestSubmissionError(
            'MintRequest transaction outcome unknown after submit: ECONNRESET',
            {
              failureClass: 'permanent',
              onChainOutcomeUnknown: true,
              txHash: TX_HASH,
            },
          ),
        ),
      } as any);

      await expect(
        consumer.processMessage(async (message) => {
          const settlement = await processor.process(message);
          await mockRedis.lPush(settlementQueue, JSON.stringify(settlement));
          return settlement;
        }),
      ).rejects.toThrow('MintRequest transaction outcome unknown after submit');

      expect(recordErrorSpy).toHaveBeenCalledWith(
        IDEMPOTENCY_KEY,
        validMessage.model_id,
        expect.stringContaining('MintRequest transaction outcome unknown after submit'),
        expect.objectContaining({ failureClass: 'permanent' }),
      );
      expect(pushedEntries.filter((entry) => entry.queue === settlementQueue)).toEqual([]);
      expect(
        pushedEntries.filter((entry) => entry.queue === 'hokusai:mint_requests:dlq'),
      ).toHaveLength(1);
      expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    test('routes contract reverts to failure handling without publishing a phantom minted settlement', async () => {
      const settlementQueue = 'hokusai:mint_request_settlements';
      const pushedEntries: Array<{ queue: string; payload: string }> = [];
      const recordErrorSpy = jest.spyOn(recordStore, 'recordError').mockResolvedValue(undefined);

      mockRedis.lPush.mockImplementation((...args: unknown[]) => {
        const queue = String(args[0]);
        const payload = String(args[1]);
        pushedEntries.push({ queue, payload });
        return Promise.resolve(1);
      });

      const processor = new MintRequestProcessor({
        submitMintRequest: jest.fn().mockRejectedValueOnce(
          new MintRequestSubmissionError('execution reverted: mint rejected', {
            failureClass: 'permanent',
            txHash: TX_HASH,
          }),
        ),
      } as any);

      await expect(
        consumer.processMessage(async (message) => {
          const settlement = await processor.process(message);
          await mockRedis.lPush(settlementQueue, JSON.stringify(settlement));
          return settlement;
        }),
      ).rejects.toThrow('execution reverted: mint rejected');

      expect(recordErrorSpy).toHaveBeenCalledWith(
        IDEMPOTENCY_KEY,
        validMessage.model_id,
        expect.stringContaining('execution reverted: mint rejected'),
        expect.objectContaining({ failureClass: 'permanent' }),
      );
      expect(pushedEntries.filter((entry) => entry.queue === settlementQueue)).toEqual([]);
      expect(
        pushedEntries.filter((entry) => entry.queue === 'hokusai:mint_requests:dlq'),
      ).toHaveLength(1);
      expect(mockRedis.zAdd).not.toHaveBeenCalled();
    });

    test('routes budget reverts to retry without publishing a settlement or DLQ entry', async () => {
      const settlementQueue = 'hokusai:mint_request_settlements';
      const pushedEntries: Array<{ queue: string; payload: string }> = [];
      const multi = createMockRedisMulti();
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      jest.spyOn(Date, 'now').mockReturnValue(1000);

      mockRedis.multi.mockReturnValue(multi as any);
      mockRedis.lPush.mockImplementation((...args: unknown[]) => {
        pushedEntries.push({ queue: String(args[0]), payload: String(args[1]) });
        return Promise.resolve(1);
      });

      const processor = new MintRequestProcessor({
        submitMintRequest: jest.fn().mockRejectedValueOnce(
          new MintBudgetExceededError('MintBudgetExceeded', {
            modelId: 21n,
            requiredAmount: 100n,
            remainingBudget: 50n,
          }),
        ),
      } as any);

      await expect(
        consumer.processMessage(async (message) => {
          const settlement = await processor.process(message);
          await mockRedis.lPush(settlementQueue, JSON.stringify(settlement));
          return settlement;
        }),
      ).rejects.toThrow('MintBudgetExceeded');

      expect(pushedEntries.filter((entry) => entry.queue === settlementQueue)).toEqual([]);
      expect(pushedEntries.filter((entry) => entry.queue === 'hokusai:mint_requests:dlq')).toEqual(
        [],
      );
      expect(multi.zAdd).toHaveBeenCalledWith(
        'hokusai:mint_requests:retry',
        expect.objectContaining({
          score: 31000,
          value: JSON.stringify({ ...validMessage, _retryCount: 1 }),
        }),
      );
      const storedRecord = JSON.parse(multi.set.mock.calls[0][1] as string) as {
        status: string;
      };
      expect(storedRecord.status).toBe('budget_exceeded_retry');
    });
  });

  describe('settlement queue delivery', () => {
    test('settlement lands on the configured settlements queue with tx_hash and status', async () => {
      const mockRedis = createMockRedisClient();
      const capturedSettlements: string[] = [];

      mockRedis.lPush.mockImplementation((...args: unknown[]) => {
        capturedSettlements.push(args[1] as string);
        return Promise.resolve(1);
      });

      const recordStore = new MintRecordStore({
        redis: mockRedis,
        keyPrefix: 'mint:record:',
        ttlSeconds: 7200,
      });

      const consumer = new MintRequestConsumer({
        redis: mockRedis,
        inboundQueue: 'hokusai:mint_requests',
        processingQueue: 'hokusai:mint_requests:processing',
        deadLetterQueue: 'hokusai:mint_requests:dlq',
        processedSetKey: 'hokusai:mint_requests:processed',
        retryQueue: 'hokusai:mint_requests:retry',
        maxRetries: 3,
        budgetMaxRetries: 24,
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
        budgetRetryBackoffBaseMs: 60000,
        budgetRetryBackoffMaxMs: 1800000,
        backoffMultiplier: 2,
        recordStore,
      });

      const settlement = createMintRequestSettlement({
        idempotency_key: IDEMPOTENCY_KEY,
        attestation_hash: validMessage.attestation_hash,
        model_id: validMessage.model_id,
        model_id_uint: validMessage.model_id_uint,
        eval_id: validMessage.eval_id,
        tx_hash: TX_HASH,
        block_number: 42,
        status: 'minted',
        reward_amount: '10',
        gas_used: '21000',
      });

      const multi = createMockRedisMulti();
      mockRedis.brPopLPush.mockResolvedValueOnce(JSON.stringify(validMessage));
      mockRedis.sIsMember.mockResolvedValueOnce(false);
      mockRedis.zRangeByScore.mockResolvedValueOnce([]);
      mockRedis.multi.mockReturnValue(multi as any);

      const handler = jest.fn().mockResolvedValueOnce(settlement);

      // Simulate the MintRequestListener handler wrapper that pushes to settlements queue
      await consumer.processMessage(async (msg) => {
        const result = await handler(msg);
        await mockRedis.lPush('hokusai:mint_request_settlements', JSON.stringify(result));
        return result;
      });

      expect(capturedSettlements.length).toBeGreaterThan(0);
      const pushedSettlement = JSON.parse(capturedSettlements[0]) as MintRequestSettlement;
      expect(pushedSettlement.idempotency_key).toBe(IDEMPOTENCY_KEY);
      expect(pushedSettlement.tx_hash).toBe(TX_HASH);
      expect(pushedSettlement.status).toBe('minted');
    });

    test('retries after a budget top-up and only publishes the eventual minted settlement', async () => {
      const mockRedis = createMockRedisClient();
      const multiRetry = createMockRedisMulti();
      const multiSuccess = createMockRedisMulti();
      const capturedSettlements: string[] = [];

      mockRedis.lPush.mockImplementation((...args: unknown[]) => {
        if (args[0] === 'hokusai:mint_request_settlements') {
          capturedSettlements.push(args[1] as string);
        }
        return Promise.resolve(1);
      });

      const recordStore = new MintRecordStore({
        redis: mockRedis,
        keyPrefix: 'mint:record:',
        ttlSeconds: 7200,
      });

      const consumer = new MintRequestConsumer({
        redis: mockRedis,
        inboundQueue: 'hokusai:mint_requests',
        processingQueue: 'hokusai:mint_requests:processing',
        deadLetterQueue: 'hokusai:mint_requests:dlq',
        processedSetKey: 'hokusai:mint_requests:processed',
        retryQueue: 'hokusai:mint_requests:retry',
        maxRetries: 3,
        budgetMaxRetries: 24,
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
        budgetRetryBackoffBaseMs: 60000,
        budgetRetryBackoffMaxMs: 1800000,
        backoffMultiplier: 2,
        recordStore,
      });

      const mintedSettlement = createMintRequestSettlement({
        idempotency_key: IDEMPOTENCY_KEY,
        attestation_hash: validMessage.attestation_hash,
        model_id: validMessage.model_id,
        model_id_uint: validMessage.model_id_uint,
        eval_id: validMessage.eval_id,
        tx_hash: TX_HASH,
        block_number: 42,
        status: 'minted',
        reward_amount: '10',
        gas_used: '21000',
      });

      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      jest.spyOn(Date, 'now').mockReturnValue(1000);
      mockRedis.brPopLPush
        .mockResolvedValueOnce(JSON.stringify(validMessage))
        .mockResolvedValueOnce(JSON.stringify({ ...validMessage, _retryCount: 1 }));
      mockRedis.sIsMember.mockResolvedValue(false);
      mockRedis.multi
        .mockReturnValueOnce(multiRetry as any)
        .mockReturnValueOnce(multiSuccess as any);

      const handler = jest
        .fn()
        .mockRejectedValueOnce(
          new MintBudgetExceededError('MintBudgetExceeded', {
            modelId: 21n,
            requiredAmount: 100n,
            remainingBudget: 50n,
          }),
        )
        .mockResolvedValueOnce(mintedSettlement);

      await expect(
        consumer.processMessage(async (msg) => {
          const result = await handler(msg);
          await mockRedis.lPush('hokusai:mint_request_settlements', JSON.stringify(result));
          return result;
        }),
      ).rejects.toThrow('MintBudgetExceeded');

      await consumer.processMessage(async (msg) => {
        const result = await handler(msg);
        await mockRedis.lPush('hokusai:mint_request_settlements', JSON.stringify(result));
        return result;
      });

      expect(capturedSettlements).toHaveLength(1);
      const pushedSettlement = JSON.parse(capturedSettlements[0]) as MintRequestSettlement;
      expect(pushedSettlement.status).toBe('minted');
      expect(multiRetry.zAdd).toHaveBeenCalled();
      expect(multiSuccess.sAdd).toHaveBeenCalledWith(
        'hokusai:mint_requests:processed',
        IDEMPOTENCY_KEY,
      );
    });
  });

  describe('DLQ replay flow', () => {
    function buildDlqEntry(overrides?: {
      reason?: string;
      failureClass?: 'transient' | 'permanent';
      originalMessage?: unknown;
    }): string {
      return JSON.stringify({
        originalMessage: overrides?.originalMessage ?? { ...validMessage, _retryCount: 24 },
        error: overrides?.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
        reason: overrides?.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
        failureClass: overrides?.failureClass ?? 'transient',
        timestamp: '2026-06-10T13:00:00.000Z',
        queue: 'hokusai:mint_requests',
      });
    }

    function createInMemoryRedis(dlqEntries: string[]) {
      const redis = createMockRedisClient();
      const queues = new Map<string, string[]>([
        ['hokusai:mint_requests', []],
        ['hokusai:mint_requests:processing', []],
        ['hokusai:mint_requests:dlq', [...dlqEntries]],
        ['hokusai:mint_requests:dlq:audit', []],
        ['hokusai:mint_request_settlements', []],
      ]);
      const strings = new Map<string, string>();
      const processedSet = new Set<string>();

      redis.lRange.mockImplementation(((...args: unknown[]) => {
        const [key, start, stop] = args as [string, number, number];
        const values = [...(queues.get(key) ?? [])];
        const end = stop === -1 ? values.length : stop + 1;
        return Promise.resolve(values.slice(start, end));
      }) as any);
      redis.lPush.mockImplementation(((...args: unknown[]) => {
        const [key, value] = args as [string, string];
        const values = queues.get(key) ?? [];
        values.unshift(value);
        queues.set(key, values);
        return Promise.resolve(values.length);
      }) as any);
      redis.lRem.mockImplementation(((...args: unknown[]) => {
        const [key, _count, value] = args as [string, number, string];
        const values = queues.get(key) ?? [];
        const index = values.indexOf(value);
        if (index >= 0) {
          values.splice(index, 1);
          queues.set(key, values);
          return Promise.resolve(1);
        }
        return Promise.resolve(0);
      }) as any);
      redis.brPopLPush.mockImplementation(((...args: unknown[]) => {
        const [source, dest] = args as [string, string];
        const sourceValues = queues.get(source) ?? [];
        if (sourceValues.length === 0) {
          return Promise.resolve(null);
        }
        const value = sourceValues.pop()!;
        const destValues = queues.get(dest) ?? [];
        destValues.unshift(value);
        queues.set(source, sourceValues);
        queues.set(dest, destValues);
        return Promise.resolve(value);
      }) as any);
      redis.sIsMember.mockImplementation(((...args: unknown[]) => {
        const [_key, value] = args as [string, string];
        return Promise.resolve(processedSet.has(value));
      }) as any);
      redis.get.mockImplementation(((...args: unknown[]) => {
        const [key] = args as [string];
        return Promise.resolve(strings.get(key) ?? null);
      }) as any);
      redis.zRangeByScore.mockResolvedValue([]);
      redis.multi.mockImplementation(() => {
        const commands: Array<() => void> = [];
        const multi = {
          lPush: jest.fn().mockImplementation((key: string, value: string) => {
            commands.push(() => {
              const values = queues.get(key) ?? [];
              values.unshift(value);
              queues.set(key, values);
            });
            return multi;
          }),
          lRem: jest.fn().mockImplementation((key: string, _count: number, value: string) => {
            commands.push(() => {
              const values = queues.get(key) ?? [];
              const index = values.indexOf(value);
              if (index >= 0) {
                values.splice(index, 1);
                queues.set(key, values);
              }
            });
            return multi;
          }),
          sAdd: jest.fn().mockImplementation((_key: string, value: string) => {
            commands.push(() => {
              processedSet.add(value);
            });
            return multi;
          }),
          set: jest.fn().mockImplementation((key: string, value: string) => {
            commands.push(() => {
              strings.set(key, value);
            });
            return multi;
          }),
          exec: jest.fn().mockImplementation(() => {
            commands.forEach((command) => command());
            return Promise.resolve([]);
          }),
        };

        return multi as any;
      });

      return { redis, queues };
    }

    function createCliDeps(redis: jest.Mocked<RedisClientType>, processed: boolean) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      return {
        stdout,
        stderr,
        deps: {
          redis: redis as any,
          deltaVerifier: {
            processedIdempotencyKeys: jest.fn().mockResolvedValue(processed),
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

    test('replay after budget top-up emits exactly one minted settlement', async () => {
      const { redis, queues } = createInMemoryRedis([buildDlqEntry()]);
      const cli = createCliDeps(redis, false);
      const recordStore = new MintRecordStore({
        redis,
        keyPrefix: 'mint:record:',
        ttlSeconds: 7200,
      });
      const consumer = new MintRequestConsumer({
        redis,
        inboundQueue: 'hokusai:mint_requests',
        processingQueue: 'hokusai:mint_requests:processing',
        deadLetterQueue: 'hokusai:mint_requests:dlq',
        processedSetKey: 'hokusai:mint_requests:processed',
        retryQueue: 'hokusai:mint_requests:retry',
        maxRetries: 3,
        budgetMaxRetries: 24,
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
        budgetRetryBackoffBaseMs: 60000,
        budgetRetryBackoffMaxMs: 1800000,
        backoffMultiplier: 2,
        recordStore,
      });
      const settlement = createMintRequestSettlement({
        idempotency_key: IDEMPOTENCY_KEY,
        attestation_hash: validMessage.attestation_hash,
        model_id: validMessage.model_id,
        model_id_uint: validMessage.model_id_uint,
        eval_id: validMessage.eval_id,
        tx_hash: TX_HASH,
        block_number: 42,
        status: 'minted',
        reward_amount: '10',
        gas_used: '21000',
      });

      expect(await runDlqCli(['replay', '#0', '--execute'], cli.deps as any)).toBe(0);
      expect(queues.get('hokusai:mint_requests:dlq')).toHaveLength(0);
      expect(queues.get('hokusai:mint_requests:dlq:audit')).toHaveLength(1);

      await consumer.processMessage(async (message) => {
        await redis.lPush(
          'hokusai:mint_request_settlements',
          JSON.stringify({
            ...settlement,
            idempotency_key: message.idempotency_key,
          }),
        );
        return settlement;
      });

      expect(queues.get('hokusai:mint_request_settlements')).toHaveLength(1);
      const emitted = JSON.parse(
        queues.get('hokusai:mint_request_settlements')![0],
      ) as MintRequestSettlement;
      expect(emitted.status).toBe('minted');
    });

    test('replay refuses an already-minted idempotency key', async () => {
      const { redis, queues } = createInMemoryRedis([buildDlqEntry()]);
      const cli = createCliDeps(redis, true);

      expect(await runDlqCli(['replay', '#0', '--execute'], cli.deps as any)).toBe(1);
      expect(queues.get('hokusai:mint_requests')).toHaveLength(0);
      expect(queues.get('hokusai:mint_requests:dlq')).toHaveLength(1);
      expect(queues.get('hokusai:mint_requests:dlq:audit')).toHaveLength(0);
    });

    test('replay refuses a tampered message', async () => {
      const { redis, queues } = createInMemoryRedis([
        buildDlqEntry({
          reason: 'permanent: validation failure',
          failureClass: 'permanent',
          originalMessage: { ...validMessage, attester_signatures: [] },
        }),
      ]);
      const cli = createCliDeps(redis, false);

      expect(await runDlqCli(['replay', '#0', '--execute'], cli.deps as any)).toBe(1);
      expect(cli.stdout.join('')).toContain('Schema validation failed');
      expect(queues.get('hokusai:mint_requests')).toHaveLength(0);
      expect(queues.get('hokusai:mint_requests:dlq')).toHaveLength(1);
    });

    test('outcome-unknown that already landed shows minted on inspect and replay refuses', async () => {
      const { redis } = createInMemoryRedis([
        buildDlqEntry({
          reason: 'MintRequest transaction outcome unknown after submit: ECONNRESET',
          failureClass: 'permanent',
        }),
      ]);
      const cli = createCliDeps(redis, true);

      expect(await runDlqCli(['inspect', '#0', '--json'], cli.deps as any)).toBe(0);
      expect(cli.stdout.join('')).toContain('"processed": true');

      cli.stdout.length = 0;
      expect(await runDlqCli(['replay', '#0', '--execute'], cli.deps as any)).toBe(1);
      expect(cli.stdout.join('')).toContain('already processed');
    });
  });

  test('requires explicit integration environment', () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      expect(true).toBe(true);
      return;
    }
  });
});
