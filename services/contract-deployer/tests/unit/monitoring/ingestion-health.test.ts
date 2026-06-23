import {
  assessIngestionHealth,
  INITIAL_INGESTION_HEALTH,
  IngestionHealthState,
} from '../../../src/monitoring/ingestion-health';

const THR = { staleBlockMs: 300_000, stuckMs: 300_000 };

describe('assessIngestionHealth (HOK-1698)', () => {
  it('a fresh first sample is healthy and does not transition', () => {
    const a = assessIngestionHealth(
      INITIAL_INGESTION_HEALTH,
      { ok: true, blockNumber: 100, blockTimestampMs: 1_000_000 },
      1_000_000,
      THR,
    );
    expect(a.healthy).toBe(true);
    expect(a.transitioned).toBe(false);
    expect(a.reason).toBeNull();
    expect(a.state.lastBlockNumber).toBe(100);
    expect(a.state.lastAdvanceAtMs).toBe(1_000_000);
  });

  it('an RPC error transitions healthy -> unhealthy (rpc_error)', () => {
    const healthy: IngestionHealthState = {
      healthy: true,
      lastBlockNumber: 100,
      lastAdvanceAtMs: 0,
    };
    const a = assessIngestionHealth(healthy, { ok: false }, 1_000, THR);
    expect(a.healthy).toBe(false);
    expect(a.transitioned).toBe(true);
    expect(a.reason).toBe('rpc_error');
  });

  it('a sustained outage pages only on the first tick (no repeat transition)', () => {
    const unhealthy: IngestionHealthState = {
      healthy: false,
      lastBlockNumber: 100,
      lastAdvanceAtMs: 0,
    };
    const a = assessIngestionHealth(unhealthy, { ok: false }, 2_000, THR);
    expect(a.healthy).toBe(false);
    expect(a.transitioned).toBe(false);
  });

  it('flags a stale head (block timestamp older than the stale threshold)', () => {
    const healthy: IngestionHealthState = {
      healthy: true,
      lastBlockNumber: 100,
      lastAdvanceAtMs: 0,
    };
    const now = 1_000_000;
    const a = assessIngestionHealth(
      healthy,
      { ok: true, blockNumber: 101, blockTimestampMs: now - (THR.staleBlockMs + 1) },
      now,
      THR,
    );
    expect(a.healthy).toBe(false);
    expect(a.reason).toBe('stale_block');
  });

  it('flags a stuck head (block number not advancing past the stuck threshold)', () => {
    // t=0: head at block 100 (healthy, advance recorded).
    const s1 = assessIngestionHealth(
      INITIAL_INGESTION_HEALTH,
      { ok: true, blockNumber: 100, blockTimestampMs: 0 },
      0,
      THR,
    );
    expect(s1.healthy).toBe(true);
    // later: same block 100, fresh timestamp (isolates the stuck branch from stale) -> stuck.
    const now = THR.stuckMs + 1;
    const s2 = assessIngestionHealth(
      s1.state,
      { ok: true, blockNumber: 100, blockTimestampMs: now },
      now,
      THR,
    );
    expect(s2.healthy).toBe(false);
    expect(s2.reason).toBe('stuck_block');
    expect(s2.transitioned).toBe(true);
  });

  it('recovers (unhealthy -> healthy) when the head advances again', () => {
    const unhealthy: IngestionHealthState = {
      healthy: false,
      lastBlockNumber: 100,
      lastAdvanceAtMs: 0,
    };
    const now = 1_000_000;
    const a = assessIngestionHealth(
      unhealthy,
      { ok: true, blockNumber: 105, blockTimestampMs: now },
      now,
      THR,
    );
    expect(a.healthy).toBe(true);
    expect(a.transitioned).toBe(true);
    expect(a.reason).toBe('recovered');
    expect(a.state.lastBlockNumber).toBe(105);
    expect(a.state.lastAdvanceAtMs).toBe(now);
  });
});
