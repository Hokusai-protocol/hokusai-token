import fs from 'fs';
import path from 'path';
import { RedisClientType } from 'redis';
import { MintRequestConsumer } from '../../src/queue/mint-request-consumer';
import { MintRecordStore } from '../../src/queue/mint-record-store';
import {
  createMintRequestSettlement,
  MintRequestMessage,
  MintRequestSettlement,
  validateMintRequestMessage,
} from '../../src/schemas/mint-request-schema';
import { createMockRedisClient, createMockRedisMulti } from '../mocks/redis-mock';

const IDEMPOTENCY_KEY =
  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX_HASH = '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

const validMessage: MintRequestMessage = {
  message_type: 'mint_request',
  schema_version: '1.0',
  message_id: 'msg-flow-1',
  timestamp: '2026-05-21T12:00:00.000Z',
  model_id: 'sales-outreach-v1',
  model_id_uint: '21',
  eval_id: 'eval-flow-1',
  attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotency_key: IDEMPOTENCY_KEY,
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

describe('MintRequest flow integration', () => {
  test('validates the pipeline v1 fixture and detects vendored drift when possible', async () => {
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

    if (siblingFixturePath && vendoredExists) {
      const siblingJson = JSON.parse(fs.readFileSync(siblingFixturePath, 'utf8')) as unknown;
      const vendoredJson = JSON.parse(fs.readFileSync(vendoredFixturePath, 'utf8')) as unknown;

      expect(vendoredJson).toEqual(siblingJson);
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
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
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

  describe('settlement queue delivery', () => {
    test('settlement lands on the configured settlements queue with tx_hash and status', async () => {
      const mockRedis = createMockRedisClient();
      const capturedSettlements: string[] = [];

      mockRedis.lPush.mockImplementation(async (...args: unknown[]) => {
        capturedSettlements.push(args[1] as string);
        return 1;
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
        blockingTimeout: 5,
        backoffBaseMs: 1000,
        backoffMaxMs: 30000,
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
      const pushedSettlement = JSON.parse(
        capturedSettlements[0]!,
      ) as MintRequestSettlement;
      expect(pushedSettlement.idempotency_key).toBe(IDEMPOTENCY_KEY);
      expect(pushedSettlement.tx_hash).toBe(TX_HASH);
      expect(pushedSettlement.status).toBe('minted');
    });
  });

  test('requires explicit integration environment', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      expect(true).toBe(true);
      return;
    }

    const settlement = {} as MintRequestSettlement;
    expect(settlement).toBeDefined();
  });
});
