import { validateEnv, validateEnvSync } from '../../src/config/env.validation';
import * as ssmModule from '../../src/config/aws-ssm';

// Mock the aws-ssm module
jest.mock('../../src/config/aws-ssm');

const mockLoadSSMConfiguration = jest.fn();
(ssmModule as any).loadSSMConfiguration = mockLoadSSMConfiguration;

const VALID_ADDRESS_1 = '0x1234567890123456789012345678901234567890';
const VALID_ADDRESS_2 = '0x0987654321098765432109876543210987654321';
const VALID_PRIVATE_KEY = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const NONZERO_SUPPLIER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NONZERO_GOVERNOR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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
    process.env.MODEL_REGISTRY_ADDRESS = VALID_ADDRESS_1;
    process.env.TOKEN_MANAGER_ADDRESS = VALID_ADDRESS_2;
    process.env.DEPLOYER_PRIVATE_KEY = VALID_PRIVATE_KEY;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('validateEnvSync', () => {
    it('should validate minimal valid environment', () => {
      const config = validateEnvSync();

      expect(config.NODE_ENV).toBe('development');
      expect(config.RPC_URL).toBe('https://ethereum-rpc.com');
      expect(config.MODEL_REGISTRY_ADDRESS).toBe(VALID_ADDRESS_1);
      expect(config.TOKEN_MANAGER_ADDRESS).toBe(VALID_ADDRESS_2);
      expect(config.DEPLOYER_PRIVATE_KEY).toBe(VALID_PRIVATE_KEY);
      expect(config.USE_SSM).toBe(false);
    });

    it('should apply default values for missing optional fields', () => {
      const config = validateEnvSync();

      expect(config.PORT).toBe(8002);
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.CHAIN_ID).toBe(11155111);
      expect(config.NETWORK_NAME).toBe('sepolia');
      expect(config.REDIS_HOST).toBe('localhost');
      expect(config.REDIS_PORT).toBe(6379);
      expect(config.CONFIRMATION_BLOCKS).toBe(2);
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
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;

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
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;

      const mockSSMParams = {
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379/1',
        api_keys: 'prod-key1,prod-key2',
        jwt_secret: 'prod-jwt-secret',
        webhook_url: 'https://prod.example.com/webhook',
        webhook_secret: 'prod-webhook-secret',
        model_supplier_recipient: NONZERO_SUPPLIER,
        governor_address: NONZERO_GOVERNOR,
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);

      const config = await validateEnv();

      expect(config.TOKEN_MANAGER_ADDRESS).toBe(mockSSMParams.token_manager_address);
      expect(config.MODEL_REGISTRY_ADDRESS).toBe(mockSSMParams.model_registry_address);
      expect(config.RPC_URL).toBe(mockSSMParams.rpc_endpoint);
      expect(config.API_KEYS).toBe(mockSSMParams.api_keys);
      expect(config.JWT_SECRET).toBe(mockSSMParams.jwt_secret);
      expect(config.WEBHOOK_URL).toBe(mockSSMParams.webhook_url);
      expect(config.WEBHOOK_SECRET).toBe(mockSSMParams.webhook_secret);

      expect(mockLoadSSMConfiguration).toHaveBeenCalledTimes(1);
    });

    it('should parse Redis URL from SSM configuration', async () => {
      process.env.NODE_ENV = 'production';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;

      const mockSSMParams = {
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://user:pass@redis-host:6380/2',
        api_keys: 'prod-key1,prod-key2',
        model_supplier_recipient: NONZERO_SUPPLIER,
        governor_address: NONZERO_GOVERNOR,
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);

      const config = await validateEnv();

      expect(config.REDIS_HOST).toBe('redis-host');
      expect(config.REDIS_PORT).toBe(6380);
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
      // Remove required env vars before the initial validation runs
      delete process.env.RPC_URL;
      delete process.env.DEPLOYER_PRIVATE_KEY;

      // Initial schema validation fires before SSM is attempted
      await expect(validateEnv()).rejects.toThrow('Environment validation error');
    });

    it('should handle optional SSM parameters correctly', async () => {
      process.env.NODE_ENV = 'production';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;

      const mockSSMParams = {
        // Only required parameters + non-zero deployment addresses
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379',
        api_keys: 'prod-key1,prod-key2',
        model_supplier_recipient: NONZERO_SUPPLIER,
        governor_address: NONZERO_GOVERNOR,
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

    it('should load deployment params from SSM and override defaults', async () => {
      process.env.NODE_ENV = 'production';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;

      const mockSSMParams = {
        token_manager_address: '0x2234567890123456789012345678901234567890',
        model_registry_address: '0x3334567890123456789012345678901234567890',
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        redis_url: 'redis://prod-redis:6379',
        api_keys: 'prod-key1',
        model_supplier_recipient: NONZERO_SUPPLIER,
        investor_allocation: '5000000000000000000000000',
        model_supplier_allocation: '1000000000000000000000000',
        tokens_per_delta_one: '2500000000000000000000',
        infrastructure_accrual_bps: '7500',
        initial_oracle_price_per_thousand_usd: '1000000',
        license_hash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
        license_uri: 'ipfs://Qm123',
        governor_address: NONZERO_GOVERNOR,
      };

      mockLoadSSMConfiguration.mockResolvedValueOnce(mockSSMParams);

      const config = await validateEnv();

      expect(config.MODEL_SUPPLIER_RECIPIENT).toBe(NONZERO_SUPPLIER);
      expect(config.INVESTOR_ALLOCATION).toBe(mockSSMParams.investor_allocation);
      expect(config.GOVERNOR_ADDRESS).toBe(NONZERO_GOVERNOR);
      expect(config.INFRASTRUCTURE_ACCRUAL_BPS).toBe(7500);
    });

    it('boots with zero MODEL_SUPPLIER_RECIPIENT (per-model; validated at deploy time)', async () => {
      // MODEL_SUPPLIER_RECIPIENT is per-model (the launcher wallet on the deploy
      // message), not a global startup requirement — startup warns, deploy validates.
      process.env.NODE_ENV = 'production';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      delete process.env.MODEL_SUPPLIER_RECIPIENT; // Joi default (zero)
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      await expect(validateEnv()).resolves.toBeDefined();
    });

    it('boots with zero GOVERNOR_ADDRESS (validated at deploy time)', async () => {
      process.env.NODE_ENV = 'production';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      delete process.env.GOVERNOR_ADDRESS; // Joi default (zero)
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      await expect(validateEnv()).resolves.toBeDefined();
    });

    it('requires KMS backend configuration in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      delete process.env.KMS_BACKEND_KEY_ID;
      delete process.env.KMS_BACKEND_EXPECTED_ADDRESS;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      await expect(validateEnv()).rejects.toThrow('KMS_BACKEND_KEY_ID is required');
    });

    it('requires the expected KMS backend address pin in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      delete process.env.KMS_BACKEND_EXPECTED_ADDRESS;
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      await expect(validateEnv()).rejects.toThrow('KMS_BACKEND_EXPECTED_ADDRESS is required');
    });

    it('rejects KMS plus raw private key in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      await expect(validateEnv()).rejects.toThrow(
        'Signer configuration is mutually exclusive: KMS_BACKEND_KEY_ID, DEPLOYER_PRIVATE_KEY',
      );
    });

    it('allows KMS with a legacy SSM deployer_key (KMS takes precedence)', async () => {
      // The legacy SSM deployer_key is retained during the KMS migration but is not
      // an active signer once KMS is configured — its presence must not block boot.
      process.env.NODE_ENV = 'production';
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce({
        deployer_key: VALID_PRIVATE_KEY,
        token_manager_address: VALID_ADDRESS_2,
        model_registry_address: VALID_ADDRESS_1,
        rpc_endpoint: 'https://prod-ethereum-rpc.com',
        model_supplier_recipient: NONZERO_SUPPLIER,
        governor_address: NONZERO_GOVERNOR,
      });

      const config = await validateEnv();
      // KMS backend wins; the legacy SSM deployer_key is not mapped as a signer.
      expect(config.KMS_BACKEND_KEY_ID).toBe('alias/hokusai/backend');
      expect(config.DEPLOYER_PRIVATE_KEY).toBeUndefined();
    });

    it('allows KMS-only configuration in production', async () => {
      process.env.NODE_ENV = 'production';
      process.env.MODEL_SUPPLIER_RECIPIENT = NONZERO_SUPPLIER;
      process.env.GOVERNOR_ADDRESS = NONZERO_GOVERNOR;
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      const config = await validateEnv();
      expect(config.KMS_BACKEND_KEY_ID).toBe('alias/hokusai/backend');
      expect(config.KMS_BACKEND_EXPECTED_ADDRESS).toBe(VALID_ADDRESS_1);
    });

    it('allows KMS-only configuration in development', async () => {
      process.env.NODE_ENV = 'development';
      process.env.KMS_BACKEND_KEY_ID = 'alias/hokusai/backend';
      process.env.KMS_BACKEND_EXPECTED_ADDRESS = VALID_ADDRESS_1;
      delete process.env.DEPLOYER_PRIVATE_KEY;
      mockLoadSSMConfiguration.mockResolvedValueOnce(null);

      const config = await validateEnv();
      expect(config.KMS_BACKEND_KEY_ID).toBe('alias/hokusai/backend');
    });
  });
});
