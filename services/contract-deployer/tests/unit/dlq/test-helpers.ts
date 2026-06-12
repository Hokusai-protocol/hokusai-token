import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';

export const validMintRequest: MintRequestMessage = {
  message_type: 'mint_request',
  schema_version: '1.0',
  message_id: 'msg-dlq-1',
  timestamp: '2026-06-10T12:00:00.000Z',
  model_id: 'sales-outreach-v1',
  model_id_uint: '21',
  eval_id: 'eval-dlq-1',
  benchmark_spec_id: 'bench-dlq-1',
  dataset_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  baseline_commitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
  candidate_commitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
  attester_signatures: [
    '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
  ],
  totalSamples: 140,
  evaluation: {
    metric_name: 'sales:revenue_per_1000_messages',
    metric_family: 'zero_inflated_continuous',
    baseline_score_bps: 5000,
    new_score_bps: 7500,
    max_cost_usd_micro: 1000,
    actual_cost_usd_micro: 500,
    sample_size_baseline: 120,
    sample_size_candidate: 140,
  },
  contributors: [
    {
      wallet_address: '0x742d35cc6634c0532925a3b844bc9e7595f82b3d',
      weight_bps: 10000,
    },
  ],
};

export function buildDlqEntry(
  overrides: Partial<{
    originalMessage: unknown;
    reason: string;
    failureClass: string;
    timestamp: string;
    queue: string;
  }> = {},
): string {
  return JSON.stringify({
    originalMessage: overrides.originalMessage ?? validMintRequest,
    error: overrides.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
    reason: overrides.reason ?? 'budget_exhausted (retries=24): MintBudgetExceeded',
    failureClass: overrides.failureClass ?? 'transient',
    timestamp: overrides.timestamp ?? '2026-06-11T12:00:00.000Z',
    queue: overrides.queue ?? 'hokusai:mint_requests',
  });
}
