import { RedisClientType } from 'redis';
import { MintRecordStore } from '../../../src/queue/mint-record-store';
import { createMintRequestSettlement } from '../../../src/schemas/mint-request-schema';
import { createMockRedisClient } from '../../mocks/redis-mock';

describe('MintRecordStore', () => {
  let mockRedis: jest.Mocked<RedisClientType>;
  let store: MintRecordStore;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    store = new MintRecordStore({
      redis: mockRedis,
      keyPrefix: 'mint:record:',
      ttlSeconds: 7200,
    });
  });

  test('stores settlement records with a TTL', async () => {
    const settlement = createMintRequestSettlement({
      idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      model_id: 'sales-outreach-v1',
      model_id_uint: '21',
      eval_id: 'eval-1',
      tx_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      block_number: 42,
      status: 'minted',
      reward_amount: '10',
      gas_used: '21000',
    });
    mockRedis.set.mockResolvedValueOnce('OK');

    await store.recordSettled(settlement);

    expect(mockRedis.set).toHaveBeenCalledWith(
      `mint:record:${settlement.idempotency_key}`,
      expect.any(String),
      { EX: 7200 },
    );
  });

  test('stores error records and can fetch them back', async () => {
    mockRedis.set.mockResolvedValueOnce('OK');
    mockRedis.get.mockResolvedValueOnce(
      JSON.stringify({
        idempotency_key: 'key-1',
        model_id: 'model-1',
        status: 'error',
        failure_class: 'permanent',
        reward_amount: '0',
        error: 'permanent: bad request',
        updated_at: '2026-05-21T00:00:00.000Z',
      }),
    );

    await store.recordError('key-1', 'model-1', 'permanent: bad request', {
      failureClass: 'permanent',
    });
    const record = await store.get('key-1');

    expect(record?.status).toBe('error');
    expect(record?.failure_class).toBe('permanent');
    expect(record?.error).toBe('permanent: bad request');
  });

  test('serializes retrying budget records without marking them settled', () => {
    const record = store.serializeRetrying(
      'key-2',
      'model-2',
      'MintBudgetExceeded',
      'transient',
      'budget_exceeded_retry',
    );

    expect(record.status).toBe('budget_exceeded_retry');
    expect(record.failure_class).toBe('transient');
    expect(record.reward_amount).toBe('0');
  });
});
