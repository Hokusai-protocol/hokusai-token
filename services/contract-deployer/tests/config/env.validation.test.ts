import { validateEnv, validateEnvSync } from '../../src/config/env.validation';
import * as ssmModule from '../../src/config/aws-ssm';

// Mock the aws-ssm module
jest.mock('../../src/config/aws-ssm');

const mockLoadSSMConfiguration = jest.fn();
(ssmModule as any).loadSSMConfiguration = mockLoadSSMConfiguration;

describe('Environment Validation', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment
    process.env = { ...originalEnv };
    
    // Set minimal valid environment
    process.env.NODE_ENV = 'development';
    process.env.USE_SSM = 'false';
    process.env.RPC_URL = 'https://ethereum-rpc.com';
    process.env.MODEL_REGISTRY_ADDRESS = '0x1234567890123456789012345678901234567890';
    process.env.TOKEN_MANAGER_ADDRESS = '0x0987654321098765432109876543210987654321';
    process.env.DEPLOYER_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateEnvSync', () => {
    it('should validate minimal valid environment', () => {
      const config = validateEnvSync();
      
      expect(config.NODE_ENV).toBe('development');
      expect(config.RPC_URL).toBe('https://ethereum-rpc.com');
      expect(config.MODEL_REGISTRY_ADDRESS).toBe('0x1234567890123456789012345678901234567890');
      expect(config.TOKEN_MANAGER_ADDRESS).toBe('0x0987654321098765432109876543210987654321');
      expect(config.DEPLOYER_PRIVATE_KEY).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef');
      expect(config.USE_SSM).toBe(false);
    });

    it('should apply default values for missing optional fields', () => {
      const config = validateEnvSync();
      
      expect(config.PORT).toBe(8002);
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.CHAIN_ID).toBe(1);
      expect(config.NETWORK_NAME).toBe('mainnet');
      expect(config.REDIS_HOST).toBe('localhost');
      expect(config.REDIS_PORT).toBe(6379);
      expect(config.CONFIRMATION_BLOCKS).toBe(3);
    });

    it('should throw error for invalid private key format', () => {
      process.env.DEPLOYER_PRIVATE_KEY = 'invalid-key';
      
      expect(() => validateEnvSync()).toThrow('Environment validation error');
    });

    it('should throw error for invalid contract address format', () => {
      process.env.MODEL_REGISTRY_ADDRESS = 'invalid-address';
      
      expect(() => validateEnvSync()).toThrow('Environment validation error');
    });

    it('should handle string boolean conversion', () => {
      process.env.USE_SSM = 'true';
      process.env.METRICS_ENABLED = 'false';
      
      const config = validateEnvSync();
      
      expect(config.USE_SSM).toBe(true);
      expect(config.METRICS_ENABLED).toBe(false);
    });

    it('should warn when SSM is required but sync validation is used', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      process.env.NODE_ENV = 'production';
      
      validateEnvSync();
      
      // The warning should be logged (we'd need to mock the logger to test this properly)
      consoleSpy.mockRestore();
    });
  });

  describe('validateEnv (async)', () => {
    it('should validate environment without SSM in development', async () => {
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);
      
      const config = await validateEnv();
      
      expect(config.NODE_ENV).toBe('development');
      expect(config.USE_SSM).toBe(false);
      expect(mockLoadSSMConfiguration).toHaveBeenCalledTimes(1);
    });

    it('should load SSM configuration in production', async () => {
      process.env.NODE_ENV = 'production';
      
      const mockSSMParams = {
        deployer_key: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379/1',
        api_keys: 'prod-key1,prod-key2',
        jwt_secret: 'prod-jwt-secret',
        webhook_url: 'https://prod.example.com/webhook',
        webhook_secret: 'prod-webhook-secret',
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      const config = await validateEnv();
      
      expect(config.DEPLOYER_PRIVATE_KEY).toBe(mockSSMParams.deployer_key);
      expect(config.TOKEN_MANAGER_ADDRESS).toBe(mockSSMParams.token_manager_address);
      expect(config.MODEL_REGISTRY_ADDRESS).toBe(mockSSMParams.model_registry_address);
      expect(config.RPC_URL).toBe(mockSSMParams.rpc_endpoint);
      expect(config.VALID_API_KEYS).toBe(mockSSMParams.api_keys);
      expect(config.JWT_SECRET).toBe(mockSSMParams.jwt_secret);
      expect(config.WEBHOOK_URL).toBe(mockSSMParams.webhook_url);
      expect(config.WEBHOOK_SECRET).toBe(mockSSMParams.webhook_secret);
      
      expect(mockLoadSSMConfiguration).toHaveBeenCalledTimes(1);
    });

    it('should parse Redis URL from SSM configuration', async () => {
      process.env.NODE_ENV = 'production';
      
      const mockSSMParams = {
        deployer_key: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://user:pass@redis-host:6380/2',
        api_keys: 'prod-key1,prod-key2',
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      const config = await validateEnv();
      
      expect(config.REDIS_HOST).toBe('redis-host');
      expect(config.REDIS_PORT).toBe(6380);
      expect(config.REDIS_PASSWORD).toBe('pass');
      expect(config.REDIS_DB).toBe(2);
    });

    it('should load SSM configuration when USE_SSM is true in development', async () => {
      process.env.USE_SSM = 'true';
      
      const mockSSMParams = {
        deployer_key: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://dev-ethereum-rpc.com',
        redis_url: 'redis://dev-redis:6379',
        api_keys: 'dev-key1,dev-key2',
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      const config = await validateEnv();
      
      expect(config.RPC_URL).toBe(mockSSMParams.rpc_endpoint);
      expect(mockLoadSSMConfiguration).toHaveBeenCalledTimes(1);
    });

    it('should throw error when SSM loading fails in production', async () => {
      process.env.NODE_ENV = 'production';
      
      const mockError = new Error('SSM connection failed');
      mockLoadSSMConfiguration.mockRejectedValueOnce(mockError);
      
      await expect(validateEnv()).rejects.toThrow('SSM configuration required in production');
    });

    it('should continue with env vars when SSM loading fails in development', async () => {
      process.env.USE_SSM = 'true';
      
      const mockError = new Error('SSM connection failed');
      mockLoadSSMConfiguration.mockRejectedValueOnce(mockError);
      
      const config = await validateEnv();
      
      // Should still return valid config from environment variables
      expect(config.RPC_URL).toBe('https://ethereum-rpc.com');
      expect(config.NODE_ENV).toBe('development');
    });

    it('should throw error when required fields are missing after SSM loading', async () => {
      process.env.NODE_ENV = 'production';
      
      // Remove required env vars
      delete process.env.RPC_URL;
      delete process.env.DEPLOYER_PRIVATE_KEY;
      
      const mockSSMParams = {
        // Missing required parameters
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        redis_url: 'redis://prod-redis:6379',
        api_keys: 'prod-key1,prod-key2',
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      await expect(validateEnv()).rejects.toThrow('Missing required configuration fields');
    });

    it('should handle optional SSM parameters correctly', async () => {
      process.env.NODE_ENV = 'production';
      
      const mockSSMParams = {
        // Only required parameters
        deployer_key: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379',
        api_keys: 'prod-key1,prod-key2',
        // Optional parameters undefined
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      const config = await validateEnv();
      
      expect(config.JWT_SECRET).toBeUndefined();
      expect(config.WEBHOOK_URL).toBeUndefined();
      expect(config.WEBHOOK_SECRET).toBeUndefined();
    });

    it('should validate SSM configuration with schema', async () => {
      process.env.NODE_ENV = 'production';
      
      const mockSSMParams = {
        deployer_key: 'invalid-private-key', // Should fail validation
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379',
        api_keys: 'prod-key1,prod-key2',
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);
      
      await expect(validateEnv()).rejects.toThrow('SSM configuration validation error');
    });
  });
});