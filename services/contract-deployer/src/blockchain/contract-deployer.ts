import { ethers } from 'ethers';
import { ModelReadyToDeployMessage } from '../schemas/message-schemas';
import { logger } from '../utils/logger';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const DeployableTokenManagerABIArray = require('../../contracts/DeployableTokenManager.json');

const DeployableTokenManagerABI = { abi: DeployableTokenManagerABIArray };

export interface ContractDeployerConfig {
  rpcUrls: string[];
  privateKey: string;
  tokenManagerAddress: string;
  modelRegistryAddress: string;
  gasMultiplier: number;
  maxGasPrice: string;
  confirmations: number;
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
    this.signer = new ethers.Wallet(config.privateKey, this.provider);
  }

  private createProvider(): ethers.Provider {
    for (let i = 0; i < this.config.rpcUrls.length; i++) {
      try {
        const provider = new ethers.JsonRpcProvider(
          this.config.rpcUrls[this.currentRpcIndex]
        );
        
        // Test connection
        provider.getNetwork().catch(() => {
          throw new Error('Failed to connect');
        });
        
        return provider;
      } catch (error) {
        logger.warn(`Failed to connect to RPC ${this.config.rpcUrls[this.currentRpcIndex]}`, { error });
        this.currentRpcIndex = (this.currentRpcIndex + 1) % this.config.rpcUrls.length;
      }
    }
    
    throw new Error('Failed to connect to any RPC endpoint');
  }

  async deployToken(message: ModelReadyToDeployMessage): Promise<DeploymentResult> {
    const tokenName = `Hokusai ${message.model_id}`;
    const tokenSymbol = message.token_symbol;

    logger.info('Deploying token contract via TokenManager', {
      modelId: message.model_id,
      tokenName,
      tokenSymbol
    });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        // Connect to TokenManager contract
        const tokenManager = new ethers.Contract(
          this.config.tokenManagerAddress,
          DeployableTokenManagerABI.abi,
          this.signer
        ) as ethers.Contract & {
          deployTokenWithAllocations: (
            modelId: string,
            name: string,
            symbol: string,
            modelSupplierAllocation: bigint,
            modelSupplierRecipient: string,
            investorAllocation: bigint,
            initialParams: unknown,
            overrides?: ethers.Overrides
          ) => Promise<ethers.ContractTransactionResponse | null>;
        };

        // Prepare allocations (use defaults if not provided)
        const modelSupplierAllocation = message.modelSupplierAllocation || BigInt(0);
        const modelSupplierRecipient = message.modelSupplierRecipient || await this.signer.getAddress();
        const investorAllocation = message.investorAllocation || BigInt(0);

        // Prepare initial params (use defaults if not provided)
        const initialParams = message.initialParams || {
          tokensPerDeltaOne: BigInt(1000) * BigInt(10 ** 18),
          infrastructureAccrualBps: 500,
          initialOraclePricePerThousandUsd: BigInt(1000),
          licenseHash: ethers.ZeroHash,
          licenseURI: '',
          governor: await this.signer.getAddress(),
          vestingConfig: {
            enabled: false,
            immediateUnlockBps: 10000,
            vestingDurationSeconds: BigInt(0),
            cliffSeconds: BigInt(0)
          }
        };

        // Estimate gas for the call
        const estimatedGas = await (tokenManager.deployTokenWithAllocations as (
          modelId: string,
          name: string,
          symbol: string,
          modelSupplierAllocation: bigint,
          modelSupplierRecipient: string,
          investorAllocation: bigint,
          initialParams: unknown
        ) => Promise<bigint>).estimateGas(
          message.model_id,
          tokenName,
          tokenSymbol,
          modelSupplierAllocation,
          modelSupplierRecipient,
          investorAllocation,
          initialParams
        );

        const gasLimit = estimatedGas * BigInt(Math.floor(this.config.gasMultiplier * 10)) / 10n;

        // Get gas price
        const feeData = await this.provider.getFeeData();
        let gasPrice = feeData.gasPrice || BigInt('30000000000');

        // Cap gas price at maximum
        const maxGasPrice = BigInt(this.config.maxGasPrice);
        if (gasPrice > maxGasPrice) {
          gasPrice = maxGasPrice;
        }

        // Call deployTokenWithAllocations
        const tx = await (tokenManager.deployTokenWithAllocations as (
          modelId: string,
          name: string,
          symbol: string,
          modelSupplierAllocation: bigint,
          modelSupplierRecipient: string,
          investorAllocation: bigint,
          initialParams: unknown,
          overrides: ethers.Overrides
        ) => Promise<ethers.ContractTransactionResponse | null>)(
          message.model_id,
          tokenName,
          tokenSymbol,
          modelSupplierAllocation,
          modelSupplierRecipient,
          investorAllocation,
          initialParams,
          { gasLimit, gasPrice }
        );

        const receipt = await tx.wait(this.config.confirmations);
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }

        // Parse TokenDeployed event to get token address
        const iface = new ethers.Interface(DeployableTokenManagerABI.abi);
        let tokenAddress: string | null = null;

        for (const log of receipt.logs) {
          try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'TokenDeployed') {
              tokenAddress = parsed.args[1]; // tokenAddress is the second indexed parameter
              break;
            }
          } catch (e) {
            // Continue if log parsing fails
          }
        }

        if (!tokenAddress) {
          throw new Error('TokenDeployed event not found in transaction receipt');
        }

        logger.info('Token deployed successfully', {
          tokenAddress,
          transactionHash: receipt.hash
        });

        return {
          tokenAddress,
          transactionHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed.toString(),
          gasPrice: receipt.gasPrice?.toString() || gasPrice.toString()
        };

      } catch (error: any) {
        attempts++;
        logger.error(`Deployment attempt ${attempts} failed`, {
          error: error.message,
          modelId: message.model_id
        });

        if (attempts >= maxAttempts) {
          throw error;
        }

        // Wait before retry
        await new Promise(resolve => setTimeout(resolve, 2000 * attempts));
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
      deployerBalance: deployerBalance.toString()
    };
  }
}