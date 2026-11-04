import { ethers } from 'ethers';
import { StateTracker } from '../../../src/monitoring/state-tracker';
import { DEFAULT_THRESHOLDS, PoolConfig } from '../../../src/config/monitoring-config';

const pool = { ammAddress: 'pool', modelId: '27' } as PoolConfig;
function fixture() {
  const provider = { getBlockNumber: jest.fn().mockRejectedValue(new Error('quota exceeded')) };
  const tracker = new StateTracker(provider as unknown as ethers.Provider, DEFAULT_THRESHOLDS);
  const internals = tracker as any;
  internals.lastSuccessfulRead.set(pool.ammAddress, Date.now());
  internals.pollingIntervals.set(pool.ammAddress, undefined);
  return tracker;
}

describe('state coverage freshness', () => {
  it('keeps a quiet pool healthy between five-minute fallback reads', () => {
    const tracker = fixture();
    expect(tracker.isFresh(pool.ammAddress, 660000, Date.now() + 300000)).toBe(true);
    expect(tracker.isFresh(pool.ammAddress, 660000, Date.now() + 660001)).toBe(false);
  });
  it('a failed scheduled contract read revokes coverage immediately', async () => {
    const tracker = fixture();
    expect(tracker.isFresh(pool.ammAddress, 660000)).toBe(true);
    await expect((tracker as any).pollPoolState(pool)).rejects.toThrow('quota exceeded');
    expect(tracker.isFresh(pool.ammAddress, 660000)).toBe(false);
  });
});
