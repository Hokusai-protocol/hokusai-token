import { RedisClientType } from 'redis';
import { MintRequestConsumer } from '../../../src/queue/mint-request-consumer';
import { createMockRedisClient } from '../../mocks/redis-mock';
import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';

describe('MintRequestConsumer', () => {
  let consumer: MintRequestConsumer;
  let mockRedis: jest.Mocked<RedisClientType>;
  let handler: jest.Mock;

  const validMessage: MintRequestMessage = {
    message_type: 'mint_request',
    schema_version: '1.0',
    message_id: 'msg-1',
    timestamp: '2026-05-12T12:00:00.000Z',
    model_id: 'sales-outreach-v1',
    model_id_uint: '21',
    eval_id: 'eval-1',
    attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
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

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    handler = jest.fn();
    consumer = new MintRequestConsumer({
      redis: mockRedis,
      inboundQueue: 'mint',
      processingQueue: 'mint:processing',
      deadLetterQueue: 'mint:dlq',
      processedSetKey: 'mint:processed',
      maxRetries: 3,
      blockingTimeout: 5,
    });
  });

  test('processes, acknowledges, and marks a valid message processed', async () => {
    const messageStr = JSON.stringify(validMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    mockRedis.sAdd.mockResolvedValueOnce(1);
    mockRedis.lRem.mockResolvedValueOnce(1);

    await consumer.processMessage(handler);

    expect(handler).toHaveBeenCalledWith(validMessage);
    expect(mockRedis.sAdd).toHaveBeenCalledWith('mint:processed', validMessage.idempotency_key);
    expect(mockRedis.lRem).toHaveBeenCalledWith('mint:processing', 1, messageStr);
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

  test('requeues transient failures and increments retry count', async () => {
    const messageStr = JSON.stringify(validMessage);
    mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
    mockRedis.sIsMember.mockResolvedValueOnce(false);
    handler.mockRejectedValueOnce(new Error('temporary failure'));
    mockRedis.lPush.mockResolvedValueOnce(1);

    await expect(consumer.processMessage(handler)).rejects.toThrow('temporary failure');

    expect(mockRedis.lPush).toHaveBeenCalledWith(
      'mint',
      JSON.stringify({ ...validMessage, _retryCount: 1 }),
    );
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
