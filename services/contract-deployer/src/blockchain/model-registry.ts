import { ethers } from 'ethers';
import { logger } from '../utils/logger';

const MODEL_REGISTRY_ABI = [
  'function registerModel(string modelId, address tokenAddress, string metricName, string mlflowRunId)',
  'function getTokenAddress(string modelId) view returns (address)',
  'function getModelInfo(string modelId) view returns (address tokenAddress, string metricName, string mlflowRunId, uint256 registrationTime, bool isActive)',
  'function owner() view returns (address)',
  'event ModelRegistered(string indexed modelId, address tokenAddress, string metricName, string mlflowRunId)'
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
  metricName: string;
  mlflowRunId: string;
}

export interface RegistrationResult {
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  success: boolean;
}

export interface ModelInfo {
  tokenAddress: string;
  metricName: string;
  mlflowRunId: string;
  registrationTime: Date;
  isActive: boolean;
}

export class ModelRegistryService {
  private contract: ethers.Contract;
  private config: ModelRegistryConfig;

  constructor(config: ModelRegistryConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.registryAddress,
      MODEL_REGISTRY_ABI,
      config.signer
    );
  }

  async registerModel(data: RegistrationData): Promise<RegistrationResult> {
    logger.info('Registering model in registry', { modelId: data.modelId });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const tx = await this.contract.registerModel(
          data.modelId,
          data.tokenAddress,
          data.metricName,
          data.mlflowRunId
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

  async getModelInfo(modelId: string): Promise<ModelInfo | null> {
    try {
      const info = await this.contract.getModelInfo(modelId);
      
      if (info.tokenAddress === ethers.ZeroAddress) {
        return null;
      }

      return {
        tokenAddress: info.tokenAddress,
        metricName: info.metricName,
        mlflowRunId: info.mlflowRunId,
        registrationTime: new Date(Number(info.registrationTime) * 1000),
        isActive: info.isActive
      };
    } catch (error) {
      logger.error('Failed to get model info', { error, modelId });
      throw error;
    }
  }

  async estimateRegistrationGas(data: RegistrationData): Promise<string> {
    try {
      const estimatedGas = await this.contract.registerModel.estimateGas(
        data.modelId,
        data.tokenAddress,
        data.metricName,
        data.mlflowRunId
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
      const filter = this.contract.filters.ModelRegistered();
      
      this.contract.on(filter, (modelId, tokenAddress, metricName, mlflowRunId, event) => {
        handler({
          modelId,
          tokenAddress,
          metricName,
          mlflowRunId,
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