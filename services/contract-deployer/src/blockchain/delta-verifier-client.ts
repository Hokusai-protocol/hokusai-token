import { ethers } from 'ethers';
import DeltaVerifierArtifact from '../../contracts/DeltaVerifier.json';
import TokenManagerArtifact from '../../contracts/TokenManager.json';
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
  totalSamples: number;
  anchors: BenchmarkAnchorsInput;
  baselineCommitment: string;
  candidateCommitment: string;
  deadline: number;
}

export interface DeltaVerifierClientConfig {
  provider: ethers.Provider;
  signer: ethers.Signer;
  deltaVerifierAddress: string;
  modelRegistryAddress: string;
  tokenManagerAddress?: string;
  confirmations: number;
  gasMultiplier: number;
  maxGasPrice: string;
}

export interface DecodedMintVestingSchedule {
  scheduleId: string;
  vaultAddress: string;
  tokenAddress: string;
  beneficiaryAddress: string;
  totalAmount: string;
  claimedAmount: string;
  startAt?: string;
  endAt?: string;
  durationSeconds?: number;
  cliffSeconds?: number;
}

export interface DecodedMintRecipientSettlement {
  recipientAddress: string;
  totalReward?: string;
  immediateAmount?: string;
  vestedAmount?: string;
  vestingSchedule?: DecodedMintVestingSchedule;
}

export interface DecodedMintReceipt {
  txHash: string;
  blockNumber: number;
  totalReward: string;
  tokenAddress?: string;
  tokenSymbol?: string;
  immediateAmount?: string;
  vestedAmount?: string;
  vestingVault?: string;
  vestingSchedule?: DecodedMintVestingSchedule;
  recipientSettlements?: DecodedMintRecipientSettlement[];
}

export interface MintSubmissionResult {
  status: 'minted' | 'budget_blocked' | 'budget_exceeded_retry' | 'no_delta' | 'replay';
  txHash?: string;
  blockNumber?: number;
  rewardAmount: string;
  gasUsed?: string;
  decodedReceipt?: DecodedMintReceipt;
}

export class MintRequestSubmissionError extends Error {
  readonly failureClass: 'transient' | 'permanent';
  readonly onChainOutcomeUnknown: boolean;
  readonly txHash?: string;

  constructor(
    message: string,
    options: {
      failureClass: 'transient' | 'permanent';
      onChainOutcomeUnknown?: boolean;
      txHash?: string;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'MintRequestSubmissionError';
    this.failureClass = options.failureClass;
    this.onChainOutcomeUnknown = options.onChainOutcomeUnknown ?? false;
    this.txHash = options.txHash;

    if (options.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export class MintBudgetExceededError extends MintRequestSubmissionError {
  readonly modelId: bigint;
  readonly requiredAmount: bigint;
  readonly remainingBudget: bigint;

  constructor(
    message: string,
    options: {
      modelId: bigint;
      requiredAmount: bigint;
      remainingBudget: bigint;
      cause?: unknown;
    },
  ) {
    super(message, {
      failureClass: 'transient',
      onChainOutcomeUnknown: false,
      cause: options.cause,
    });
    this.name = 'MintBudgetExceededError';
    this.modelId = options.modelId;
    this.requiredAmount = options.requiredAmount;
    this.remainingBudget = options.remainingBudget;
  }
}

interface ParsedLogLike {
  name: string;
  args: {
    rewardAmount?: bigint;
    contributor?: string;
    totalReward?: bigint;
    immediateAmount?: bigint;
    vestedAmount?: bigint;
    vestingStart?: bigint;
    vestingEnd?: bigint;
    scheduleId?: bigint;
    beneficiary?: string;
    token?: string;
    start?: bigint;
    cliffSeconds?: bigint;
    duration?: bigint;
    modelId?: string | bigint;
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
  hash?: string;
  wait(confirmations: number): Promise<TxReceiptLike>;
}

interface DeltaVerifierContract {
  processedIdempotencyKeys(idempotencyKey: string): Promise<boolean>;
  interface: {
    parseLog(log: ethers.Log): ParsedLogLike | null;
    parseError(data: ethers.BytesLike): ethers.ErrorDescription | null;
  };
  submitMintRequest: ((
    modelId: bigint,
    payload: MintRequestPayloadInput,
    contributors: DeltaVerifierContributor[],
    attesterSignatures: string[],
    overrides?: { gasLimit: bigint; gasPrice: bigint },
  ) => Promise<TxResponseLike>) & {
    estimateGas(
      modelId: bigint,
      payload: MintRequestPayloadInput,
      contributors: DeltaVerifierContributor[],
      attesterSignatures: string[],
    ): Promise<bigint>;
  };
}

interface ModelRegistryContract {
  isRegistered(modelId: bigint): Promise<boolean>;
  isModelActive(modelId: bigint): Promise<boolean>;
}

interface TokenManagerContract {
  getTokenAddress(modelId: string): Promise<string>;
}

interface TokenContract {
  symbol(): Promise<string>;
}

export class DeltaVerifierClient {
  private readonly contract: DeltaVerifierContract;
  private readonly modelRegistry: ModelRegistryContract;
  private readonly tokenManager?: TokenManagerContract;
  private readonly config: DeltaVerifierClientConfig;
  private readonly tokenManagerInterface = new ethers.Interface(TokenManagerArtifact.abi);
  private readonly vestingVaultInterface = new ethers.Interface([
    'event VestingScheduleCreated(uint256 indexed scheduleId,string indexed modelId,address indexed beneficiary,address token,uint256 vestedAmount,uint64 start,uint64 cliffSeconds,uint64 duration)',
  ]);
  private readonly erc20Interface = new ethers.Interface([
    'function symbol() view returns (string)',
  ]);

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
    this.tokenManager = config.tokenManagerAddress
      ? (new ethers.Contract(
          config.tokenManagerAddress,
          TokenManagerArtifact.abi,
          config.signer,
        ) as unknown as TokenManagerContract)
      : undefined;
  }

  private parseMintBudgetExceeded(error: unknown): {
    detected: boolean;
    modelId?: bigint;
    required?: bigint;
    remaining?: bigint;
  } {
    const revertData = this.extractRevertData(error);
    if (revertData) {
      try {
        const parsedError = this.contract.interface.parseError(revertData);
        if (parsedError?.name === 'MintBudgetExceeded') {
          const [modelId, required, remaining] = parsedError.args as unknown as [
            bigint,
            bigint,
            bigint,
          ];

          return {
            detected: true,
            modelId,
            required,
            remaining,
          };
        }
      } catch {
        // Fall back to message substring matching below when providers strip structured data.
      }
    }

    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('MintBudgetExceeded')) {
      return { detected: true };
    }

    return { detected: false };
  }

  private extractRevertData(error: unknown): string | undefined {
    if (typeof error !== 'object' || error === null) {
      return undefined;
    }

    const candidates: unknown[] = [
      (error as { data?: unknown }).data,
      (error as { error?: { data?: unknown } }).error?.data,
      (error as { info?: { error?: { data?: unknown } } }).info?.error?.data,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.startsWith('0x')) {
        return candidate;
      }
    }

    return undefined;
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
    attesterSignatures: string[],
    context?: { modelName?: string },
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
        attesterSignatures,
      );
      const feeData = await this.config.provider.getFeeData();
      let gasPrice = feeData.gasPrice ?? 0n;
      const maxGasPrice = BigInt(this.config.maxGasPrice);

      if (gasPrice > maxGasPrice) {
        gasPrice = maxGasPrice;
      }

      const gasLimit = (gasEstimate * BigInt(Math.floor(this.config.gasMultiplier * 10))) / 10n;
      const tx = await this.contract.submitMintRequest(
        modelId,
        payload,
        contributors,
        attesterSignatures,
        {
          gasLimit,
          gasPrice,
        },
      );
      let receipt: TxReceiptLike;
      try {
        receipt = await tx.wait(this.config.confirmations);
      } catch (error: unknown) {
        const message =
          error instanceof Error ? error.message : 'MintRequest receipt wait failed after submit';
        throw new MintRequestSubmissionError(
          `MintRequest transaction outcome unknown after submit: ${message}`,
          {
            failureClass: 'permanent',
            onChainOutcomeUnknown: true,
            txHash: tx.hash,
            cause: error,
          },
        );
      }

      if (receipt.status !== 1) {
        throw new MintRequestSubmissionError('MintRequest transaction reverted', {
          failureClass: 'permanent',
          cause: receipt,
          txHash: receipt.hash,
        });
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

      const decodedReceipt =
        status === 'minted'
          ? await this.decodeMintReceipt(receipt, {
              modelId: modelId.toString(),
              modelName: context?.modelName,
              rewardAmount,
            })
          : undefined;

      return {
        status,
        txHash: receipt.hash,
        blockNumber: receipt.blockNumber,
        rewardAmount,
        gasUsed: receipt.gasUsed.toString(),
        decodedReceipt,
      };
    } catch (error: unknown) {
      const mintBudgetExceeded = this.parseMintBudgetExceeded(error);
      if (mintBudgetExceeded.detected) {
        throw new MintBudgetExceededError(
          `MintBudgetExceeded${
            mintBudgetExceeded.modelId !== undefined
              ? `: modelId=${mintBudgetExceeded.modelId.toString()} required=${(
                  mintBudgetExceeded.required ?? 0n
                ).toString()} remaining=${(mintBudgetExceeded.remaining ?? 0n).toString()}`
              : ''
          }`,
          {
            modelId: mintBudgetExceeded.modelId ?? modelId,
            requiredAmount: mintBudgetExceeded.required ?? 0n,
            remainingBudget: mintBudgetExceeded.remaining ?? 0n,
            cause: error,
          },
        );
      }

      if (error instanceof Error && error.message.includes('Idempotency key already processed')) {
        logger.warn('MintRequest already processed on-chain', {
          idempotencyKey: payload.anchors.idempotencyKey,
        });
        return { status: 'replay', rewardAmount: '0' };
      }

      if (
        error instanceof MintRequestSubmissionError ||
        (error instanceof Error && error.message.toLowerCase().includes('execution reverted'))
      ) {
        if (error instanceof MintRequestSubmissionError) {
          throw error;
        }

        throw new MintRequestSubmissionError(error.message, {
          failureClass: 'permanent',
          cause: error,
        });
      }

      throw error;
    }
  }

  private async decodeMintReceipt(
    receipt: TxReceiptLike,
    context: { modelId: string; modelName?: string; rewardAmount: string },
  ): Promise<DecodedMintReceipt> {
    const decoded: DecodedMintReceipt = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      totalReward: context.rewardAmount,
    };

    for (const log of receipt.logs) {
      this.applyTokenManagerLog(decoded, log);
      this.applyVestingVaultLog(decoded, log);
    }

    const modelTokenAddress = await this.resolveTokenAddress(context.modelId, context.modelName);
    if (modelTokenAddress) {
      decoded.tokenAddress = modelTokenAddress;
      if (decoded.vestingSchedule && !decoded.vestingSchedule.tokenAddress) {
        decoded.vestingSchedule.tokenAddress = modelTokenAddress;
      }
    }

    if (decoded.tokenAddress) {
      decoded.tokenSymbol = await this.resolveTokenSymbol(decoded.tokenAddress);
    }

    return decoded;
  }

  private applyTokenManagerLog(decoded: DecodedMintReceipt, log: ethers.Log): void {
    try {
      const parsed = this.tokenManagerInterface.parseLog(log);
      if (!parsed || parsed.name !== 'RewardVestingCreated') {
        return;
      }
      const contributor = parsed.args.contributor as string;
      const totalReward = parsed.args.totalReward as bigint;
      const immediateAmount = parsed.args.immediateAmount as bigint;
      const vestedAmount = parsed.args.vestedAmount as bigint;
      const vestingStart = parsed.args.vestingStart as bigint;
      const vestingEnd = parsed.args.vestingEnd as bigint;

      const recipient = this.upsertRecipientSettlement(decoded, contributor);
      recipient.totalReward = totalReward.toString();
      recipient.immediateAmount = immediateAmount.toString();
      recipient.vestedAmount = vestedAmount.toString();
      recipient.vestingSchedule = {
        ...(recipient.vestingSchedule ?? {
          scheduleId: '',
          vaultAddress: '',
          tokenAddress: '',
          beneficiaryAddress: contributor,
          totalAmount: vestedAmount.toString(),
          claimedAmount: '0',
        }),
        beneficiaryAddress: contributor,
        totalAmount: vestedAmount.toString(),
        startAt: secondsToIso(vestingStart),
        endAt: secondsToIso(vestingEnd),
      };

      decoded.immediateAmount = addDecimalString(decoded.immediateAmount, immediateAmount);
      decoded.vestedAmount = addDecimalString(decoded.vestedAmount, vestedAmount);
    } catch {
      // Ignore logs from other contracts.
    }
  }

  private applyVestingVaultLog(decoded: DecodedMintReceipt, log: ethers.Log): void {
    try {
      const parsed = this.vestingVaultInterface.parseLog(log);
      if (!parsed || parsed.name !== 'VestingScheduleCreated') {
        return;
      }
      const scheduleId = parsed.args.scheduleId as bigint;
      const beneficiary = parsed.args.beneficiary as string;
      const token = parsed.args.token as string;
      const vestedAmount = parsed.args.vestedAmount as bigint;
      const start = parsed.args.start as bigint;
      const cliffSeconds = parsed.args.cliffSeconds as bigint;
      const duration = parsed.args.duration as bigint;

      decoded.vestingVault = log.address;
      const recipient = this.upsertRecipientSettlement(decoded, beneficiary);
      recipient.vestedAmount = vestedAmount.toString();
      recipient.vestingSchedule = {
        scheduleId: scheduleId.toString(),
        vaultAddress: log.address,
        tokenAddress: token,
        beneficiaryAddress: beneficiary,
        totalAmount: vestedAmount.toString(),
        claimedAmount: '0',
        startAt: secondsToIso(start),
        endAt: secondsToIso(start + duration),
        durationSeconds: Number(duration),
        cliffSeconds: Number(cliffSeconds),
      };
      decoded.tokenAddress = token;
    } catch {
      // Ignore logs from other contracts.
    }
  }

  private upsertRecipientSettlement(
    decoded: DecodedMintReceipt,
    recipientAddress: string,
  ): DecodedMintRecipientSettlement {
    const normalizedAddress = recipientAddress.toLowerCase();
    decoded.recipientSettlements ??= [];
    const existing = decoded.recipientSettlements.find(
      (settlement) => settlement.recipientAddress.toLowerCase() === normalizedAddress,
    );
    if (existing) {
      return existing;
    }

    const settlement: DecodedMintRecipientSettlement = { recipientAddress };
    decoded.recipientSettlements.push(settlement);
    return settlement;
  }

  private async resolveTokenAddress(
    modelId: string,
    modelName?: string,
  ): Promise<string | undefined> {
    if (!this.tokenManager) {
      return undefined;
    }

    for (const candidate of [modelName, modelId]) {
      if (!candidate) {
        continue;
      }
      try {
        const tokenAddress = await this.tokenManager.getTokenAddress(candidate);
        if (ethers.isAddress(tokenAddress) && tokenAddress !== ethers.ZeroAddress) {
          return tokenAddress;
        }
      } catch {
        // Model ids have historically appeared as either numeric strings or names.
      }
    }
    return undefined;
  }

  private async resolveTokenSymbol(tokenAddress: string): Promise<string | undefined> {
    const configuredSymbol = process.env.REWARD_TOKEN_SYMBOL || process.env.TOKEN_SYMBOL;
    if (configuredSymbol?.trim()) {
      return configuredSymbol.trim();
    }

    try {
      const token = new ethers.Contract(
        tokenAddress,
        this.erc20Interface,
        this.config.provider,
      ) as unknown as TokenContract;
      return await token.symbol();
    } catch (error) {
      logger.warn('Failed to resolve minted token symbol', {
        tokenAddress,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function secondsToIso(value: bigint): string {
  return new Date(Number(value) * 1000).toISOString();
}

function addDecimalString(current: string | undefined, value: bigint): string {
  return ((current ? BigInt(current) : 0n) + value).toString();
}
