import { ethers, Interface } from 'ethers';
import {
  DeltaVerifierClient,
  MintBudgetExceededError,
  MintRequestSubmissionError,
} from '../../../src/blockchain/delta-verifier-client';
import serviceArtifact from '../../../contracts/DeltaVerifier.json';

describe('DeltaVerifierClient', () => {
  const deltaVerifierAddress = '0x1111111111111111111111111111111111111111';
  const registryAddress = '0x2222222222222222222222222222222222222222';
  const attesterSignatures = [
    '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
  ];

  let deltaVerifierContract: any;
  let modelRegistryContract: any;
  let provider: any;
  let signer: any;

  const buildPayload = () => ({
    pipelineRunId: 'eval-1',
    baselineScoreBps: 5000,
    candidateScoreBps: 7500,
    maxCostUsdMicro: 0,
    actualCostUsdMicro: 0,
    totalSamples: 1,
    anchors: {
      benchmarkSpecHash: ethers.ZeroHash,
      datasetHash: ethers.ZeroHash,
      attestationHash: ethers.ZeroHash,
      idempotencyKey: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      metricName: 'metric',
      metricFamily: 'family',
    },
    baselineCommitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
    candidateCommitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
  });

  const createClient = () =>
    new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

  beforeEach(() => {
    deltaVerifierContract = {
      processedIdempotencyKeys: jest.fn(),
      interface: new Interface(serviceArtifact.abi),
      submitMintRequest: jest.fn(),
    };
    deltaVerifierContract.submitMintRequest.estimateGas = jest.fn();

    modelRegistryContract = {
      isRegistered: jest.fn(),
      isModelActive: jest.fn(),
    };

    provider = {
      getFeeData: jest.fn().mockResolvedValue({ gasPrice: 50n }),
    };
    signer = { getAddress: jest.fn() };

    jest.spyOn(ethers, 'Contract').mockImplementation(((address: string | ethers.Addressable) => {
      const target = typeof address === 'string' ? address : '';
      if (target === deltaVerifierAddress) {
        return deltaVerifierContract;
      }
      if (target === registryAddress) {
        return modelRegistryContract;
      }
      throw new Error(`Unexpected contract ${target}`);
    }) as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('returns replay before sending a transaction when the key is already processed', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(true);

    const result = await createClient().submitMintRequest(
      21n,
      buildPayload(),
      [],
      attesterSignatures,
    );

    expect(result.status).toBe('replay');
    expect(deltaVerifierContract.submitMintRequest).not.toHaveBeenCalled();
  });

  test('submits and classifies minted receipts', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockResolvedValue(100n);

    const receipt = {
      status: 1,
      hash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
      blockNumber: 7,
      gasUsed: 321n,
      logs: [{}],
    };
    jest.spyOn(deltaVerifierContract.interface, 'parseLog').mockReturnValue({
      name: 'DeltaOneAccepted',
      args: { rewardAmount: 55n },
    } as any);

    deltaVerifierContract.submitMintRequest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue(receipt),
    });

    const result = await createClient().submitMintRequest(
      21n,
      buildPayload(),
      [],
      attesterSignatures,
    );

    expect(result).toEqual({
      status: 'minted',
      txHash: receipt.hash,
      blockNumber: 7,
      rewardAmount: '55',
      gasUsed: '321',
    });
    expect(deltaVerifierContract.submitMintRequest).toHaveBeenCalledWith(
      21n,
      expect.objectContaining({
        baselineCommitment: buildPayload().baselineCommitment,
        candidateCommitment: buildPayload().candidateCommitment,
      }),
      [],
      attesterSignatures,
      expect.objectContaining({
        gasLimit: expect.any(BigInt),
        gasPrice: 50n,
      }),
    );
  });

  test('throws for unregistered or inactive models', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(false);
    modelRegistryContract.isModelActive.mockResolvedValue(true);

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toThrow('Model not registered');
  });

  test('marks receipt-wait failures after broadcast as permanent unknown-outcome errors', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockResolvedValue(100n);
    deltaVerifierContract.submitMintRequest.mockResolvedValue({
      hash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      wait: jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('ECONNRESET'), { code: 'ECONNRESET' })),
    });

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toMatchObject({
      name: 'MintRequestSubmissionError',
      failureClass: 'permanent',
      onChainOutcomeUnknown: true,
      txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    } satisfies Partial<MintRequestSubmissionError>);
  });

  test('detects MintBudgetExceeded from estimateGas as a transient typed error', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        data: deltaVerifierContract.interface.encodeErrorResult('MintBudgetExceeded', [
          21n,
          1_000_000n,
          500_000n,
        ]),
      }),
    );

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toMatchObject({
      name: 'MintBudgetExceededError',
      failureClass: 'transient',
      modelId: 21n,
      requiredAmount: 1_000_000n,
      remainingBudget: 500_000n,
    } satisfies Partial<MintBudgetExceededError>);
  });

  test('detects MintBudgetExceeded from submit and does not re-wrap it as permanent', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockResolvedValue(100n);
    deltaVerifierContract.submitMintRequest.mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        data: deltaVerifierContract.interface.encodeErrorResult('MintBudgetExceeded', [
          21n,
          1_000_000n,
          500_000n,
        ]),
      }),
    );

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toBeInstanceOf(MintBudgetExceededError);
    expect(deltaVerifierContract.submitMintRequest).toHaveBeenCalledTimes(1);
  });

  test('wraps other execution reverted errors as permanent submission failures', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockRejectedValue(
      new Error('execution reverted: LineageParentMismatch'),
    );

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toMatchObject({
      name: 'MintRequestSubmissionError',
      failureClass: 'permanent',
      message: 'execution reverted: LineageParentMismatch',
    } satisfies Partial<MintRequestSubmissionError>);
  });

  test('preserves permanent classification for non-budget contract errors from submit', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockResolvedValue(100n);
    deltaVerifierContract.submitMintRequest.mockRejectedValue(
      Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        data: deltaVerifierContract.interface.encodeErrorResult('SignerNotAttester', [
          '0x742d35cc6634c0532925a3b844bc9e7595f82b3d',
        ]),
      }),
    );

    await expect(
      createClient().submitMintRequest(21n, buildPayload(), [], attesterSignatures),
    ).rejects.toMatchObject({
      name: 'MintRequestSubmissionError',
      failureClass: 'permanent',
    } satisfies Partial<MintRequestSubmissionError>);
  });
});

describe('submitMintRequest calldata encoding', () => {
  const iface = new Interface(serviceArtifact.abi);

  test('encodes a current-shape payload with selector 0xc9b4e69b', () => {
    const payload = {
      pipelineRunId: 'eval-1',
      baselineScoreBps: 5000,
      candidateScoreBps: 7500,
      maxCostUsdMicro: 0,
      actualCostUsdMicro: 0,
      totalSamples: 140,
      anchors: {
        benchmarkSpecHash: ethers.ZeroHash,
        datasetHash: ethers.ZeroHash,
        attestationHash: ethers.ZeroHash,
        idempotencyKey: ethers.ZeroHash,
        metricName: 'accuracy',
        metricFamily: 'classification',
      },
      baselineCommitment: '0x1111111111111111111111111111111111111111111111111111111111111111',
      candidateCommitment: '0x2222222222222222222222222222222222222222222222222222222222222222',
    };

    const contributors = [
      { walletAddress: '0x742D35cC6634C0532925a3b844BC9E7595f82b3d', weight: 10000 },
    ];
    const signatures = [
      '0x111111111111111111111111111111111111111111111111111111111111111122222222222222222222222222222222222222222222222222222222222222221b',
    ];

    const calldata = iface.encodeFunctionData('submitMintRequest', [
      21n,
      payload,
      contributors,
      signatures,
    ]);
    expect(calldata.startsWith('0xc9b4e69b')).toBe(true);
  });

  test('encoding fails loudly when totalSamples is missing', () => {
    const payload = {
      pipelineRunId: 'eval-1',
      baselineScoreBps: 5000,
      candidateScoreBps: 7500,
      maxCostUsdMicro: 0,
      actualCostUsdMicro: 0,
      anchors: {
        benchmarkSpecHash: ethers.ZeroHash,
        datasetHash: ethers.ZeroHash,
        attestationHash: ethers.ZeroHash,
        idempotencyKey: ethers.ZeroHash,
        metricName: 'accuracy',
        metricFamily: 'classification',
      },
      baselineCommitment: ethers.ZeroHash,
      candidateCommitment: ethers.ZeroHash,
    };

    expect(() => iface.encodeFunctionData('submitMintRequest', [21n, payload, [], []])).toThrow();
  });
});
