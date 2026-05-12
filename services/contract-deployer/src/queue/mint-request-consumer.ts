import { EventEmitter } from 'events';
import { RedisClientType } from 'redis';
import { MintRequestMessage, validateMintRequestMessage } from '../schemas/mint-request-schema';
import { logger } from '../utils/logger';

export interface MintRequestConsumerConfig {
  redis: RedisClientType;
  inboundQueue: string;
  processingQueue: string;
  deadLetterQueue: string;
  processedSetKey: string;
  maxRetries: number;
  blockingTimeout: number;
}

export class MintRequestConsumer extends EventEmitter {
  private readonly redis: RedisClientType;
  private readonly config: MintRequestConsumerConfig;
  private running = false;
  private processingCount = 0;

  constructor(config: MintRequestConsumerConfig) {
    super();
    this.redis = config.redis;
    this.config = config;
  }

  async processMessage(handler: (message: MintRequestMessage) => Promise<void>): Promise<void> {
    const messageStr = await this.redis.brPopLPush(
      this.config.inboundQueue,
      this.config.processingQueue,
      this.config.blockingTimeout,
    );

    if (messageStr === null) {
      return;
    }

    try {
      let parsedMessage: MintRequestMessage;
      try {
        parsedMessage = JSON.parse(messageStr) as MintRequestMessage;
      } catch (error) {
        logger.error('Failed to parse MintRequest JSON', { error, messageStr });
        await this.moveToDeadLetterQueue(messageStr, 'Invalid JSON');
        return;
      }

      const validation = validateMintRequestMessage(parsedMessage);
      if (validation.error) {
        logger.error('MintRequest validation failed', {
          error: validation.error.message,
          message: parsedMessage,
        });
        await this.moveToDeadLetterQueue(messageStr, validation.error.message);
        return;
      }

      const message = validation.value;
      const alreadyProcessed = await this.redis.sIsMember(
        this.config.processedSetKey,
        message.idempotency_key,
      );
      if (alreadyProcessed) {
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
        logger.info('Skipping already processed MintRequest', {
          idempotencyKey: message.idempotency_key,
        });
        return;
      }

      this.processingCount++;
      try {
        await handler(message);
        await this.redis.sAdd(this.config.processedSetKey, message.idempotency_key);
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
      } finally {
        this.processingCount--;
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('MintRequest processing failed', { error: errorMessage });

      const message = JSON.parse(messageStr) as MintRequestMessage;
      const retryCount = message._retryCount ?? 0;

      if (retryCount < this.config.maxRetries) {
        message._retryCount = retryCount + 1;
        await this.redis.lPush(this.config.inboundQueue, JSON.stringify(message));
      } else {
        await this.redis.lRem(this.config.processingQueue, 1, messageStr);
        await this.moveToDeadLetterQueue(messageStr, errorMessage);
      }

      this.emit('error', error);
      throw error;
    }
  }

  async start(handler: (message: MintRequestMessage) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info('MintRequest consumer started');

    while (this.running) {
      try {
        await this.processMessage(handler);
      } catch {
        // Continue processing after per-message failures.
      }
    }

    while (this.processingCount > 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  stop(): void {
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  private async moveToDeadLetterQueue(messageStr: string, reason: string): Promise<void> {
    const originalMessage = this.safeJsonParse(messageStr);
    const dlqEntry = {
      originalMessage,
      error: reason,
      timestamp: new Date().toISOString(),
      queue: this.config.inboundQueue,
    };

    await this.redis.lPush(this.config.deadLetterQueue, JSON.stringify(dlqEntry));
    await this.redis.lRem(this.config.processingQueue, 1, messageStr);
  }

  private safeJsonParse(messageStr: string): unknown {
    try {
      return JSON.parse(messageStr);
    } catch {
      return messageStr;
    }
  }
}
