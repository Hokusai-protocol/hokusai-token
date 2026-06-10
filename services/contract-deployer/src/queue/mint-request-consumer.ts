import { EventEmitter } from 'events';
import { RedisClientType } from 'redis';
import {
  MintRequestMessage,
  MintRequestSettlement,
  validateMintRequestMessage,
} from '../schemas/mint-request-schema';
import { MintBudgetExceededError } from '../blockchain/delta-verifier-client';
import { MintRecordStore } from './mint-record-store';
import { classifyError, computeBackoffMs, FailureClass } from './retry-policy';
import { logger } from '../utils/logger';

export interface MintRequestConsumerConfig {
  redis: RedisClientType;
  inboundQueue: string;
  processingQueue: string;
  deadLetterQueue: string;
  processedSetKey: string;
  retryQueue: string;
  maxRetries: number;
  budgetMaxRetries: number;
  blockingTimeout: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  budgetRetryBackoffBaseMs: number;
  budgetRetryBackoffMaxMs: number;
  backoffMultiplier: number;
  recordStore: MintRecordStore;
}

export class MintRequestConsumer extends EventEmitter {
  private static readonly RETRY_PROMOTION_BATCH_SIZE = 25;
  private readonly redis: RedisClientType;
  private readonly config: MintRequestConsumerConfig;
  private running = false;
  private processingCount = 0;

  constructor(config: MintRequestConsumerConfig) {
    super();
    this.redis = config.redis;
    this.config = config;
  }

  async processMessage(
    handler: (message: MintRequestMessage) => Promise<MintRequestSettlement>,
  ): Promise<void> {
    const messageStr = await this.redis.brPopLPush(
      this.config.inboundQueue,
      this.config.processingQueue,
      this.config.blockingTimeout,
    );

    if (messageStr === null) {
      return;
    }

    let parsedMessage: MintRequestMessage;
    try {
      parsedMessage = JSON.parse(messageStr) as MintRequestMessage;
    } catch (error) {
      logger.error('Failed to parse MintRequest JSON', { error, messageStr });
      await this.moveToDeadLetterQueue(messageStr, undefined, 'Invalid JSON');
      return;
    }

    const validation = validateMintRequestMessage(parsedMessage);
    if (validation.error) {
      logger.error('MintRequest validation failed', {
        error: validation.error.message,
        message: parsedMessage,
      });
      await this.moveToDeadLetterQueue(messageStr, undefined, validation.error.message);
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
      const settlement = await handler(message);
      const multi = this.redis.multi();
      multi.sAdd(this.config.processedSetKey, message.idempotency_key);
      multi.lRem(this.config.processingQueue, 1, messageStr);
      multi.set(
        this.config.recordStore.getKey(message.idempotency_key),
        JSON.stringify(this.config.recordStore.serializeSettled(settlement)),
        { EX: this.config.recordStore.getTtlSeconds() },
      );
      await multi.exec();
    } catch (error: unknown) {
      await this.handleProcessingFailure(messageStr, message, error);
      this.emit('error', error);
      throw error;
    } finally {
      this.processingCount--;
    }
  }

  async start(
    handler: (message: MintRequestMessage) => Promise<MintRequestSettlement>,
  ): Promise<void> {
    this.running = true;
    logger.info('MintRequest consumer started');

    while (this.running) {
      try {
        await this.promoteDueRetries();
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

  private async promoteDueRetries(): Promise<void> {
    const dueRetries = await this.redis.zRangeByScore(this.config.retryQueue, 0, Date.now(), {
      LIMIT: {
        offset: 0,
        count: MintRequestConsumer.RETRY_PROMOTION_BATCH_SIZE,
      },
    });

    for (const retryMessage of dueRetries) {
      const multi = this.redis.multi();
      multi.lPush(this.config.inboundQueue, retryMessage);
      multi.zRem(this.config.retryQueue, retryMessage);
      await multi.exec();
    }
  }

  private async handleProcessingFailure(
    messageStr: string,
    message: MintRequestMessage,
    error: unknown,
  ): Promise<void> {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    const failureClass = classifyError(error);
    const retryCount = message._retryCount ?? 0;
    const isBudgetRetry = this.isBudgetRetryError(error);
    const maxRetries = isBudgetRetry ? this.config.budgetMaxRetries : this.config.maxRetries;

    logger.error('MintRequest processing failed', {
      error: errorMessage,
      failureClass,
      budgetRetry: isBudgetRetry,
      idempotencyKey: message.idempotency_key,
      retryCount,
    });

    if (failureClass === 'permanent') {
      await this.moveToDeadLetterQueue(
        messageStr,
        message,
        `permanent: ${errorMessage}`,
        failureClass,
      );
      return;
    }

    if (retryCount < maxRetries) {
      const nextRetryCount = retryCount + 1;
      const retryMessage = JSON.stringify({ ...message, _retryCount: nextRetryCount });
      const delayMs = computeBackoffMs(nextRetryCount, {
        baseMs: isBudgetRetry ? this.config.budgetRetryBackoffBaseMs : this.config.backoffBaseMs,
        maxMs: isBudgetRetry ? this.config.budgetRetryBackoffMaxMs : this.config.backoffMaxMs,
        multiplier: this.config.backoffMultiplier,
      });

      const multi = this.redis.multi();
      multi.lRem(this.config.processingQueue, 1, messageStr);
      multi.zAdd(this.config.retryQueue, {
        score: Date.now() + delayMs,
        value: retryMessage,
      });
      multi.set(
        this.config.recordStore.getKey(message.idempotency_key),
        JSON.stringify(
          this.config.recordStore.serializeRetrying(
            message.idempotency_key,
            message.model_id,
            errorMessage,
            failureClass,
            'budget_exceeded_retry',
          ),
        ),
        { EX: this.config.recordStore.getTtlSeconds() },
      );
      await multi.exec();
      return;
    }

    await this.moveToDeadLetterQueue(
      messageStr,
      message,
      `${isBudgetRetry ? 'budget_exhausted' : 'exhausted'} (retries=${retryCount}): ${errorMessage}`,
      failureClass,
    );
  }

  private async moveToDeadLetterQueue(
    messageStr: string,
    message: MintRequestMessage | undefined,
    reason: string,
    failureClass: FailureClass = 'permanent',
  ): Promise<void> {
    const originalMessage = this.safeJsonParse(messageStr);
    const dlqEntry = {
      originalMessage,
      error: reason,
      reason,
      failureClass,
      timestamp: new Date().toISOString(),
      queue: this.config.inboundQueue,
    };

    await this.redis.lPush(this.config.deadLetterQueue, JSON.stringify(dlqEntry));
    await this.redis.lRem(this.config.processingQueue, 1, messageStr);

    if (typeof message?.idempotency_key === 'string') {
      await this.config.recordStore.recordError(message.idempotency_key, message.model_id, reason, {
        failureClass,
      });
    }
  }

  private isBudgetRetryError(error: unknown): boolean {
    return (
      error instanceof MintBudgetExceededError ||
      (error instanceof Error && error.message.includes('MintBudgetExceeded'))
    );
  }

  private safeJsonParse(messageStr: string): unknown {
    try {
      return JSON.parse(messageStr);
    } catch {
      return messageStr;
    }
  }
}
