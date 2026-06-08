import { RedisClientType } from 'redis';
import { EventEmitter } from 'events';
import {
  ModelReadyToDeployMessage,
  validateModelReadyToDeployMessage,
} from '../schemas/message-schemas';
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
  // Backoff applied between idle/failed polls to prevent a busy-loop when
  // brPopLPush returns immediately (blockingTimeout=0 or a non-blocking client).
  private readonly idleBackoffMs: number = 50;

  constructor(config: RedisQueueConsumerConfig) {
    super();
    this.redis = config.redis;
    this.config = config;
  }

  /**
   * Polls the inbound queue once and processes a single message if available.
   * Any failure (poll error or processing error) is surfaced via an 'error'
   * event before being re-thrown, so subscribers can observe it.
   * @returns true if a message was dequeued (regardless of processing outcome
   *          beyond a thrown error), false if the poll timed out with no work.
   */
  async processMessage(
    handler: (message: ModelReadyToDeployMessage) => Promise<void>,
  ): Promise<boolean> {
    try {
      return await this.pollAndProcess(handler);
    } catch (error) {
      // Surface every failure (including a brPopLPush poll rejection, which the
      // inner path cannot catch) to subscribers. Guarded by listenerCount because
      // an 'error' event with no listener would otherwise crash the process.
      if (this.listenerCount('error') > 0) {
        this.emit('error', error);
      }
      throw error;
    }
  }

  private async pollAndProcess(
    handler: (message: ModelReadyToDeployMessage) => Promise<void>,
  ): Promise<boolean> {
    const messageStr = await this.redis.brPopLPush(
      this.config.inboundQueue,
      this.config.processingQueue,
      this.config.blockingTimeout,
    );

    if (!messageStr) {
      // Timeout - no message available
      return false;
    }

    try {
      // Parse and validate message
      let message: ModelReadyToDeployMessage;
      try {
        message = JSON.parse(messageStr);
      } catch (parseError) {
        logger.error('Failed to parse message JSON', { error: parseError, messageStr });
        await this.moveToDeadLetterQueue(messageStr, 'Invalid JSON');
        return true;
      }

      // Validate message schema
      const validation = validateModelReadyToDeployMessage(message);
      if (validation.error) {
        logger.error('Message validation failed', {
          error: validation.error.message,
          message,
        });
        await this.moveToDeadLetterQueue(messageStr, validation.error.message);
        return true;
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

      return true;
    } catch (error) {
      // Handle processing failure (the handler threw). messageStr is valid JSON
      // here because malformed payloads are dead-lettered and returned above.
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('Message processing failed', { error: errorMessage });

      const message = JSON.parse(messageStr) as ModelReadyToDeployMessage & {
        _retryCount?: number;
      };
      const retryCount = message._retryCount ?? 0;

      if (retryCount < this.config.maxRetries) {
        // Retry the message
        message._retryCount = retryCount + 1;
        await this.redis.lPush(this.config.inboundQueue, JSON.stringify(message));
        logger.info('Message requeued for retry', {
          modelId: message.model_id,
          retryCount: message._retryCount,
        });
      } else {
        // Max retries exceeded - move to DLQ
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
        await this.moveToDeadLetterQueue(messageStr, errorMessage);
      }

      throw error;
    }
  }

  private async moveToDeadLetterQueue(messageStr: string, reason: string): Promise<void> {
    // Tolerate non-JSON payloads: a malformed message must still be dead-lettered,
    // so fall back to storing the raw string rather than re-parsing (and re-throwing).
    let originalMessage: unknown;
    let modelId: string | undefined;
    try {
      const parsed = JSON.parse(messageStr) as { model_id?: string };
      originalMessage = parsed;
      modelId = parsed.model_id;
    } catch {
      originalMessage = messageStr;
    }

    const dlqEntry = {
      originalMessage,
      error: reason,
      timestamp: new Date().toISOString(),
      queue: this.config.inboundQueue,
    };

    await this.redis.lPush(this.config.deadLetterQueue, JSON.stringify(dlqEntry));
    await this.redis.lRem(this.config.processingQueue, 1, messageStr);

    logger.error('Message moved to DLQ', { reason, modelId });
  }

  async start(handler: (message: ModelReadyToDeployMessage) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info('Queue consumer started');

    while (this.running) {
      try {
        const handled = await this.processMessage(handler);
        // Guard against a busy-loop: if the poll returned immediately with no
        // message (e.g. blockingTimeout=0 or a non-blocking Redis client),
        // yield/back off so we don't spin the event loop allocating until OOM.
        if (!handled && this.running) {
          await new Promise((resolve) => setTimeout(resolve, this.idleBackoffMs));
        }
      } catch (error) {
        // Error already handled in processMessage
        // Continue processing other messages, but back off so a persistent
        // failure (e.g. Redis down) cannot tight-loop.
        if (this.running) {
          await new Promise((resolve) => setTimeout(resolve, this.idleBackoffMs));
        }
      }
    }

    // Wait for any in-flight processing to complete
    while (this.processingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
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
      this.redis.lLen('hokusai:token_deployed_queue'),
    ]);

    return {
      inbound,
      processing,
      deadLetter,
      outbound,
    };
  }

  async checkHealth(): Promise<HealthStatus> {
    try {
      await this.redis.ping();
      const queues = await this.getQueueDepths();

      return {
        healthy: true,
        redis: 'connected',
        queues,
      };
    } catch (error: any) {
      return {
        healthy: false,
        redis: 'disconnected',
        error: error.message,
      };
    }
  }
}
