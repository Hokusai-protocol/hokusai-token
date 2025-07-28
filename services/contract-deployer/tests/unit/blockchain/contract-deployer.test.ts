import { ethers } from 'ethers';
import { ContractDeployer } from '../../../src/blockchain/contract-deployer';
import { ModelReadyToDeployMessage } from '../../../src/schemas/message-schemas';
import { createMockProvider, createMockSigner, createMockContract, createMockTransactionResponse } from '../../mocks/ethers-mock';

describe('ContractDeployer', () => {
  let deployer: ContractDeployer;
  let mockProvider: jest.Mocked<ethers.Provider>;
  let mockSigner: jest.Mocked<ethers.Signer>;
  let mockContractFactory: jest.Mocked<ethers.ContractFactory>;
  let mockContract: jest.Mocked<ethers.Contract>;

  const config = {
    rpcUrls: ['https://polygon-rpc.com'],
    privateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
    tokenManagerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
    modelRegistryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    gasMultiplier: 1.2,
    maxGasPrice: '100000000000', // 100 gwei
    confirmations: 2
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
    message_version: '1.0'
  };

  beforeEach(() => {
    mockProvider = createMockProvider();
    mockSigner = createMockSigner();
    mockContract = createMockContract();
    mockContractFactory = {
      deploy: jest.fn().mockResolvedValue(mockContract),
      attach: jest.fn(),
      connect: jest.fn().mockReturnThis()
    } as any;

    // Mock ethers constructors
    jest.spyOn(ethers, 'JsonRpcProvider').mockReturnValue(mockProvider as any);
    jest.spyOn(ethers, 'Wallet').mockReturnValue(mockSigner as any);
    jest.spyOn(ethers, 'ContractFactory').mockReturnValue(mockContractFactory as any);
    
    mockSigner.connect.mockReturnValue(mockSigner);

    deployer = new ContractDeployer(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('Token deployment', () => {
    test('should deploy a new token contract', async () => {
      const deploymentReceipt = {
        contractAddress: '0x1234567890123456789012345678901234567890',
        hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('2845632'),
        gasPrice: ethers.toBigInt('35000000000'),
        confirmations: jest.fn().mockResolvedValue(2)
      };

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      const mockTx = createMockTransactionResponse();
      mockTx.hash = deploymentReceipt.hash;
      mockTx.wait.mockResolvedValue(deploymentReceipt);
      mockContract.deploymentTransaction.mockReturnValue(mockTx);
      mockContract.getAddress.mockResolvedValue(deploymentReceipt.contractAddress);

      const result = await deployer.deployToken(validMessage);

      expect(mockContractFactory.deploy).toHaveBeenCalledWith(
        `Hokusai ${validMessage.model_id}`,
        validMessage.token_symbol,
        config.tokenManagerAddress
      );

      expect(result).toEqual({
        tokenAddress: deploymentReceipt.contractAddress,
        transactionHash: deploymentReceipt.hash,
        blockNumber: deploymentReceipt.blockNumber,
        gasUsed: '2845632',
        gasPrice: '35000000000'
      });
    });

    test('should handle deployment with contributor address', async () => {
      const messageWithContributor = {
        ...validMessage,
        contributor_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d'
      };

      const deploymentReceipt = {
        contractAddress: '0x1234567890123456789012345678901234567890',
        hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('2845632'),
        gasPrice: ethers.toBigInt('35000000000'),
        confirmations: jest.fn().mockResolvedValue(2)
      };

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      const mockTx = createMockTransactionResponse();
      mockTx.hash = deploymentReceipt.hash;
      mockTx.wait.mockResolvedValue(deploymentReceipt);
      mockContract.deploymentTransaction.mockReturnValue(mockTx);
      mockContract.getAddress.mockResolvedValue(deploymentReceipt.contractAddress);

      await deployer.deployToken(messageWithContributor);

      // Should set contributor after deployment
      expect(mockContract.setContributor).toHaveBeenCalledWith(
        messageWithContributor.contributor_address
      );
    });

    test('should retry on deployment failure', async () => {
      mockContractFactory.deploy
        .mockRejectedValueOnce(new Error('Nonce too low'))
        .mockResolvedValueOnce(mockContract);

      const deploymentReceipt = {
        contractAddress: '0x1234567890123456789012345678901234567890',
        hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('2845632'),
        gasPrice: ethers.toBigInt('35000000000'),
        confirmations: jest.fn().mockResolvedValue(2)
      };

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      const mockTx = createMockTransactionResponse();
      mockTx.hash = deploymentReceipt.hash;
      mockTx.wait.mockResolvedValue(deploymentReceipt);
      mockContract.deploymentTransaction.mockReturnValue(mockTx);
      mockContract.getAddress.mockResolvedValue(deploymentReceipt.contractAddress);

      const result = await deployer.deployToken(validMessage);

      expect(mockContractFactory.deploy).toHaveBeenCalledTimes(2);
      expect(result.tokenAddress).toBe(deploymentReceipt.contractAddress);
    });

    test('should fail after max retries', async () => {
      mockContractFactory.deploy.mockRejectedValue(new Error('Insufficient funds'));

      await expect(deployer.deployToken(validMessage)).rejects.toThrow('Insufficient funds');
      expect(mockContractFactory.deploy).toHaveBeenCalledTimes(3); // Default max retries
    });
  });

  describe('Gas estimation', () => {
    test('should estimate gas with multiplier', async () => {
      const estimatedGas = ethers.toBigInt('2000000');
      const gasPrice = ethers.toBigInt('30000000000');
      
      mockProvider.estimateGas.mockResolvedValue(estimatedGas);
      mockProvider.getFeeData.mockResolvedValue({
        gasPrice,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        toJSON: () => ({ gasPrice: gasPrice.toString() })
      } as any);

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      mockContract.deploymentTransaction.mockReturnValue({ 
        hash: '0xabc',
        wait: jest.fn().mockResolvedValue({
          contractAddress: '0x123',
          hash: '0xabc',
          blockNumber: 123,
          gasUsed: estimatedGas,
          gasPrice
        })
      });
      mockContract.getAddress.mockResolvedValue('0x123');

      await deployer.deployToken(validMessage);

      const expectedGasLimit = estimatedGas * ethers.toBigInt(12) / ethers.toBigInt(10); // 1.2x multiplier
      expect(mockContractFactory.deploy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          gasLimit: expectedGasLimit
        })
      );
    });

    test('should cap gas price at maximum', async () => {
      const highGasPrice = ethers.toBigInt('200000000000'); // 200 gwei
      
      mockProvider.getFeeData.mockResolvedValue({
        gasPrice: highGasPrice,
        maxFeePerGas: null,
        maxPriorityFeePerGas: null,
        toJSON: () => ({ gasPrice: highGasPrice.toString() })
      } as any);

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      mockContract.deploymentTransaction.mockReturnValue({ 
        hash: '0xabc',
        wait: jest.fn().mockResolvedValue({
          contractAddress: '0x123',
          hash: '0xabc',
          blockNumber: 123,
          gasUsed: ethers.toBigInt('2000000'),
          gasPrice: ethers.toBigInt(config.maxGasPrice)
        })
      });
      mockContract.getAddress.mockResolvedValue('0x123');

      await deployer.deployToken(validMessage);

      expect(mockContractFactory.deploy).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          gasPrice: ethers.toBigInt(config.maxGasPrice)
        })
      );
    });
  });

  describe('Network handling', () => {
    test('should fall back to next RPC on connection error', async () => {
      const secondProvider = createMockProvider();
      
      jest.spyOn(ethers, 'JsonRpcProvider')
        .mockReturnValueOnce(mockProvider as any)
        .mockReturnValueOnce(secondProvider as any);
      
      mockProvider.getNetwork.mockRejectedValue(new Error('Connection failed'));
      secondProvider.getNetwork.mockResolvedValue({ chainId: 137n, name: 'polygon' });
      
      const deployerWithMultipleRpcs = new ContractDeployer({
        ...config,
        rpcUrls: ['https://failing-rpc.com', 'https://working-rpc.com']
      });

      // Should successfully initialize with second RPC
      expect(secondProvider.getNetwork).toHaveBeenCalled();
    });

    test('should handle transaction confirmation timeouts', async () => {
      const deploymentReceipt = {
        contractAddress: '0x1234567890123456789012345678901234567890',
        hash: '0xabcdef1234567890123456789012345678901234567890123456789012345678',
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('2845632'),
        gasPrice: ethers.toBigInt('35000000000'),
        confirmations: jest.fn()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(2)
      };

      mockContract.waitForDeployment.mockResolvedValue(mockContract);
      const mockTx = createMockTransactionResponse();
      mockTx.hash = deploymentReceipt.hash;
      mockTx.wait.mockResolvedValue(deploymentReceipt);
      mockContract.deploymentTransaction.mockReturnValue(mockTx);
      mockContract.getAddress.mockResolvedValue(deploymentReceipt.contractAddress);

      const result = await deployer.deployToken(validMessage);

      expect(deploymentReceipt.confirmations).toHaveBeenCalledTimes(2);
      expect(result.blockNumber).toBe(deploymentReceipt.blockNumber);
    });
  });

  describe('getNetworkInfo', () => {
    test('should return current network information', async () => {
      mockProvider.getNetwork.mockResolvedValue({ 
        chainId: 137n, 
        name: 'polygon' 
      });
      
      const sampleAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d';
      mockSigner.getAddress.mockResolvedValue(sampleAddress);
      
      mockProvider.getBalance.mockResolvedValue(ethers.toBigInt('1000000000000000000'));

      const networkInfo = await deployer.getNetworkInfo();

      expect(networkInfo).toEqual({
        network: 'polygon',
        chainId: 137,
        deployerAddress: sampleAddress,
        deployerBalance: '1000000000000000000'
      });
    });
  });
});