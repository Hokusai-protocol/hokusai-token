import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { MintRequestConsumer } from './queue/mint-request-consumer';
import { MintRecordStore } from './queue/mint-record-store';
import { DeltaVerifierClient } from './blockchain/delta-verifier-client';
import { MintRequestProcessor } from './services/mint-request-processor';
import { buildBackendSigner } from './blockchain/signer-factory';
import { logger } from './utils/logger';

export interface MintRequestListenerConfig {
  redis: {
    url: string;
  };
  blockchain: {
    rpcUrls: string[];
    privateKey?: string;
    signer?: ethers.Signer;
    kmsKeyId?: string;
    kmsExpectedAddress?: string;
    awsRegion?: string;
    deltaVerifierAddress: string;
    modelRegistryAddress: string;
    confirmations: number;
    gasMultiplier: number;
    maxGasPrice: string;
  };
  queues: {
    inbound: string;
    processing: string;
    deadLetter: string;
    processedSet: string;
    retry: string;
    settlements: string;
    maxRetries: number;
    budgetMaxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    budgetRetryBackoffBaseMs: number;
    budgetRetryBackoffMaxMs: number;
    backoffMultiplier: number;
    recordKeyPrefix: string;
    recordTtlSeconds: number;
  };
}

export class MintRequestListener {
  private readonly redis: RedisClientType;
  private consumer?: MintRequestConsumer;
  private processor?: MintRequestProcessor;

  constructor(private readonly config: MintRequestListenerConfig) {
    this.redis = createClient({ url: config.redis.url });
  }

  async initialize(): Promise<void> {
    const provider = new ethers.JsonRpcProvider(this.config.blockchain.rpcUrls[0]);
    const signer =
      this.config.blockchain.signer?.connect(provider) ??
      (await buildBackendSigner(
        {
          awsRegion: this.config.blockchain.awsRegion ?? 'us-east-1',
          kmsBackendKeyId: this.config.blockchain.kmsKeyId,
          kmsBackendExpectedAddress: this.config.blockchain.kmsExpectedAddress,
          privateKey: this.config.blockchain.privateKey,
        },
        provider,
      ));
    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress: this.config.blockchain.deltaVerifierAddress,
      modelRegistryAddress: this.config.blockchain.modelRegistryAddress,
      confirmations: this.config.blockchain.confirmations,
      gasMultiplier: this.config.blockchain.gasMultiplier,
      maxGasPrice: this.config.blockchain.maxGasPrice,
    });
    const recordStore = new MintRecordStore({
      redis: this.redis,
      keyPrefix: this.config.queues.recordKeyPrefix,
      ttlSeconds: this.config.queues.recordTtlSeconds,
    });

    this.consumer = new MintRequestConsumer({
      redis: this.redis,
      inboundQueue: this.config.queues.inbound,
      processingQueue: this.config.queues.processing,
      deadLetterQueue: this.config.queues.deadLetter,
      processedSetKey: this.config.queues.processedSet,
      retryQueue: this.config.queues.retry,
      maxRetries: this.config.queues.maxRetries,
      budgetMaxRetries: this.config.queues.budgetMaxRetries,
      blockingTimeout: 5,
      backoffBaseMs: this.config.queues.backoffBaseMs,
      backoffMaxMs: this.config.queues.backoffMaxMs,
      budgetRetryBackoffBaseMs: this.config.queues.budgetRetryBackoffBaseMs,
      budgetRetryBackoffMaxMs: this.config.queues.budgetRetryBackoffMaxMs,
      backoffMultiplier: this.config.queues.backoffMultiplier,
      recordStore,
    });
    this.processor = new MintRequestProcessor(client);
    await this.redis.connect();
    logger.info('MintRequest listener initialized');
  }

  async start(): Promise<void> {
    if (!this.consumer || !this.processor) {
      throw new Error('MintRequest listener must be initialized before start');
    }
    await this.consumer.start(async (message) => {
      const settlement = await this.processor!.process(message);
      await this.redis.lPush(this.config.queues.settlements, JSON.stringify(settlement));
      return settlement;
    });
  }

  stop(): void {
    this.consumer?.stop();
  }

  async cleanup(): Promise<void> {
    await this.redis.quit();
  }
}
