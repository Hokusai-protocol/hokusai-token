import { ethers } from 'ethers';
import { ModelRegistryService } from '../../../src/blockchain/model-registry';
import { createMockContract, createMockProvider, createMockSigner } from '../../mocks/ethers-mock';

describe('ModelRegistryService', () => {
  let registryService: ModelRegistryService;
  let mockContract: jest.Mocked<ethers.Contract>;
  let mockProvider: jest.Mocked<ethers.Provider>;
  let mockSigner: jest.Mocked<ethers.Signer>;

  const config = {
    registryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    provider: null as any,
    signer: null as any,
    confirmations: 2
  };

  beforeEach(() => {
    mockContract = createMockContract();
    mockProvider = createMockProvider();
    mockSigner = createMockSigner();
    
    config.provider = mockProvider;
    config.signer = mockSigner;

    jest.spyOn(ethers, 'Contract').mockReturnValue(mockContract as any);
    
    registryService = new ModelRegistryService(config);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('registerModel', () => {
    const modelData = {
      modelId: 'model_123',
      tokenAddress: '0x1234567890123456789012345678901234567890',
      metricName: 'accuracy',
      mlflowRunId: 'run_abc123'
    };

    test('should successfully register a model', async () => {
      const txHash = '0xabcdef1234567890123456789012345678901234567890123456789012345678';
      const receipt = {
        hash: txHash,
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('150000'),
        status: 1
      };

      mockContract.registerModel.mockResolvedValue({
        hash: txHash,
        wait: jest.fn().mockResolvedValue(receipt)
      });

      const result = await registryService.registerModel(modelData);

      expect(mockContract.registerModel).toHaveBeenCalledWith(
        modelData.modelId,
        modelData.tokenAddress,
        modelData.metricName,
        modelData.mlflowRunId
      );

      expect(result).toEqual({
        transactionHash: txHash,
        blockNumber: receipt.blockNumber,
        gasUsed: '150000',
        success: true
      });
    });

    test('should retry on temporary failures', async () => {
      const txHash = '0xabcdef1234567890123456789012345678901234567890123456789012345678';
      const receipt = {
        hash: txHash,
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('150000'),
        status: 1
      };

      mockContract.registerModel
        .mockRejectedValueOnce(new Error('Nonce too low'))
        .mockResolvedValueOnce({
          hash: txHash,
          wait: jest.fn().mockResolvedValue(receipt)
        });

      const result = await registryService.registerModel(modelData);

      expect(mockContract.registerModel).toHaveBeenCalledTimes(2);
      expect(result.success).toBe(true);
    });

    test('should handle registration failure', async () => {
      mockContract.registerModel.mockRejectedValue(
        new Error('Model already registered')
      );

      await expect(registryService.registerModel(modelData))
        .rejects.toThrow('Model already registered');
    });

    test('should handle transaction revert', async () => {
      const txHash = '0xabcdef1234567890123456789012345678901234567890123456789012345678';
      const receipt = {
        hash: txHash,
        blockNumber: 12345678,
        gasUsed: ethers.toBigInt('150000'),
        status: 0 // Failed transaction
      };

      mockContract.registerModel.mockResolvedValue({
        hash: txHash,
        wait: jest.fn().mockResolvedValue(receipt)
      });

      await expect(registryService.registerModel(modelData))
        .rejects.toThrow('Transaction reverted');
    });
  });

  describe('checkModelExists', () => {
    test('should return true for existing model', async () => {
      const tokenAddress = '0x1234567890123456789012345678901234567890';
      mockContract.getTokenAddress.mockResolvedValue(tokenAddress);

      const exists = await registryService.checkModelExists('model_123');

      expect(exists).toBe(true);
      expect(mockContract.getTokenAddress).toHaveBeenCalledWith('model_123');
    });

    test('should return false for non-existing model', async () => {
      mockContract.getTokenAddress.mockResolvedValue(ethers.ZeroAddress);

      const exists = await registryService.checkModelExists('model_456');

      expect(exists).toBe(false);
    });

    test('should handle query errors', async () => {
      mockContract.getTokenAddress.mockRejectedValue(new Error('Network error'));

      await expect(registryService.checkModelExists('model_123'))
        .rejects.toThrow('Network error');
    });
  });

  describe('getModelInfo', () => {
    test('should retrieve model information', async () => {
      const modelInfo = {
        tokenAddress: '0x1234567890123456789012345678901234567890',
        metricName: 'accuracy',
        mlflowRunId: 'run_abc123',
        registrationTime: ethers.toBigInt('1706352090'),
        isActive: true
      };

      mockContract.getModelInfo.mockResolvedValue(modelInfo);

      const result = await registryService.getModelInfo('model_123');

      expect(result).toEqual({
        tokenAddress: modelInfo.tokenAddress,
        metricName: modelInfo.metricName,
        mlflowRunId: modelInfo.mlflowRunId,
        registrationTime: new Date(Number(modelInfo.registrationTime) * 1000),
        isActive: modelInfo.isActive
      });
    });

    test('should return null for non-existing model', async () => {
      mockContract.getModelInfo.mockResolvedValue({
        tokenAddress: ethers.ZeroAddress,
        metricName: '',
        mlflowRunId: '',
        registrationTime: ethers.toBigInt('0'),
        isActive: false
      });

      const result = await registryService.getModelInfo('model_456');

      expect(result).toBeNull();
    });
  });

  describe('estimateGas', () => {
    test('should estimate gas for registration', async () => {
      const estimatedGas = ethers.toBigInt('120000');
      mockContract.registerModel.estimateGas.mockResolvedValue(estimatedGas);

      const gasEstimate = await registryService.estimateRegistrationGas({
        modelId: 'model_123',
        tokenAddress: '0x1234567890123456789012345678901234567890',
        metricName: 'accuracy',
        mlflowRunId: 'run_abc123'
      });

      expect(gasEstimate).toBe('120000');
    });
  });

  describe('health check', () => {
    test('should verify registry is accessible', async () => {
      mockContract.owner.mockResolvedValue('0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d');

      const isHealthy = await registryService.checkHealth();

      expect(isHealthy).toBe(true);
      expect(mockContract.owner).toHaveBeenCalled();
    });

    test('should report unhealthy on connection failure', async () => {
      mockContract.owner.mockRejectedValue(new Error('Connection failed'));

      const isHealthy = await registryService.checkHealth();

      expect(isHealthy).toBe(false);
    });
  });

  describe('event listening', () => {
    test('should listen for ModelRegistered events', async () => {
      const eventHandler = jest.fn();
      const filter = { address: config.registryAddress };
      
      mockContract.filters.ModelRegistered.mockReturnValue(filter);
      mockContract.on.mockImplementation((event, handler) => {
        if (event === 'ModelRegistered') {
          // Simulate an event
          handler(
            'model_123',
            '0x1234567890123456789012345678901234567890',
            'accuracy',
            'run_abc123',
            { blockNumber: 12345678 }
          );
        }
      });

      await registryService.onModelRegistered(eventHandler);

      expect(eventHandler).toHaveBeenCalledWith({
        modelId: 'model_123',
        tokenAddress: '0x1234567890123456789012345678901234567890',
        metricName: 'accuracy',
        mlflowRunId: 'run_abc123',
        blockNumber: 12345678
      });
    });

    test('should handle event listener errors', async () => {
      const eventHandler = jest.fn();
      const errorHandler = jest.fn();
      
      mockContract.filters.ModelRegistered.mockReturnValue({});
      mockContract.on.mockImplementation((event, handler) => {
        if (event === 'error') {
          handler(new Error('Event subscription failed'));
        }
      });

      await registryService.onModelRegistered(eventHandler, errorHandler);

      expect(errorHandler).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Event subscription failed' })
      );
    });
  });
});