import { ethers } from 'ethers';
import { PacedRpcProvider } from '../../../src/monitoring/paced-rpc-provider';
import { EventListener } from '../../../src/monitoring/event-listener';
import { StateTracker } from '../../../src/monitoring/state-tracker';
import { DEFAULT_THRESHOLDS, PoolConfig } from '../../../src/config/monitoring-config';

const payload: ethers.JsonRpcPayload = {
  id: 1,
  jsonrpc: '2.0',
  method: 'eth_blockNumber',
  params: [],
};
const success = [{ id: 1, jsonrpc: '2.0', result: '0x64' }];
const throttled = [
  { id: 1, jsonrpc: '2.0', error: { code: -32005, message: 'Too Many Requests' } },
];
const pool = { ammAddress: '0x' + '11'.repeat(20), modelId: 'test' } as PoolConfig;

describe('paced backup requests', () => {
  it('serializes parallel calls and spaces requests instead of batching a burst', async () => {
    const timestamps: number[] = [];
    const send = jest.spyOn(ethers.JsonRpcProvider.prototype, '_send').mockImplementation(() => {
      timestamps.push(Date.now());
      return Promise.resolve(success);
    });
    const provider = new PacedRpcProvider('http://localhost:8545', 30);
    try {
      await Promise.all([provider._send(payload), provider._send({ ...payload, id: 2 })]);
      expect(send).toHaveBeenCalledTimes(2);
      expect(timestamps[1] - timestamps[0]).toBeGreaterThanOrEqual(25);
    } finally {
      provider.destroy();
    }
  });
  it('retries JSON-RPC throttling with bounded backoff', async () => {
    const send = jest
      .spyOn(ethers.JsonRpcProvider.prototype, '_send')
      .mockResolvedValueOnce(throttled as unknown as ethers.JsonRpcResult[])
      .mockResolvedValue(success);
    const provider = new PacedRpcProvider('http://localhost:8545');
    try {
      const request = provider._send(payload);
      await expect(request).resolves.toEqual(success);
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      provider.destroy();
    }
  });
  it('returns a persistent throttle after three attempts instead of retrying indefinitely', async () => {
    const send = jest
      .spyOn(ethers.JsonRpcProvider.prototype, '_send')
      .mockResolvedValue(throttled as unknown as ethers.JsonRpcResult[]);
    const provider = new PacedRpcProvider('http://localhost:8545');
    try {
      const request = provider._send(payload);
      await expect(request).resolves.toEqual(throttled);
      expect(send).toHaveBeenCalledTimes(3);
    } finally {
      provider.destroy();
    }
  });
  it('does not poison the queue after a transport failure', async () => {
    jest
      .spyOn(ethers.JsonRpcProvider.prototype, '_send')
      .mockRejectedValueOnce(new Error('connection failed'))
      .mockResolvedValue(success);
    const provider = new PacedRpcProvider('http://localhost:8545', 10);
    try {
      const failed = expect(provider._send(payload)).rejects.toThrow('connection failed');
      const next = provider._send({ ...payload, id: 2 });
      await failed;
      await expect(next).resolves.toEqual(success);
    } finally {
      provider.destroy();
    }
  });
});

describe('backup event traffic', () => {
  it('registers replay handlers without redundant per-event subscriptions', async () => {
    const on = jest.spyOn(ethers.Contract.prototype, 'on');
    const provider = new PacedRpcProvider('http://localhost:8545');
    const listener = new EventListener(provider, DEFAULT_THRESHOLDS);
    try {
      await listener.startListeningToPool(pool);
      expect(listener.isListeningToPool(pool.ammAddress)).toBe(true);
      expect(listener.isCaughtUp(pool.ammAddress)).toBe(false);
      expect(on).not.toHaveBeenCalled();
    } finally {
      listener.stopAllListening();
      provider.destroy();
    }
  });
  it('uses confirmed event callbacks and fallback state reads instead of duplicate state subscriptions', async () => {
    const on = jest.spyOn(ethers.Contract.prototype, 'on');
    const provider = new PacedRpcProvider('http://localhost:8545');
    const tracker = new StateTracker(provider, DEFAULT_THRESHOLDS);
    (tracker as any).pollPoolState = jest.fn().mockResolvedValue(undefined);
    try {
      await tracker.startTracking(pool);
      expect(tracker.isTrackingPool(pool.ammAddress)).toBe(true);
      expect(on).not.toHaveBeenCalled();
    } finally {
      tracker.stopAllTracking();
      provider.destroy();
    }
  });
});
