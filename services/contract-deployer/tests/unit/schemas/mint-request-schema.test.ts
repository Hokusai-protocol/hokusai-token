import { createMintRequestSettlement, MintRequestMessage, validateMintRequestMessage } from '../../../src/schemas/mint-request-schema';

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

  test('rejects contributor weights that do not sum to 10000', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      contributors: [{ ...validMessage.contributors[0], weight_bps: 5000 }, validMessage.contributors[1]],
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

  test('accepts all eight optional evaluation fields plus top-level total_samples', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      total_samples: 2000,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_baseline: 1000,
        sample_size_candidate: 1000,
        ci_low_bps: 50,
        ci_high_bps: 550,
        p_value: 0.03,
        effect_size_bps: 300,
        statistical_method: 'bootstrap_ci',
        statistical_reason: 'accepted',
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.value?.total_samples).toBe(2000);
    expect(result.value?.evaluation.sample_size_candidate).toBe(1000);
    expect(result.value?.evaluation.p_value).toBe(0.03);
  });

  test('accepts optional evaluation fields set to null', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_baseline: null,
        sample_size_candidate: null,
        ci_low_bps: null,
        ci_high_bps: null,
        p_value: null,
        effect_size_bps: null,
        statistical_method: null,
        statistical_reason: null,
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.value?.evaluation.sample_size_baseline).toBeNull();
  });

  test('rejects p_value outside 0..1 range', () => {
    const result1 = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        p_value: 1.5,
      },
    });
    expect(result1.error).toBeDefined();

    const result2 = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        p_value: -0.1,
      },
    });
    expect(result2.error).toBeDefined();
  });

  test('rejects ci_low_bps outside 0..10000 range', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        ci_low_bps: 10001,
      },
    });
    expect(result.error).toBeDefined();
  });

  test('rejects invalid total_samples values', () => {
    const zeroResult = validateMintRequestMessage({
      ...validMessage,
      total_samples: 0,
    });
    expect(zeroResult.error).toBeDefined();

    const negativeResult = validateMintRequestMessage({
      ...validMessage,
      total_samples: -5,
    });
    expect(negativeResult.error).toBeDefined();

    const nonIntegerResult = validateMintRequestMessage({
      ...validMessage,
      total_samples: 3.7,
    });
    expect(nonIntegerResult.error).toBeDefined();
  });

  test('rejects malformed contributor wallet address', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      contributors: [
        { wallet_address: '0xZZZ', weight_bps: 6000 },
        validMessage.contributors[1],
      ],
    });
    expect(result.error).toBeDefined();
  });

  test('rejects unknown keys at root level', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      foo: 'bar',
    } as any);
    expect(result.error).toBeDefined();
  });

  test('rejects unknown keys inside evaluation', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        unknown_field: 'value',
      } as any,
    });
    expect(result.error).toBeDefined();
  });
});
