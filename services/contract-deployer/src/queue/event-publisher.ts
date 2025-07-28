import { RedisClientType } from 'redis';
import { TokenDeployedMessage, validateTokenDeployedMessage } from '../schemas/message-schemas';
import { logger } from '../utils/logger';

export interface EventPublisherConfig {
  redis: RedisClientType;
  outboundQueue: string;
}

export interface PublishMetadata {
  correlationId?: string;
  source?: string;
}

export interface PublisherMetrics {
  published: number;
  failed: number;
  avgPublishTime: number;
  lastPublishTime?: Date;
}

export interface PublisherHealth {
  healthy: boolean;
  queueDepth: number;
  redis: 'connected' | 'disconnected';
  error?: string;
}

export class EventPublisher {
  private redis: RedisClientType;
  private config: EventPublisherConfig;
  private metrics: {
    published: number;
    failed: number;
    totalPublishTime: number;
    lastPublishTime?: Date;
  } = {
    published: 0,
    failed: 0,
    totalPublishTime: 0
  };

  constructor(config: EventPublisherConfig) {
    this.redis = config.redis;
    this.config = config;
  }

  async publish(
    message: TokenDeployedMessage, 
    metadata?: PublishMetadata
  ): Promise<void> {
    const startTime = Date.now();
    
    try {
      // Validate message
      const validation = validateTokenDeployedMessage(message);
      if (validation.error) {
        throw new Error(`Invalid message: ${validation.error.message}`);
      }

      // Add metadata if provided
      const messageToPublish = metadata ? {
        ...message,
        _metadata: {
          ...metadata,
          publishedAt: new Date().toISOString()
        }
      } : message;

      // Publish to queue
      await this.redis.lPush(
        this.config.outboundQueue,
        JSON.stringify(messageToPublish)
      );

      // Update metrics
      const publishTime = Date.now() - startTime;
      this.metrics.published++;
      this.metrics.totalPublishTime += publishTime;
      this.metrics.lastPublishTime = new Date();

      logger.info('Event published successfully', {
        modelId: message.model_id,
        tokenAddress: message.token_address,
        queue: this.config.outboundQueue
      });

    } catch (error: any) {
      this.metrics.failed++;
      logger.error('Failed to publish event', {
        error: error.message,
        modelId: message.model_id
      });
      throw error;
    }
  }

  async publishBatch(messages: TokenDeployedMessage[]): Promise<void> {
    // Validate all messages first
    for (const message of messages) {
      const validation = validateTokenDeployedMessage(message);
      if (validation.error) {
        throw new Error(`Invalid message: ${validation.error.message}`);
      }
    }

    // Use Redis transaction for atomic batch publish
    const multi = this.redis.multi();
    
    for (const message of messages) {
      multi.lPush(
        this.config.outboundQueue,
        JSON.stringify(message)
      );
    }

    await multi.exec();
    
    this.metrics.published += messages.length;
    this.metrics.lastPublishTime = new Date();

    logger.info('Batch events published successfully', {
      count: messages.length,
      queue: this.config.outboundQueue
    });
  }

  async publishWithRetry(
    message: TokenDeployedMessage,
    maxRetries: number = 3,
    backoffMs: number = 1000
  ): Promise<void> {
    let lastError: Error | undefined;
    
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.publish(message);
        return;
      } catch (error: any) {
        lastError = error;
        logger.warn(`Publish attempt ${attempt + 1} failed`, {
          error: error.message,
          modelId: message.model_id
        });
        
        if (attempt < maxRetries - 1) {
          // Exponential backoff
          const delay = backoffMs * Math.pow(2, attempt);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Publish failed after retries');
  }

  async confirmDelivery(modelId: string): Promise<boolean> {
    try {
      // Get all messages in queue
      const messages = await this.redis.lRange(this.config.outboundQueue, 0, -1);
      
      // Check if any message contains the model ID
      for (const messageStr of messages) {
        try {
          const message = JSON.parse(messageStr);
          if (message.model_id === modelId) {
            return true;
          }
        } catch {
          // Skip malformed messages
          continue;
        }
      }
      
      return false;
    } catch (error) {
      logger.error('Failed to confirm delivery', { error, modelId });
      throw error;
    }
  }

  async getQueueDepth(): Promise<number> {
    return await this.redis.lLen(this.config.outboundQueue);
  }

  async checkHealth(): Promise<PublisherHealth> {
    try {
      await this.redis.ping();
      const queueDepth = await this.getQueueDepth();
      
      return {
        healthy: true,
        queueDepth,
        redis: 'connected'
      };
    } catch (error: any) {
      return {
        healthy: false,
        queueDepth: 0,
        redis: 'disconnected',
        error: error.message
      };
    }
  }

  getMetrics(): PublisherMetrics {
    const avgPublishTime = this.metrics.published > 0
      ? this.metrics.totalPublishTime / this.metrics.published
      : 0;

    return {
      published: this.metrics.published,
      failed: this.metrics.failed,
      avgPublishTime,
      lastPublishTime: this.metrics.lastPublishTime
    };
  }

  resetMetrics(): void {
    this.metrics = {
      published: 0,
      failed: 0,
      totalPublishTime: 0
    };
  }
}