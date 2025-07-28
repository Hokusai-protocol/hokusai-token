import Joi from 'joi';

// Ethereum address validation regex
const ETH_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
const ETH_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;
const TOKEN_SYMBOL_REGEX = /^[A-Z0-9\-]{1,10}$/;

export interface ModelReadyToDeployMessage {
  model_id: string;
  token_symbol: string;
  metric_name: string;
  baseline_value: number;
  current_value: number;
  model_name: string;
  model_version: string;
  mlflow_run_id: string;
  improvement_percentage: number;
  contributor_address?: string;
  experiment_name?: string;
  tags?: Record<string, string>;
  timestamp: string;
  message_version: string;
  _retryCount?: number;
}

export interface TokenDeployedMessage {
  event_type: 'token_deployed';
  model_id: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  transaction_hash: string;
  registry_transaction_hash: string;
  mlflow_run_id: string;
  model_name: string;
  model_version: string;
  deployment_timestamp: string;
  deployer_address: string;
  network: string;
  block_number: number;
  gas_used: string;
  gas_price: string;
  contributor_address?: string;
  performance_metric: string;
  performance_improvement: number;
  message_version: string;
  _metadata?: {
    correlationId?: string;
    source?: string;
    publishedAt?: string;
  };
}

// Joi validation schemas
const modelReadySchema = Joi.object<ModelReadyToDeployMessage>({
  model_id: Joi.string().required(),
  token_symbol: Joi.string().pattern(TOKEN_SYMBOL_REGEX).required(),
  metric_name: Joi.string().required(),
  baseline_value: Joi.number().positive().required(),
  current_value: Joi.number().positive().required(),
  model_name: Joi.string().required(),
  model_version: Joi.string().required(),
  mlflow_run_id: Joi.string().required(),
  improvement_percentage: Joi.number().greater(0).required(),
  contributor_address: Joi.string().pattern(ETH_ADDRESS_REGEX).optional(),
  experiment_name: Joi.string().optional(),
  tags: Joi.object().pattern(Joi.string(), Joi.string()).optional(),
  timestamp: Joi.string().isoDate().required(),
  message_version: Joi.string().valid('1.0').required(),
  _retryCount: Joi.number().integer().min(0).optional()
});

const tokenDeployedSchema = Joi.object<TokenDeployedMessage>({
  event_type: Joi.string().valid('token_deployed').required(),
  model_id: Joi.string().required(),
  token_address: Joi.string().pattern(ETH_ADDRESS_REGEX).required(),
  token_symbol: Joi.string().pattern(TOKEN_SYMBOL_REGEX).required(),
  token_name: Joi.string().required(),
  transaction_hash: Joi.string().pattern(ETH_HASH_REGEX).required(),
  registry_transaction_hash: Joi.string().pattern(ETH_HASH_REGEX).required(),
  mlflow_run_id: Joi.string().required(),
  model_name: Joi.string().required(),
  model_version: Joi.string().required(),
  deployment_timestamp: Joi.string().isoDate().required(),
  deployer_address: Joi.string().pattern(ETH_ADDRESS_REGEX).required(),
  network: Joi.string().valid('ethereum', 'polygon', 'localhost', 'hardhat').required(),
  block_number: Joi.number().integer().positive().required(),
  gas_used: Joi.string().pattern(/^\d+$/).required(),
  gas_price: Joi.string().pattern(/^\d+$/).required(),
  contributor_address: Joi.string().pattern(ETH_ADDRESS_REGEX).optional(),
  performance_metric: Joi.string().required(),
  performance_improvement: Joi.number().greater(0).required(),
  message_version: Joi.string().valid('1.0').required(),
  _metadata: Joi.object({
    correlationId: Joi.string().optional(),
    source: Joi.string().optional(),
    publishedAt: Joi.string().isoDate().optional()
  }).optional()
});

export function validateModelReadyToDeployMessage(message: unknown): Joi.ValidationResult<ModelReadyToDeployMessage> {
  return modelReadySchema.validate(message);
}

export function validateTokenDeployedMessage(message: unknown): Joi.ValidationResult<TokenDeployedMessage> {
  return tokenDeployedSchema.validate(message);
}

export interface DeploymentData {
  model_id: string;
  token_address: string;
  token_symbol: string;
  token_name: string;
  transaction_hash: string;
  registry_transaction_hash: string;
  mlflow_run_id: string;
  model_name: string;
  model_version: string;
  deployer_address: string;
  network: string;
  block_number: number;
  gas_used: string;
  gas_price: string;
  contributor_address?: string;
  performance_metric: string;
  performance_improvement: number;
}

export function createTokenDeployedMessage(data: DeploymentData): TokenDeployedMessage {
  return {
    event_type: 'token_deployed',
    model_id: data.model_id,
    token_address: data.token_address,
    token_symbol: data.token_symbol,
    token_name: data.token_name,
    transaction_hash: data.transaction_hash,
    registry_transaction_hash: data.registry_transaction_hash,
    mlflow_run_id: data.mlflow_run_id,
    model_name: data.model_name,
    model_version: data.model_version,
    deployment_timestamp: new Date().toISOString(),
    deployer_address: data.deployer_address,
    network: data.network,
    block_number: data.block_number,
    gas_used: data.gas_used,
    gas_price: data.gas_price,
    contributor_address: data.contributor_address,
    performance_metric: data.performance_metric,
    performance_improvement: data.performance_improvement,
    message_version: '1.0'
  };
}