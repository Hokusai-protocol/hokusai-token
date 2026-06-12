import Joi from 'joi';
import { createLogger } from '../utils/logger';
import { loadSSMConfiguration } from './aws-ssm';
import type { SSMParameters } from './aws-ssm';

const logger = createLogger('config');

// Environment variable schema
const envSchema = Joi.object({
  // Node environment
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),

  // Server configuration
  PORT: Joi.number().default(8002),

  // Redis configuration
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_URL: Joi.string().optional(),

  // Blockchain configuration
  RPC_URL: Joi.string().required(),
  CHAIN_ID: Joi.number().default(11155111),
  NETWORK_NAME: Joi.string().default('sepolia'),

  // Contract addresses
  MODEL_REGISTRY_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  TOKEN_MANAGER_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .required(),
  DELTA_VERIFIER_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  USAGE_FEE_ROUTER_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  // Deployment allocation params for deployTokenWithAllocations
  MODEL_SUPPLIER_ALLOCATION: Joi.string().default('2500000000000000000000000'),
  MODEL_SUPPLIER_RECIPIENT: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .default('0x0000000000000000000000000000000000000000'),
  INVESTOR_ALLOCATION: Joi.string().default('10000000000000000000000000'),
  TOKENS_PER_DELTA_ONE: Joi.string().default('5000000000000000000000'),
  INFRASTRUCTURE_ACCRUAL_BPS: Joi.number().integer().min(0).max(10000).default(8000),
  INITIAL_ORACLE_PRICE_PER_THOUSAND_USD: Joi.string().default('0'),
  LICENSE_HASH: Joi.string().default('0x' + '00'.repeat(32)),
  LICENSE_URI: Joi.string().default('').allow(''),
  GOVERNOR_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .default('0x0000000000000000000000000000000000000000'),

  // Deployer configuration
  DEPLOYER_PRIVATE_KEY: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{64}$/)
    .optional(),
  KMS_BACKEND_KEY_ID: Joi.string().optional(),
  KMS_BACKEND_EXPECTED_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),
  KMS_DEPLOYER_KEY_ID: Joi.string().optional(),
  KMS_DEPLOYER_EXPECTED_ADDRESS: Joi.string()
    .pattern(/^0x[a-fA-F0-9]{40}$/)
    .optional(),

  // Gas configuration
  GAS_PRICE_MULTIPLIER: Joi.number().min(1).max(5).default(1.2),
  MAX_GAS_PRICE_GWEI: Joi.number().default(500), // 500 Gwei
  DEFAULT_GAS_LIMIT: Joi.number().default(5000000),

  // Transaction configuration
  CONFIRMATION_BLOCKS: Joi.number().min(1).max(50).default(2),
  CONFIRMATION_TIMEOUT_MS: Joi.number().default(300000), // 5 minutes
  RETRY_DELAY_MS: Joi.number().integer().min(0).default(1000), // delay before retrying queue processing

  // Queue configuration
  QUEUE_NAME: Joi.string().default('contract-deployments'),
  QUEUE_PREFIX: Joi.string().default('hokusai'),
  MINT_REQUEST_QUEUE: Joi.string().default('hokusai:mint_requests'),
  MINT_REQUEST_PROCESSING_QUEUE: Joi.string().default('hokusai:mint_requests:processing'),
  MINT_REQUEST_DLQ: Joi.string().default('hokusai:mint_requests:dlq'),
  MINT_REQUEST_PROCESSED_SET: Joi.string().default('hokusai:mint_requests:processed'),
  MINT_REQUEST_SETTLEMENT_QUEUE: Joi.string().default('hokusai:mint_request_settlements'),
  MINT_REQUEST_MAX_RETRIES: Joi.number().integer().min(0).default(3),
  MINT_REQUEST_BUDGET_MAX_RETRIES: Joi.number().integer().min(0).default(24),
  MINT_REQUEST_RETRY_QUEUE: Joi.string().default('hokusai:mint_requests:retry'),
  MINT_BACKOFF_BASE_MS: Joi.number().integer().min(0).default(1000),
  MINT_BACKOFF_MAX_MS: Joi.number().integer().min(0).default(60000),
  MINT_BUDGET_BACKOFF_BASE_MS: Joi.number().integer().min(0).default(60000),
  MINT_BUDGET_BACKOFF_MAX_MS: Joi.number().integer().min(0).default(1800000),
  MINT_BACKOFF_MULTIPLIER: Joi.number().min(1).default(2),
  MINT_RECORD_KEY_PREFIX: Joi.string().default('hokusai:mint_record:'),
  MINT_RECORD_TTL_SECONDS: Joi.number().integer().min(1).default(2592000),

  // API configuration
  RATE_LIMIT_WINDOW_MS: Joi.number().default(900000), // 15 minutes
  RATE_LIMIT_MAX_REQUESTS: Joi.number().default(100),
  CORS_ORIGINS: Joi.string().default('*'),

  // Monitoring
  METRICS_ENABLED: Joi.alternatives()
    .try(Joi.boolean(), Joi.string().valid('true', 'false'))
    .default(false),
  METRICS_PORT: Joi.number().default(9091),

  // AWS configuration (optional)
  AWS_REGION: Joi.string().default('us-east-1'),
  AWS_ACCESS_KEY_ID: Joi.string().optional(),
  AWS_SECRET_ACCESS_KEY: Joi.string().optional(),
  USE_SSM: Joi.alternatives()
    .try(Joi.boolean(), Joi.string().valid('true', 'false'))
    .default(false),

  // Deployment environment (for SSM path resolution)
  DEPLOY_ENV: Joi.string().optional(),

  // Service identification
  SERVICE_NAME: Joi.string().default('contract-deployer'),

  // Health check configuration
  HEALTH_CHECK_INTERVAL: Joi.number().default(30000),
  HEALTH_CHECK_TIMEOUT: Joi.number().default(5000),

  // Feature flags
  ENABLE_AUTH: Joi.boolean().default(false),
  RATE_LIMIT_ENABLED: Joi.boolean().default(true),
  CORS_ENABLED: Joi.boolean().default(true),

  // Webhook configuration (optional)
  WEBHOOK_URL: Joi.string().uri().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),

  // API keys (comma-separated list)
  API_KEYS: Joi.string().optional(),

  // JWT configuration (optional)
  JWT_SECRET: Joi.string().optional(),
  JWT_EXPIRY: Joi.string().default('24h'),

  // Logging
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  LOG_FORMAT: Joi.string().valid('json', 'simple').default('json'),
}).unknown(true); // Allow additional environment variables

// Configuration interface
export interface Config {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_URL?: string;
  RPC_URL: string;
  CHAIN_ID: number;
  NETWORK_NAME: string;
  MODEL_REGISTRY_ADDRESS: string;
  TOKEN_MANAGER_ADDRESS: string;
  DELTA_VERIFIER_ADDRESS?: string;
  USAGE_FEE_ROUTER_ADDRESS?: string;
  MODEL_SUPPLIER_ALLOCATION: string;
  MODEL_SUPPLIER_RECIPIENT: string;
  INVESTOR_ALLOCATION: string;
  TOKENS_PER_DELTA_ONE: string;
  INFRASTRUCTURE_ACCRUAL_BPS: number;
  INITIAL_ORACLE_PRICE_PER_THOUSAND_USD: string;
  LICENSE_HASH: string;
  LICENSE_URI: string;
  GOVERNOR_ADDRESS: string;
  DEPLOYER_PRIVATE_KEY?: string;
  KMS_BACKEND_KEY_ID?: string;
  KMS_BACKEND_EXPECTED_ADDRESS?: string;
  KMS_DEPLOYER_KEY_ID?: string;
  KMS_DEPLOYER_EXPECTED_ADDRESS?: string;
  GAS_PRICE_MULTIPLIER: number;
  MAX_GAS_PRICE_GWEI: number;
  DEFAULT_GAS_LIMIT: number;
  CONFIRMATION_BLOCKS: number;
  CONFIRMATION_TIMEOUT_MS: number;
  RETRY_DELAY_MS: number;
  QUEUE_NAME: string;
  QUEUE_PREFIX: string;
  MINT_REQUEST_QUEUE: string;
  MINT_REQUEST_PROCESSING_QUEUE: string;
  MINT_REQUEST_DLQ: string;
  MINT_REQUEST_PROCESSED_SET: string;
  MINT_REQUEST_SETTLEMENT_QUEUE: string;
  MINT_REQUEST_MAX_RETRIES: number;
  MINT_REQUEST_BUDGET_MAX_RETRIES: number;
  MINT_REQUEST_RETRY_QUEUE: string;
  MINT_BACKOFF_BASE_MS: number;
  MINT_BACKOFF_MAX_MS: number;
  MINT_BUDGET_BACKOFF_BASE_MS: number;
  MINT_BUDGET_BACKOFF_MAX_MS: number;
  MINT_BACKOFF_MULTIPLIER: number;
  MINT_RECORD_KEY_PREFIX: string;
  MINT_RECORD_TTL_SECONDS: number;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  CORS_ORIGINS: string;
  METRICS_ENABLED: boolean;
  METRICS_PORT: number;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID?: string;
  AWS_SECRET_ACCESS_KEY?: string;
  USE_SSM: boolean;
  DEPLOY_ENV?: string;
  SERVICE_NAME: string;
  HEALTH_CHECK_INTERVAL: number;
  HEALTH_CHECK_TIMEOUT: number;
  ENABLE_AUTH: boolean;
  RATE_LIMIT_ENABLED: boolean;
  CORS_ENABLED: boolean;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  API_KEYS?: string;
  JWT_SECRET?: string;
  JWT_EXPIRY: string;
  LOG_LEVEL: 'error' | 'warn' | 'info' | 'debug';
  LOG_FORMAT: 'json' | 'simple';
}

/**
 * Parse Redis URL and extract host/port
 */
function parseRedisUrl(redisUrl: string): { REDIS_HOST: string; REDIS_PORT: string } {
  try {
    const url = new URL(redisUrl);
    return {
      REDIS_HOST: url.hostname,
      REDIS_PORT: url.port || '6379',
    };
  } catch (error) {
    logger.warn('Failed to parse Redis URL, using defaults');
    return {
      REDIS_HOST: 'localhost',
      REDIS_PORT: '6379',
    };
  }
}

/**
 * Map SSM parameters to environment variable names
 */
function mapSSMToEnvVars(ssmParams: SSMParameters): Record<string, string> {
  const mapping: Record<string, string> = {};

  if (ssmParams.redis_url) {
    mapping.REDIS_URL = ssmParams.redis_url;
  }
  if (ssmParams.rpc_endpoint) {
    mapping.RPC_URL = ssmParams.rpc_endpoint;
  }
  if (ssmParams.model_registry_address) {
    mapping.MODEL_REGISTRY_ADDRESS = ssmParams.model_registry_address;
  }
  if (ssmParams.token_manager_address) {
    mapping.TOKEN_MANAGER_ADDRESS = ssmParams.token_manager_address;
  }
  if (ssmParams.deployer_key && !process.env.KMS_BACKEND_KEY_ID) {
    mapping.DEPLOYER_PRIVATE_KEY = ssmParams.deployer_key;
  }
  if (ssmParams.api_keys) {
    mapping.API_KEYS = ssmParams.api_keys;
  }
  if (ssmParams.jwt_secret) {
    mapping.JWT_SECRET = ssmParams.jwt_secret;
  }
  if (ssmParams.webhook_url) {
    mapping.WEBHOOK_URL = ssmParams.webhook_url;
  }
  if (ssmParams.webhook_secret) {
    mapping.WEBHOOK_SECRET = ssmParams.webhook_secret;
  }
  if (ssmParams.usage_fee_router_address) {
    mapping.USAGE_FEE_ROUTER_ADDRESS = ssmParams.usage_fee_router_address;
  }
  if (ssmParams.model_supplier_allocation) {
    mapping.MODEL_SUPPLIER_ALLOCATION = ssmParams.model_supplier_allocation;
  }
  if (ssmParams.model_supplier_recipient) {
    mapping.MODEL_SUPPLIER_RECIPIENT = ssmParams.model_supplier_recipient;
  }
  if (ssmParams.investor_allocation) {
    mapping.INVESTOR_ALLOCATION = ssmParams.investor_allocation;
  }
  if (ssmParams.tokens_per_delta_one) {
    mapping.TOKENS_PER_DELTA_ONE = ssmParams.tokens_per_delta_one;
  }
  if (ssmParams.infrastructure_accrual_bps) {
    mapping.INFRASTRUCTURE_ACCRUAL_BPS = ssmParams.infrastructure_accrual_bps;
  }
  if (ssmParams.initial_oracle_price_per_thousand_usd) {
    mapping.INITIAL_ORACLE_PRICE_PER_THOUSAND_USD = ssmParams.initial_oracle_price_per_thousand_usd;
  }
  if (ssmParams.license_hash) {
    mapping.LICENSE_HASH = ssmParams.license_hash;
  }
  if (ssmParams.license_uri !== undefined) {
    mapping.LICENSE_URI = ssmParams.license_uri;
  }
  if (ssmParams.governor_address) {
    mapping.GOVERNOR_ADDRESS = ssmParams.governor_address;
  }

  // Map any additional parameters
  const additionalParams = Object.entries(ssmParams).filter(
    ([key]) =>
      ![
        'redis_url',
        'rpc_endpoint',
        'model_registry_address',
        'token_manager_address',
        'deployer_key',
        'api_keys',
        'jwt_secret',
        'webhook_url',
        'webhook_secret',
        'usage_fee_router_address',
        'model_supplier_allocation',
        'model_supplier_recipient',
        'investor_allocation',
        'tokens_per_delta_one',
        'infrastructure_accrual_bps',
        'initial_oracle_price_per_thousand_usd',
        'license_hash',
        'license_uri',
        'governor_address',
      ].includes(key),
  );

  for (const [key, value] of additionalParams) {
    // Convert snake_case to UPPER_SNAKE_CASE
    const envKey = key.toUpperCase();
    if (value !== undefined) {
      mapping[envKey] = value;
    }
  }

  return mapping;
}

function enforceSignerConfiguration(
  config: Config,
  sources: { envPrivateKey: boolean; ssmPrivateKey: boolean },
): void {
  const hasKmsBackend = Boolean(config.KMS_BACKEND_KEY_ID);
  const hasExpectedAddress = Boolean(config.KMS_BACKEND_EXPECTED_ADDRESS);
  const hasRawPrivateKey = Boolean(config.DEPLOYER_PRIVATE_KEY);

  if (config.NODE_ENV === 'production') {
    if (!hasKmsBackend) {
      throw new Error('KMS_BACKEND_KEY_ID is required when NODE_ENV=production');
    }
    if (!hasExpectedAddress) {
      throw new Error(
        'KMS_BACKEND_EXPECTED_ADDRESS is required when NODE_ENV=production and KMS_BACKEND_KEY_ID is set',
      );
    }
  }

  if (hasKmsBackend && (sources.envPrivateKey || sources.ssmPrivateKey || hasRawPrivateKey)) {
    const conflictingSources: string[] = ['KMS_BACKEND_KEY_ID'];
    if (sources.envPrivateKey) {
      conflictingSources.push('DEPLOYER_PRIVATE_KEY');
    }
    if (sources.ssmPrivateKey) {
      conflictingSources.push('SSM deployer_key');
    }

    throw new Error(`Signer configuration is mutually exclusive: ${conflictingSources.join(', ')}`);
  }

  if (hasKmsBackend !== hasExpectedAddress) {
    throw new Error(
      'KMS_BACKEND_KEY_ID and KMS_BACKEND_EXPECTED_ADDRESS must be set together',
    );
  }

  if (!hasKmsBackend && !hasRawPrivateKey) {
    throw new Error(
      'Missing required signer configuration: set KMS_BACKEND_KEY_ID or DEPLOYER_PRIVATE_KEY',
    );
  }
}

/**
 * Validate environment variables, optionally loading from SSM Parameter Store
 */
export async function validateEnv(): Promise<Config> {
  console.log('[STARTUP] validateEnv() called');

  // First validate the basic environment schema
  console.log('[STARTUP] Validating basic environment schema...');
  const { error, value } = envSchema.validate(process.env, {
    abortEarly: false,
  });

  if (error) {
    console.error('[STARTUP] Environment validation error:', error.message);
    throw new Error(`Environment validation error: ${error.message}`);
  }

  console.log('[STARTUP] Basic environment validation passed');
  let config = value as Config;
  const envPrivateKeySet = Boolean(process.env.DEPLOYER_PRIVATE_KEY);
  let ssmDeployerKeySet = false;

  // Try to load from SSM Parameter Store
  console.log('[STARTUP] Loading SSM configuration...');
  try {
    const ssmParams = await loadSSMConfiguration();
    console.log('[STARTUP] SSM configuration loaded:', ssmParams ? 'success' : 'no params');

    if (ssmParams) {
      ssmDeployerKeySet = Boolean(ssmParams.deployer_key);
      // Map SSM parameters to environment variables
      const envOverrides = mapSSMToEnvVars(ssmParams);

      // Apply overrides
      const mergedEnv = { ...process.env, ...envOverrides };

      // Parse Redis URL if provided
      if (ssmParams.redis_url) {
        const redisConfig = parseRedisUrl(ssmParams.redis_url);
        Object.assign(mergedEnv, redisConfig);
      }

      // Re-validate with SSM parameters
      const { error: ssmError, value: ssmValue } = envSchema.validate(mergedEnv, {
        abortEarly: false,
      });

      if (ssmError) {
        throw new Error(`SSM configuration validation error: ${ssmError.message}`);
      }

      config = ssmValue as Config;
      logger.info('Successfully loaded and validated SSM configuration');
    }
  } catch (error) {
    logger.error('Failed to load SSM configuration:', error);

    // In production, SSM failure should be fatal
    if (config.NODE_ENV === 'production') {
      throw new Error(
        `SSM configuration required in production: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }

    // In development, warn but continue
    logger.warn('Continuing with environment variables (SSM load failed)');
  }

  // Final validation for required fields
  const requiredFields = ['RPC_URL', 'MODEL_REGISTRY_ADDRESS', 'TOKEN_MANAGER_ADDRESS'];

  const missingFields = requiredFields.filter((field) => !config[field as keyof Config]);

  if (missingFields.length > 0) {
    throw new Error(`Missing required configuration fields: ${missingFields.join(', ')}`);
  }

  enforceSignerConfiguration(config, {
    envPrivateKey: envPrivateKeySet,
    ssmPrivateKey: ssmDeployerKeySet,
  });

  // In production, deployment addresses must be non-zero — DeployableTokenManager rejects
  // zero supplier recipient and governor at the contract level.
  if (config.NODE_ENV === 'production') {
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    const zeroAddressFields: string[] = [];
    if (config.MODEL_SUPPLIER_RECIPIENT === ZERO_ADDRESS) {
      zeroAddressFields.push('MODEL_SUPPLIER_RECIPIENT');
    }
    if (config.GOVERNOR_ADDRESS === ZERO_ADDRESS) {
      zeroAddressFields.push('GOVERNOR_ADDRESS');
    }
    if (zeroAddressFields.length > 0) {
      throw new Error(
        `Deployment params must not be zero address in production: ${zeroAddressFields.join(', ')}`,
      );
    }
  }

  // Convert string booleans
  if (typeof config.USE_SSM === 'string') {
    config.USE_SSM = config.USE_SSM === 'true';
  }
  if (typeof config.METRICS_ENABLED === 'string') {
    config.METRICS_ENABLED = config.METRICS_ENABLED === 'true';
  }

  logger.debug('Environment validation completed successfully');
  return config;
}

/**
 * Synchronous version of validateEnv for backwards compatibility
 * Will throw if SSM loading is required but fails
 */
export function validateEnvSync(): Config {
  const { error, value } = envSchema.validate(process.env, {
    abortEarly: false,
  });

  if (error) {
    throw new Error(`Environment validation error: ${error.message}`);
  }

  const config = value as Config;

  // Convert string booleans
  if (typeof config.USE_SSM === 'string') {
    config.USE_SSM = config.USE_SSM === 'true';
  }
  if (typeof config.METRICS_ENABLED === 'string') {
    config.METRICS_ENABLED = config.METRICS_ENABLED === 'true';
  }

  // Note: This sync version cannot load from SSM
  if (config.NODE_ENV === 'production' && config.USE_SSM) {
    logger.warn('SSM loading requested but not available in sync mode');
  }

  enforceSignerConfiguration(config, {
    envPrivateKey: Boolean(process.env.DEPLOYER_PRIVATE_KEY),
    ssmPrivateKey: false,
  });

  return config;
}
