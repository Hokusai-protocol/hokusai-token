import { ethers } from 'ethers';
import { logger } from '../utils/logger';

const MODEL_REGISTRY_ABI = [
  'function registerStringModel(string modelId, address token, string performanceMetric)',
  'function getTokenAddress(string modelId) view returns (address)',
  'function owner() view returns (address)',
  'event StringModelRegistered(string indexed modelId, address indexed tokenAddress, string performanceMetric)'
];

export interface ModelRegistryConfig {
  registryAddress: string;
  provider: ethers.Provider;
  signer: ethers.Signer;
  confirmations: number;
}

export interface RegistrationData {
  modelId: string;
  tokenAddress: string;
  performanceMetric: string;
}

export interface RegistrationResult {
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  success: boolean;
}

export interface ModelInfo {
  tokenAddress: string;
  performanceMetric: string;
}

export class ModelRegistryService {
  private contract: ethers.Contract & {
    registerStringModel: (modelId: string, token: string, performanceMetric: string) => Promise<ethers.ContractTransactionResponse | null>;
    getTokenAddress: (modelId: string) => Promise<string>;
    owner: () => Promise<string>;
  };
  private config: ModelRegistryConfig;

  constructor(config: ModelRegistryConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.registryAddress,
      MODEL_REGISTRY_ABI,
      config.signer
    ) as typeof this.contract;
  }

  async registerModel(data: RegistrationData): Promise<RegistrationResult> {
    logger.info('Registering model in registry', { modelId: data.modelId });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const tx = await this.contract.registerStringModel(
          data.modelId,
          data.tokenAddress,
          data.performanceMetric
        );

        const receipt = await tx.wait(this.config.confirmations);

        if (receipt.status === 0) {
          throw new Error('Transaction reverted');
        }

        logger.info('Model registered successfully', {
          modelId: data.modelId,
          transactionHash: receipt.hash
        });

        return {
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          success: true
        };

      } catch (error: any) {
        attempts++;
        logger.error(`Registration attempt ${attempts} failed`, {
          error: error.message,
          modelId: data.modelId
        });

        if (attempts >= maxAttempts || error.message.includes('already registered')) {
          throw error;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
      }
    }

    throw new Error('Registration failed after max retries');
  }

  async checkModelExists(modelId: string): Promise<boolean> {
    try {
      const tokenAddress = await this.contract.getTokenAddress(modelId);
      return tokenAddress !== ethers.ZeroAddress;
    } catch (error) {
      logger.error('Failed to check model existence', { error, modelId });
      throw error;
    }
  }

  async getTokenAddress(modelId: string): Promise<string | null> {
    try {
      const tokenAddress = await this.contract.getTokenAddress(modelId);

      if (tokenAddress === ethers.ZeroAddress) {
        return null;
      }

      return tokenAddress;
    } catch (error) {
      logger.error('Failed to get token address', { error, modelId });
      throw error;
    }
  }

  async estimateRegistrationGas(data: RegistrationData): Promise<string> {
    try {
      const estimatedGas = await this.contract.registerStringModel.estimateGas(
        data.modelId,
        data.tokenAddress,
        data.performanceMetric
      );
      return estimatedGas.toString();
    } catch (error) {
      logger.error('Failed to estimate gas', { error, modelId: data.modelId });
      throw error;
    }
  }

  async checkHealth(): Promise<boolean> {
    try {
      await this.contract.owner();
      return true;
    } catch (error) {
      logger.error('Registry health check failed', { error });
      return false;
    }
  }

  async onModelRegistered(
    handler: (event: any) => void,
    errorHandler?: (error: Error) => void
  ): Promise<void> {
    try {
      const filter = this.contract.filters.StringModelRegistered();

      this.contract.on(filter, (modelId, tokenAddress, performanceMetric, event) => {
        handler({
          modelId,
          tokenAddress,
          performanceMetric,
          blockNumber: event.blockNumber
        });
      });

      if (errorHandler) {
        this.contract.on('error', errorHandler);
      }
    } catch (error: any) {
      logger.error('Failed to setup event listener', { error });
      if (errorHandler) {
        errorHandler(error);
      }
    }
  }
}