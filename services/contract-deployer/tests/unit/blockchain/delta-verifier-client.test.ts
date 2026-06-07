import { ethers, Interface } from 'ethers';
import {
  DeltaVerifierClient,
  MintRequestSubmissionError,
} from '../../../src/blockchain/delta-verifier-client';
import serviceArtifact from '../../../contracts/DeltaVerifier.json';

describe('DeltaVerifierClient', () => {
  const deltaVerifierAddress = '0x1111111111111111111111111111111111111111';
  const registryAddress = '0x2222222222222222222222222222222222222222';
  let deltaVerifierContract: any;
  let modelRegistryContract: any;
  let provider: any;
  let signer: any;

  beforeEach(() => {
    deltaVerifierContract = {
      processedIdempotencyKeys: jest.fn(),
      interface: {
        parseLog: jest.fn(),
      },
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

    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

    const result = await client.submitMintRequest(
      21n,
      {
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
      },
      [],
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

    deltaVerifierContract.interface.parseLog.mockReturnValue({
      name: 'DeltaOneAccepted',
      args: {
        rewardAmount: 55n,
      },
    });
    deltaVerifierContract.submitMintRequest.mockResolvedValue({
      wait: jest.fn().mockResolvedValue(receipt),
    });

    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

    const result = await client.submitMintRequest(
      21n,
      {
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
      },
      [],
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
      expect.objectContaining({ totalSamples: 1 }),
      [],
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

    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

    await expect(
      client.submitMintRequest(
        21n,
        {
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
        },
        [],
      ),
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

    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

    await expect(
      client.submitMintRequest(
        21n,
        {
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
        },
        [],
      ),
    ).rejects.toMatchObject({
      name: 'MintRequestSubmissionError',
      failureClass: 'permanent',
      onChainOutcomeUnknown: true,
      txHash: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    } satisfies Partial<MintRequestSubmissionError>);
  });

  test('wraps execution reverted errors as permanent submission failures', async () => {
    deltaVerifierContract.processedIdempotencyKeys.mockResolvedValue(false);
    modelRegistryContract.isRegistered.mockResolvedValue(true);
    modelRegistryContract.isModelActive.mockResolvedValue(true);
    deltaVerifierContract.submitMintRequest.estimateGas.mockRejectedValue(
      new Error('execution reverted: mint rejected'),
    );

    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress,
      modelRegistryAddress: registryAddress,
      confirmations: 1,
      gasMultiplier: 1.2,
      maxGasPrice: '1000',
    });

    await expect(
      client.submitMintRequest(
        21n,
        {
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
        },
        [],
      ),
    ).rejects.toMatchObject({
      name: 'MintRequestSubmissionError',
      failureClass: 'permanent',
      message: 'execution reverted: mint rejected',
    } satisfies Partial<MintRequestSubmissionError>);
  });
});

describe('submitMintRequest calldata encoding', () => {
  const iface = new Interface(serviceArtifact.abi);

  test('encodes a current-shape payload with selector 0x6d2140ad', () => {
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
    };

    const contributors = [
      { walletAddress: '0x742D35cC6634C0532925a3b844BC9E7595f82b3d', weight: 10000 },
    ];

    const calldata = iface.encodeFunctionData('submitMintRequest', [21n, payload, contributors]);
    expect(calldata.startsWith('0x6d2140ad')).toBe(true);
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
    };

    expect(() => iface.encodeFunctionData('submitMintRequest', [21n, payload, []])).toThrow();
  });
});
