import { createClient, RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { RedisQueueConsumer } from './queue/redis-consumer';
import { ContractDeployer } from './blockchain/contract-deployer';
import { ModelRegistryService } from './blockchain/model-registry';
import { EventPublisher } from './queue/event-publisher';
import { HealthCheckService } from './monitoring/health-check';
import { ModelReadyToDeployMessage, createTokenDeployedMessage } from './schemas/message-schemas';
import { logger } from './utils/logger';

export interface ContractDeployListenerConfig {
  redis: {
    url: string;
  };
  blockchain: {
    rpcUrls: string[];
    privateKey: string;
    tokenManagerAddress: string;
    modelRegistryAddress: string;
    gasMultiplier: number;
    maxGasPrice: string;
    confirmations: number;
  };
  queues: {
    inbound: string;
    outbound: string;
    processing: string;
    deadLetter: string;
  };
}

export class ContractDeployListener {
  private redis: RedisClientType;
  private consumer: RedisQueueConsumer;
  private deployer: ContractDeployer;
  private registry: ModelRegistryService;
  private publisher: EventPublisher;
  private healthCheck: HealthCheckService;
  private config: ContractDeployListenerConfig;
  private provider: ethers.Provider;
  private signer: ethers.Signer;

  constructor(config: ContractDeployListenerConfig) {
    this.config = config;
    this.redis = createClient({ url: config.redis.url });
    
    // Initialize blockchain components
    this.provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrls[0]);
    this.signer = new ethers.Wallet(config.blockchain.privateKey, this.provider);
    
    // Initialize services
    this.consumer = new RedisQueueConsumer({
      redis: this.redis,
      inboundQueue: config.queues.inbound,
      processingQueue: config.queues.processing,
      deadLetterQueue: config.queues.deadLetter,
      maxRetries: 3,
      blockingTimeout: 5
    });
    
    this.deployer = new ContractDeployer(config.blockchain);
    
    this.registry = new ModelRegistryService({
      registryAddress: config.blockchain.modelRegistryAddress,
      provider: this.provider,
      signer: this.signer,
      confirmations: config.blockchain.confirmations
    });
    
    this.publisher = new EventPublisher({
      redis: this.redis,
      outboundQueue: config.queues.outbound
    });
    
    this.healthCheck = new HealthCheckService({
      redis: this.redis,
      provider: this.provider,
      registryAddress: config.blockchain.modelRegistryAddress,
      tokenManagerAddress: config.blockchain.tokenManagerAddress
    });
  }

  async initialize(): Promise<void> {
    logger.info('Initializing Contract Deploy Listener');
    
    // Connect to Redis with timeout
    try {
      const connectPromise = this.redis.connect();
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Redis connection timeout')), 5000)
      );
      await Promise.race([connectPromise, timeoutPromise]);
      logger.info('Connected to Redis');
    } catch (error) {
      logger.error('Failed to connect to Redis', error);
      throw new Error(`Redis connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // Verify blockchain connection
    const networkInfo = await this.deployer.getNetworkInfo();
    logger.info('Connected to blockchain', networkInfo);
    
    // Verify contracts are deployed
    const contractsReady = await this.healthCheck.isReady();
    if (!contractsReady) {
      logger.warn('Required contracts not deployed - service will run with limited functionality');
    }
    
    logger.info('Contract Deploy Listener initialized successfully');
  }

  async start(): Promise<void> {
    logger.info('Starting Contract Deploy Listener');
    
    // Start processing messages
    await this.consumer.start(async (message) => {
      await this.processMessage(message);
    });
  }

  stop(): void {
    logger.info('Stopping Contract Deploy Listener');
    this.consumer.stop();
  }

  private async processMessage(message: ModelReadyToDeployMessage): Promise<void> {
    const startTime = Date.now();
    const correlationId = `deploy_${message.model_id}_${Date.now()}`;
    
    logger.info('Processing deployment request', {
      modelId: message.model_id,
      correlationId
    });
    
    try {
      // Check if model already registered
      const exists = await this.registry.checkModelExists(message.model_id);
      if (exists) {
        logger.warn('Model already registered, skipping deployment', {
          modelId: message.model_id
        });
        return;
      }
      
      // Deploy token contract
      const deploymentResult = await this.deployer.deployToken(message);
      logger.info('Token deployed', {
        modelId: message.model_id,
        tokenAddress: deploymentResult.tokenAddress
      });
      
      // Register in ModelRegistry
      const registrationResult = await this.registry.registerModel({
        modelId: message.model_id,
        tokenAddress: deploymentResult.tokenAddress,
        metricName: message.metric_name,
        mlflowRunId: message.mlflow_run_id
      });
      logger.info('Model registered', {
        modelId: message.model_id,
        transactionHash: registrationResult.transactionHash
      });
      
      // Get network info for the event
      const networkInfo = await this.deployer.getNetworkInfo();
      
      // Create and publish deployment event
      const deploymentEvent = createTokenDeployedMessage({
        model_id: message.model_id,
        token_address: deploymentResult.tokenAddress,
        token_symbol: message.token_symbol,
        token_name: `Hokusai ${message.model_id}`,
        transaction_hash: deploymentResult.transactionHash,
        registry_transaction_hash: registrationResult.transactionHash,
        mlflow_run_id: message.mlflow_run_id,
        model_name: message.model_name,
        model_version: message.model_version,
        deployer_address: networkInfo.deployerAddress,
        network: networkInfo.network,
        block_number: deploymentResult.blockNumber,
        gas_used: deploymentResult.gasUsed,
        gas_price: deploymentResult.gasPrice,
        contributor_address: message.contributor_address,
        performance_metric: message.metric_name,
        performance_improvement: message.improvement_percentage
      });
      
      await this.publisher.publishWithRetry(deploymentEvent, 3, 1000);
      logger.info('Deployment event published', {
        modelId: message.model_id,
        tokenAddress: deploymentResult.tokenAddress
      });
      
      // Record metrics
      const deploymentTime = Date.now() - startTime;
      this.healthCheck.recordDeployment({
        modelId: message.model_id,
        tokenAddress: deploymentResult.tokenAddress,
        deploymentTime,
        gasUsed: deploymentResult.gasUsed
      });
      
      logger.info('Deployment completed successfully', {
        modelId: message.model_id,
        tokenAddress: deploymentResult.tokenAddress,
        deploymentTime,
        correlationId
      });
      
    } catch (error: any) {
      logger.error('Deployment failed', {
        error: error.message,
        modelId: message.model_id,
        correlationId
      });
      
      this.healthCheck.recordFailure({
        modelId: message.model_id,
        error: error.message,
        stage: 'deployment'
      });
      
      throw error;
    }
  }

  async getHealth(): Promise<any> {
    const consumerHealth = await this.consumer.checkHealth();
    const publisherHealth = await this.publisher.checkHealth();
    const networkInfo = await this.deployer.getNetworkInfo();
    
    return {
      status: consumerHealth.healthy && publisherHealth.healthy ? 'healthy' : 'degraded',
      components: {
        redis: consumerHealth,
        blockchain: {
          status: 'healthy',
          network: networkInfo.network,
          blockNumber: await this.provider.getBlockNumber()
        }
      },
      metrics: {
        messagesProcessed: this.healthCheck.getMetrics().messagesProcessed,
        tokensDeployed: this.healthCheck.getMetrics().tokensDeployed
      }
    };
  }

  async cleanup(): Promise<void> {
    logger.info('Cleaning up resources');
    await this.redis.quit();
  }
}