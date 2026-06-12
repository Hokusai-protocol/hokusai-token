import { DlqEntryAmbiguousError, DlqStore } from '../../../src/dlq/dlq-store';
import { stripRetryScratch } from '../../../src/dlq/dlq-entry';
import { createMockRedisClient, createMockRedisMulti } from '../../mocks/redis-mock';
import { buildDlqEntry, validMintRequest } from './test-helpers';

describe('DlqStore', () => {
  const config = {
    dlqQueue: 'hokusai:mint_requests:dlq',
    inboundQueue: 'hokusai:mint_requests',
    archiveQueue: 'hokusai:mint_requests:dlq:archive',
  };

  test('lists and resolves entries by unambiguous ID prefix', async () => {
    const redis = createMockRedisClient();
    const raw = buildDlqEntry();
    redis.lRange.mockResolvedValue([raw]);
    const store = new DlqStore({ redis, ...config });

    const entries = await store.list(50);
    const entry = await store.getById(entries[0].id.slice(0, 6));

    expect(redis.lRange).toHaveBeenCalledWith(config.dlqQueue, 0, 49);
    expect(entry.id).toBe(entries[0].id);
  });

  test('throws on ambiguous ID prefixes', async () => {
    const redis = createMockRedisClient();
    const first = buildDlqEntry({ reason: 'budget_exhausted first' });
    const second = buildDlqEntry({ reason: 'budget_exhausted second' });
    redis.lRange.mockResolvedValue([first, second]);
    const store = new DlqStore({ redis, ...config });

    const firstId = (await store.list(2))[0].id;
    const secondId = (await store.list(2))[1].id;
    const sharedPrefix = [...firstId].findIndex((char, index) => char !== secondId[index]) + 1;

    if (sharedPrefix <= 1) {
      await expect(store.getById('')).rejects.toBeInstanceOf(DlqEntryAmbiguousError);
    } else {
      await expect(store.getById(firstId.slice(0, sharedPrefix - 1))).rejects.toBeInstanceOf(
        DlqEntryAmbiguousError,
      );
    }
  });

  test('replays by pushing stripped message and removing the exact DLQ entry in one MULTI', async () => {
    const redis = createMockRedisClient();
    const multi = createMockRedisMulti();
    multi.exec.mockResolvedValue([2, 1]);
    redis.multi.mockReturnValue(multi as any);
    const raw = buildDlqEntry({ originalMessage: { ...validMintRequest, _retryCount: 24 } });
    const store = new DlqStore({ redis, ...config });
    const entry = await (async () => {
      redis.lRange.mockResolvedValue([raw]);
      return store.getById('');
    })();

    const result = await store.replay(
      entry,
      stripRetryScratch({ ...validMintRequest, _retryCount: 24 }),
    );

    expect(multi.lPush).toHaveBeenCalledWith(config.inboundQueue, JSON.stringify(validMintRequest));
    expect(multi.lRem).toHaveBeenCalledWith(config.dlqQueue, 1, raw);
    expect(multi.exec).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ inboundDepth: 2, removedCount: 1 });
  });

  test('discards by archiving before removing the exact DLQ entry in one MULTI', async () => {
    const redis = createMockRedisClient();
    const multi = createMockRedisMulti();
    multi.exec.mockResolvedValue([1, 1]);
    redis.multi.mockReturnValue(multi as any);
    const raw = buildDlqEntry();
    redis.lRange.mockResolvedValue([raw]);
    const store = new DlqStore({ redis, ...config });
    const entry = await store.getById('');

    const result = await store.discard(entry, 'already-minted', 'operator');

    expect(multi.lPush).toHaveBeenCalledWith(config.archiveQueue, expect.any(String));
    const archivePayload = JSON.parse(multi.lPush.mock.calls[0][1] as string);
    expect(archivePayload.reason).toBe('already-minted');
    expect(archivePayload.operator).toBe('operator');
    expect(archivePayload.originalDlqEntry).toBe(raw);
    expect(multi.lRem).toHaveBeenCalledWith(config.dlqQueue, 1, raw);
    expect(result).toEqual({ archiveDepth: 1, removedCount: 1 });
  });
});
