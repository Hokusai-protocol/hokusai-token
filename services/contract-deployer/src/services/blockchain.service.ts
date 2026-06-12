import { ethers } from 'ethers';
import { Logger } from 'winston';

export class BlockchainService {
  private provider: ethers.Provider;
  private signer: ethers.Signer;
  private signerAddress?: string;

  constructor(
    rpcUrl: string,
    signer: ethers.Signer,
    private readonly logger: Logger,
  ) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
    this.signer = signer.connect(this.provider);
  }

  async deployContract(
    bytecode: string,
    abi: ethers.InterfaceAbi,
    args: unknown[],
  ): Promise<ethers.Contract> {
    try {
      const factory = new ethers.ContractFactory(abi, bytecode, this.signer);
      const contract = (await factory.deploy(...args)) as unknown as ethers.Contract;
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

  async waitForConfirmations(
    txHash: string,
    confirmations: number,
  ): Promise<ethers.TransactionReceipt | null> {
    const receipt = await this.provider.waitForTransaction(txHash, confirmations);
    return receipt;
  }

  async estimateGas(transaction: ethers.TransactionRequest): Promise<bigint> {
    return this.provider.estimateGas(transaction);
  }

  async getGasPrice(): Promise<bigint> {
    return this.provider.getFeeData().then((feeData) => feeData.gasPrice || 0n);
  }

  async getWalletAddress(): Promise<string> {
    if (!this.signerAddress) {
      this.signerAddress = await this.signer.getAddress();
    }
    return this.signerAddress;
  }
}
