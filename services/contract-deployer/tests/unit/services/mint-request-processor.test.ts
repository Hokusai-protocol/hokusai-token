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
    expect(payload.anchors.datasetHash).toBe('0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
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
        ethers.AbiCoder.defaultAbiCoder().encode(['uint256', 'string'], [21n, message.evaluation.metric_name])
      )
    );
    expect(settlement.status).toBe('no_delta');
  });

  test('derives totalSamples from sample_size_candidate when present', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      evaluation: {
        ...message.evaluation,
        sample_size_candidate: 1500,
      },
    });

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.totalSamples).toBe(1500);
  });

  test('derives totalSamples from sample_size_baseline when candidate is absent', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      evaluation: {
        ...message.evaluation,
        sample_size_baseline: 800,
      },
    });

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.totalSamples).toBe(800);
  });

  test('uses top-level total_samples with precedence over sample_size_candidate', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      total_samples: 2000,
      evaluation: {
        ...message.evaluation,
        sample_size_candidate: 1500,
      },
    });

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.totalSamples).toBe(2000);
  });

  test('falls back to zero when no sample size is present', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '0',
      }),
    } as any;

    const processor = new MintRequestProcessor(client);
    await processor.process(message);

    const payload = client.submitMintRequest.mock.calls[0][1];
    expect(payload.totalSamples).toBe(0);
  });

  test('emits audit log with statistical fields', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '123',
      }),
    } as any;

    const loggerSpy = jest.spyOn(logger, 'info').mockImplementation();

    const processor = new MintRequestProcessor(client);
    await processor.process({
      ...message,
      total_samples: 2000,
      evaluation: {
        ...message.evaluation,
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

    expect(loggerSpy).toHaveBeenCalledWith('MintRequest evaluation metadata', expect.objectContaining({
      idempotency_key: message.idempotency_key,
      model_id: message.model_id,
      eval_id: message.eval_id,
      total_samples: 2000,
      sample_size_baseline: 1000,
      sample_size_candidate: 1000,
      ci_low_bps: 50,
      ci_high_bps: 550,
      p_value: 0.03,
      effect_size_bps: 300,
      statistical_method: 'bootstrap_ci',
      statistical_reason: 'accepted',
    }));

    loggerSpy.mockRestore();
  });

  test('emits audit log with null values for missing statistical fields', async () => {
    const client = {
      submitMintRequest: jest.fn().mockResolvedValue({
        status: 'minted',
        rewardAmount: '0',
      }),
    } as any;

    const loggerSpy = jest.spyOn(logger, 'info').mockImplementation();

    const processor = new MintRequestProcessor(client);
    await processor.process(message);

    expect(loggerSpy).toHaveBeenCalledWith('MintRequest evaluation metadata', expect.objectContaining({
      total_samples: 0,
      sample_size_baseline: null,
      sample_size_candidate: null,
      ci_low_bps: null,
      ci_high_bps: null,
      p_value: null,
      effect_size_bps: null,
      statistical_method: null,
      statistical_reason: null,
    }));

    loggerSpy.mockRestore();
  });
});
