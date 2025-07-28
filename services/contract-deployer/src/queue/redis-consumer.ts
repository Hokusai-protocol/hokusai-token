import { RedisClientType } from 'redis';
import { EventEmitter } from 'events';
import { ModelReadyToDeployMessage, validateModelReadyToDeployMessage } from '../schemas/message-schemas';
import { logger } from '../utils/logger';

export interface RedisQueueConsumerConfig {
  redis: RedisClientType;
  inboundQueue: string;
  processingQueue: string;
  deadLetterQueue: string;
  maxRetries: number;
  blockingTimeout: number;
}

export interface QueueDepths {
  inbound: number;
  processing: number;
  deadLetter: number;
  outbound: number;
}

export interface HealthStatus {
  healthy: boolean;
  redis: 'connected' | 'disconnected';
  queues?: QueueDepths;
  error?: string;
}

export class RedisQueueConsumer extends EventEmitter {
  private redis: RedisClientType;
  private config: RedisQueueConsumerConfig;
  private running: boolean = false;
  private processingCount: number = 0;

  constructor(config: RedisQueueConsumerConfig) {
    super();
    this.redis = config.redis;
    this.config = config;
  }

  async processMessage(
    handler: (message: ModelReadyToDeployMessage) => Promise<void>
  ): Promise<void> {
    const messageStr = await this.redis.brPopLPush(
      this.config.inboundQueue,
      this.config.processingQueue,
      this.config.blockingTimeout
    );

    if (!messageStr) {
      // Timeout - no message available
      return;
    }

    try {
      // Parse and validate message
      let message: ModelReadyToDeployMessage;
      try {
        message = JSON.parse(messageStr);
      } catch (error) {
        logger.error('Failed to parse message JSON', { error, messageStr });
        await this.moveToDeadLetterQueue(messageStr, 'Invalid JSON');
        return;
      }

      // Validate message schema
      const validation = validateModelReadyToDeployMessage(message);
      if (validation.error) {
        logger.error('Message validation failed', { 
          error: validation.error.message, 
          message 
        });
        await this.moveToDeadLetterQueue(messageStr, validation.error.message);
        return;
      }

      // Process the message
      this.processingCount++;
      try {
        await handler(validation.value);
        
        // Success - remove from processing queue
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
        logger.info('Message processed successfully', { modelId: message.model_id });
      } catch (error) {
        this.processingCount--;
        throw error;
      }
      this.processingCount--;
      
    } catch (error: any) {
      // Handle processing failure
      logger.error('Message processing failed', { error: error.message });
      
      const message = JSON.parse(messageStr);
      const retryCount = message._retryCount || 0;
      
      if (retryCount < this.config.maxRetries) {
        // Retry the message
        message._retryCount = retryCount + 1;
        await this.redis.lPush(
          this.config.inboundQueue, 
          JSON.stringify(message)
        );
        logger.info('Message requeued for retry', { 
          modelId: message.model_id, 
          retryCount: message._retryCount 
        });
      } else {
        // Max retries exceeded - move to DLQ
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
        await this.moveToDeadLetterQueue(messageStr, error.message);
      }
      
      this.emit('error', error);
      throw error;
    }
  }

  private async moveToDeadLetterQueue(messageStr: string, reason: string): Promise<void> {
    const dlqEntry = {
      originalMessage: JSON.parse(messageStr),
      error: reason,
      timestamp: new Date().toISOString(),
      queue: this.config.inboundQueue
    };
    
    await this.redis.lPush(this.config.deadLetterQueue, JSON.stringify(dlqEntry));
    await this.redis.lRem(this.config.processingQueue, 1, messageStr);
    
    logger.error('Message moved to DLQ', { reason, modelId: dlqEntry.originalMessage.model_id });
  }

  async start(handler: (message: ModelReadyToDeployMessage) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info('Queue consumer started');
    
    while (this.running) {
      try {
        await this.processMessage(handler);
      } catch (error) {
        // Error already handled in processMessage
        // Continue processing other messages
      }
    }
    
    // Wait for any in-flight processing to complete
    while (this.processingCount > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    logger.info('Queue consumer stopped');
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  async getQueueDepths(): Promise<QueueDepths> {
    const [inbound, processing, deadLetter, outbound] = await Promise.all([
      this.redis.lLen(this.config.inboundQueue),
      this.redis.lLen(this.config.processingQueue),
      this.redis.lLen(this.config.deadLetterQueue),
      this.redis.lLen('hokusai:token_deployed_queue')
    ]);

    return {
      inbound,
      processing,
      deadLetter,
      outbound
    };
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      await this.redis.ping();
      const queues = await this.getQueueDepths();
      
      return {
        healthy: true,
        redis: 'connected',
        queues
      };
    } catch (error: any) {
      return {
        healthy: false,
        redis: 'disconnected',
        error: error.message
      };
    }
  }
}