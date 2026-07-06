import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { MintRequestConsumer } from './queue/mint-request-consumer';
import { MintRecordStore } from './queue/mint-record-store';
import { DeltaVerifierClient } from './blockchain/delta-verifier-client';
import { MintRequestProcessor } from './services/mint-request-processor';
import { PayoutIntentStore } from './services/payout-intent-store';
import { DirectMintSettlementClient } from './services/direct-mint-settlement-client';
import { DlqMetricsEmitter } from './monitoring/dlq-metrics';
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
    tokenManagerAddress?: string;
    confirmations: number;
    gasMultiplier: number;
    maxGasPrice: string;
    networkName?: string;
    chainId?: number;
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
  directMintSettlement?: {
    authServiceUrl: string;
    internalToken: string;
    timeoutMs?: number;
  };
}

export class MintRequestListener {
  private readonly redis: RedisClientType;
  private readonly consumer: MintRequestConsumer;
  private readonly processor: MintRequestProcessor;

  constructor(private readonly config: MintRequestListenerConfig) {
    this.redis = createClient({ url: config.redis.url });
    // node-redis emits 'error' on socket drops (e.g. ElastiCache idle/network blips). Without a
    // listener, the EventEmitter rethrows it as an uncaught exception ("Socket closed unexpectedly")
    // that crash-loops the relayer (the real root cause of B2). node-redis auto-reconnects, so we
    // log and let it recover rather than letting the money-path process die.
    this.redis.on('error', (err: unknown) => {
      logger.error('Redis client error (mint listener)', {
        error: err instanceof Error ? err.message : String(err),
      });
    });

    const provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrls[0]);
    const signer = config.blockchain.signer.connect(provider);
    const client = new DeltaVerifierClient({
      provider,
      signer,
      deltaVerifierAddress: config.blockchain.deltaVerifierAddress,
      modelRegistryAddress: config.blockchain.modelRegistryAddress,
      tokenManagerAddress: config.blockchain.tokenManagerAddress,
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

    // HOK-1698: publish a CloudWatch metric on every dead-letter so a spike in permanently-failed
    // mint requests surfaces in the daily health report + mttr. Reuses the AMM monitor's env flags
    // and namespace so ops configure one toggle. Best-effort — never blocks the relayer.
    const dlqMetrics = new DlqMetricsEmitter({
      enabled: process.env.MONITORING_CLOUDWATCH_ENABLED !== 'false',
      namespace: process.env.MONITORING_METRICS_NAMESPACE || 'Hokusai/ContractMonitoring',
      environment: process.env.HOKUSAI_ENVIRONMENT || process.env.ENVIRONMENT || 'development',
      region: process.env.AWS_REGION,
    });
    this.consumer.on('dead-letter', (event: { reason: string }) => {
      void dlqMetrics.recordDeadLetter(event.reason);
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

    const directMintSettlementClient = config.directMintSettlement
      ? new DirectMintSettlementClient({
          ...config.directMintSettlement,
          networkName: config.blockchain.networkName,
          chainId: config.blockchain.chainId,
          deltaVerifierAddress: config.blockchain.deltaVerifierAddress,
          modelRegistryAddress: config.blockchain.modelRegistryAddress,
          tokenManagerAddress: config.blockchain.tokenManagerAddress,
        })
      : undefined;
    if (directMintSettlementClient) {
      logger.info('Direct mint auth settlement enabled');
    }

    this.processor = new MintRequestProcessor(
      client,
      payoutIntentStore,
      directMintSettlementClient,
    );
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
