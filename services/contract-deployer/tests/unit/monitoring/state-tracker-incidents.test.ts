/* eslint-disable @typescript-eslint/require-await -- Async test doubles implement Redis and RPC interfaces. */
const mockContract = jest.fn();
jest.mock('ethers', () => {
  const actual = jest.requireActual('ethers');
  return {
    ...actual,
    ethers: {
      ...actual.ethers,
      Contract: function (...args: unknown[]) {
        return mockContract(...args);
      },
    },
  };
});
import { ethers } from 'ethers';
import { StateTracker } from '../../../src/monitoring/state-tracker';
import { IncidentStore, MonitoringRedis } from '../../../src/monitoring/incident-store';
import { DEFAULT_THRESHOLDS, PoolConfig } from '../../../src/config/monitoring-config';

const pool: PoolConfig = {
  modelId: '27',
  ammAddress: '0x' + '11'.repeat(20),
  tokenAddress: '0x' + '22'.repeat(20),
  crr: 200000,
  tradeFee: 30,
  protocolFee: 0,
  ibrDuration: 0,
  flatCurveThreshold: '25000000000',
  flatCurvePrice: '10000',
};
const privatePoll = (tracker: StateTracker) =>
  (tracker as any).pollPoolState(pool) as Promise<void>;

function redisFixture(): MonitoringRedis {
  const data = new Map<string, string>();
  return {
    get: async (key) => data.get(key) ?? null,
    set: async (key, value, options) => {
      if (options?.NX && data.has(key)) {
        return null;
      }
      data.set(key, value);
      return 'OK';
    },
    del: async (key) => {
      data.delete(key);
      return 1;
    },
  };
}

describe('persistent pool incidents', () => {
  let paused = true;
  let phase = 0n;
  let reserve = 10_000_000n;
  const tag = { blockTag: 99 };
  const read = jest.fn(async (name: string) => {
    switch (name) {
      case 'getReserves':
        return [reserve, 1000n * 10n ** 18n];
      case 'graduationSupply':
        return 1000n * 10n ** 18n;
      case 'anchorBasisSupply':
        return 1000n * 10n ** 18n;
      case 'crr':
        return 200000n;
      default:
        throw new Error(name);
    }
  });
  const methods = {
    reserveBalance: jest.fn(async () => reserve),
    spotPrice: jest.fn(async () => 10000n),
    hokusaiToken: jest.fn(async () => pool.tokenAddress),
    paused: jest.fn(async () => paused),
    totalSupply: jest.fn(async () => 9000n * 10n ** 18n),
    balanceOf: jest.fn(async () => reserve),
    getCurrentPhase: jest.fn(async () => phase),
    FLAT_CURVE_THRESHOLD: jest.fn(async () => 25_000_000_000n),
    FLAT_CURVE_PRICE: jest.fn(async () => 10000n),
    getFunction:
      (name: string) =>
      (..._args: unknown[]) =>
        read(name),
  };
  const provider = {
    getBlockNumber: async () => 100,
    getBlock: async () => ({ timestamp: Math.floor(Date.now() / 1000) }),
    getNetwork: async () => ({ chainId: 1n }),
  } as unknown as ethers.Provider;
  beforeEach(() => {
    paused = true;
    phase = 0n;
    reserve = 10_000_000n;
    mockContract.mockImplementation(() => methods);
  });

  it('preserves pause first-observed time, deduplicates after restart and emits recovery', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const redis = redisFixture();
    const first = jest.fn().mockResolvedValue(undefined);
    const tracker = new StateTracker(
      provider,
      DEFAULT_THRESHOLDS,
      { onAlert: first },
      new IncidentStore('1:factory', redis),
    );
    await privatePoll(tracker);
    now += 3600_001;
    const alerts = jest.fn().mockResolvedValue(undefined);
    const restarted = new StateTracker(
      provider,
      DEFAULT_THRESHOLDS,
      { onAlert: alerts },
      new IncidentStore('1:factory', redis),
    );
    await privatePoll(restarted);
    expect(alerts).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'paused',
        metadata: expect.objectContaining({ firstObservedAt: now - 3600_001 }),
      }),
    );
    const again = new StateTracker(
      provider,
      DEFAULT_THRESHOLDS,
      { onAlert: alerts },
      new IncidentStore('1:factory', redis),
    );
    await privatePoll(again);
    expect(alerts).toHaveBeenCalledTimes(1);
    now += 6 * 3600_000;
    await privatePoll(again);
    expect(alerts).toHaveBeenCalledTimes(2);
    paused = false;
    await privatePoll(again);
    expect(alerts).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'condition_recovered', priority: 'info' }),
    );
  });

  it('uses redeemable supply, a numeric phase, and one confirmed block for state reads', async () => {
    const tracker = new StateTracker(provider, DEFAULT_THRESHOLDS);
    await privatePoll(tracker);
    const state = tracker.getCurrentState(pool.ammAddress)!;
    expect(state.pricingPhase).toBe(0);
    expect(state.curveSupply).toBe(1000n * 10n ** 18n);
    expect(state.tokenSupply).toBe(9000n * 10n ** 18n);
    expect(methods.reserveBalance).toHaveBeenCalledWith(tag);
    expect(methods.getCurrentPhase).toHaveBeenCalledWith(tag);
  });

  it('retries an opening notification after delivery failure', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const alerts = jest
      .fn()
      .mockRejectedValueOnce(new Error('SES unavailable'))
      .mockResolvedValue(undefined);
    const tracker = new StateTracker(provider, DEFAULT_THRESHOLDS, { onAlert: alerts });
    await privatePoll(tracker);
    now += 3600_001;
    await expect(privatePoll(tracker)).rejects.toThrow('SES unavailable');
    await privatePoll(tracker);
    expect(alerts).toHaveBeenCalledTimes(2);
  });

  it('detects a reserve drop during bootstrap', async () => {
    paused = false;
    const alerts = jest.fn().mockResolvedValue(undefined);
    const tracker = new StateTracker(provider, DEFAULT_THRESHOLDS, { onAlert: alerts });
    await privatePoll(tracker);
    reserve = 1_000_000n;
    await privatePoll(tracker);
    expect(alerts).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'reserve_drop', priority: 'critical' }),
    );
  });
});
