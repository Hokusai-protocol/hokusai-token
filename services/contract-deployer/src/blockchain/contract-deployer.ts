import { ethers } from 'ethers';
import { ModelReadyToDeployMessage } from '../schemas/message-schemas';
import { TokenManagerContract, TokenManagerInitialParams, typedContract } from './contract-types';
import { logger } from '../utils/logger';
import TokenManagerABI from '../../contracts/TokenManager.json';

export interface DeploymentParams {
  modelSupplierAllocation: bigint;
  modelSupplierRecipient: string;
  investorAllocation: bigint;
  tokensPerDeltaOne: bigint;
  infrastructureAccrualBps: number;
  initialOraclePricePerThousandUsd: bigint;
  licenseHash: string;
  licenseURI: string;
  governor: string;
}

export interface ContractDeployerConfig {
  rpcUrls: string[];
  signer: ethers.Signer;
  tokenManagerAddress: string;
  modelRegistryAddress: string;
  gasMultiplier: number;
  maxGasPrice: string;
  confirmations: number;
  deploymentParams: DeploymentParams;
}

export interface DeploymentResult {
  tokenAddress: string;
  transactionHash: string;
  blockNumber: number;
  gasUsed: string;
  gasPrice: string;
}

export interface NetworkInfo {
  network: string;
  chainId: number;
  deployerAddress: string;
  deployerBalance: string;
}

export class ContractDeployer {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private config: ContractDeployerConfig;
  private currentRpcIndex: number = 0;

  constructor(config: ContractDeployerConfig) {
    this.config = config;
    this.provider = this.createProvider();
    this.signer = config.signer.connect(this.provider);
  }

  private createProvider(): ethers.Provider {
    for (let i = 0; i < this.config.rpcUrls.length; i++) {
      try {
        const provider = new ethers.JsonRpcProvider(this.config.rpcUrls[this.currentRpcIndex]);

        // Test connection
        provider.getNetwork().catch(() => {
          throw new Error('Failed to connect');
        });

        return provider;
      } catch (error) {
        logger.warn(`Failed to connect to RPC ${this.config.rpcUrls[this.currentRpcIndex]}`, {
          error,
        });
        this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpcUrls.length;
      }
    }

    throw new Error('Failed to connect to any RPC endpoint');
  }

  async deployToken(message: ModelReadyToDeployMessage): Promise<DeploymentResult> {
    const tokenName = `Hokusai ${message.model_id}`;
    const tokenSymbol = message.token_symbol;
    const params = this.config.deploymentParams;

    logger.info('Deploying token via TokenManager.deployTokenWithAllocations', {
      modelId: message.model_id,
      tokenName,
      tokenSymbol,
    });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        const tokenManager = typedContract<TokenManagerContract>(
          this.config.tokenManagerAddress,
          TokenManagerABI.abi,
          this.signer,
        );

        const feeData = await this.provider.getFeeData();
        let gasPrice = feeData.gasPrice || BigInt('30000000000');
        const maxGasPrice = BigInt(this.config.maxGasPrice);
        if (gasPrice > maxGasPrice) {
          gasPrice = maxGasPrice;
        }

        const initialParams: TokenManagerInitialParams = {
          tokensPerDeltaOne: params.tokensPerDeltaOne,
          infrastructureAccrualBps: params.infrastructureAccrualBps,
          initialOraclePricePerThousandUsd: params.initialOraclePricePerThousandUsd,
          licenseHash: params.licenseHash,
          licenseURI: params.licenseURI,
          governor: params.governor,
          vestingConfig: {
            enabled: false,
            immediateUnlockBps: 10000,
            vestingDurationSeconds: 0,
            cliffSeconds: 0,
          },
        };

        const tx = await tokenManager.deployTokenWithAllocations(
          message.model_id,
          tokenName,
          tokenSymbol,
          params.modelSupplierAllocation,
          params.modelSupplierRecipient,
          params.investorAllocation,
          initialParams,
          { gasPrice },
        );

        const receipt = await tx.wait(this.config.confirmations);
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }

        const tokenDeployedEvent = receipt.logs
          .map((log: ethers.Log) => {
            try {
              return tokenManager.interface.parseLog({ topics: [...log.topics], data: log.data });
            } catch {
              return null;
            }
          })
          .find((parsed: ethers.LogDescription | null) => parsed?.name === 'TokenDeployed');

        if (!tokenDeployedEvent) {
          throw new Error('TokenDeployed event not found in receipt');
        }

        const tokenAddress = tokenDeployedEvent.args.tokenAddress;

        logger.info('Token deployed successfully', {
          tokenAddress,
          transactionHash: receipt.hash,
        });

        return {
          tokenAddress,
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.gasPrice?.toString() || gasPrice.toString(),
        };
      } catch (error: any) {
        attempts++;
        logger.error(`Deployment attempt ${attempts} failed`, {
          error: error.message,
          modelId: message.model_id,
        });

        if (attempts >= maxAttempts) {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 2000 * attempts));
      }
    }

    throw new Error('Deployment failed after max retries');
  }

  async getNetworkInfo(): Promise<NetworkInfo> {
    const network = await this.provider.getNetwork();
    const deployerAddress = await this.signer.getAddress();
    const deployerBalance = await this.provider.getBalance(deployerAddress);

    return {
      network: network.name,
      chainId: Number(network.chainId),
      deployerAddress,
      deployerBalance: deployerBalance.toString(),
    };
  }
}
