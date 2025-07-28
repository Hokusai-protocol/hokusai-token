import Joi from 'joi';

const envSchema = Joi.object({
  // Application
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  PORT: Joi.number().port().default(3001),
  LOG_LEVEL: Joi.string().valid('error', 'warn', 'info', 'debug').default('info'),

  // Blockchain
  RPC_URL: Joi.string().uri().required(),
  CHAIN_ID: Joi.number().integer().positive().required(),
  NETWORK_NAME: Joi.string().required(),

  // Contracts
  MODEL_REGISTRY_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),
  TOKEN_MANAGER_ADDRESS: Joi.string().pattern(/^0x[a-fA-F0-9]{40}$/).required(),

  // Private Keys
  DEPLOYER_PRIVATE_KEY: Joi.string().pattern(/^0x[a-fA-F0-9]{64}$/).required(),

  // Redis
  REDIS_HOST: Joi.string().hostname().default('localhost'),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').default(''),
  REDIS_DB: Joi.number().integer().min(0).default(0),
  REDIS_KEY_PREFIX: Joi.string().default('hokusai:deployer:'),

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

  // API
  API_KEY: Joi.string().optional(),
  RATE_LIMIT_WINDOW_MS: Joi.number().integer().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().positive().default(100),

  // Deployment
  CONFIRMATION_BLOCKS: Joi.number().integer().min(1).default(3),
  DEPLOYMENT_TIMEOUT_MS: Joi.number().integer().positive().default(300000),

  // External Services
  WEBHOOK_URL: Joi.string().uri().optional(),
  WEBHOOK_SECRET: Joi.string().optional(),
})
  .unknown()
  .required();

export interface Config {
  NODE_ENV: string;
  PORT: number;
  LOG_LEVEL: string;
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
  QUEUE_NAME: string;
  MAX_RETRIES: number;
  RETRY_DELAY_MS: number;
  GAS_PRICE_MULTIPLIER: number;
  MAX_GAS_PRICE_GWEI: number;
  GAS_LIMIT_MULTIPLIER: number;
  HEALTH_CHECK_INTERVAL_MS: number;
  METRICS_ENABLED: boolean;
  API_KEY?: string;
  RATE_LIMIT_WINDOW_MS: number;
  RATE_LIMIT_MAX_REQUESTS: number;
  CONFIRMATION_BLOCKS: number;
  DEPLOYMENT_TIMEOUT_MS: number;
  WEBHOOK_URL?: string;
  WEBHOOK_SECRET?: string;
}

export function validateEnv(): Config {
  const { error, value } = envSchema.validate(process.env, {
    abortEarly: false,
  });

  if (error) {
    throw new Error(`Environment validation error: ${error.message}`);
  }

  return value as Config;
}