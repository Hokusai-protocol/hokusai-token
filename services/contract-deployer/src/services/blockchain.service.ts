import { ethers } from 'ethers';
import { Logger } from 'winston';

export class BlockchainService {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;

  constructor(
    rpcUrl: string,
    privateKey: string,
    private readonly logger: Logger,
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.wallet = new ethers.Wallet(privateKey, this.provider);
  }

  async deployContract(
    bytecode: string,
    abi: ethers.InterfaceAbi,
    args: unknown[],
  ): Promise<ethers.Contract> {
    try {
      const factory = new ethers.ContractFactory(abi, bytecode, this.wallet);
      const contract = await factory.deploy(...args);
      await contract.waitForDeployment();
      
      const address = await contract.getAddress();
      this.logger.info(`Contract deployed at: ${address}`);
      
      return contract;
    } catch (error) {
      this.logger.error('Failed to deploy contract:', error);
      throw error;
    }
  }

  async getTransactionReceipt(txHash: string): Promise<ethers.TransactionReceipt | null> {
    return this.provider.getTransactionReceipt(txHash);
  }

  async waitForConfirmations(txHash: string, confirmations: number): Promise<ethers.TransactionReceipt | null> {
    const receipt = await this.provider.waitForTransaction(txHash, confirmations);
    return receipt;
  }

  async estimateGas(transaction: ethers.TransactionRequest): Promise<bigint> {
    return this.provider.estimateGas(transaction);
  }

  async getGasPrice(): Promise<bigint> {
    return this.provider.getFeeData().then((feeData) => feeData.gasPrice || 0n);
  }

  getWalletAddress(): string {
    return this.wallet.address;
  }
}