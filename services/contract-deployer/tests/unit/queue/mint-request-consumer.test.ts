import { RedisClientType } from 'redis';
import { MintRequestConsumer } from '../../../src/queue/mint-request-consumer';
import { MintRecordStore } from '../../../src/queue/mint-record-store';
import { MintBudgetExceededError } from '../../../src/blockchain/delta-verifier-client';
import {
  createMintRequestSettlement,
  MintRequestMessage,
} from '../../../src/schemas/mint-request-schema';
import { createMockRedisClient, createMockRedisMulti } from '../../mocks/redis-mock';

describe('MintRequestConsumer', () => {
  let consumer: MintRequestConsumer;
  let mockRedis: jest.Mocked<RedisClientType>;
  let handler: jest.Mock;
  let recordStore: MintRecordStore;

  const validMessage: MintRequestMessage = {
    message_type: 'mint_request',
    schema_version: '1.0',
    message_id: 'msg-1',
    timestamp: '2026-05-12T12:00:00.000Z',
    model_id: 'sales-outreach-v1',
    model_id_uint: '21',
    eval_id: 'eval-1',
    benchmark_spec_id: 'bench-1',
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

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    handler = jest.fn();
    recordStore = new MintRecordStore({
      redis: mockRedis,
      keyPrefix: 'mint:record:',
      ttlSeconds: 3600,
    });
    consumer = new MintRequestConsumer({
      redis: mockRedis,
      inboundQueue: 'mint',
      processingQueue: 'mint:processing',
      deadLetterQueue: 'mint:dlq',
      processedSetKey: 'mint:processed',
      retryQueue: 'mint:retry',
      maxRetries: 3,
      budgetMaxRetries: 5,
      blockingTimeout: 5,
      backoffBaseMs: 1000,
      backoffMaxMs: 10000,
      budgetRetryBackoffBaseMs: 60000,
      budgetRetryBackoffMaxMs: 1800000,
      backoffMultiplier: 2,
      recordStore,
    });
  });

  test('processes, acknowledges, and marks a valid message processed', async () => {
    const messageStr = JSON.stringify(validMessage);
    const multi = createMockRedisMulti();
    const settlement = createMintRequestSettlement({
      idempotency_key: validMessage.idempotency_key,
      attestation_hash: validMessage.attestation_hash,
      model_id: validMessage.model_id,
      model_id_uint: validMessage.model_id_uint,
      eval_id: validMessage.eval_id,
      tx_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      block_number: 42,
      status: 'minted',
      reward_amount: '10',
      gas_used: '21000',
    });
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    mockRedis.multi.mockReturnValue(multi as any);
    handler.mockResolvedValueOnce(settlement);

    await consumer.processMessage(handler);

    expect(handler).toHaveBeenCalledWith(validMessage);
    expect(multi.sAdd).toHaveBeenCalledWith('mint:processed', validMessage.idempotency_key);
    expect(multi.lRem).toHaveBeenCalledWith('mint:processing', 1, messageStr);
    expect(multi.set).toHaveBeenCalledWith(
      `mint:record:${validMessage.idempotency_key}`,
      expect.any(String),
      { EX: 3600 },
    );
  });

  test('skips a redis-replayed message', async () => {
    const messageStr = JSON.stringify(validMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(true);
    mockRedis.lRem.mockResolvedValueOnce(1);

    await consumer.processMessage(handler);

    expect(handler).not.toHaveBeenCalled();
    expect(mockRedis.lRem).toHaveBeenCalledWith('mint:processing', 1, messageStr);
  });

  test('requeues transient failures into the delayed retry queue', async () => {
    const messageStr = JSON.stringify(validMessage);
    const multi = createMockRedisMulti();
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(new Error('temporary failure'));
    mockRedis.multi.mockReturnValue(multi as any);

    await expect(consumer.processMessage(handler)).rejects.toThrow('temporary failure');

    expect(multi.lRem).toHaveBeenCalledWith('mint:processing', 1, messageStr);
    expect(multi.zAdd).toHaveBeenCalledWith(
      'mint:retry',
      expect.objectContaining({
        value: JSON.stringify({ ...validMessage, _retryCount: 1 }),
      }),
    );
  });

  test('requeues budget exceeded failures with budget backoff and record-only status', async () => {
    const messageStr = JSON.stringify(validMessage);
    const multi = createMockRedisMulti();
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    mockRedis.multi.mockReturnValue(multi as any);
    jest.spyOn(Math, 'random').mockReturnValue(0.5);
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    handler.mockRejectedValueOnce(
      new MintBudgetExceededError('MintBudgetExceeded', {
        modelId: 21n,
        requiredAmount: 100n,
        remainingBudget: 50n,
      }),
    );

    await expect(consumer.processMessage(handler)).rejects.toThrow('MintBudgetExceeded');

    expect(multi.zAdd).toHaveBeenCalledWith(
      'mint:retry',
      expect.objectContaining({
        score: expect.any(Number),
        value: JSON.stringify({ ...validMessage, _retryCount: 1 }),
      }),
    );
    const zAddPayload = multi.zAdd.mock.calls[0][1] as { score: number };
    expect(zAddPayload.score).toBe(31000);
    const storedRecord = JSON.parse(multi.set.mock.calls[0][1] as string) as {
      status: string;
      failure_class: string;
    };
    expect(storedRecord.status).toBe('budget_exceeded_retry');
    expect(storedRecord.failure_class).toBe('transient');
    expect(mockRedis.lPush).not.toHaveBeenCalledWith('mint:dlq', expect.any(String));
  });

  test('moves permanent failures to the DLQ without retrying', async () => {
    const messageStr = JSON.stringify(validMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(
      Object.assign(new Error('Model not registered'), { code: 'CALL_EXCEPTION' }),
    );
    mockRedis.lPush.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);
    mockRedis.set.mockResolvedValueOnce('OK');

    await expect(consumer.processMessage(handler)).rejects.toThrow('Model not registered');

    expect(mockRedis.lPush).toHaveBeenCalledWith('mint:dlq', expect.any(String));
    expect(mockRedis.set).toHaveBeenCalledWith(
      `mint:record:${validMessage.idempotency_key}`,
      expect.any(String),
      { EX: 3600 },
    );
  });

  test('emits a dead-letter event carrying the failure reason (HOK-1698 metric hook)', async () => {
    const messageStr = JSON.stringify(validMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(
      Object.assign(new Error('Model not registered'), { code: 'CALL_EXCEPTION' }),
    );
    mockRedis.lPush.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);
    mockRedis.set.mockResolvedValueOnce('OK');

    const events: Array<{ reason: string }> = [];
    consumer.on('dead-letter', (e: { reason: string }) => events.push(e));

    await expect(consumer.processMessage(handler)).rejects.toThrow('Model not registered');

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toContain('Model not registered');
  });

  test('moves exhausted transient failures to the DLQ', async () => {
    const exhaustedMessage = { ...validMessage, _retryCount: 3 };
    const messageStr = JSON.stringify(exhaustedMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(new Error('temporary failure'));
    mockRedis.lPush.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);
    mockRedis.set.mockResolvedValueOnce('OK');

    await expect(consumer.processMessage(handler)).rejects.toThrow('temporary failure');

    const firstDlqCall = mockRedis.lPush.mock.calls[0];
    expect(firstDlqCall).toBeDefined();
    const dlqPayload = firstDlqCall?.[1] as string;
    expect(dlqPayload).toContain('exhausted (retries=3): temporary failure');
  });

  test('moves exhausted budget retries to the DLQ with a budget-specific reason', async () => {
    const exhaustedMessage = { ...validMessage, _retryCount: 5 };
    const messageStr = JSON.stringify(exhaustedMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(
      new MintBudgetExceededError('MintBudgetExceeded', {
        modelId: 21n,
        requiredAmount: 100n,
        remainingBudget: 50n,
      }),
    );
    mockRedis.lPush.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);
    mockRedis.set.mockResolvedValueOnce('OK');

    await expect(consumer.processMessage(handler)).rejects.toThrow('MintBudgetExceeded');

    const dlqPayload = mockRedis.lPush.mock.calls[0][1] as string;
    expect(dlqPayload).toContain('budget_exhausted (retries=5): MintBudgetExceeded');
  });

  test('promotes due retries before consuming a new message', async () => {
    const retryMessage = JSON.stringify({ ...validMessage, _retryCount: 1 });
    const messageStr = JSON.stringify(validMessage);
    const retryMulti = createMockRedisMulti();
    const successMulti = createMockRedisMulti();
    const settlement = createMintRequestSettlement({
      idempotency_key: validMessage.idempotency_key,
      attestation_hash: validMessage.attestation_hash,
      model_id: validMessage.model_id,
      model_id_uint: validMessage.model_id_uint,
      eval_id: validMessage.eval_id,
      tx_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      block_number: 42,
      status: 'minted',
      reward_amount: '10',
      gas_used: '21000',
    });
    let startCalls = 0;

    mockRedis.zRangeByScore.mockResolvedValueOnce([retryMessage]).mockResolvedValueOnce([]);
    mockRedis.brPopLPush.mockImplementation(() => {
      startCalls += 1;
      if (startCalls === 1) {
        consumer.stop();
        return Promise.resolve(messageStr);
      }
      return Promise.resolve(null);
    });
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    mockRedis.multi.mockReturnValueOnce(retryMulti as any).mockReturnValueOnce(successMulti as any);
    handler.mockResolvedValueOnce(settlement);

    await consumer.start(handler);

    expect(retryMulti.lPush).toHaveBeenCalledWith('mint', retryMessage);
    expect(retryMulti.zRem).toHaveBeenCalledWith('mint:retry', retryMessage);
    expect(handler).toHaveBeenCalledWith(validMessage);
  });

  test('moves invalid messages to the DLQ', async () => {
    const messageStr = JSON.stringify({ bad: 'payload' });
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.lPush.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);

    await consumer.processMessage(handler);

    expect(handler).not.toHaveBeenCalled();
    expect(mockRedis.lPush).toHaveBeenCalledWith('mint:dlq', expect.any(String));
  });
});
