/**
 * Testnet execution logic - actually mint tokens on Sepolia
 */

import { ethers } from 'ethers';
import {
  EvaluationData,
  ExecutionResult,
  ErrorResult,
  ExecutorConfig
} from './types';
import { Simulator } from './simulator';
import DeltaVerifierABI from '../abis/DeltaVerifier.json';

export class Executor {
  private provider: ethers.Provider;
  private signer?: ethers.Signer;
  private deltaVerifier: ethers.Contract;
  private config: ExecutorConfig;
  private simulator: Simulator;

  constructor(config: ExecutorConfig) {
    this.config = config;
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.simulator = new Simulator(config);

    // Initialize contract without signer first
    this.deltaVerifier = new ethers.Contract(
      config.deltaVerifierAddress,
      DeltaVerifierABI.abi,
      this.provider
    );
  }

  /**
   * Connect wallet (either private key or MetaMask)
   */
  async connectWallet(): Promise<void> {
    if (this.config.privateKey) {
      // Connect with private key
      this.signer = new ethers.Wallet(this.config.privateKey, this.provider);
    } else if (this.config.useMetaMask) {
      // For MetaMask support in browser
      throw new Error('MetaMask support requires browser environment. Use private key for CLI.');
    } else {
      throw new Error('No wallet configuration provided. Set privateKey or useMetaMask.');
    }

    // Reconnect contract with signer
    this.deltaVerifier = new ethers.Contract(
      this.config.deltaVerifierAddress,
      DeltaVerifierABI.abi,
      this.signer
    );

    const address = await this.signer.getAddress();
    console.log(`✅ Wallet connected: ${address}`);
  }

  /**
   * Estimate gas cost for execution
   */
  async estimateGas(
    modelId: string,
    evaluationData: EvaluationData
  ): Promise<{
    gasEstimate: bigint;
    gasPrice: bigint;
    estimatedCost: string;
  }> {
    // First convert string modelId to uint256 if needed
    const modelIdNum = this.convertModelId(modelId);

    const gasEstimate = await this.deltaVerifier.submitEvaluation.estimateGas(
      modelIdNum,
      evaluationData
    );

    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || BigInt(0);
    const estimatedCostWei = gasEstimate * gasPrice;
    const estimatedCostEth = ethers.formatEther(estimatedCostWei);

    return {
      gasEstimate,
      gasPrice,
      estimatedCost: estimatedCostEth
    };
  }

  /**
   * Execute token minting on Sepolia testnet
   */
  async execute(
    modelId: string,
    evaluationData: EvaluationData
  ): Promise<ExecutionResult | ErrorResult> {
    try {
      // Step 1: Run simulation first
      console.log('\n🔄 Running simulation before execution...');
      const simulationResult = await this.simulator.simulate(modelId, evaluationData);

      if (simulationResult.status === 'error') {
        return simulationResult as ErrorResult;
      }

      // Step 2: Check wallet connection
      if (!this.signer) {
        await this.connectWallet();
      }

      // Step 3: Estimate gas
      console.log('\n⛽ Estimating gas...');
      const gasInfo = await this.estimateGas(modelId, evaluationData);
      console.log(`Gas estimate: ${gasInfo.gasEstimate.toString()}`);
      console.log(`Gas price: ${ethers.formatUnits(gasInfo.gasPrice, 'gwei')} gwei`);
      console.log(`Estimated cost: ${gasInfo.estimatedCost} ETH\n`);

      // Step 4: Execute transaction
      console.log('📝 Submitting transaction to Sepolia...');
      const modelIdNum = this.convertModelId(modelId);

      const tx = await this.deltaVerifier.submitEvaluation(
        modelIdNum,
        evaluationData
      );

      console.log(`Transaction hash: ${tx.hash}`);
      console.log('⏳ Waiting for confirmation...\n');

      // Step 5: Wait for confirmation
      const receipt = await tx.wait();

      if (!receipt) {
        throw new Error('Transaction receipt not available');
      }

      console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
      console.log(`Gas used: ${receipt.gasUsed.toString()}\n`);

      // Step 6: Parse events to get minted amount
      const tokensMinted = this.parseTokensMintedFromReceipt(receipt);

      // Step 7: Create execution result
      return this.createExecutionResult(
        simulationResult,
        receipt,
        tokensMinted,
        evaluationData.contributor
      );

    } catch (error: any) {
      return this.createErrorResult(
        'EXECUTION_ERROR',
        error.message || 'Unknown error during execution',
        {
          error: error.toString(),
          code: error.code,
          reason: error.reason
        }
      );
    }
  }

  /**
   * Convert string modelId to uint256 (simple hash for now)
   */
  private convertModelId(modelId: string): bigint {
    // For testing: try to parse as number, otherwise use hash
    try {
      return BigInt(modelId);
    } catch {
      // Use keccak256 hash of the string
      const hash = ethers.keccak256(ethers.toUtf8Bytes(modelId));
      return BigInt(hash) % BigInt(2 ** 64); // Keep it reasonable size
    }
  }

  /**
   * Parse TokensMinted event from receipt
   */
  private parseTokensMintedFromReceipt(receipt: ethers.TransactionReceipt): string {
    try {
      // Look for TokensMinted event in logs
      const iface = new ethers.Interface(DeltaVerifierABI.abi);

      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({
            topics: log.topics as string[],
            data: log.data
          });

          if (parsed && parsed.name === 'RewardCalculated') {
            // RewardCalculated event has rewardAmount
            return parsed.args.rewardAmount.toString();
          }
        } catch {
          // Skip logs that don't match our interface
          continue;
        }
      }
    } catch (error) {
      console.error('Error parsing events:', error);
    }

    return '0';
  }

  /**
   * Create formatted execution result
   */
  private createExecutionResult(
    simulationResult: any,
    receipt: ethers.TransactionReceipt,
    tokensMinted: string,
    recipient: string
  ): ExecutionResult {
    const explorerUrl = `https://sepolia.etherscan.io/tx/${receipt.hash}`;

    return {
      ...simulationResult,
      execution: {
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        gasUsed: receipt.gasUsed.toString(),
        status: receipt.status === 1 ? 'success' : 'failed',
        tokensMinted,
        recipient,
        explorerUrl
      },
      status: 'executed'
    };
  }

  /**
   * Create formatted error result
   */
  private createErrorResult(
    code: string,
    message: string,
    details: Record<string, any>
  ): ErrorResult {
    return {
      error: {
        code,
        message,
        details
      },
      status: 'error'
    };
  }
}
