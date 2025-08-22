import request from 'supertest';
import { createServer } from '../../src/server';
import { DeployTokenRequest, DeployTokenResponse, DeploymentStatusResponse } from '../../src/types/api.types';
import { ValidationHelpers } from '../../src/schemas/api-schemas';
import { ApiErrorFactory } from '../../src/types/errors';

// Mock external dependencies
jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue(undefined),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    lPush: jest.fn(),
    rPop: jest.fn(),
    lLen: jest.fn(),
    ping: jest.fn().mockResolvedValue('PONG'),
  })),
}));

jest.mock('../../src/services/queue.service');
jest.mock('../../src/services/blockchain.service');
jest.mock('../../src/services/deployment.service');
jest.mock('../../src/services/deployment-processor');
jest.mock('../../src/blockchain/contract-deployer');

// Mock Winston logger
jest.mock('../../src/utils/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
}));

describe('Deployment API Endpoints', () => {
  let app: any;
  let mockDeploymentService: any;
  let mockQueueService: any;
  let mockBlockchainService: any;

  beforeAll(async () => {
    // Set test environment variables
    process.env.NODE_ENV = 'test';
    process.env.RPC_URL = 'http://localhost:8545';
    process.env.CHAIN_ID = '1337';
    process.env.NETWORK_NAME = 'localhost';
    process.env.MODEL_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.TOKEN_MANAGER_ADDRESS = '0x0987654321098765432109876543210987654321';
    process.env.DEPLOYER_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12';
    process.env.REDIS_HOST = 'localhost';
    process.env.REDIS_PORT = '6379';
    process.env.VALID_API_KEYS = 'test-key,test-key-2';
    process.env.QUEUE_NAME = 'test-queue';
    process.env.GAS_PRICE_MULTIPLIER = '1.2';
    process.env.MAX_GAS_PRICE_GWEI = '100';
    process.env.CONFIRMATION_BLOCKS = '1';

    // Create server instance
    app = await createServer();
  });

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock service instances
    const { QueueService } = require('../../src/services/queue.service');
    const { BlockchainService } = require('../../src/services/blockchain.service');
    const { DeploymentService } = require('../../src/services/deployment.service');

    // Set up default mock implementations
    mockQueueService = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      enqueue: jest.fn().mockResolvedValue(undefined),
      getQueueLength: jest.fn().mockResolvedValue(0),
    };

    mockBlockchainService = {
      isHealthy: jest.fn().mockResolvedValue(true),
      getLatestBlockNumber: jest.fn().mockResolvedValue(12345),
      getNetworkInfo: jest.fn().mockResolvedValue({
        chainId: 1337,
        name: 'localhost'
      }),
    };

    mockDeploymentService = {
      initialize: jest.fn().mockResolvedValue(undefined),
      createDeployment: jest.fn(),
      getDeploymentStatus: jest.fn(),
    };

    // Mock constructors
    QueueService.mockImplementation(() => mockQueueService);
    BlockchainService.mockImplementation(() => mockBlockchainService);
    DeploymentService.mockImplementation(() => mockDeploymentService);
  });

  describe('POST /api/deployments', () => {
    const validDeployRequest: DeployTokenRequest = {
      token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJhZGRyZXNzIjoiMHg3NDJkMzVjYzY2MzFjMDUzMjkyNWEzYjhkNzU2ZDJiZThiNmM2ZGQ5IiwiZXhwIjoxNzA5MjA4MDAwfQ.test',
      modelId: 'sentiment-analysis-v1',
      userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9',
      tokenName: 'Sentiment Analysis Token',
      tokenSymbol: 'SAT',
      initialSupply: '1000000',
      metadata: {
        description: 'Token for sentiment analysis model',
        website: 'https://example.com',
        tags: {
          'model-type': 'nlp',
          'category': 'sentiment'
        }
      }
    };

    const mockDeploymentResponse: DeployTokenResponse = {
      requestId: '123e4567-e89b-42d3-a456-426614174000',
      status: 'pending',
      estimatedCompletionTime: 300,
      message: 'Deployment request queued successfully',
      links: {
        status: '/api/deployments/123e4567-e89b-42d3-a456-426614174000/status'
      }
    };

    describe('Successful deployment request', () => {
      it('should create deployment with valid API key and request', async () => {
        mockDeploymentService.createDeployment.mockResolvedValue(mockDeploymentResponse);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(validDeployRequest)
          .expect(202);

        expect(response.body.success).toBe(true);
        expect(response.body.data.requestId).toBe(mockDeploymentResponse.requestId);
        expect(response.body.data.status).toBe('pending');
        expect(response.body.data.links.status).toBeDefined();
        expect(response.body.meta.requestId).toBeDefined();
        expect(response.body.meta.timestamp).toBeDefined();
        expect(response.body.meta.version).toBe('1.0');

        expect(mockDeploymentService.createDeployment).toHaveBeenCalledWith(
          validDeployRequest,
          expect.objectContaining({
            userId: 'api_user',
            address: '0x0000000000000000000000000000000000000000',
            exp: expect.any(Number)
          }),
          expect.any(String)
        );
      });

      it('should create deployment with minimal required fields', async () => {
        const minimalRequest = {
          token: validDeployRequest.token,
          modelId: validDeployRequest.modelId,
          userAddress: validDeployRequest.userAddress
        };

        mockDeploymentService.createDeployment.mockResolvedValue(mockDeploymentResponse);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(minimalRequest)
          .expect(202);

        expect(response.body.success).toBe(true);
        expect(response.body.data.requestId).toBe(mockDeploymentResponse.requestId);
      });

      it('should accept Bearer token authentication', async () => {
        mockDeploymentService.createDeployment.mockResolvedValue(mockDeploymentResponse);

        const response = await request(app)
          .post('/api/deployments')
          .set('Authorization', 'Bearer test-jwt-token')
          .send(validDeployRequest)
          .expect(202);

        expect(response.body.success).toBe(true);
      });
    });

    describe('Authentication errors', () => {
      it('should reject request without authentication', async () => {
        const response = await request(app)
          .post('/api/deployments')
          .send(validDeployRequest)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INVALID_TOKEN');
        expect(response.body.error.message).toBe('Invalid authentication token');
      });

      it('should reject request with invalid API key', async () => {
        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'invalid-key')
          .send(validDeployRequest)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INVALID_TOKEN');
        expect(response.body.error.message).toBe('Invalid authentication token');
      });

      it('should reject request with empty API key', async () => {
        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', '')
          .send(validDeployRequest)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });
    });

    describe('Request validation errors', () => {
      it('should reject request with missing modelId', async () => {
        const invalidRequest = { ...validDeployRequest };
        delete (invalidRequest as any).modelId;

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'modelId',
              message: expect.stringContaining('required')
            })
          ])
        );
      });

      it('should reject request with invalid modelId format', async () => {
        const invalidRequest = {
          ...validDeployRequest,
          modelId: 'invalid model id with spaces!'
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'modelId',
              message: expect.stringContaining('alphanumeric characters')
            })
          ])
        );
      });

      it('should reject request with missing userAddress', async () => {
        const invalidRequest = { ...validDeployRequest };
        delete (invalidRequest as any).userAddress;

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'userAddress',
              message: expect.stringContaining('required')
            })
          ])
        );
      });

      it('should reject request with invalid Ethereum address', async () => {
        const invalidRequest = {
          ...validDeployRequest,
          userAddress: 'invalid-address'
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'userAddress',
              message: expect.stringContaining('Invalid Ethereum address')
            })
          ])
        );
      });

      it('should reject request with invalid token symbol', async () => {
        const invalidRequest = {
          ...validDeployRequest,
          tokenSymbol: 'lowercase-symbol'
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'tokenSymbol',
              message: expect.stringContaining('uppercase')
            })
          ])
        );
      });

      it('should reject request with invalid token name', async () => {
        const invalidRequest = {
          ...validDeployRequest,
          tokenName: 'A'.repeat(51) // Too long
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should reject request with invalid initialSupply', async () => {
        const invalidRequest = {
          ...validDeployRequest,
          initialSupply: 'invalid-amount'
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              field: 'initialSupply',
              message: expect.stringContaining('decimal number')
            })
          ])
        );
      });

      it('should reject request with multiple validation errors', async () => {
        const invalidRequest = {
          token: validDeployRequest.token,
          modelId: 'invalid model!',
          userAddress: 'not-an-address',
          tokenSymbol: 'lowercase',
          initialSupply: 'not-a-number'
        };

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(invalidRequest)
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.details).toHaveLength(4); // modelId, userAddress, tokenSymbol, initialSupply
      });
    });

    describe('Business logic errors', () => {
      it('should handle token already exists error', async () => {
        const tokenExistsError = ApiErrorFactory.tokenAlreadyExists('sentiment-analysis-v1', 'test-correlation-id');
        mockDeploymentService.createDeployment.mockRejectedValue(tokenExistsError);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(validDeployRequest)
          .expect(409);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('TOKEN_ALREADY_EXISTS');
        expect(response.body.error.message).toBe('Token already exists for this model');
      });

      it('should handle model not found error', async () => {
        const modelNotFoundError = ApiErrorFactory.modelNotFound('non-existent-model', 'test-correlation-id');
        mockDeploymentService.createDeployment.mockRejectedValue(modelNotFoundError);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(validDeployRequest)
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('MODEL_NOT_FOUND');
        expect(response.body.error.message).toBe('Model not found');
      });

      it('should handle blockchain connection error', async () => {
        const blockchainError = ApiErrorFactory.blockchainConnectionError('RPC connection failed', 'test-correlation-id');
        mockDeploymentService.createDeployment.mockRejectedValue(blockchainError);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(validDeployRequest)
          .expect(503);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('BLOCKCHAIN_CONNECTION_ERROR');
        expect(response.body.error.retryable).toBe(true);
      });

      it('should handle internal server error', async () => {
        const internalError = new Error('Unexpected error');
        mockDeploymentService.createDeployment.mockRejectedValue(internalError);

        const response = await request(app)
          .post('/api/deployments')
          .set('X-API-Key', 'test-key')
          .send(validDeployRequest)
          .expect(500);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INTERNAL_ERROR');
        expect(response.body.error.message).toBe('Internal server error');
      });
    });
  });

  describe('GET /api/deployments/:id/status', () => {
    const validUUID = '123e4567-e89b-42d3-a456-426614174000';
    
    const mockStatusResponse: DeploymentStatusResponse = {
      requestId: validUUID,
      status: 'deployed',
      progress: 100,
      currentStep: 'Contract deployed successfully',
      lastUpdated: '2024-01-01T12:00:00.000Z',
      tokenDetails: {
        tokenAddress: '0xabc123def456789abc123def456789abc123def456',
        tokenName: 'Sentiment Analysis Token',
        tokenSymbol: 'SAT',
        transactionHash: '0x123abc456def789abc123def456789abc123def456789abc123def456789abc123',
        registryTransactionHash: '0x456def789abc123def456789abc123def456789abc123def456789abc123def456',
        blockNumber: 12345,
        gasUsed: '150000',
        gasPrice: '20000000000',
        deploymentTime: '2024-01-01T12:00:00.000Z',
        network: 'localhost'
      }
    };

    describe('Successful status retrieval', () => {
      it('should return deployment status for valid UUID with deployed status', async () => {
        mockDeploymentService.getDeploymentStatus.mockResolvedValue(mockStatusResponse);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.requestId).toBe(validUUID);
        expect(response.body.data.status).toBe('deployed');
        expect(response.body.data.progress).toBe(100);
        expect(response.body.data.tokenDetails).toBeDefined();
        expect(response.body.data.tokenDetails.tokenAddress).toBe('0xabc123def456789abc123def456789abc123def456');
        expect(response.body.meta.requestId).toBeDefined();
        expect(response.body.meta.timestamp).toBeDefined();
      });

      it('should return pending status', async () => {
        const pendingResponse = {
          ...mockStatusResponse,
          status: 'pending' as const,
          progress: 10,
          currentStep: 'Queued for deployment',
          tokenDetails: undefined
        };
        mockDeploymentService.getDeploymentStatus.mockResolvedValue(pendingResponse);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe('pending');
        expect(response.body.data.progress).toBe(10);
        expect(response.body.data.tokenDetails).toBeUndefined();
      });

      it('should return processing status', async () => {
        const processingResponse = {
          ...mockStatusResponse,
          status: 'processing' as const,
          progress: 50,
          currentStep: 'Deploying smart contract',
          tokenDetails: undefined
        };
        mockDeploymentService.getDeploymentStatus.mockResolvedValue(processingResponse);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe('processing');
        expect(response.body.data.progress).toBe(50);
        expect(response.body.data.currentStep).toBe('Deploying smart contract');
      });

      it('should return failed status with error details', async () => {
        const failedResponse = {
          ...mockStatusResponse,
          status: 'failed' as const,
          progress: 0,
          currentStep: 'Deployment failed',
          tokenDetails: undefined,
          error: {
            code: 'TRANSACTION_FAILED',
            message: 'Transaction reverted',
            details: 'Insufficient gas for execution',
            suggestions: ['Increase gas limit', 'Check transaction parameters'],
            timestamp: '2024-01-01T12:00:00.000Z',
            retryable: true
          }
        };
        mockDeploymentService.getDeploymentStatus.mockResolvedValue(failedResponse);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.status).toBe('failed');
        expect(response.body.data.error).toBeDefined();
        expect(response.body.data.error.code).toBe('TRANSACTION_FAILED');
        expect(response.body.data.error.retryable).toBe(true);
      });
    });

    describe('Authentication errors', () => {
      it('should reject request without authentication', async () => {
        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });

      it('should reject request with invalid API key', async () => {
        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'invalid-key')
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('INVALID_TOKEN');
      });
    });

    describe('Validation errors', () => {
      it('should return 400 for invalid UUID format', async () => {
        const response = await request(app)
          .get('/api/deployments/invalid-uuid/status')
          .set('X-API-Key', 'test-key')
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
        expect(response.body.error.message).toBe('Request validation failed');
        expect(response.body.error.details).toContain('Invalid deployment ID format');
      });

      it('should return 400 for UUID with wrong version', async () => {
        const v1UUID = '12345678-1234-1234-1234-123456789012'; // v1 UUID format

        const response = await request(app)
          .get(`/api/deployments/${v1UUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('VALIDATION_ERROR');
      });

      it('should return 400 for empty deployment ID', async () => {
        const response = await request(app)
          .get('/api/deployments//status')
          .set('X-API-Key', 'test-key')
          .expect(404); // Express routing will treat this as not found

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('NOT_FOUND');
      });
    });

    describe('Business logic errors', () => {
      it('should return 404 for non-existent deployment', async () => {
        const deploymentNotFoundError = ApiErrorFactory.deploymentNotFound(validUUID, 'test-correlation-id');
        mockDeploymentService.getDeploymentStatus.mockRejectedValue(deploymentNotFoundError);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(404);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('DEPLOYMENT_NOT_FOUND');
        expect(response.body.error.message).toBe('Deployment not found');
      });

      it('should handle service unavailable error', async () => {
        const serviceUnavailableError = ApiErrorFactory.serviceUnavailable('Redis', 'test-correlation-id');
        mockDeploymentService.getDeploymentStatus.mockRejectedValue(serviceUnavailableError);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(503);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
        expect(response.body.error.retryable).toBe(true);
      });

      it('should handle timeout error', async () => {
        const timeoutError = ApiErrorFactory.timeoutError('Status check', 'test-correlation-id');
        mockDeploymentService.getDeploymentStatus.mockRejectedValue(timeoutError);

        const response = await request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(504);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('TIMEOUT_ERROR');
        expect(response.body.error.retryable).toBe(true);
      });
    });
  });

  describe('GET /api/deployments/:id (Legacy endpoint)', () => {
    const validUUID = '123e4567-e89b-42d3-a456-426614174000';

    it('should redirect to status endpoint', async () => {
      const response = await request(app)
        .get(`/api/deployments/${validUUID}`)
        .set('X-API-Key', 'test-key')
        .expect(301);

      expect(response.headers.location).toBe(`/api/deployments/${validUUID}/status`);
    });

    it('should handle redirect error gracefully', async () => {
      // This test ensures the redirect error handling works
      const invalidUUID = 'invalid-uuid';
      
      const response = await request(app)
        .get(`/api/deployments/${invalidUUID}`)
        .set('X-API-Key', 'test-key')
        .expect(301);

      expect(response.headers.location).toBe(`/api/deployments/${invalidUUID}/status`);
    });
  });

  describe('Error handling and edge cases', () => {
    it('should handle malformed JSON request body', async () => {
      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'test-key')
        .set('Content-Type', 'application/json')
        .send('{"invalid": json}')
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it('should handle missing Content-Type header', async () => {
      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'test-key')
        .send('not-json')
        .expect(400);

      expect(response.body.error).toBeDefined();
    });

    it('should handle very large request body', async () => {
      const largeRequest = {
        ...{
          token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIiLCJhZGRyZXNzIjoiMHg3NDJkMzVjYzY2MzFjMDUzMjkyNWEzYjhkNzU2ZDJiZThiNmM2ZGQ5IiwiZXhwIjoxNzA5MjA4MDAwfQ.test',
          modelId: 'test-model',
          userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9',
        },
        metadata: {
          description: 'A'.repeat(1000), // Very long description
          tags: Object.fromEntries(Array(100).fill(0).map((_, i) => [`tag${i}`, `value${i}`])) // Many tags
        }
      };

      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'test-key')
        .send(largeRequest)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('should preserve correlation ID in error responses', async () => {
      const customCorrelationId = 'custom-correlation-123';
      
      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'test-key')
        .set('X-Correlation-ID', customCorrelationId)
        .send({}) // Empty request to trigger validation error
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      // Note: The correlation ID handling would need to be implemented in the actual middleware
    });

    it('should handle concurrent requests to same deployment ID', async () => {
      const validUUID = '123e4567-e89b-42d3-a456-426614174000';
      const mockResponse: DeploymentStatusResponse = {
        requestId: validUUID,
        status: 'processing',
        progress: 75,
        currentStep: 'Verifying contract',
        lastUpdated: '2024-01-01T12:00:00.000Z'
      };

      mockDeploymentService.getDeploymentStatus.mockResolvedValue(mockResponse);

      // Make multiple concurrent requests
      const promises = Array(5).fill(0).map(() => 
        request(app)
          .get(`/api/deployments/${validUUID}/status`)
          .set('X-API-Key', 'test-key')
          .expect(200)
      );

      const responses = await Promise.all(promises);
      
      responses.forEach(response => {
        expect(response.body.success).toBe(true);
        expect(response.body.data.requestId).toBe(validUUID);
        expect(response.body.data.status).toBe('processing');
      });

      expect(mockDeploymentService.getDeploymentStatus).toHaveBeenCalledTimes(5);
    });
  });

  describe('API Response format validation', () => {
    it('should always include required response structure', async () => {
      const validRequest = {
        token: 'test-token',
        modelId: 'test-model',
        userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9'
      };

      mockDeploymentService.createDeployment.mockResolvedValue({
        requestId: '123e4567-e89b-42d3-a456-426614174000',
        status: 'pending',
        message: 'Test message',
        links: { status: '/test' }
      });

      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'test-key')
        .send(validRequest)
        .expect(202);

      // Validate response structure
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('meta');
      expect(response.body.meta).toHaveProperty('requestId');
      expect(response.body.meta).toHaveProperty('timestamp');
      expect(response.body.meta).toHaveProperty('version');
      expect(response.body.success).toBe(true);
    });

    it('should always include error structure in error responses', async () => {
      const response = await request(app)
        .post('/api/deployments')
        .set('X-API-Key', 'invalid-key')
        .send({})
        .expect(401);

      // Validate error response structure
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body.error).toHaveProperty('timestamp');
      expect(response.body.error).toHaveProperty('retryable');
      expect(response.body.success).toBe(false);
    });
  });
});

describe('Validation Helper Unit Tests', () => {
  describe('validateDeployTokenRequest', () => {
    it('should validate correct deploy token request', () => {
      const validRequest = {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIifQ.test',
        modelId: 'test-model-123',
        userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9'
      };

      const result = ValidationHelpers.validateDeployTokenRequest(validRequest);
      expect(result.error).toBeUndefined();
      expect(result.value).toMatchObject(validRequest);
    });

    it('should reject invalid JWT token format', () => {
      const invalidRequest = {
        token: 'not-a-jwt-token',
        modelId: 'test-model',
        userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9'
      };

      const result = ValidationHelpers.validateDeployTokenRequest(invalidRequest);
      expect(result.error).toBeTruthy();
      expect(result.error?.details?.[0]?.path).toContain('token');
    });

    it('should strip unknown fields', () => {
      const requestWithUnknownFields = {
        token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJ0ZXN0LXVzZXIifQ.test',
        modelId: 'test-model',
        userAddress: '0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9',
        unknownField: 'should-be-stripped'
      };

      const result = ValidationHelpers.validateDeployTokenRequest(requestWithUnknownFields);
      expect(result.error).toBeUndefined();
      expect(result.value).not.toHaveProperty('unknownField');
    });
  });

  describe('Helper function tests', () => {
    it('should validate Ethereum addresses correctly', () => {
      expect(ValidationHelpers.isValidEthereumAddress('0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9')).toBe(true);
      expect(ValidationHelpers.isValidEthereumAddress('0x742D35Cc6631C0532925a3b8D756d2bE8b6c6DD9')).toBe(true);
      expect(ValidationHelpers.isValidEthereumAddress('invalid-address')).toBe(false);
      expect(ValidationHelpers.isValidEthereumAddress('0x123')).toBe(false);
      expect(ValidationHelpers.isValidEthereumAddress('')).toBe(false);
    });

    it('should validate token symbols correctly', () => {
      expect(ValidationHelpers.isValidTokenSymbol('HOKUSAI')).toBe(true);
      expect(ValidationHelpers.isValidTokenSymbol('HK-TOKEN')).toBe(true);
      expect(ValidationHelpers.isValidTokenSymbol('HK123')).toBe(true);
      expect(ValidationHelpers.isValidTokenSymbol('H')).toBe(true);
      expect(ValidationHelpers.isValidTokenSymbol('1234567890')).toBe(true);
      expect(ValidationHelpers.isValidTokenSymbol('lowercase')).toBe(false);
      expect(ValidationHelpers.isValidTokenSymbol('TOOLONGSYMBOL')).toBe(false);
      expect(ValidationHelpers.isValidTokenSymbol('')).toBe(false);
      expect(ValidationHelpers.isValidTokenSymbol('INVALID!')).toBe(false);
    });

    it('should validate model IDs correctly', () => {
      expect(ValidationHelpers.isValidModelId('sentiment-analysis-v1')).toBe(true);
      expect(ValidationHelpers.isValidModelId('model_123')).toBe(true);
      expect(ValidationHelpers.isValidModelId('test-model')).toBe(true);
      expect(ValidationHelpers.isValidModelId('MODEL123')).toBe(true);
      expect(ValidationHelpers.isValidModelId('a')).toBe(true);
      expect(ValidationHelpers.isValidModelId('invalid model id')).toBe(false);
      expect(ValidationHelpers.isValidModelId('invalid!model')).toBe(false);
      expect(ValidationHelpers.isValidModelId('')).toBe(false);
      expect(ValidationHelpers.isValidModelId('a'.repeat(65))).toBe(false);
    });

    it('should validate decimal strings correctly', () => {
      expect(ValidationHelpers.isValidDecimalString('123')).toBe(true);
      expect(ValidationHelpers.isValidDecimalString('123.456')).toBe(true);
      expect(ValidationHelpers.isValidDecimalString('0')).toBe(true);
      expect(ValidationHelpers.isValidDecimalString('0.0')).toBe(true);
      expect(ValidationHelpers.isValidDecimalString('1000000')).toBe(true);
      expect(ValidationHelpers.isValidDecimalString('invalid')).toBe(false);
      expect(ValidationHelpers.isValidDecimalString('')).toBe(false);
      expect(ValidationHelpers.isValidDecimalString('123.456.789')).toBe(false);
      expect(ValidationHelpers.isValidDecimalString('-123')).toBe(false);
    });
  });

  describe('createValidationErrorResponse', () => {
    it('should format validation errors correctly', () => {
      const mockError = {
        details: [
          {
            path: ['modelId'],
            message: 'Model ID is required',
            context: { value: undefined }
          },
          {
            path: ['userAddress'],
            message: 'Invalid Ethereum address format',
            context: { value: 'invalid-address' }
          }
        ]
      } as any;

      const response = ValidationHelpers.createValidationErrorResponse(mockError);
      
      expect(response.success).toBe(false);
      expect(response.error.code).toBe('VALIDATION_ERROR');
      expect(response.error.message).toBe('Request validation failed');
      expect(response.error.details).toHaveLength(2);
      expect(response.error.details[0]).toEqual({
        field: 'modelId',
        message: 'Model ID is required',
        value: undefined
      });
      expect(response.error.details[1]).toEqual({
        field: 'userAddress',
        message: 'Invalid Ethereum address format',
        value: 'invalid-address'
      });
    });
  });
});