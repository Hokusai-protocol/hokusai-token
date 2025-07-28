import { ethers } from 'ethers';
import { ModelReadyToDeployMessage } from '../schemas/message-schemas';
import { logger } from '../utils/logger';
import HokusaiTokenABI from '../../contracts/HokusaiToken.json';

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
    const controller = this.config.tokenManagerAddress;

    logger.info('Deploying token contract', { 
      modelId: message.model_id, 
      tokenName, 
      tokenSymbol 
    });

    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        // Deploy the contract
        const factory = new ethers.ContractFactory(
          HokusaiTokenABI.abi,
          HokusaiTokenABI.bytecode,
          this.signer
        );

        // Estimate gas
        const estimatedGas = await this.provider.estimateGas({
          data: factory.bytecode,
          from: await this.signer.getAddress()
        });
        
        const gasLimit = estimatedGas * BigInt(Math.floor(this.config.gasMultiplier * 10)) / 10n;
        
        // Get gas price
        const feeData = await this.provider.getFeeData();
        let gasPrice = feeData.gasPrice || BigInt('30000000000');
        
        // Cap gas price at maximum
        const maxGasPrice = BigInt(this.config.maxGasPrice);
        if (gasPrice > maxGasPrice) {
          gasPrice = maxGasPrice;
        }

        const contract = await factory.deploy(tokenName, tokenSymbol, controller, {
          gasLimit,
          gasPrice
        });

        await contract.waitForDeployment();
        
        const deploymentTx = contract.deploymentTransaction();
        if (!deploymentTx) {
          throw new Error('Deployment transaction not found');
        }
        
        const receipt = await deploymentTx.wait(this.config.confirmations);
        if (!receipt) {
          throw new Error('Transaction receipt not found');
        }

        const tokenAddress = await contract.getAddress();

        // Set contributor if provided
        if (message.contributor_address) {
          try {
            const setContributorTx = await contract.setContributor(message.contributor_address);
            await setContributorTx.wait(this.config.confirmations);
            logger.info('Contributor address set', { 
              tokenAddress, 
              contributor: message.contributor_address 
            });
          } catch (error) {
            logger.error('Failed to set contributor address', { error, tokenAddress });
            // Don't fail deployment if contributor setting fails
          }
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