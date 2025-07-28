import { RedisClientType } from 'redis';
import { EventPublisher } from '../../../src/queue/event-publisher';
import { TokenDeployedMessage } from '../../../src/schemas/message-schemas';
import { createMockRedisClient } from '../../mocks/redis-mock';

describe('EventPublisher', () => {
  let publisher: EventPublisher;
  let mockRedis: jest.Mocked<RedisClientType>;
  
  const OUTBOUND_QUEUE = 'hokusai:token_deployed_queue';
  
  const validTokenDeployedMessage: TokenDeployedMessage = {
    event_type: 'token_deployed',
    model_id: 'model_123',
    token_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    token_symbol: 'HKAI-123',
    token_name: 'Hokusai Model 123',
    transaction_hash: '0x7b1203ad2b29d6f24b07b46ec2f970eb37e1e9c8f2a3d4e5f6789012345678ab',
    registry_transaction_hash: '0x8c2314be3c30e7a35c18c57fd3f081fc48f2f0d9a3b4e5a67890123456789bcd',
    mlflow_run_id: 'run_abc123',
    model_name: 'enhanced_classifier_v1',
    model_version: '1.1.0',
    deployment_timestamp: '2024-01-27T10:01:30Z',
    deployer_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
    network: 'polygon',
    block_number: 12345678,
    gas_used: '2845632',
    gas_price: '35000000000',
    performance_metric: 'accuracy',
    performance_improvement: 3.51,
    message_version: '1.0'
  };

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    publisher = new EventPublisher({
      redis: mockRedis,
      outboundQueue: OUTBOUND_QUEUE
    });
  });

  describe('publish', () => {
    test('should publish valid message to queue', async () => {
      mockRedis.lPush.mockResolvedValue(1);
      
      await publisher.publish(validTokenDeployedMessage);
      
      expect(mockRedis.lPush).toHaveBeenCalledWith(
        OUTBOUND_QUEUE,
        JSON.stringify(validTokenDeployedMessage)
      );
    });

    test('should validate message before publishing', async () => {
      const invalidMessage = { ...validTokenDeployedMessage, event_type: 'invalid_type' };
      
      await expect(publisher.publish(invalidMessage as any))
        .rejects.toThrow();
      
      expect(mockRedis.lPush).not.toHaveBeenCalled();
    });

    test('should handle Redis errors', async () => {
      mockRedis.lPush.mockRejectedValue(new Error('Redis connection lost'));
      
      await expect(publisher.publish(validTokenDeployedMessage))
        .rejects.toThrow('Redis connection lost');
    });

    test('should add metadata to messages', async () => {
      mockRedis.lPush.mockResolvedValue(1);
      
      await publisher.publish(validTokenDeployedMessage, {
        correlationId: 'corr_123',
        source: 'contract-deployer'
      });
      
      const calledWith = mockRedis.lPush.mock.calls[0]?.[1];
      expect(calledWith).toBeDefined();
      const publishedMessage = JSON.parse(calledWith as string);
      
      expect(publishedMessage._metadata).toEqual({
        correlationId: 'corr_123',
        source: 'contract-deployer',
        publishedAt: expect.any(String)
      });
    });
  });

  describe('publishBatch', () => {
    test('should publish multiple messages atomically', async () => {
      const messages = [
        validTokenDeployedMessage,
        { ...validTokenDeployedMessage, model_id: 'model_456' }
      ];
      
      mockRedis.multi.mockReturnValue({
        lPush: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([1, 2])
      } as any);
      
      await publisher.publishBatch(messages);
      
      expect(mockRedis.multi).toHaveBeenCalled();
      const multi = mockRedis.multi();
      expect(multi.lPush).toHaveBeenCalledTimes(2);
      expect(multi.exec).toHaveBeenCalled();
    });

    test('should rollback on batch failure', async () => {
      const messages = [
        validTokenDeployedMessage,
        { ...validTokenDeployedMessage, event_type: 'invalid' } as any
      ];
      
      await expect(publisher.publishBatch(messages))
        .rejects.toThrow();
      
      expect(mockRedis.multi).not.toHaveBeenCalled();
    });
  });

  describe('publishWithRetry', () => {
    test('should retry on temporary failures', async () => {
      mockRedis.lPush
        .mockRejectedValueOnce(new Error('Temporary error'))
        .mockResolvedValueOnce(1);
      
      await publisher.publishWithRetry(validTokenDeployedMessage, 3, 10);
      
      expect(mockRedis.lPush).toHaveBeenCalledTimes(2);
    });

    test('should fail after max retries', async () => {
      mockRedis.lPush.mockRejectedValue(new Error('Persistent error'));
      
      await expect(publisher.publishWithRetry(validTokenDeployedMessage, 3, 10))
        .rejects.toThrow('Persistent error');
      
      expect(mockRedis.lPush).toHaveBeenCalledTimes(3);
    });

    test('should use exponential backoff', async () => {
      const startTime = Date.now();
      mockRedis.lPush
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockRejectedValueOnce(new Error('Error 2'))
        .mockResolvedValueOnce(1);
      
      await publisher.publishWithRetry(validTokenDeployedMessage, 3, 50);
      
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeGreaterThanOrEqual(100); // 50ms + 100ms backoff
    });
  });

  describe('confirmDelivery', () => {
    test('should confirm message exists in queue', async () => {
      mockRedis.lRange.mockResolvedValue([
        JSON.stringify(validTokenDeployedMessage)
      ]);
      
      const confirmed = await publisher.confirmDelivery(
        validTokenDeployedMessage.model_id
      );
      
      expect(confirmed).toBe(true);
      expect(mockRedis.lRange).toHaveBeenCalledWith(OUTBOUND_QUEUE, 0, -1);
    });

    test('should return false if message not found', async () => {
      mockRedis.lRange.mockResolvedValue([]);
      
      const confirmed = await publisher.confirmDelivery('model_999');
      
      expect(confirmed).toBe(false);
    });

    test('should handle large queues efficiently', async () => {
      // Simulate a large queue
      const messages = Array(1000).fill(null).map((_, i) => 
        JSON.stringify({ ...validTokenDeployedMessage, model_id: `model_${i}` })
      );
      mockRedis.lRange.mockResolvedValue(messages);
      
      const confirmed = await publisher.confirmDelivery('model_500');
      
      expect(confirmed).toBe(true);
    });
  });

  describe('getQueueDepth', () => {
    test('should return current queue depth', async () => {
      mockRedis.lLen.mockResolvedValue(42);
      
      const depth = await publisher.getQueueDepth();
      
      expect(depth).toBe(42);
      expect(mockRedis.lLen).toHaveBeenCalledWith(OUTBOUND_QUEUE);
    });
  });

  describe('health check', () => {
    test('should verify publisher health', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.lLen.mockResolvedValue(10);
      
      const health = await publisher.checkHealth();
      
      expect(health).toEqual({
        healthy: true,
        queueDepth: 10,
        redis: 'connected'
      });
    });

    test('should report unhealthy on Redis failure', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection refused'));
      
      const health = await publisher.checkHealth();
      
      expect(health).toEqual({
        healthy: false,
        queueDepth: 0,
        redis: 'disconnected',
        error: 'Connection refused'
      });
    });
  });

  describe('metrics', () => {
    test('should track publish metrics', async () => {
      mockRedis.lPush.mockResolvedValue(1);
      
      await publisher.publish(validTokenDeployedMessage);
      await publisher.publish(validTokenDeployedMessage);
      
      mockRedis.lPush.mockRejectedValueOnce(new Error('Failed'));
      await expect(publisher.publish(validTokenDeployedMessage))
        .rejects.toThrow();
      
      const metrics = publisher.getMetrics();
      
      expect(metrics).toEqual({
        published: 2,
        failed: 1,
        avgPublishTime: expect.any(Number),
        lastPublishTime: expect.any(Date)
      });
    });

    test('should reset metrics', async () => {
      mockRedis.lPush.mockResolvedValue(1);
      await publisher.publish(validTokenDeployedMessage);
      
      publisher.resetMetrics();
      const metrics = publisher.getMetrics();
      
      expect(metrics.published).toBe(0);
      expect(metrics.failed).toBe(0);
    });
  });
});