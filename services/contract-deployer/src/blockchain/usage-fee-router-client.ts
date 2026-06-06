import { ethers } from 'ethers';
import { logger } from '../utils/logger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const UsageFeeRouterABIArray = require('../../contracts/UsageFeeRouter.json');

const UsageFeeRouterABI = { abi: UsageFeeRouterABIArray };

export class ModelNotActiveError extends Error {
  constructor(modelId: string) {
    super(`Model ${modelId} is not active or not registered`);
    this.name = 'ModelNotActiveError';
  }
}

export interface DepositResult {
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  gasPrice: string;
}

export interface UsageFeeRouterConfig {
  routerAddress: string;
  provider: ethers.Provider;
  signer: ethers.Signer;
  confirmations: number;
}

export class UsageFeeRouterClient {
  private contract: ethers.Contract;
  private config: UsageFeeRouterConfig;

  constructor(config: UsageFeeRouterConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.routerAddress,
      UsageFeeRouterABI.abi,
      config.signer
    );
  }

  async depositFee(
    modelId: string,
    amount: bigint,
    callCount: bigint
  ): Promise<DepositResult> {
    logger.info('Depositing fee for model', {
      modelId,
      amount: amount.toString(),
      callCount: callCount.toString()
    });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const tx = await this.contract.depositFee(modelId, amount, callCount);

        const receipt = await tx.wait(this.config.confirmations);

        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }

        if (receipt.status === 0) {
          throw new Error('Transaction reverted');
        }

        logger.info('Fee deposited successfully', {
          modelId,
          transactionHash: receipt.hash
        });

        return {
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.gasPrice?.toString() || '0'
        };

      } catch (error: any) {
        attempts++;
        const errorMessage = error.message || '';

        // Check for model not active or unknown model errors
        if (
          errorMessage.includes('Model not active') ||
          errorMessage.includes('unknown model') ||
          errorMessage.includes('not registered')
        ) {
          logger.error('Model not active or not found', { modelId, error });
          throw new ModelNotActiveError(modelId);
        }

        logger.error(`Fee deposit attempt ${attempts} failed`, {
          error: errorMessage,
          modelId
        });

        if (attempts >= maxAttempts) {
          throw error;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
      }
    }

    throw new Error('Fee deposit failed after max retries');
  }
}
