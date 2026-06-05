import {
  createMintRequestSettlement,
  MintRequestMessage,
  validateMintRequestMessage,
} from '../../../src/schemas/mint-request-schema';

describe('MintRequest schema', () => {
  const validMessage: MintRequestMessage = {
    message_type: 'mint_request',
    schema_version: '1.0',
    message_id: 'msg-1',
    timestamp: '2026-05-12T12:00:00.000Z',
    model_id: 'sales-outreach-v1',
    model_id_uint: '21',
    eval_id: 'eval-1',
    attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    benchmark_spec_id: 'bench-1',
    dataset_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    evaluation: {
      metric_name: 'sales:revenue_per_1000_messages',
      metric_family: 'zero_inflated_continuous',
      baseline_score_bps: 5000,
      new_score_bps: 7500,
      max_cost_usd_micro: 1000,
      actual_cost_usd_micro: 500,
    },
    contributors: [
      {
        wallet_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
        weight_bps: 6000,
      },
      {
        wallet_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        weight_bps: 4000,
      },
    ],
  };

  test('validates a correct message', () => {
    const result = validateMintRequestMessage(validMessage);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual(validMessage);
  });

  test('rejects invalid hash fields', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      attestation_hash: 'invalid',
    });
    expect(result.error).toBeDefined();
  });

  test('rejects missing canonical anchors', () => {
    const { benchmark_spec_id, ...missingBenchmarkSpec } = validMessage;
    const resultMissingBenchmarkSpec = validateMintRequestMessage(missingBenchmarkSpec);
    expect(resultMissingBenchmarkSpec.error).toBeDefined();

    const resultBlankBenchmarkSpec = validateMintRequestMessage({
      ...validMessage,
      benchmark_spec_id: '',
    });
    expect(resultBlankBenchmarkSpec.error).toBeDefined();

    const resultMissingDatasetHash = validateMintRequestMessage({
      ...validMessage,
      dataset_hash: undefined as unknown as string,
    });
    expect(resultMissingDatasetHash.error).toBeDefined();
  });

  test('rejects contributor weights that do not sum to 10000', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      contributors: [
        { ...validMessage.contributors[0], weight_bps: 5000 },
        validMessage.contributors[1],
      ],
    });
    expect(result.error).toBeDefined();
  });

  test('rejects scores outside the bps range', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        baseline_score_bps: 10001,
      },
    });
    expect(result.error).toBeDefined();
  });

  test('builds settlement envelopes', () => {
    const settlement = createMintRequestSettlement({
      idempotency_key: validMessage.idempotency_key,
      attestation_hash: validMessage.attestation_hash,
      model_id: validMessage.model_id,
      model_id_uint: validMessage.model_id_uint,
      eval_id: validMessage.eval_id,
      status: 'minted',
      reward_amount: '123',
      tx_hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      block_number: 123,
      gas_used: '456',
    });

    expect(settlement.event_type).toBe('mint_request_settled');
    expect(settlement.message_version).toBe('1.0');
    expect(settlement.settled_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
