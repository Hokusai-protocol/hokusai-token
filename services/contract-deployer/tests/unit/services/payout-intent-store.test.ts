import { PayoutIntentStore } from '../../../src/services/payout-intent-store';

describe('PayoutIntentStore', () => {
  function makeStore(overrides: Partial<{ ttlSeconds: number }> = {}) {
    const send = jest.fn().mockResolvedValue({});
    const store = new PayoutIntentStore({
      client: { send } as any,
      tableName: 'payout-intent-test',
      ttlSeconds: overrides.ttlSeconds,
      now: () => 1_700_000_000_000, // fixed epoch ms => 1_700_000_000 s
    });
    return { store, send };
  }

  test('writes an item keyed by idempotency_key with normalized recipients and TTL', async () => {
    const { store, send } = makeStore({ ttlSeconds: 100 });

    await store.putIntent({
      idempotencyKey: '0x' + 'ab'.repeat(32),
      recipients: [
        '0xAAA0000000000000000000000000000000000001',
        '0xbbb0000000000000000000000000000000000002',
      ],
      modelId: '30',
    });

    expect(send).toHaveBeenCalledTimes(1);
    const item = send.mock.calls[0][0].input.Item;
    expect(item.idempotency_key.S).toBe('0x' + 'ab'.repeat(32));
    expect(item.recipients.SS).toEqual([
      '0xaaa0000000000000000000000000000000000001',
      '0xbbb0000000000000000000000000000000000002',
    ]);
    expect(item.model_id.S).toBe('30');
    expect(item.written_at.N).toBe('1700000000');
    expect(item.expires_at.N).toBe('1700000100');
  });

  test('de-duplicates recipients (case-insensitive)', async () => {
    const { store, send } = makeStore();

    await store.putIntent({
      idempotencyKey: '0x' + 'cd'.repeat(32),
      recipients: [
        '0xAbC0000000000000000000000000000000000001',
        '0xabc0000000000000000000000000000000000001',
      ],
      modelId: '30',
    });

    expect(send.mock.calls[0][0].input.Item.recipients.SS).toEqual([
      '0xabc0000000000000000000000000000000000001',
    ]);
  });

  test('refuses to write an empty recipient set', async () => {
    const { store, send } = makeStore();

    await expect(
      store.putIntent({ idempotencyKey: '0x' + 'ef'.repeat(32), recipients: [], modelId: '30' }),
    ).rejects.toThrow(/no recipients/);
    expect(send).not.toHaveBeenCalled();
  });
});
