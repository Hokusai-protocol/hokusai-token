/**
 * HOK-1698 — monitor ingestion health (RPC failure + stale event ingestion).
 *
 * The AMM monitor is event-driven with a fallback poll; if the RPC goes down or its head freezes,
 * the monitor goes BLIND and every other alert (reserve/price/supply/pause/whale) silently stops
 * firing. This is the meta-alert that makes the rest trustworthy: a heartbeat samples the chain
 * head and flags when ingestion is unhealthy (RPC error, a stale head, or a head that stops
 * advancing). Pure + deterministic so it can be unit-tested without a live chain; the I/O loop and
 * alert emission live in amm-monitor.ts.
 */

export interface IngestionHealthState {
  healthy: boolean;
  lastBlockNumber: number | null;
  lastAdvanceAtMs: number | null; // wall-clock when the head last advanced
}

export interface IngestionSample {
  ok: boolean; // false when the RPC head fetch threw
  blockNumber?: number;
  blockTimestampMs?: number; // block.timestamp * 1000
}

export interface IngestionHealthThresholds {
  staleBlockMs: number; // head timestamp older than now - this => stale chain/RPC
  stuckMs: number; // head block number has not advanced for at least this long => stuck
}

export interface IngestionAssessment {
  state: IngestionHealthState;
  healthy: boolean;
  transitioned: boolean; // health changed vs the previous state (emit only on transition)
  reason: string | null; // 'rpc_error' | 'stale_block' | 'stuck_block' when unhealthy; 'recovered' on transition to healthy
}

export const INITIAL_INGESTION_HEALTH: IngestionHealthState = {
  healthy: true,
  lastBlockNumber: null,
  lastAdvanceAtMs: null,
};

/**
 * Fold one heartbeat sample into the health state. Emit an alert only when `transitioned` is true,
 * so a sustained outage pages once (not every tick) and recovery pages once.
 */
export function assessIngestionHealth(
  prev: IngestionHealthState,
  sample: IngestionSample,
  nowMs: number,
  thresholds: IngestionHealthThresholds,
): IngestionAssessment {
  let lastBlockNumber = prev.lastBlockNumber;
  let lastAdvanceAtMs = prev.lastAdvanceAtMs;
  let healthy: boolean;
  let unhealthyReason: string | null = null;

  if (!sample.ok || sample.blockNumber === undefined) {
    // RPC head fetch failed — do not advance block tracking.
    healthy = false;
    unhealthyReason = 'rpc_error';
  } else {
    if (lastBlockNumber === null || sample.blockNumber > lastBlockNumber) {
      lastBlockNumber = sample.blockNumber;
      lastAdvanceAtMs = nowMs;
    }

    if (
      sample.blockTimestampMs !== undefined &&
      nowMs - sample.blockTimestampMs > thresholds.staleBlockMs
    ) {
      healthy = false;
      unhealthyReason = 'stale_block';
    } else if (lastAdvanceAtMs !== null && nowMs - lastAdvanceAtMs > thresholds.stuckMs) {
      healthy = false;
      unhealthyReason = 'stuck_block';
    } else {
      healthy = true;
    }
  }

  const transitioned = healthy !== prev.healthy;
  const reason = healthy ? (transitioned ? 'recovered' : null) : unhealthyReason;

  return {
    state: { healthy, lastBlockNumber, lastAdvanceAtMs },
    healthy,
    transitioned,
    reason,
  };
}
