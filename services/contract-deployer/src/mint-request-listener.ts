import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MintRequestConsumer } from './queue/mint-request-consumer';
import { MintRecordStore } from './queue/mint-record-store';
import { DeltaVerifierClient } from './blockchain/delta-verifier-client';
import { MintRequestProcessor } from './services/mint-request-processor';
import { PayoutIntentStore } from './services/payout-intent-store';
import { logger } from './utils/logger';

export interface MintRequestListenerConfig {
  redis: {
    url: string;
  };
  blockchain: {
    rpcUrls: string[];
    signer: ethers.Signer;
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
  // Optional: when set, authorized payout intent is written to this DynamoDB table
  // before each mint for DeltaOne recipient reconciliation (HOK-2223). Omit to disable.
  payoutIntent?: {
    tableName: string;
    awsRegion?: string;
  };
}

export class MintRequestListener {
  private readonly redis: RedisClientType;
  private readonly consumer: MintRequestConsumer;
  private readonly processor: MintRequestProcessor;

  constructor(private readonly config: MintRequestListenerConfig) {
    this.redis = createClient({ url: config.redis.url });

    const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrls[0]);
    const signer = config.blockchain.signer.connect(provider);
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
      budgetMaxRetries: config.queues.budgetMaxRetries,
      blockingTimeout: 5,
      backoffBaseMs: config.queues.backoffBaseMs,
      backoffMaxMs: config.queues.backoffMaxMs,
      budgetRetryBackoffBaseMs: config.queues.budgetRetryBackoffBaseMs,
      budgetRetryBackoffMaxMs: config.queues.budgetRetryBackoffMaxMs,
      backoffMultiplier: config.queues.backoffMultiplier,
      recordStore,
    });
    let payoutIntentStore: PayoutIntentStore | undefined;
    if (config.payoutIntent?.tableName) {
      payoutIntentStore = new PayoutIntentStore({
        client: new DynamoDBClient({ region: config.payoutIntent.awsRegion }),
        tableName: config.payoutIntent.tableName,
      });
      logger.info('Payout intent recording enabled', {
        table: config.payoutIntent.tableName,
      });
    }
    this.processor = new MintRequestProcessor(client, payoutIntentStore);
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
