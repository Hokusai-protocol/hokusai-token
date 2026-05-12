import { ethers } from 'ethers';
import DeltaVerifierArtifact from '../../contracts/DeltaVerifier.json';
import { logger } from '../utils/logger';

const MODEL_REGISTRY_ABI = [
  'function isRegistered(uint256 modelId) view returns (bool)',
  'function isModelActive(uint256 modelId) view returns (bool)',
];

export interface DeltaVerifierContributor {
  walletAddress: string;
  weight: number;
}

export interface BenchmarkAnchorsInput {
  benchmarkSpecHash: string;
  datasetHash: string;
  attestationHash: string;
  idempotencyKey: string;
  metricName: string;
  metricFamily: string;
}

export interface MintRequestPayloadInput {
  pipelineRunId: string;
  baselineScoreBps: number;
  candidateScoreBps: number;
  maxCostUsdMicro: number;
  actualCostUsdMicro: number;
  anchors: BenchmarkAnchorsInput;
}

export interface DeltaVerifierClientConfig {
  provider: ethers.Provider;
  signer: ethers.Signer;
  deltaVerifierAddress: string;
  modelRegistryAddress: string;
  confirmations: number;
  gasMultiplier: number;
  maxGasPrice: string;
}

export interface MintSubmissionResult {
  status: 'minted' | 'budget_blocked' | 'no_delta' | 'replay';
  txHash?: string;
  blockNumber?: number;
  rewardAmount: string;
  gasUsed?: string;
}

interface ParsedLogLike {
  name: string;
  args: {
    rewardAmount?: bigint;
  };
}

interface TxReceiptLike {
  status: number;
  hash: string;
  blockNumber: number;
  gasUsed: bigint;
  logs: ethers.Log[];
}

interface TxResponseLike {
  wait(confirmations: number): Promise<TxReceiptLike>;
}

interface DeltaVerifierContract {
  processedIdempotencyKeys(idempotencyKey: string): Promise<boolean>;
  interface: {
    parseLog(log: ethers.Log): ParsedLogLike | null;
  };
  submitMintRequest: ((
    modelId: bigint,
    payload: MintRequestPayloadInput,
    contributors: DeltaVerifierContributor[],
    overrides?: { gasLimit: bigint; gasPrice: bigint },
  ) => Promise<TxResponseLike>) & {
    estimateGas(
      modelId: bigint,
      payload: MintRequestPayloadInput,
      contributors: DeltaVerifierContributor[],
    ): Promise<bigint>;
  };
}

interface ModelRegistryContract {
  isRegistered(modelId: bigint): Promise<boolean>;
  isModelActive(modelId: bigint): Promise<boolean>;
}

export class DeltaVerifierClient {
  private readonly contract: DeltaVerifierContract;
  private readonly modelRegistry: ModelRegistryContract;
  private readonly config: DeltaVerifierClientConfig;

  constructor(config: DeltaVerifierClientConfig) {
    this.config = config;
    this.contract = new ethers.Contract(
      config.deltaVerifierAddress,
      DeltaVerifierArtifact.abi,
      config.signer,
    ) as unknown as DeltaVerifierContract;
    this.modelRegistry = new ethers.Contract(
      config.modelRegistryAddress,
      MODEL_REGISTRY_ABI,
      config.signer,
    ) as unknown as ModelRegistryContract;
  }

  async isIdempotencyKeyProcessed(idempotencyKey: string): Promise<boolean> {
    return await this.contract.processedIdempotencyKeys(idempotencyKey);
  }

  async validateModel(modelId: bigint): Promise<void> {
    const [isRegistered, isActive] = await Promise.all([
      this.modelRegistry.isRegistered(modelId),
      this.modelRegistry.isModelActive(modelId),
    ]);

    if (!isRegistered) {
      throw new Error('Model not registered');
    }

    if (!isActive) {
      throw new Error('Model is deactivated');
    }
  }

  async submitMintRequest(
    modelId: bigint,
    payload: MintRequestPayloadInput,
    contributors: DeltaVerifierContributor[],
  ): Promise<MintSubmissionResult> {
    if (await this.isIdempotencyKeyProcessed(payload.anchors.idempotencyKey)) {
      return { status: 'replay', rewardAmount: '0' };
    }

    await this.validateModel(modelId);

    try {
      const gasEstimate = await this.contract.submitMintRequest.estimateGas(
        modelId,
        payload,
        contributors,
      );
      const feeData = await this.config.provider.getFeeData();
      let gasPrice = feeData.gasPrice ?? 0n;
      const maxGasPrice = BigInt(this.config.maxGasPrice);

      if (gasPrice > maxGasPrice) {
        gasPrice = maxGasPrice;
      }

      const gasLimit = (gasEstimate * BigInt(Math.floor(this.config.gasMultiplier * 10))) / 10n;
      const tx = await this.contract.submitMintRequest(modelId, payload, contributors, {
        gasLimit,
        gasPrice,
      });
      const receipt = await tx.wait(this.config.confirmations);

      if (receipt.status !== 1) {
        throw new Error('MintRequest transaction reverted');
      }

      let rewardAmount = '0';
      let status: MintSubmissionResult['status'] = 'no_delta';

      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (!parsed) {
            continue;
          }

          if (parsed.name === 'BudgetConstraintViolated') {
            status = 'budget_blocked';
          }

          if (parsed.name === 'DeltaOneAccepted') {
            const eventRewardAmount = parsed.args.rewardAmount ?? 0n;
            rewardAmount = eventRewardAmount.toString();
            status = eventRewardAmount > 0n ? 'minted' : status;
          }
        } catch {
          // Ignore logs from other contracts.
        }
      }

      return {
        status,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        rewardAmount,
        gasUsed: receipt.gasUsed.toString(),
      };
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes('Idempotency key already processed')) {
        logger.warn('MintRequest already processed on-chain', {
          idempotencyKey: payload.anchors.idempotencyKey,
        });
        return { status: 'replay', rewardAmount: '0' };
      }

      throw error;
    }
  }
}
