import { DirectMintSettlementClient } from '../../../src/services/direct-mint-settlement-client';
import { DecodedMintReceipt } from '../../../src/blockchain/delta-verifier-client';
import { MintRequestMessage } from '../../../src/schemas/mint-request-schema';

describe('DirectMintSettlementClient', () => {
  const message: MintRequestMessage = {
    message_type: 'mint_request',
    schema_version: '1.0',
    message_id: 'msg-1',
    timestamp: '2026-07-03T12:00:00.000Z',
    model_id: 'sales-outreach-v1',
    model_id_uint: '21',
    eval_id: 'eval-1',
    benchmark_spec_id: 'bench-1',
    dataset_hash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    attestation_hash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    idempotency_key: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    baseline_commitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
    candidate_commitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
    attester_signatures: [
      '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
    ],
    totalSamples: 140,
    deadline: 4102444800,
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
        wallet_address: '0x1111111111111111111111111111111111111111',
        weight_bps: 7000,
        recipientKind: 'wallet',
        submissionId: '33333333-3333-3333-3333-333333333331',
        contributorId: '44444444-4444-4444-4444-444444444441',
      },
      {
        wallet_address: '0x2222222222222222222222222222222222222222',
        weight_bps: 3000,
        recipientKind: 'escrow',
        submissionId: '33333333-3333-3333-3333-333333333332',
        contributorId: '44444444-4444-4444-4444-444444444442',
      },
    ],
  };

  const receipt: DecodedMintReceipt = {
    txHash: '0x9999999999999999999999999999999999999999999999999999999999999999',
    blockNumber: 123,
    totalReward: '245000000000000000000000',
    tokenAddress: '0x7777777777777777777777777777777777777777',
    tokenSymbol: 'HROUT',
    immediateAmount: '49000000000000000000000',
    vestedAmount: '196000000000000000000000',
    vestingVault: '0x8888888888888888888888888888888888888888',
    vestingSchedule: {
      scheduleId: '7',
      vaultAddress: '0x8888888888888888888888888888888888888888',
      tokenAddress: '0x7777777777777777777777777777777777777777',
      beneficiaryAddress: '0x1111111111111111111111111111111111111111',
      totalAmount: '196000000000000000000000',
      claimedAmount: '0',
      startAt: '2026-07-03T12:00:00.000Z',
      endAt: '2027-07-03T12:00:00.000Z',
      durationSeconds: 31536000,
      cliffSeconds: 0,
    },
  };

  function client(): DirectMintSettlementClient {
    return new DirectMintSettlementClient({
      authServiceUrl: 'https://auth.service.local/',
      internalToken: 'secret',
      networkName: 'sepolia',
      chainId: 11155111,
      deltaVerifierAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      modelRegistryAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tokenManagerAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
    });
  }

  test('builds wallet contributor settlement rows and skips escrow contributors', () => {
    const rows = client().buildRows(message, receipt);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        reward_id:
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:44444444-4444-4444-4444-444444444441',
        submission_id: '33333333-3333-3333-3333-333333333331',
        user_id: '44444444-4444-4444-4444-444444444441',
        token_symbol: 'HROUT',
        token_address: '0x7777777777777777777777777777777777777777',
        amount: '171500.0',
        immediate_amount: '34300.0',
        vested_amount: '137200.0',
      }),
    );
    expect(rows[0]?.vesting_schedule).toEqual(
      expect.objectContaining({
        schedule_id: '7',
        vault_address: '0x8888888888888888888888888888888888888888',
        total_amount: '137200.0',
      }),
    );
    expect(rows[0]?.deployment).toEqual(
      expect.objectContaining({
        network: 'sepolia',
        chain_id: 11155111,
        delta_verifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token_manager: '0xcccccccccccccccccccccccccccccccccccccccc',
        block_number: 123,
      }),
    );
  });

  test('prefers per-recipient receipt facts when decoded logs include them', () => {
    const rows = client().buildRows(message, {
      ...receipt,
      recipientSettlements: [
        {
          recipientAddress: '0x1111111111111111111111111111111111111111',
          totalReward: '171500000000000000000000',
          immediateAmount: '30000000000000000000000',
          vestedAmount: '141500000000000000000000',
          vestingSchedule: {
            scheduleId: '11',
            vaultAddress: '0x8888888888888888888888888888888888888888',
            tokenAddress: '0x7777777777777777777777777777777777777777',
            beneficiaryAddress: '0x1111111111111111111111111111111111111111',
            totalAmount: '141500000000000000000000',
            claimedAmount: '0',
          },
        },
      ],
    });

    expect(rows[0]).toEqual(
      expect.objectContaining({
        amount: '171500.0',
        immediate_amount: '30000.0',
        vested_amount: '141500.0',
      }),
    );
    expect(rows[0]?.vesting_schedule).toEqual(
      expect.objectContaining({
        schedule_id: '11',
        total_amount: '141500.0',
      }),
    );
  });

  test('treats auth 409 as idempotent success', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 409,
      text: jest.fn().mockResolvedValue('already claimed'),
    } as any);

    await expect(client().postSettlements(message, receipt)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://auth.service.local/api/v1/internal/rewards/settlements/direct-mint',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer secret',
          'Idempotency-Key':
            '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:44444444-4444-4444-4444-444444444441',
        }),
      }),
    );

    fetchMock.mockRestore();
  });

  test('surfaces non-2xx auth failures as permanent settlement errors', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 422,
      text: jest.fn().mockResolvedValue('invalid settlement'),
    } as any);

    await expect(client().postSettlements(message, receipt)).rejects.toMatchObject({
      name: 'DirectMintSettlementError',
      failureClass: 'permanent',
      message: expect.stringContaining('422'),
    });

    fetchMock.mockRestore();
  });
});
