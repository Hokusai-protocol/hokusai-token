import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { MintRequestConsumer } from './queue/mint-request-consumer';
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
    settlements: string;
    maxRetries: number;
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

    this.consumer = new MintRequestConsumer({
      redis: this.redis,
      inboundQueue: config.queues.inbound,
      processingQueue: config.queues.processing,
      deadLetterQueue: config.queues.deadLetter,
      processedSetKey: config.queues.processedSet,
      maxRetries: config.queues.maxRetries,
      blockingTimeout: 5,
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
    });
  }

  stop(): void {
    this.consumer.stop();
  }

  async cleanup(): Promise<void> {
    await this.redis.quit();
  }
}
