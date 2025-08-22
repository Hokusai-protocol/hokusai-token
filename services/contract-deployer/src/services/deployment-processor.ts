import { Logger } from 'winston';
import { QueueService } from './queue.service';
import { BlockchainService } from './blockchain.service';
import { DeploymentService } from './deployment.service';
import { Config } from '../config/env.validation';
import { DeploymentRequest, QueueMessage } from '../types';

export class DeploymentProcessor {
  private running = false;
  private processingInterval?: NodeJS.Timeout;

  constructor(
    private readonly queueService: QueueService,
    private readonly blockchainService: BlockchainService,
    private readonly deploymentService: DeploymentService,
    private readonly logger: Logger,
    private readonly config: Config,
  ) {}

  async start(): Promise<void> {
    if (this.running) {
      this.logger.warn('Deployment processor is already running');
      return;
    }

    this.running = true;
    this.logger.info('Starting deployment processor');

    // Start processing queue
    this.processQueue();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.processingInterval) {
      clearInterval(this.processingInterval);
    }
    this.logger.info('Deployment processor stopped');
  }

  private async processQueue(): Promise<void> {
    while (this.running) {
      try {
        const message = await this.queueService.dequeue(this.config.QUEUE_NAME, 5);
        if (message) {
          await this.processMessage(message);
        }
      } catch (error) {
        this.logger.error('Error processing queue:', error);
        await this.sleep(this.config.RETRY_DELAY_MS);
      }
    }
  }

  private async processMessage(message: QueueMessage): Promise<void> {
    this.logger.info(`Processing queue message: ${message.id}`, {
      type: message.type,
      attempts: message.attempts
    });

    try {
      if (message.type === 'deploy_token') {
        await this.processDeployment(message.payload as DeploymentRequest);
      } else {
        this.logger.warn(`Unknown message type: ${message.type}`, {
          messageId: message.id
        });
      }
    } catch (error) {
      this.logger.error(`Failed to process message: ${message.id}`, {
        error,
        messageType: message.type,
        attempts: message.attempts
      });

      // TODO: Implement retry logic with exponential backoff
      // For now, just log the error
    }
  }

  private async processDeployment(request: DeploymentRequest): Promise<void> {
    this.logger.info(`Processing deployment request: ${request.id}`, {
      modelId: request.modelId,
      retryCount: request.retryCount
    });

    try {
      await this.deploymentService.processDeployment(request);
      
      this.logger.info(`Deployment completed successfully: ${request.id}`, {
        modelId: request.modelId
      });
    } catch (error) {
      this.logger.error(`Deployment failed: ${request.id}`, {
        error,
        modelId: request.modelId,
        retryCount: request.retryCount
      });

      // The DeploymentService handles status updates on failure
      // Here we could implement retry logic if needed
      throw error;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}