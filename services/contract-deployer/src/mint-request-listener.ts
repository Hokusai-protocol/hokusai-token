import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { MintRequestConsumer } from './queue/mint-request-consumer';
import { MintRecordStore } from './queue/mint-record-store';
import { DeltaVerifierClient } from './blockchain/delta-verifier-client';
import { MintRequestProcessor } from './services/mint-request-processor';
import { logger } from './utils/logger';

export interface MintRequestListenerConfig {
  redis: {
    url: string;
  };
  blockchain: {
    rpcUrls: string[];
    privateKey: string;
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
    backoffBaseMs: number;
    backoffMaxMs: number;
    backoffMultiplier: number;
    recordKeyPrefix: string;
    recordTtlSeconds: number;
  };
}

export class MintRequestListener {
  private readonly redis: RedisClientType;
  private readonly consumer: MintRequestConsumer;
  private readonly processor: MintRequestProcessor;

  constructor(private readonly config: MintRequestListenerConfig) {
    this.redis = createClient({ url: config.redis.url });

    const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrls[0]);
    const signer = new ethers.Wallet(config.blockchain.privateKey, provider);
    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress: config.blockchain.deltaVerifierAddress,
      modelRegistryAddress: config.blockchain.modelRegistryAddress,
      confirmations: config.blockchain.confirmations,
      gasMultiplier: config.blockchain.gasMultiplier,
      maxGasPrice: config.blockchain.maxGasPrice,
    });
    const recordStore = new MintRecordStore({
      redis: this.redis,
      keyPrefix: config.queues.recordKeyPrefix,
      ttlSeconds: config.queues.recordTtlSeconds,
    });

    this.consumer = new MintRequestConsumer({
      redis: this.redis,
      inboundQueue: config.queues.inbound,
      processingQueue: config.queues.processing,
      deadLetterQueue: config.queues.deadLetter,
      processedSetKey: config.queues.processedSet,
      retryQueue: config.queues.retry,
      maxRetries: config.queues.maxRetries,
      blockingTimeout: 5,
      backoffBaseMs: config.queues.backoffBaseMs,
      backoffMaxMs: config.queues.backoffMaxMs,
      backoffMultiplier: config.queues.backoffMultiplier,
      recordStore,
    });
    this.processor = new MintRequestProcessor(client);
  }

  async initialize(): Promise<void> {
    await this.redis.connect();
    logger.info('MintRequest listener initialized');
  }

  async start(): Promise<void> {
    await this.consumer.start(async (message) => {
      const settlement = await this.processor.process(message);
      await this.redis.lPush(this.config.queues.settlements, JSON.stringify(settlement));
      return settlement;
    });
  }

  stop(): void {
    this.consumer.stop();
  }

  async cleanup(): Promise<void> {
    await this.redis.quit();
  }
}
