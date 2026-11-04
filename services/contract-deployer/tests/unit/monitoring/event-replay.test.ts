import { ethers } from 'ethers';
import { EventListener } from '../../../src/monitoring/event-listener';
import { IncidentStore } from '../../../src/monitoring/incident-store';
import { DEFAULT_THRESHOLDS, PoolConfig } from '../../../src/config/monitoring-config';

const pool = {
  ammAddress: '0x' + '11'.repeat(20),
  modelId: '27',
} as PoolConfig;
const signature = 'Paused(address)';
function fixture(store = new IncidentStore('replay')) {
  const head = jest.fn().mockResolvedValue(101);
  const provider = {
    getBlockNumber: head,
    waitForTransaction: jest.fn().mockResolvedValue({ blockHash: '0xblock' }),
    getBlock: jest.fn().mockResolvedValue({ hash: '0xblock', timestamp: 123 }),
  } as unknown as ethers.Provider;
  const listener = new EventListener(provider, DEFAULT_THRESHOLDS, {}, store, 2);
  const handler = jest.fn().mockResolvedValue(undefined);
  const query = jest.fn().mockResolvedValue([]);
  const internal = listener as any;
  internal.poolContracts.set(pool.ammAddress, { queryFilter: query });
  internal.handlers.set(pool.ammAddress, new Map([[signature, handler]]));
  const log = Object.assign(Object.create(ethers.EventLog.prototype), {
    blockNumber: 99,
    index: 1,
    transactionHash: '0xtx',
    blockHash: '0xblock',
    removed: false,
    fragment: { format: () => signature },
    args: ['actor'],
  });
  return { listener, handler, query, head, log, store };
}

describe('confirmed event coverage and replay', () => {
  it('verifies quiet pools by a successful log range query, without requiring trades', async () => {
    const f = fixture();
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(false);
    await f.listener.reconcilePool(pool);
    expect(f.query).toHaveBeenCalledWith('*', 88, 100);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(true);
    expect(await f.store.get(`event-checkpoint:${pool.ammAddress}`)).toBe(100);
    expect(f.listener.isCaughtUp(pool.ammAddress, 180000, Date.now() + 180001)).toBe(false);
  });

  it('revokes previous coverage immediately when reconciliation fails', async () => {
    const f = fixture();
    await f.listener.reconcilePool(pool);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(true);
    f.query.mockRejectedValueOnce(new Error('quota exceeded'));
    await expect(f.listener.reconcilePool(pool)).rejects.toThrow('quota exceeded');
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(false);
  });

  it('uses a durable checkpoint after restart and deduplicates an overlapping event', async () => {
    const f = fixture();
    f.query.mockResolvedValue([f.log]);
    await f.listener.reconcilePool(pool);
    expect(f.handler).toHaveBeenCalledTimes(1);
    const restarted = fixture(f.store);
    restarted.head.mockResolvedValue(111);
    restarted.query.mockResolvedValue([restarted.log]);
    await restarted.listener.reconcilePool(pool);
    expect(restarted.query).toHaveBeenCalledWith('*', 88, 110);
    expect(restarted.handler).not.toHaveBeenCalled();
    expect(await f.store.get(`event-checkpoint:${pool.ammAddress}`)).toBe(110);
  });

  it('does not advance a checkpoint or recover if an event callback fails', async () => {
    const f = fixture();
    f.query.mockResolvedValue([f.log]);
    f.handler.mockRejectedValueOnce(new Error('delivery failed'));
    await expect(f.listener.reconcilePool(pool)).rejects.toThrow('delivery failed');
    expect(await f.store.get(`event-checkpoint:${pool.ammAddress}`)).toBe(88);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(false);
    await f.listener.reconcilePool(pool);
    expect(f.handler).toHaveBeenCalledTimes(2);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(true);
  });

  it('bounds replay work per heartbeat and remains unhealthy until caught up', async () => {
    const f = fixture();
    await f.store.put(`event-checkpoint:${pool.ammAddress}`, 10);
    f.head.mockResolvedValue(3001);
    await f.listener.reconcilePool(pool);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(false);
    expect(f.query.mock.calls.every(([, from, to]) => to - from < 500)).toBe(true);
    await f.listener.reconcilePool(pool);
    expect(f.listener.isCaughtUp(pool.ammAddress)).toBe(true);
  });
});
