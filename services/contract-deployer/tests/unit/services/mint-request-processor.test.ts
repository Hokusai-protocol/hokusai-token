import { ethers } from 'ethers';
import { MintRequestProcessor } from '../../../src/services/mint-request-processor';
import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';
import { logger } from '../../../src/utils/logger';

describe('MintRequestProcessor', () => {
  const message: MintRequestMessage = {
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
        weight_bps: 10000,
      },
    ],
  };

  test('maps optional benchmark anchors when present', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
        txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        blockNumber: 9,
        gasUsed: '77',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      benchmark_spec_id: 'bench-1',
      dataset_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.anchors.benchmarkSpecHash).toBe(ethers.keccak256(ethers.toUtf8Bytes('bench-1')));
    expect(payload.anchors.datasetHash).toBe(
      '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    );
    expect(payload.totalSamples).toBe(140);
  });

  test('falls back to derived benchmark hash and zero dataset hash', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'no_delta',
        rewardAmount: '0',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    const settlement = await processor.process(message);

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.anchors.datasetHash).toBe(ethers.ZeroHash);
    expect(payload.anchors.benchmarkSpecHash).toBe(
      ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['uint256', 'string'],
          [21n, message.evaluation.metric_name],
        ),
      ),
    );
    expect(payload.totalSamples).toBe(140);
    expect(settlement.status).toBe('no_delta');
  });

  test('uses message.totalSamples directly in payload', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'no_delta',
        rewardAmount: '0',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      totalSamples: 120,
      evaluation: {
        ...message.evaluation,
        sample_size_candidate: 0,
      },
    });

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.totalSamples).toBe(120);
  });

  test('audit logs statistical metadata when present and omits absent fields', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
        txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
        blockNumber: 9,
        gasUsed: '77',
      }),
    } as any;
    const loggerInfoSpy = jest.spyOn(logger, 'info').mockImplementation() as jest.Mock;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      evaluation: {
        ...message.evaluation,
        ci_low_bps: 50,
        ci_high_bps: 550,
        p_value: 0.03,
        effect_size_bps: 300,
        statistical_method: 'bootstrap_ci',
        statistical_reason: 'accepted',
      },
    });

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      'MintRequest processed',
      expect.objectContaining({
        idempotencyKey: message.idempotency_key,
        modelId: message.model_id,
        totalSamples: 140,
        ciLowBps: 50,
        ciHighBps: 550,
        pValue: 0.03,
        effectSizeBps: 300,
        statisticalMethod: 'bootstrap_ci',
        statisticalReason: 'accepted',
        sampleSizeBaseline: 120,
        sampleSizeCandidate: 140,
      }),
    );
    const firstLogMetadata = loggerInfoSpy.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(firstLogMetadata).not.toHaveProperty('foo');

    loggerInfoSpy.mockClear();

    await processor.process({
      ...message,
      totalSamples: 120,
      evaluation: {
        ...message.evaluation,
        ci_low_bps: null,
        ci_high_bps: null,
        p_value: null,
        effect_size_bps: null,
        statistical_method: null,
        statistical_reason: null,
        sample_size_candidate: null,
      },
    });

    expect(loggerInfoSpy).toHaveBeenCalledWith(
      'MintRequest processed',
      expect.objectContaining({
        idempotencyKey: message.idempotency_key,
        modelId: message.model_id,
        totalSamples: 120,
        sampleSizeBaseline: 120,
      }),
    );
    const secondLogMetadata = loggerInfoSpy.mock.calls[0]?.[1] as Record<string, unknown>;

    expect(secondLogMetadata).not.toHaveProperty('ciLowBps');
    expect(secondLogMetadata).not.toHaveProperty('sampleSizeCandidate');
  });
});
