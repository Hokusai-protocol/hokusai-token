import { ethers } from 'ethers';
import { DeltaVerifierClient } from '../../../src/blockchain/delta-verifier-client';

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

    const result = await client.submitMintRequest(21n, {
      pipelineRunId: 'eval-1',
      baselineScoreBps: 5000,
      candidateScoreBps: 7500,
      maxCostUsdMicro: 0,
      actualCostUsdMicro: 0,
      anchors: {
        benchmarkSpecHash: ethers.ZeroHash,
        datasetHash: ethers.ZeroHash,
        attestationHash: ethers.ZeroHash,
        idempotencyKey: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        metricName: 'metric',
        metricFamily: 'family',
      },
    }, []);

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

    const result = await client.submitMintRequest(21n, {
      pipelineRunId: 'eval-1',
      baselineScoreBps: 5000,
      candidateScoreBps: 7500,
      maxCostUsdMicro: 0,
      actualCostUsdMicro: 0,
      anchors: {
        benchmarkSpecHash: ethers.ZeroHash,
        datasetHash: ethers.ZeroHash,
        attestationHash: ethers.ZeroHash,
        idempotencyKey: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        metricName: 'metric',
        metricFamily: 'family',
      },
    }, []);

    expect(result).toEqual({
      status: 'minted',
      txHash: receipt.hash,
      blockNumber: 7,
      rewardAmount: '55',
      gasUsed: '321',
    });
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
      client.submitMintRequest(21n, {
        pipelineRunId: 'eval-1',
        baselineScoreBps: 5000,
        candidateScoreBps: 7500,
        maxCostUsdMicro: 0,
        actualCostUsdMicro: 0,
        anchors: {
          benchmarkSpecHash: ethers.ZeroHash,
          datasetHash: ethers.ZeroHash,
          attestationHash: ethers.ZeroHash,
          idempotencyKey: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          metricName: 'metric',
          metricFamily: 'family',
        },
      }, [])
    ).rejects.toThrow('Model not registered');
  });
});
