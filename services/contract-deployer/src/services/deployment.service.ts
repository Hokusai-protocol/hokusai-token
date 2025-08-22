import { createClient, RedisClientType } from 'redis';
import { v4 as uuidv4 } from 'uuid';
import { Logger } from 'winston';
import { 
  DeployTokenRequest, 
  DeployTokenResponse, 
  DeploymentStatusResponse,
  AuthenticatedUser 
} from '../types/api.types';
import { 
  DeploymentRequest, 
  DeploymentStatus, 
  QueueMessage 
} from '../types';
import { ContractDeployer, DeploymentResult } from '../blockchain/contract-deployer';
import { ModelReadyToDeployMessage } from '../schemas/message-schemas';
import { QueueService } from './queue.service';
import { ApiErrorFactory } from '../types/errors';
import { createLogger } from '../utils/logger';

export interface DeploymentServiceConfig {
  redisHost: string;
  redisPort: number;
  queueName: string;
  statusTtlSeconds: number;
  maxConcurrentDeployments: number;
}

/**
 * Service for managing contract deployments
 */
export class DeploymentService {
  private redisClient: RedisClientType;
  private logger: Logger;
  private readonly DEPLOYMENT_STATUS_PREFIX = 'deployment:status:';
  private readonly DEPLOYMENT_QUEUE_PREFIX = 'deployment:queue:';
  private readonly USER_DEPLOYMENTS_PREFIX = 'user:deployments:';
  private readonly MODEL_DEPLOYMENT_PREFIX = 'model:deployment:';

  constructor(
    private readonly config: DeploymentServiceConfig,
    private readonly queueService: QueueService,
    private readonly contractDeployer: ContractDeployer
  ) {
    this.logger = createLogger('deployment-service');
    
    this.redisClient = createClient({
      socket: {
        host: config.redisHost,
        port: config.redisPort,
      },
    });

    this.redisClient.on('error', (err) => {
      this.logger.error('Redis client error:', err);
    });

    this.redisClient.on('connect', () => {
      this.logger.info('Deployment service connected to Redis');
    });
  }

  /**
   * Initialize the service
   */
  async initialize(): Promise<void> {
    await this.redisClient.connect();
    await this.queueService.connect();
  }

  /**
   * Shutdown the service
   */
  async shutdown(): Promise<void> {
    await this.redisClient.quit();
    await this.queueService.disconnect();
  }

  /**
   * Create a new deployment request
   */
  async createDeployment(
    request: DeployTokenRequest,
    user: AuthenticatedUser,
    correlationId?: string
  ): Promise<DeployTokenResponse> {
    this.logger.info('Creating new deployment', {
      correlationId,
      modelId: request.modelId,
      userAddress: request.userAddress,
      userId: user.userId
    });

    // Check if token already exists for this model
    const existingDeployment = await this.getDeploymentByModelId(request.modelId);
    if (existingDeployment && existingDeployment.status === 'deployed') {
      this.logger.warn('Token already exists for model', {
        correlationId,
        modelId: request.modelId,
        existingDeployment: existingDeployment.requestId
      });
      
      throw ApiErrorFactory.tokenAlreadyExists(request.modelId, correlationId);
    }

    // Check for existing pending/processing deployments for this model
    if (existingDeployment && ['pending', 'processing'].includes(existingDeployment.status)) {
      this.logger.warn('Deployment already in progress for model', {
        correlationId,
        modelId: request.modelId,
        existingDeployment: existingDeployment.requestId
      });
      
      throw ApiErrorFactory.validationError(
        `Deployment already in progress for model ${request.modelId}`,
        correlationId
      );
    }

    // Generate unique deployment ID
    const requestId = uuidv4();
    
    // Create deployment request
    const deploymentRequest: DeploymentRequest = {
      id: requestId,
      modelId: request.modelId,
      tokenName: request.tokenName || `Hokusai ${request.modelId}`,
      tokenSymbol: request.tokenSymbol || this.generateTokenSymbol(request.modelId),
      initialSupply: request.initialSupply || '0',
      metadata: request.metadata,
      timestamp: Date.now(),
      retryCount: 0
    };

    // Create initial status
    const initialStatus: DeploymentStatus = {
      requestId,
      status: 'pending',
      timestamp: Date.now()
    };

    try {
      // Store deployment status in Redis
      await this.setDeploymentStatus(requestId, {
        ...initialStatus,
        progress: 0,
        currentStep: 'Queued for deployment',
        lastUpdated: new Date().toISOString(),
        estimatedCompletion: new Date(Date.now() + 300000).toISOString() // 5 minutes estimate
      });

      // Map model to deployment
      await this.redisClient.set(
        `${this.MODEL_DEPLOYMENT_PREFIX}${request.modelId}`,
        requestId,
        { EX: this.config.statusTtlSeconds }
      );

      // Add to user's deployments list
      await this.redisClient.sAdd(
        `${this.USER_DEPLOYMENTS_PREFIX}${user.userId}`,
        requestId
      );

      // Queue deployment for background processing
      const queueMessage: QueueMessage = {
        id: requestId,
        type: 'deploy_token',
        payload: deploymentRequest,
        timestamp: Date.now(),
        attempts: 0
      };

      await this.queueService.enqueue(this.config.queueName, queueMessage);

      this.logger.info('Deployment queued successfully', {
        correlationId,
        requestId,
        modelId: request.modelId
      });

      // Return response
      return {
        requestId,
        status: 'pending',
        estimatedCompletionTime: 300, // 5 minutes in seconds
        message: 'Deployment request queued successfully',
        links: {
          status: `/api/deployments/${requestId}/status`,
          cancel: `/api/deployments/${requestId}/cancel`
        }
      };

    } catch (error) {
      this.logger.error('Failed to create deployment', {
        correlationId,
        error,
        requestId
      });
      
      // Cleanup on failure
      try {
        await this.redisClient.del(`${this.DEPLOYMENT_STATUS_PREFIX}${requestId}`);
        await this.redisClient.del(`${this.MODEL_DEPLOYMENT_PREFIX}${request.modelId}`);
      } catch (cleanupError) {
        this.logger.warn('Failed to cleanup after deployment creation error', {
          correlationId,
          cleanupError
        });
      }
      
      throw error;
    }
  }

  /**
   * Get deployment status by request ID
   */
  async getDeploymentStatus(
    requestId: string,
    correlationId?: string
  ): Promise<DeploymentStatusResponse> {
    this.logger.debug('Retrieving deployment status', {
      correlationId,
      requestId
    });

    const statusData = await this.redisClient.get(`${this.DEPLOYMENT_STATUS_PREFIX}${requestId}`);
    
    if (!statusData) {
      throw ApiErrorFactory.deploymentNotFound(requestId, correlationId);
    }

    const status = JSON.parse(statusData) as DeploymentStatusResponse;
    
    this.logger.debug('Deployment status retrieved', {
      correlationId,
      requestId,
      status: status.status
    });

    return status;
  }

  /**
   * Process a deployment (called by background worker)
   */
  async processDeployment(request: DeploymentRequest): Promise<void> {
    const correlationId = `deploy_${request.id}_${Date.now()}`;
    
    this.logger.info('Starting deployment processing', {
      correlationId,
      requestId: request.id,
      modelId: request.modelId
    });

    try {
      // Update status to processing
      await this.updateDeploymentStatus(request.id, {
        status: 'processing',
        progress: 10,
        currentStep: 'Initializing deployment',
        lastUpdated: new Date().toISOString()
      });

      // Prepare deployment message for ContractDeployer
      const deployMessage: ModelReadyToDeployMessage = {
        model_id: request.modelId,
        token_symbol: request.tokenSymbol,
        contributor_address: undefined, // TODO: Extract from request if needed
        metadata: request.metadata ? {
          name: request.tokenName,
          description: request.metadata.description,
          website: request.metadata.website,
          ...request.metadata
        } : undefined
      };

      // Update status
      await this.updateDeploymentStatus(request.id, {
        status: 'processing',
        progress: 30,
        currentStep: 'Deploying smart contract',
        lastUpdated: new Date().toISOString()
      });

      // Deploy the contract
      const deploymentResult: DeploymentResult = await this.contractDeployer.deployToken(deployMessage);

      // Update status
      await this.updateDeploymentStatus(request.id, {
        status: 'processing',
        progress: 80,
        currentStep: 'Confirming deployment',
        lastUpdated: new Date().toISOString()
      });

      // TODO: Register token in ModelRegistry if needed
      
      // Mark as completed
      await this.updateDeploymentStatus(request.id, {
        status: 'deployed',
        progress: 100,
        currentStep: 'Deployment completed',
        lastUpdated: new Date().toISOString(),
        tokenDetails: {
          tokenAddress: deploymentResult.tokenAddress,
          tokenName: request.tokenName,
          tokenSymbol: request.tokenSymbol,
          transactionHash: deploymentResult.transactionHash,
          registryTransactionHash: deploymentResult.transactionHash, // TODO: Separate registry tx
          blockNumber: deploymentResult.blockNumber,
          gasUsed: deploymentResult.gasUsed,
          gasPrice: deploymentResult.gasPrice,
          deploymentTime: new Date().toISOString(),
          network: 'ethereum' // TODO: Get from config
        }
      });

      this.logger.info('Deployment completed successfully', {
        correlationId,
        requestId: request.id,
        tokenAddress: deploymentResult.tokenAddress
      });

    } catch (error) {
      this.logger.error('Deployment processing failed', {
        correlationId,
        requestId: request.id,
        error
      });

      // Mark as failed
      await this.updateDeploymentStatus(request.id, {
        status: 'failed',
        progress: 0,
        currentStep: 'Deployment failed',
        lastUpdated: new Date().toISOString(),
        error: {
          code: 'DEPLOYMENT_FAILED',
          message: error instanceof Error ? error.message : 'Unknown deployment error',
          details: error instanceof Error ? error.stack : undefined,
          timestamp: new Date().toISOString(),
          retryable: true,
          suggestions: [
            'Check if the model ID is valid',
            'Ensure sufficient gas and balance',
            'Try again after a few minutes'
          ]
        }
      });

      throw error;
    }
  }

  /**
   * Private helper methods
   */

  private async setDeploymentStatus(
    requestId: string, 
    status: Partial<DeploymentStatusResponse>
  ): Promise<void> {
    const fullStatus: DeploymentStatusResponse = {
      requestId,
      status: 'pending',
      progress: 0,
      currentStep: 'Unknown',
      lastUpdated: new Date().toISOString(),
      ...status
    };

    await this.redisClient.set(
      `${this.DEPLOYMENT_STATUS_PREFIX}${requestId}`,
      JSON.stringify(fullStatus),
      { EX: this.config.statusTtlSeconds }
    );
  }

  private async updateDeploymentStatus(
    requestId: string,
    updates: Partial<DeploymentStatusResponse>
  ): Promise<void> {
    const currentStatusData = await this.redisClient.get(`${this.DEPLOYMENT_STATUS_PREFIX}${requestId}`);
    
    if (!currentStatusData) {
      throw new Error(`Deployment status not found: ${requestId}`);
    }

    const currentStatus = JSON.parse(currentStatusData) as DeploymentStatusResponse;
    const updatedStatus = { ...currentStatus, ...updates };

    await this.redisClient.set(
      `${this.DEPLOYMENT_STATUS_PREFIX}${requestId}`,
      JSON.stringify(updatedStatus),
      { EX: this.config.statusTtlSeconds }
    );
  }

  private async getDeploymentByModelId(modelId: string): Promise<DeploymentStatusResponse | null> {
    const requestId = await this.redisClient.get(`${this.MODEL_DEPLOYMENT_PREFIX}${modelId}`);
    
    if (!requestId) {
      return null;
    }

    try {
      return await this.getDeploymentStatus(requestId);
    } catch (error) {
      // If deployment status is not found, clean up the model mapping
      await this.redisClient.del(`${this.MODEL_DEPLOYMENT_PREFIX}${modelId}`);
      return null;
    }
  }

  private generateTokenSymbol(modelId: string): string {
    // Generate a token symbol from model ID
    // Take first 6 characters, convert to uppercase, and add 'HK' prefix
    const modelPart = modelId.substring(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, '');
    return `HK${modelPart}`.substring(0, 10);
  }
}