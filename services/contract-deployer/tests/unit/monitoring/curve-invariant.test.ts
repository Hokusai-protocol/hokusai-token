import {
  normalizePhase,
  reserveRatio,
  anchoredReserveRatio,
} from '../../../src/monitoring/curve-invariant';

describe('released AMM curve accounting', () => {
  it('normalizes ethers bigint enum values and rejects unknown phases', () => {
    expect(normalizePhase(0n)).toBe(0);
    expect(normalizePhase(1n)).toBe(1);
    expect(() => normalizePhase(2n)).toThrow('Invalid pricing phase');
  });

  it('cancels USDC decimals and uses redeemable token wei', () => {
    expect(reserveRatio(100_000_000n, 10_000n, 50_000n * 10n ** 18n)).toBeCloseTo(0.2);
    expect(reserveRatio(100_000_000n, 0n, 0n)).toBe(0);
  });

  it('is continuous at graduation and below the graduation anchor', () => {
    expect(anchoredReserveRatio(100n, 100n, 100n, 200_000)).toBe(1);
    expect(anchoredReserveRatio(50n, 100n, 50n, 200_000)).toBe(1);
    expect(anchoredReserveRatio(100n, 0n, 0n, 200_000)).toBe(1);
  });

  it('matches the released shape and slope for buys and sells above the anchor', () => {
    // w=.2; S/Sg=2; grown=32; f/Sg=1+.2*(32-1)=7.2; slope=16.
    expect(anchoredReserveRatio(200n, 100n, 200n, 200_000)).toBeCloseTo(7.2 / 32);
    expect(anchoredReserveRatio(150n, 100n, 150n, 200_000)).toBeCloseTo(0.2 + 0.8 / 1.5 ** 5);
  });

  it('rescales the anchor when supplier allocations become redeemable outside a trade', () => {
    expect(anchoredReserveRatio(400n, 100n, 200n, 200_000)).toBeCloseTo(
      anchoredReserveRatio(200n, 100n, 200n, 200_000),
    );
  });
});
