import Joi from 'joi';
import { loadSSMConfiguration, SSMParameters } from './aws-ssm';
import { createLogger } from '../utils/logger';

const logger = createLogger('env-validation');

// Schema for environment variables loaded from .env files
const envSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(8002),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),
  
  // AWS/SSM Configuration
  USE_SSM: Joi.string().valid('true', 'false').default('false'),
  AWS_REGION: Joi.string().default('us-east-1'),
  DEPLOY_ENV: Joi.string().optional(),

  // Blockchain - these can be overridden by SSM
  RPC_URL: Joi.string().uri().optional(),
  CHAIN_ID: Joi.number().integer().positive().default(1),
  NETWORK_NAME: Joi.string().default('mainnet'),

  // Contracts - these can be overridden by SSM
  MODEL_REGISTRY_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).optional(),
  TOKEN_MANAGER_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).optional(),

  // Private Keys - these can be overridden by SSM
  DEPLOYER_PRIVATE_KEY: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).optional(),

  // Redis - these can be overridden by SSM
  REDIS_HOST: Joi.string().hostname().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  REDIS_KEY_PREFIX: Joi.string().default('hokusai:deployer:'),
  REDIS_URL: Joi.string().optional(), // Can be provided via SSM

  // Queue
  QUEUE_NAME: Joi.string().default('contract-deployments'),
  MAX_RETRIES: Joi.number().integer().min(0).default(3),
  RETRY_DELAY_MS: Joi.number().integer().positive().default(5000),

  // Gas
  GAS_PRICE_MULTIPLIER: Joi.number().positive().default(1.2),
  MAX_GAS_PRICE_GWEI: Joi.number().positive().default(100),
  GAS_LIMIT_MULTIPLIER: Joi.number().positive().default(1.5),

  // Monitoring
  HEALTH_CHECK_INTERVAL_MS: Joi.number().integer().positive().default(30000),
  METRICS_ENABLED: Joi.boolean().default(true),

  // API - these can be overridden by SSM
  API_KEY: Joi.string().optional(),
  VALID_API_KEYS: Joi.string().optional(), // Can be provided via SSM
  JWT_SECRET: Joi.string().optional(), // Can be provided via SSM
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().positive().default(100),

  // Deployment
  CONFIRMATION_BLOCKS: Joi.number().integer().min(1).default(3),
  DEPLOYMENT_TIMEOUT_MS: Joi.number().integer().positive().default(300000),

  // External Services - these can be overridden by SSM
  WEBHOOK_URL: Joi.string().uri().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),
  
  // CORS Configuration
  ALLOWED_ORIGINS: Joi.string().optional(),
})
  .unknown()
  .required();

export interface Config {
  NODE_ENV: string;
  PORT: number;
  LOG_LEVEL: string;
  USE_SSM: boolean;
  AWS_REGION: string;
  DEPLOY_ENV?: string;
  RPC_URL: string;
  CHAIN_ID: number;
  NETWORK_NAME: string;
  MODEL_REGISTRY_ADDRESS: string;
  TOKEN_MANAGER_ADDRESS: string;
  DEPLOYER_PRIVATE_KEY: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD: string;
  REDIS_DB: number;
  REDIS_KEY_PREFIX: string;
  REDIS_URL?: string;
  QUEUE_NAME: string;
  MAX_RETRIES: number;
  RETRY_DELAY_MS: number;
  GAS_PRICE_MULTIPLIER: number;
  MAX_GAS_PRICE_GWEI: number;
  GAS_LIMIT_MULTIPLIER: number;
  HEALTH_CHECK_INTERVAL_MS: number;
  METRICS_ENABLED: boolean;
  API_KEY?: string;
  VALID_API_KEYS?: string;
  JWT_SECRET?: string;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  CONFIRMATION_BLOCKS: number;
  DEPLOYMENT_TIMEOUT_MS: number;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
  ALLOWED_ORIGINS?: string;
}

/**
 * Maps SSM parameters to environment variable names
 */
function mapSSMToEnvVars(ssmParams: SSMParameters): Record<string, string> {
  const envMap: Record<string, string> = {};
  
  // Required parameters
  envMap.DEPLOYER_PRIVATE_KEY = ssmParams.deployer_key;
  envMap.TOKEN_MANAGER_ADDRESS = ssmParams.token_manager_address;
  envMap.MODEL_REGISTRY_ADDRESS = ssmParams.model_registry_address;
  envMap.RPC_URL = ssmParams.rpc_endpoint;
  envMap.REDIS_URL = ssmParams.redis_url;
  envMap.VALID_API_KEYS = ssmParams.api_keys;
  
  // Optional parameters
  if (ssmParams.jwt_secret) {
    envMap.JWT_SECRET = ssmParams.jwt_secret;
  }
  if (ssmParams.webhook_url) {
    envMap.WEBHOOK_URL = ssmParams.webhook_url;
  }
  if (ssmParams.webhook_secret) {
    envMap.WEBHOOK_SECRET = ssmParams.webhook_secret;
  }
  
  return envMap;
}

/**
 * Parse Redis URL to extract host, port, password, etc.
 */
function parseRedisUrl(redisUrl: string): Partial<Config> {
  try {
    const url = new URL(redisUrl);
    const config: Partial<Config> = {
      REDIS_HOST: url.hostname,
      REDIS_PORT: parseInt(url.port) || 6379,
    };
    
    if (url.password) {
      config.REDIS_PASSWORD = url.password;
    }
    
    // Extract database number from pathname (e.g., /0, /1)
    if (url.pathname && url.pathname !== '/') {
      const dbNum = parseInt(url.pathname.substring(1));
      if (!isNaN(dbNum)) {
        config.REDIS_DB = dbNum;
      }
    }
    
    return config;
  } catch (error) {
    logger.warn(`Failed to parse Redis URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return {};
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

  // Try to load from SSM Parameter Store
  console.log('[STARTUP] Loading SSM configuration...');
  try {
    const ssmParams = await loadSSMConfiguration();
    console.log('[STARTUP] SSM configuration loaded:', ssmParams ? 'success' : 'no params');
    
    if (ssmParams) {
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
      throw new Error(`SSM configuration required in production: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
    
    // In development, warn but continue
    logger.warn('Continuing with environment variables (SSM load failed)');
  }

  // Final validation for required fields
  const requiredFields = [
    'RPC_URL',
    'MODEL_REGISTRY_ADDRESS', 
    'TOKEN_MANAGER_ADDRESS',
    'DEPLOYER_PRIVATE_KEY'
  ];

  const missingFields = requiredFields.filter(field => !config[field as keyof Config]);
  
  if (missingFields.length > 0) {
    throw new Error(`Missing required configuration fields: ${missingFields.join(', ')}`);
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

  // Warn if SSM should be used but can't be loaded synchronously
  if (config.USE_SSM || config.NODE_ENV === 'production') {
    logger.warn('SSM configuration required but validateEnvSync() called. Use validateEnv() for SSM support.');
  }

  return config;
}