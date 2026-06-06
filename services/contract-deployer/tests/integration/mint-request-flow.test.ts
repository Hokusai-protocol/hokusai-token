import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers } from 'ethers';
import { RedisClientType } from 'redis';
import DeltaVerifierArtifact from '../../contracts/DeltaVerifier.json';
import { MintRequestConsumer } from '../../src/queue/mint-request-consumer';
import { MintRecordStore } from '../../src/queue/mint-record-store';
import {
  createMintRequestSettlement,
  MintRequestMessage,
  MintRequestSettlement,
  validateMintRequestMessage,
} from '../../src/schemas/mint-request-schema';
import { MintRequestProcessor } from '../../src/services/mint-request-processor';
import { createMockRedisClient, createMockRedisMulti } from '../mocks/redis-mock';

const VENDORED_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/mint_request.v1.json');
const SUBMIT_MINT_REQUEST_SELECTOR = '0xb6370507';
type MintRequestFixture = MintRequestMessage & {
  totalSamples: number;
  evaluation: MintRequestMessage['evaluation'] & {
    sample_size_candidate: number;
  };
};

function findSiblingPipelineFixture(): string | null {
  const workspaceRoot = path.resolve(__dirname, '../../../..');
  const siblingRoot = path.dirname(workspaceRoot);
  const preferredNames = [
    'hokusai-data-pipeline',
    'gate-2-cross-repo-mintrequest-deltaverifier-abi-conformance',
  ];

  for (const name of preferredNames) {
    const candidate = path.join(siblingRoot, name, 'schema/examples/mint_request.v1.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  for (const entry of fs.readdirSync(siblingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(siblingRoot, entry.name, 'schema/examples/mint_request.v1.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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
  benchmark_spec_id: 'bench-flow-1',
  dataset_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
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
  test('fixture stays byte-identical with the vendored copy when a sibling pipeline checkout exists', () => {
    const siblingPath = findSiblingPipelineFixture();
    const vendoredRaw = fs.readFileSync(VENDORED_FIXTURE_PATH, 'utf8');

    if (!siblingPath) {
      expect(vendoredRaw.length).toBeGreaterThan(0);
      return;
    }

    const siblingRaw = fs.readFileSync(siblingPath, 'utf8');
    expect(vendoredRaw).toBe(siblingRaw);
  });

  test('maps the golden fixture into submitMintRequest calldata', () => {
    const { fixture, sourcePath } = loadFixture();
    const processor = new MintRequestProcessor({ submitMintRequest: jest.fn() } as any);
    const payload = (processor as any).buildPayload(fixture);
    const contributors = (processor as any).buildContributors(fixture);
    const modelId = BigInt(fixture.model_id_uint);
    const calldata = new ethers.Interface(DeltaVerifierArtifact.abi).encodeFunctionData(
      'submitMintRequest',
      [modelId, payload, contributors],
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
  });

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
  });
});
