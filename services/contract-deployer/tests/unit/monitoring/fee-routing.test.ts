import { buildFeeMismatchAlert } from '../../../src/monitoring/event-listener';
import type { FeeEvent } from '../../../src/monitoring/event-listener';

const ROUTER = '0xAbC0000000000000000000000000000000000001';

function feeEvent(depositor: string): FeeEvent {
  return {
    poolAddress: '0x' + 'pool'.padEnd(40, '0').slice(0, 40),
    modelId: '30',
    depositor,
    amount: 1_000_000n, // 1 USDC (6dp)
    amountUSD: 1,
    newReserveBalance: 25_000_000_000n,
    newSpotPrice: 10_000n,
    blockNumber: 123,
    transactionHash: '0x' + 'ab'.repeat(32),
    timestamp: 1_700_000_000,
  };
}

describe('buildFeeMismatchAlert (HOK-1698 fee-routing)', () => {
  it('flags a deposit from an unexpected depositor', () => {
    const rogue = '0xdead00000000000000000000000000000000beef';
    const alert = buildFeeMismatchAlert(feeEvent(rogue), ROUTER);
    expect(alert).not.toBeNull();
    expect(alert!.type).toBe('fee_mismatch');
    expect(alert!.priority).toBe('high');
    expect(alert!.message).toContain(rogue);
    expect((alert!.metadata as { depositor: string }).depositor).toBe(rogue);
    expect((alert!.metadata as { expectedDepositor: string }).expectedDepositor).toBe(
      ROUTER.toLowerCase(),
    );
  });

  it('passes a deposit from the expected router (case-insensitive)', () => {
    expect(buildFeeMismatchAlert(feeEvent(ROUTER.toLowerCase()), ROUTER)).toBeNull();
    expect(buildFeeMismatchAlert(feeEvent(ROUTER.toUpperCase()), ROUTER)).toBeNull();
  });

  it('does not flag when no expected depositor is configured', () => {
    expect(
      buildFeeMismatchAlert(feeEvent('0xanything00000000000000000000000000000000'), undefined),
    ).toBeNull();
    expect(
      buildFeeMismatchAlert(feeEvent('0xanything00000000000000000000000000000000'), ''),
    ).toBeNull();
  });
});
