import {
  createMintRequestSettlement,
  deriveTotalSamples,
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
    totalSamples: 140,
    benchmark_spec_id: 'bench-1',
    dataset_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
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

  // Guards the cross-repo seam (HOK-2099): the pipeline serializes contributors with
  // model_dump_json(by_alias=True) and NO exclude_none, so EVERY provenance field is
  // always present on the wire — null when unset. The committed example fixture omits
  // them, which is why earlier drift (submissionId/contributionBatchId, then contributorId)
  // slipped past fixture-based tests. Assert the schema accepts the full pipeline contributor
  // shape with all provenance fields present, both as values and as null.
  test('accepts the full pipeline contributor shape (all provenance fields, incl. null)', () => {
    const withProvenance = {
      ...validMessage,
      contributors: [
        {
          wallet_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
          weight_bps: 6000,
          submissionId: 'sub-1',
          contributionBatchId: 'batch-1',
          contributorId: 'contrib-1',
        },
        {
          wallet_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
          weight_bps: 4000,
          submissionId: null,
          contributionBatchId: null,
          contributorId: null,
        },
      ],
    };
    const result = validateMintRequestMessage(withProvenance);
    expect(result.error).toBeUndefined();
  });

  test('accepts the canonical statistical metadata fields', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 1000,
      timestamp: '2026-05-05T12:00:00.000000+00:00',
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
    expect(result.value?.evaluation).toEqual(
      expect.objectContaining({
        sample_size_baseline: 1000,
        sample_size_candidate: 1000,
        ci_low_bps: 50,
        ci_high_bps: 550,
        p_value: 0.03,
        effect_size_bps: 300,
        statistical_method: 'bootstrap_ci',
        statistical_reason: 'accepted',
      }),
    );
  });

  test('accepts sample sizes without optional statistical metadata', () => {
    const result = validateMintRequestMessage(validMessage);
    expect(result.error).toBeUndefined();
  });

  test('accepts null statistical metadata fields', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 1000,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_baseline: 1000,
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

  test('rejects unknown root keys', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      foo: 'bar',
    });

    expect(result.error?.details.some((detail) => detail.message === '"foo" is not allowed')).toBe(
      true,
    );
  });

  test('rejects unknown evaluation keys', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        foo: 'bar',
      },
    });

    expect(
      result.error?.details.some((detail) => detail.message === '"evaluation.foo" is not allowed'),
    ).toBe(true);
  });

  test('rejects invalid contributor addresses', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      contributors: [
        {
          ...validMessage.contributors[0],
          wallet_address: '0x123',
        },
        validMessage.contributors[1],
      ],
    });

    expect(result.error).toBeDefined();
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
    const highResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        baseline_score_bps: 10001,
      },
    });
    const lowResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        baseline_score_bps: -1,
      },
    });

    expect(highResult.error).toBeDefined();
    expect(lowResult.error).toBeDefined();
  });

  test('rejects invalid p_value values', () => {
    const highResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        p_value: 1.5,
      },
    });
    const lowResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        p_value: -0.1,
      },
    });

    expect(highResult.error).toBeDefined();
    expect(lowResult.error).toBeDefined();
  });

  test('rejects invalid ci_low_bps values', () => {
    const lowResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        ci_low_bps: -1,
      },
    });
    const highResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        ci_low_bps: 10001,
      },
    });

    expect(lowResult.error).toBeDefined();
    expect(highResult.error).toBeDefined();
  });

  test('rejects invalid sample_size_candidate values', () => {
    const floatResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: 3.7,
      },
    });
    const negativeResult = validateMintRequestMessage({
      ...validMessage,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: -5,
      },
    });

    expect(floatResult.error).toBeDefined();
    expect(negativeResult.error).toBeDefined();
  });

  test('rejects missing derivable totalSamples in evaluation', () => {
    const missingResult = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 100,
      evaluation: {
        metric_name: validMessage.evaluation.metric_name,
        metric_family: validMessage.evaluation.metric_family,
        baseline_score_bps: validMessage.evaluation.baseline_score_bps,
        new_score_bps: validMessage.evaluation.new_score_bps,
        max_cost_usd_micro: validMessage.evaluation.max_cost_usd_micro,
        actual_cost_usd_micro: validMessage.evaluation.actual_cost_usd_micro,
      },
    });
    const nullResult = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 100,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: null,
        sample_size_baseline: null,
      },
    });
    const zeroCandidateResult = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 100,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: 0,
        sample_size_baseline: undefined,
      },
    });

    expect(
      missingResult.error?.details.some((detail) => detail.message.includes('derive totalSamples')),
    ).toBe(true);
    expect(
      nullResult.error?.details.some((detail) => detail.message.includes('derive totalSamples')),
    ).toBe(true);
    expect(
      zeroCandidateResult.error?.details.some((detail) =>
        detail.message.includes('derive totalSamples'),
      ),
    ).toBe(true);
  });

  test('accepts baseline fallback when candidate sample size is zero', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 1000,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: 0,
        sample_size_baseline: 1000,
      },
    });

    expect(result.error).toBeUndefined();
  });

  test('accepts valid totalSamples >= 1', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 1,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: undefined,
        sample_size_baseline: 1,
      },
    });
    expect(result.error).toBeUndefined();
  });

  test('rejects totalSamples = 0', () => {
    const result = validateMintRequestMessage({ ...validMessage, totalSamples: 0 });
    expect(result.error).toBeDefined();
  });

  test('rejects negative totalSamples', () => {
    const result = validateMintRequestMessage({ ...validMessage, totalSamples: -5 });
    expect(result.error).toBeDefined();
  });

  test('rejects float totalSamples', () => {
    const result = validateMintRequestMessage({ ...validMessage, totalSamples: 3.7 });
    expect(result.error).toBeDefined();
  });

  test('rejects missing totalSamples', () => {
    const { totalSamples: _, ...withoutTotalSamples } = validMessage;
    const result = validateMintRequestMessage(withoutTotalSamples);
    expect(result.error).toBeDefined();
  });

  test('rejects non-numeric totalSamples', () => {
    const result = validateMintRequestMessage({ ...validMessage, totalSamples: 'abc' });
    expect(result.error).toBeDefined();
  });

  test('rejects totalSamples mismatch with evaluation.sample_size_candidate', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 999,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: 140,
      },
    });
    expect(result.error).toBeDefined();
    expect(result.error?.details.some((d) => d.message.includes('does not match'))).toBe(true);
  });

  test('accepts totalSamples when sample_size_candidate is absent', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 500,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: undefined,
        sample_size_baseline: 500,
      },
    });
    expect(result.error).toBeUndefined();
  });

  test('accepts totalSamples matching sample_size_candidate', () => {
    const result = validateMintRequestMessage({
      ...validMessage,
      totalSamples: 140,
      evaluation: {
        ...validMessage.evaluation,
        sample_size_candidate: 140,
      },
    });
    expect(result.error).toBeUndefined();
  });

  test('deriveTotalSamples prefers candidate then falls back to baseline', () => {
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: 44,
        sample_size_baseline: 33,
      }),
    ).toBe(44);
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: 0,
        sample_size_baseline: 33,
      }),
    ).toBe(33);
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: null,
        sample_size_baseline: 33,
      }),
    ).toBe(33);
  });

  test('deriveTotalSamples returns null when no positive integer sample size exists', () => {
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: undefined,
        sample_size_baseline: undefined,
      }),
    ).toBeNull();
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: null,
        sample_size_baseline: 0,
      }),
    ).toBeNull();
    expect(
      deriveTotalSamples({
        ...validMessage.evaluation,
        sample_size_candidate: 3.7,
        sample_size_baseline: 2.2,
      }),
    ).toBeNull();
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
