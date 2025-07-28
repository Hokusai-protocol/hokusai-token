import { RedisClientType } from 'redis';
import { RedisQueueConsumer } from '../../../src/queue/redis-consumer';
import { createMockRedisClient } from '../../mocks/redis-mock';
import { ModelReadyToDeployMessage } from '../../../src/schemas/message-schemas';

describe('RedisQueueConsumer', () => {
  let consumer: RedisQueueConsumer;
  let mockRedis: jest.Mocked<RedisClientType>;
  let processMessageSpy: jest.Mock;
  
  const INBOUND_QUEUE = 'hokusai:model_ready_queue';
  const PROCESSING_QUEUE = 'hokusai:processing_queue';
  const DLQ = 'hokusai:dlq';
  
  const validMessage: ModelReadyToDeployMessage = {
    model_id: 'model_123',
    token_symbol: 'HKAI-123',
    metric_name: 'accuracy',
    baseline_value: 0.854,
    current_value: 0.884,
    model_name: 'enhanced_classifier_v1',
    model_version: '1.1.0',
    mlflow_run_id: 'run_abc123',
    improvement_percentage: 3.51,
    timestamp: '2024-01-27T10:00:00Z',
    message_version: '1.0'
  };

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    processMessageSpy = jest.fn();
    consumer = new RedisQueueConsumer({
      redis: mockRedis,
      inboundQueue: INBOUND_QUEUE,
      processingQueue: PROCESSING_QUEUE,
      deadLetterQueue: DLQ,
      maxRetries: 3,
      blockingTimeout: 5
    });
  });

  afterEach(() => {
    consumer.stop();
    jest.clearAllMocks();
  });

  describe('BRPOPLPUSH pattern', () => {
    test('should implement reliable queue processing with BRPOPLPUSH', async () => {
      const messageStr = JSON.stringify(validMessage);
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      mockRedis.lRem.mockResolvedValueOnce(1);

      await consumer.processMessage(processMessageSpy);

      expect(mockRedis.brPopLPush).toHaveBeenCalledWith(INBOUND_QUEUE, PROCESSING_QUEUE, 5);
      expect(processMessageSpy).toHaveBeenCalledWith(validMessage);
      expect(mockRedis.lRem).toHaveBeenCalledWith(PROCESSING_QUEUE, 1, messageStr);
    });

    test('should handle timeout when no messages available', async () => {
      mockRedis.brPopLPush.mockResolvedValueOnce(null);

      await consumer.processMessage(processMessageSpy);

      expect(mockRedis.brPopLPush).toHaveBeenCalled();
      expect(processMessageSpy).not.toHaveBeenCalled();
    });

    test('should not remove message from processing queue on failure', async () => {
      const messageStr = JSON.stringify(validMessage);
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      processMessageSpy.mockRejectedValueOnce(new Error('Processing failed'));

      await expect(consumer.processMessage(processMessageSpy)).rejects.toThrow('Processing failed');

      expect(mockRedis.lRem).not.toHaveBeenCalled();
    });
  });

  describe('Message validation', () => {
    test('should reject malformed JSON messages', async () => {
      const invalidJson = 'not valid json';
      mockRedis.brPopLPush.mockResolvedValueOnce(invalidJson);
      mockRedis.lRem.mockResolvedValueOnce(1);
      mockRedis.lPush.mockResolvedValueOnce(1);

      await consumer.processMessage(processMessageSpy);

      expect(processMessageSpy).not.toHaveBeenCalled();
      expect(mockRedis.lRem).toHaveBeenCalledWith(PROCESSING_QUEUE, 1, invalidJson);
      expect(mockRedis.lPush).toHaveBeenCalledWith(DLQ, expect.any(String));
    });

    test('should reject messages with invalid schema', async () => {
      const invalidMessage = { invalid: 'message' };
      const messageStr = JSON.stringify(invalidMessage);
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      mockRedis.lRem.mockResolvedValueOnce(1);
      mockRedis.lPush.mockResolvedValueOnce(1);

      await consumer.processMessage(processMessageSpy);

      expect(processMessageSpy).not.toHaveBeenCalled();
      expect(mockRedis.lPush).toHaveBeenCalledWith(DLQ, expect.any(String));
    });
  });

  describe('Retry logic', () => {
    test('should retry failed messages up to maxRetries', async () => {
      const messageWithRetry = { ...validMessage, _retryCount: 2 };
      const messageStr = JSON.stringify(messageWithRetry);
      
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      processMessageSpy.mockRejectedValueOnce(new Error('Temporary failure'));
      mockRedis.lPush.mockResolvedValueOnce(1);

      await expect(consumer.processMessage(processMessageSpy)).rejects.toThrow();

      expect(mockRedis.lPush).toHaveBeenCalledWith(
        INBOUND_QUEUE,
        JSON.stringify({ ...messageWithRetry, _retryCount: 3 })
      );
    });

    test('should move to DLQ after exceeding maxRetries', async () => {
      const messageWithMaxRetries = { ...validMessage, _retryCount: 3 };
      const messageStr = JSON.stringify(messageWithMaxRetries);
      
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      processMessageSpy.mockRejectedValueOnce(new Error('Permanent failure'));
      mockRedis.lRem.mockResolvedValueOnce(1);
      mockRedis.lPush.mockResolvedValueOnce(1);

      await expect(consumer.processMessage(processMessageSpy)).rejects.toThrow();

      expect(mockRedis.lRem).toHaveBeenCalledWith(PROCESSING_QUEUE, 1, messageStr);
      expect(mockRedis.lPush).toHaveBeenCalledWith(DLQ, expect.any(String));
    });
  });

  describe('Queue operations', () => {
    test('should get queue depths', async () => {
      mockRedis.lLen.mockResolvedValueOnce(10)
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(1)
        .mockResolvedValueOnce(5);

      const depths = await consumer.getQueueDepths();

      expect(depths).toEqual({
        inbound: 10,
        processing: 2,
        deadLetter: 1,
        outbound: 5
      });
    });

    test('should check health status', async () => {
      mockRedis.ping.mockResolvedValueOnce('PONG');
      mockRedis.lLen.mockResolvedValue(0);

      const health = await consumer.checkHealth();

      expect(health.healthy).toBe(true);
      expect(health.redis).toBe('connected');
      expect(health.queues).toBeDefined();
    });

    test('should report unhealthy when Redis is down', async () => {
      mockRedis.ping.mockRejectedValueOnce(new Error('Connection refused'));

      const health = await consumer.checkHealth();

      expect(health.healthy).toBe(false);
      expect(health.redis).toBe('disconnected');
    });
  });

  describe('Consumer lifecycle', () => {
    test('should start and stop consumer', async () => {
      const stopPromise = consumer.start(processMessageSpy);
      
      // Let it run for a bit
      await new Promise(resolve => setTimeout(resolve, 10));
      
      consumer.stop();
      await stopPromise;

      expect(consumer.isRunning()).toBe(false);
    });

    test('should handle graceful shutdown', async () => {
      const messageStr = JSON.stringify(validMessage);
      let processingMessage = false;
      
      processMessageSpy.mockImplementation(async () => {
        processingMessage = true;
        await new Promise(resolve => setTimeout(resolve, 100));
        processingMessage = false;
      });
      
      mockRedis.brPopLPush.mockResolvedValueOnce(messageStr);
      mockRedis.lRem.mockResolvedValueOnce(1);
      
      const startPromise = consumer.start(processMessageSpy);
      
      // Wait for processing to start
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(processingMessage).toBe(true);
      
      // Stop while processing
      consumer.stop();
      await startPromise;
      
      // Should have completed processing
      expect(processingMessage).toBe(false);
      expect(mockRedis.lRem).toHaveBeenCalled();
    });
  });

  describe('Error handling', () => {
    test('should handle Redis connection errors', async () => {
      mockRedis.brPopLPush.mockRejectedValueOnce(new Error('Redis connection lost'));

      await expect(consumer.processMessage(processMessageSpy)).rejects.toThrow('Redis connection lost');
    });

    test('should emit error events', async () => {
      const errorHandler = jest.fn();
      consumer.on('error', errorHandler);
      
      const error = new Error('Test error');
      mockRedis.brPopLPush.mockRejectedValueOnce(error);
      
      await expect(consumer.processMessage(processMessageSpy)).rejects.toThrow();
      
      expect(errorHandler).toHaveBeenCalledWith(error);
    });
  });
});