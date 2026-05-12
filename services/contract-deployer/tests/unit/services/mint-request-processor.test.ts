import { ethers } from 'ethers';
import { MintRequestProcessor } from '../../../src/services/mint-request-processor';
import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';

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
});
