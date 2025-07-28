import request from 'supertest';
import express from 'express';
import { ethers } from 'ethers';
import { HealthCheckService } from '../../../src/monitoring/health-check';
import { createMockRedisClient } from '../../mocks/redis-mock';
import { createMockProvider } from '../../mocks/ethers-mock';

describe('HealthCheckService', () => {
  let app: express.Application;
  let healthService: HealthCheckService;
  let mockRedis: any;
  let mockProvider: any;

  beforeEach(() => {
    mockRedis = createMockRedisClient();
    mockProvider = createMockProvider();
    
    healthService = new HealthCheckService({
      redis: mockRedis,
      provider: mockProvider,
      registryAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      tokenManagerAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d'
    });

    app = express();
    app.get('/health', healthService.getHealthHandler());
    app.get('/health/detailed', healthService.getDetailedHealthHandler());
  });

  describe('Basic health check', () => {
    test('should return healthy when all services are up', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockProvider.getBlockNumber.mockResolvedValue(12345678);
      
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'healthy',
        timestamp: expect.any(String),
        uptime: expect.any(Number)
      });
    });

    test('should return unhealthy when Redis is down', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection refused'));
      mockProvider.getBlockNumber.mockResolvedValue(12345678);
      
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('unhealthy');
    });

    test('should return unhealthy when blockchain is down', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockProvider.getBlockNumber.mockRejectedValue(new Error('Network error'));
      
      const response = await request(app).get('/health');
      
      expect(response.status).toBe(503);
      expect(response.body.status).toBe('unhealthy');
    });
  });

  describe('Detailed health check', () => {
    test('should return detailed component status', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.lLen.mockResolvedValue(5);
      mockProvider.getBlockNumber.mockResolvedValue(12345678);
      mockProvider.getNetwork.mockResolvedValue({ chainId: 137n, name: 'polygon' });
      mockProvider.getBalance.mockResolvedValue(ethers.toBigInt('1000000000000000000'));
      
      const response = await request(app).get('/health/detailed');
      
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'healthy',
        timestamp: expect.any(String),
        uptime: expect.any(Number),
        components: {
          redis: {
            status: 'healthy',
            latency: expect.any(Number),
            queues: {
              inbound: 5,
              processing: 5,
              deadLetter: 5,
              outbound: 5
            }
          },
          blockchain: {
            status: 'healthy',
            network: 'polygon',
            chainId: 137,
            blockNumber: 12345678,
            latency: expect.any(Number),
            deployerBalance: '1000000000000000000'
          },
          contracts: {
            registry: {
              status: 'healthy',
              address: '0x5FbDB2315678afecb367f032d93F642f64180aa3'
            },
            tokenManager: {
              status: 'healthy',
              address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d'
            }
          }
        },
        metrics: {
          messagesProcessed: expect.any(Number),
          messagesFaile: expect.any(Number),
          tokensDeployed: expect.any(Number),
          averageDeploymentTime: expect.any(Number),
          lastDeploymentTime: expect.any(String)
        }
      });
    });

    test('should show partial failure in components', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockRedis.lLen.mockResolvedValue(100); // High queue depth
      mockProvider.getBlockNumber.mockResolvedValue(12345678);
      mockProvider.getBalance.mockResolvedValue(ethers.toBigInt('100000000000000')); // Low balance
      
      const response = await request(app).get('/health/detailed');
      
      expect(response.status).toBe(200);
      expect(response.body.components.redis.status).toBe('degraded');
      expect(response.body.components.blockchain.warnings).toContain('Low deployer balance');
    });
  });

  describe('Metrics collection', () => {
    test('should track deployment metrics', () => {
      healthService.recordDeployment({
        modelId: 'model_123',
        tokenAddress: '0x123',
        deploymentTime: 45000,
        gasUsed: '2845632'
      });
      
      healthService.recordDeployment({
        modelId: 'model_456',
        tokenAddress: '0x456',
        deploymentTime: 35000,
        gasUsed: '2645632'
      });
      
      const metrics = healthService.getMetrics();
      
      expect(metrics.tokensDeployed).toBe(2);
      expect(metrics.averageDeploymentTime).toBe(40000);
      expect(metrics.totalGasUsed).toBe('5491264');
    });

    test('should track failure metrics', () => {
      healthService.recordFailure({
        modelId: 'model_123',
        error: 'Insufficient gas',
        stage: 'deployment'
      });
      
      const metrics = healthService.getMetrics();
      
      expect(metrics.messagesFaile).toBe(1);
      expect(metrics.failureReasons).toEqual({
        'Insufficient gas': 1
      });
    });
  });

  describe('Readiness check', () => {
    test('should be ready when all components initialized', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockProvider.getNetwork.mockResolvedValue({ chainId: 137n, name: 'polygon' });
      mockProvider.getCode.mockResolvedValue('0x123'); // Contract exists
      
      const ready = await healthService.isReady();
      
      expect(ready).toBe(true);
    });

    test('should not be ready if contracts not deployed', async () => {
      mockRedis.ping.mockResolvedValue('PONG');
      mockProvider.getNetwork.mockResolvedValue({ chainId: 137n, name: 'polygon' });
      mockProvider.getCode.mockResolvedValue('0x'); // No contract
      
      const ready = await healthService.isReady();
      
      expect(ready).toBe(false);
    });
  });

  describe('Liveness check', () => {
    test('should implement liveness probe', async () => {
      const response = await request(app).get('/health/live');
      
      expect(response.status).toBe(200);
      expect(response.body.alive).toBe(true);
    });
  });

  describe('Alerts', () => {
    test('should trigger alerts on threshold breach', () => {
      const alertHandler = jest.fn();
      healthService.onAlert(alertHandler);
      
      // Simulate high queue depth
      for (let i = 0; i < 1000; i++) {
        healthService.recordQueueDepth('inbound', 100 + i);
      }
      
      expect(alertHandler).toHaveBeenCalledWith({
        type: 'queue_depth_high',
        queue: 'inbound',
        depth: expect.any(Number),
        threshold: expect.any(Number)
      });
    });

    test('should alert on consecutive failures', () => {
      const alertHandler = jest.fn();
      healthService.onAlert(alertHandler);
      
      for (let i = 0; i < 5; i++) {
        healthService.recordFailure({
          modelId: `model_${i}`,
          error: 'Deployment failed',
          stage: 'deployment'
        });
      }
      
      expect(alertHandler).toHaveBeenCalledWith({
        type: 'high_failure_rate',
        failures: 5,
        window: '5m'
      });
    });
  });
});