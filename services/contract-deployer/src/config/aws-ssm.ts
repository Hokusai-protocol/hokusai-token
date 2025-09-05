import { SSMClient, GetParametersCommand, GetParameterCommand } from '@aws-sdk/client-ssm';
import { createLogger } from '../utils/logger';

const logger = createLogger('aws-ssm');

export interface SSMConfig {
  region?: string;
  pathPrefix: string;
  retryConfig?: {
    maxAttempts: number;
    baseDelay: number;
    maxDelay: number;
  };
}

export interface SSMParameters {
  // Required parameters
  deployer_key: string;
  token_manager_address: string;
  model_registry_address: string;
  rpc_endpoint: string;
  redis_url: string;
  api_keys: string;
  
  // Optional parameters
  jwt_secret?: string;
  webhook_url?: string;
  webhook_secret?: string;
}

export class SSMParameterStore {
  private client: SSMClient;
  private config: SSMConfig;
  
  constructor(config: SSMConfig) {
    this.config = config;
    this.client = new SSMClient({
      region: config.region || process.env.AWS_REGION || 'us-east-1',
      // Enable AWS SDK retry with exponential backoff
      maxAttempts: config.retryConfig?.maxAttempts || 3,
    });
  }

  /**
   * Retrieve a single parameter from SSM Parameter Store with retry logic
   */
  async getParameter(name: string, isRequired = true): Promise<string | undefined> {
    const fullPath = `${this.config.pathPrefix}${name}`;
    
    const maxAttempts = this.config.retryConfig?.maxAttempts || 3;
    const baseDelay = this.config.retryConfig?.baseDelay || 1000;
    const maxDelay = this.config.retryConfig?.maxDelay || 10000;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.debug(`Fetching SSM parameter: ${fullPath} (attempt ${attempt}/${maxAttempts})`);
        
        const command = new GetParameterCommand({
          Name: fullPath,
          WithDecryption: true, // Always decrypt secure strings
        });
        
        const response = await this.client.send(command);
        
        if (response.Parameter?.Value) {
          logger.debug(`Successfully retrieved parameter: ${fullPath}`);
          return response.Parameter.Value;
        }
        
        if (isRequired) {
          throw new Error(`Parameter ${fullPath} exists but has no value`);
        }
        
        logger.debug(`Optional parameter ${fullPath} not found or empty`);
        return undefined;
        
      } catch (error: any) {
        const isLastAttempt = attempt === maxAttempts;
        
        if (error.name === 'ParameterNotFound') {
          if (isRequired) {
            throw new Error(`Required SSM parameter not found: ${fullPath}`);
          }
          logger.debug(`Optional parameter not found: ${fullPath}`);
          return undefined;
        }
        
        if (isLastAttempt) {
          logger.error(`Failed to retrieve SSM parameter ${fullPath} after ${maxAttempts} attempts:`, error);
          throw new Error(`Failed to retrieve SSM parameter ${fullPath}: ${error.message}`);
        }
        
        // Exponential backoff with jitter
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = Math.random() * 0.1 * delay;
        const totalDelay = delay + jitter;
        
        logger.warn(`Failed to retrieve SSM parameter ${fullPath} (attempt ${attempt}/${maxAttempts}), retrying in ${totalDelay.toFixed(0)}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }
    
    throw new Error(`Exhausted all retry attempts for parameter: ${fullPath}`);
  }

  /**
   * Retrieve multiple parameters efficiently using batch operation
   */
  async getParameters(names: string[]): Promise<Record<string, string | undefined>> {
    const fullPaths = names.map(name => `${this.config.pathPrefix}${name}`);
    
    const maxAttempts = this.config.retryConfig?.maxAttempts || 3;
    const baseDelay = this.config.retryConfig?.baseDelay || 1000;
    const maxDelay = this.config.retryConfig?.maxDelay || 10000;
    
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        logger.debug(`Fetching ${fullPaths.length} SSM parameters (attempt ${attempt}/${maxAttempts})`);
        
        // SSM GetParameters has a limit of 10 parameters per request
        const batchSize = 10;
        const results: Record<string, string | undefined> = {};
        
        for (let i = 0; i < fullPaths.length; i += batchSize) {
          const batch = fullPaths.slice(i, i + batchSize);
          
          const command = new GetParametersCommand({
            Names: batch,
            WithDecryption: true,
          });
          
          const response = await this.client.send(command);
          
          // Process successful parameters
          if (response.Parameters) {
            for (const param of response.Parameters) {
              if (param.Name && param.Value) {
                // Remove the path prefix to get the original name
                const originalName = param.Name.replace(this.config.pathPrefix, '');
                results[originalName] = param.Value;
              }
            }
          }
          
          // Log invalid parameters
          if (response.InvalidParameters && response.InvalidParameters.length > 0) {
            logger.warn(`Invalid SSM parameters found: ${response.InvalidParameters.join(', ')}`);
          }
        }
        
        logger.debug(`Successfully retrieved ${Object.keys(results).length} SSM parameters`);
        return results;
        
      } catch (error: any) {
        const isLastAttempt = attempt === maxAttempts;
        
        if (isLastAttempt) {
          logger.error(`Failed to retrieve SSM parameters after ${maxAttempts} attempts:`, error);
          throw new Error(`Failed to retrieve SSM parameters: ${error.message}`);
        }
        
        // Exponential backoff with jitter
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
        const jitter = Math.random() * 0.1 * delay;
        const totalDelay = delay + jitter;
        
        logger.warn(`Failed to retrieve SSM parameters (attempt ${attempt}/${maxAttempts}), retrying in ${totalDelay.toFixed(0)}ms:`, error.message);
        await new Promise(resolve => setTimeout(resolve, totalDelay));
      }
    }
    
    throw new Error('Exhausted all retry attempts for parameters batch');
  }

  /**
   * Retrieve all required parameters for the Contract Deployer service
   */
  async getAllParameters(): Promise<SSMParameters> {
    const requiredParams = [
      'deployer_key',
      'token_manager_address',
      'model_registry_address',
      'rpc_endpoint',
      'redis_url',
      'api_keys'
    ];
    
    const optionalParams = [
      'jwt_secret',
      'webhook_url',
      'webhook_secret'
    ];
    
    const allParams = [...requiredParams, ...optionalParams];
    
    logger.info(`Fetching ${allParams.length} SSM parameters from ${this.config.pathPrefix}`);
    
    try {
      const results = await this.getParameters(allParams);
      
      // Validate required parameters
      const missingRequired: string[] = [];
      for (const param of requiredParams) {
        if (!results[param]) {
          missingRequired.push(`${this.config.pathPrefix}${param}`);
        }
      }
      
      if (missingRequired.length > 0) {
        throw new Error(`Missing required SSM parameters: ${missingRequired.join(', ')}`);
      }
      
      // Log successful retrieval
      const retrievedCount = Object.keys(results).filter(key => results[key]).length;
      logger.info(`Successfully retrieved ${retrievedCount}/${allParams.length} SSM parameters`);
      
      // Return typed parameters object
      return {
        deployer_key: results.deployer_key!,
        token_manager_address: results.token_manager_address!,
        model_registry_address: results.model_registry_address!,
        rpc_endpoint: results.rpc_endpoint!,
        redis_url: results.redis_url!,
        api_keys: results.api_keys!,
        jwt_secret: results.jwt_secret,
        webhook_url: results.webhook_url,
        webhook_secret: results.webhook_secret,
      };
      
    } catch (error) {
      logger.error('Failed to retrieve SSM parameters:', error);
      throw error;
    }
  }

  /**
   * Test connection to SSM Parameter Store
   */
  async testConnection(): Promise<boolean> {
    try {
      // Try to list parameters with the configured prefix (limit to 1 for testing)
      const command = new GetParametersCommand({
        Names: [`${this.config.pathPrefix}test`],
        WithDecryption: false,
      });
      
      await this.client.send(command);
      logger.debug('SSM connection test successful');
      return true;
      
    } catch (error: any) {
      if (error.name === 'ParameterNotFound') {
        // This is expected - it means we can connect to SSM
        logger.debug('SSM connection test successful (parameter not found is expected)');
        return true;
      }
      
      logger.error('SSM connection test failed:', error);
      return false;
    }
  }
}

/**
 * Create an SSM Parameter Store client with default configuration
 */
export function createSSMClient(pathPrefix = '/hokusai/development/contracts/'): SSMParameterStore {
  return new SSMParameterStore({
    pathPrefix,
    retryConfig: {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
    },
  });
}

/**
 * Load configuration from SSM Parameter Store if running in production
 */
export async function loadSSMConfiguration(): Promise<SSMParameters | null> {
  const nodeEnv = process.env.NODE_ENV || 'development';
  
  // Only load from SSM in production or if explicitly requested
  if (nodeEnv !== 'production' && process.env.USE_SSM !== 'true') {
    logger.debug('Not loading from SSM (NODE_ENV is not production and USE_SSM is not true)');
    return null;
  }
  
  // Determine the SSM path prefix based on environment
  const environment = process.env.DEPLOY_ENV || nodeEnv;
  const pathPrefix = `/hokusai/${environment}/contracts/`;
  
  logger.info(`Loading configuration from SSM Parameter Store (path: ${pathPrefix})`);
  
  const ssmClient = createSSMClient(pathPrefix);
  
  try {
    // Test connection first
    const connected = await ssmClient.testConnection();
    if (!connected) {
      throw new Error('Failed to connect to SSM Parameter Store');
    }
    
    // Load all parameters
    const parameters = await ssmClient.getAllParameters();
    
    logger.info('Successfully loaded configuration from SSM Parameter Store');
    return parameters;
    
  } catch (error) {
    logger.error('Failed to load configuration from SSM Parameter Store:', error);
    throw error;
  }
}