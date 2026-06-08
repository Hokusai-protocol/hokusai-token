import { ethers } from 'ethers';
import {
  ContractDeployer,
  ContractDeployerConfig,
} from '../../../src/blockchain/contract-deployer';
import { ModelReadyToDeployMessage } from '../../../src/schemas/message-schemas';
import {
  createMockProvider,
  createMockSigner,
  createMockTransactionResponse,
} from '../../mocks/ethers-mock';

describe('ContractDeployer', () => {
  let deployer: ContractDeployer;
  let mockProvider: jest.Mocked<ethers.Provider>;
  let mockSigner: jest.Mocked<ethers.Signer>;
  let mockTokenManager: any;

  const defaultDeploymentParams = {
    modelSupplierAllocation: BigInt('2500000000000000000000000'),
    modelSupplierRecipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
    investorAllocation: BigInt('10000000000000000000000000'),
    tokensPerDeltaOne: BigInt('5000000000000000000000'),
    infrastructureAccrualBps: 8000,
    initialOraclePricePerThousandUsd: BigInt('0'),
    licenseHash: '0x' + '00'.repeat(32),
    licenseURI: 'https://example.com/license',
    governor: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
  };

  const config: ContractDeployerConfig = {
    rpcUrls: ['https://sepolia-rpc.com'],
    privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    tokenManagerAddress: '0x4ebC3558Ec08c81AbB9F220fd2C98c838b96De68',
    modelRegistryAddress: '0x8E891850C0677c2D9581c953bF1Df5446cB4c54f',
    gasMultiplier: 1.2,
    maxGasPrice: '100000000000',
    confirmations: 2,
    deploymentParams: defaultDeploymentParams,
  };

  const validMessage: ModelReadyToDeployMessage = {
    model_id: 'model_123',
    token_symbol: 'HKAI-123',
    metric_name: 'accuracy',
    baseline_value: 0.854,
    current_value: 0.884,
    model_name: 'enhanced_classifier_v1',
    model_version: '1.1.0',
    mlflow_run_id: 'run_abc123',
    improvement_percentage: 3.51,
    timestamp: '2024-01-27T10:00:00Z',
    message_version: '1.0',
  };

  const tokenAddress = '0x9690580864274E57899a79bD97e8d7C6cAe0d7d5';
  const txHash = '0xabcdef1234567890123456789012345678901234567890123456789012345678';

  function makeMockReceipt(overrides: Record<string, any> = {}) {
    return {
      hash: txHash,
      blockNumber: 12345678,
      gasUsed: ethers.toBigInt('2845632'),
      gasPrice: ethers.toBigInt('35000000000'),
      status: 1,
      logs: [{ topics: ['0x00'], data: '0x' }],
      ...overrides,
    };
  }

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockSigner = createMockSigner();

    const mockInterface = {
      parseLog: jest.fn().mockReturnValue({
        name: 'TokenDeployed',
        args: { tokenAddress },
      }),
    };

    const mockTx = createMockTransactionResponse();
    mockTx.wait = jest.fn().mockResolvedValue(makeMockReceipt());

    mockTokenManager = {
      deployTokenWithAllocations: jest.fn().mockResolvedValue(mockTx),
      interface: mockInterface,
    };

    mockProvider.getNetwork.mockResolvedValue({ chainId: 11155111n, name: 'sepolia' } as any);

    jest.spyOn(ethers, 'JsonRpcProvider').mockReturnValue(mockProvider as any);
    jest.spyOn(ethers, 'Wallet').mockReturnValue(mockSigner as any);
    jest.spyOn(ethers, 'Contract').mockReturnValue(mockTokenManager);

    mockSigner.connect.mockReturnValue(mockSigner);
    mockProvider.getFeeData.mockResolvedValue({
      gasPrice: ethers.toBigInt('30000000000'),
      maxFeePerGas: null,
      maxPriorityFeePerGas: null,
      toJSON: () => ({}),
    } as any);

    deployer = new ContractDeployer(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Token deployment via deployTokenWithAllocations', () => {
    test('should call TokenManager.deployTokenWithAllocations with correct args', async () => {
      const result = await deployer.deployToken(validMessage);

      expect(ethers.Contract).toHaveBeenCalledWith(
        config.tokenManagerAddress,
        expect.any(Array),
        mockSigner,
      );

      expect(mockTokenManager.deployTokenWithAllocations).toHaveBeenCalledWith(
        validMessage.model_id,
        `Hokusai ${validMessage.model_id}`,
        validMessage.token_symbol,
        defaultDeploymentParams.modelSupplierAllocation,
        defaultDeploymentParams.modelSupplierRecipient,
        defaultDeploymentParams.investorAllocation,
        expect.objectContaining({
          tokensPerDeltaOne: defaultDeploymentParams.tokensPerDeltaOne,
          infrastructureAccrualBps: defaultDeploymentParams.infrastructureAccrualBps,
          governor: defaultDeploymentParams.governor,
          vestingConfig: expect.objectContaining({
            enabled: false,
            immediateUnlockBps: 10000,
          }),
        }),
        expect.objectContaining({ gasPrice: expect.any(BigInt) }),
      );

      expect(result).toEqual({
        tokenAddress,
        transactionHash: txHash,
        blockNumber: 12345678,
        gasUsed: '2845632',
        gasPrice: '35000000000',
      });
    });

    test('should extract token address from TokenDeployed event', async () => {
      const customAddress = '0x1111111111111111111111111111111111111111';
      mockTokenManager.interface.parseLog.mockReturnValue({
        name: 'TokenDeployed',
        args: { tokenAddress: customAddress },
      });

      const result = await deployer.deployToken(validMessage);
      expect(result.tokenAddress).toBe(customAddress);
    });

    test('should throw when TokenDeployed event is missing', async () => {
      mockTokenManager.interface.parseLog.mockReturnValue(null);

      await expect(deployer.deployToken(validMessage)).rejects.toThrow(
        'TokenDeployed event not found in receipt',
      );
    });

    test('should retry on deployment failure', async () => {
      const mockTx = createMockTransactionResponse();
      mockTx.wait = jest.fn().mockResolvedValue(makeMockReceipt());

      mockTokenManager.deployTokenWithAllocations
        .mockRejectedValueOnce(new Error('Nonce too low'))
        .mockResolvedValueOnce(mockTx);

      const result = await deployer.deployToken(validMessage);

      expect(mockTokenManager.deployTokenWithAllocations).toHaveBeenCalledTimes(2);
      expect(result.tokenAddress).toBe(tokenAddress);
    });

    test('should fail after max retries', async () => {
      mockTokenManager.deployTokenWithAllocations.mockRejectedValue(
        new Error('Insufficient funds'),
      );

      await expect(deployer.deployToken(validMessage)).rejects.toThrow('Insufficient funds');
      expect(mockTokenManager.deployTokenWithAllocations).toHaveBeenCalledTimes(3);
    });

    test('should cap gas price at maximum', async () => {
      const highGasPrice = ethers.toBigInt('200000000000');
      mockProvider.getFeeData.mockResolvedValue({
        gasPrice: highGasPrice,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        toJSON: () => ({}),
      } as any);

      await deployer.deployToken(validMessage);

      expect(mockTokenManager.deployTokenWithAllocations).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.any(BigInt),
        expect.any(String),
        expect.any(BigInt),
        expect.any(Object),
        expect.objectContaining({
          gasPrice: ethers.toBigInt(config.maxGasPrice),
        }),
      );
    });
  });

  describe('getNetworkInfo', () => {
    test('should return current network information', async () => {
      mockProvider.getNetwork.mockResolvedValue({
        chainId: 11155111n,
        name: 'sepolia',
      } as any);

      const sampleAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d';
      mockSigner.getAddress.mockResolvedValue(sampleAddress);
      mockProvider.getBalance.mockResolvedValue(ethers.toBigInt('1000000000000000000'));

      const networkInfo = await deployer.getNetworkInfo();

      expect(networkInfo).toEqual({
        network: 'sepolia',
        chainId: 11155111,
        deployerAddress: sampleAddress,
        deployerBalance: '1000000000000000000',
      });
    });
  });
});
