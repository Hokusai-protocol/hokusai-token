/**
 * Example: Using the Contract Deployer Service with AWS SSM Parameter Store
 * 
 * This example demonstrates how to configure and use the service with 
 * AWS SSM Parameter Store for secure configuration management in production.
 */

import { createSSMClient, loadSSMConfiguration } from '../config/aws-ssm';
import { validateEnv } from '../config/env.validation';

/**
 * Example 1: Direct SSM Parameter Store usage
 */
async function directSSMUsage() {
  console.log('=== Direct SSM Usage Example ===');
  
  try {
    // Create SSM client with custom path
    const ssmClient = createSSMClient('/hokusai/development/contracts/');
    
    // Test connection
    const connected = await ssmClient.testConnection();
    console.log('SSM Connection:', connected ? 'Success' : 'Failed');
    
    // Get a single parameter
    const deployerKey = await ssmClient.getParameter('deployer_key');
    console.log('Deployer Key Length:', deployerKey?.length);
    
    // Get multiple parameters
    const params = await ssmClient.getParameters([
      'token_manager_address',
      'model_registry_address',
      'rpc_endpoint'
    ]);
    console.log('Retrieved Parameters:', Object.keys(params));
    
    // Get all parameters
    const allParams = await ssmClient.getAllParameters();
    console.log('All Parameters:', {
      required: [
        'deployer_key',
        'token_manager_address', 
        'model_registry_address',
        'rpc_endpoint',
        'redis_url',
        'api_keys'
      ].every(key => allParams[key as keyof typeof allParams]),
      optional: {
        jwt_secret: !!allParams.jwt_secret,
        webhook_url: !!allParams.webhook_url,
        webhook_secret: !!allParams.webhook_secret
      }
    });
    
  } catch (error) {
    console.error('Direct SSM Usage Error:', error);
  }
}

/**
 * Example 2: Configuration loading with SSM integration
 */
async function configurationLoadingExample() {
  console.log('\n=== Configuration Loading Example ===');
  
  try {
    // Load SSM configuration directly
    const ssmConfig = await loadSSMConfiguration();
    
    if (ssmConfig) {
      console.log('SSM Configuration Loaded:', {
        hasDeployerKey: !!ssmConfig.deployer_key,
        rpcEndpoint: ssmConfig.rpc_endpoint,
        redisUrl: ssmConfig.redis_url?.includes('redis://'),
        apiKeysCount: ssmConfig.api_keys.split(',').length
      });
    } else {
      console.log('SSM Configuration: Not loaded (development mode)');
    }
    
    // Load full environment configuration (includes SSM if enabled)
    const config = await validateEnv();
    console.log('Full Configuration:', {
      nodeEnv: config.NODE_ENV,
      useSSM: config.USE_SSM,
      port: config.PORT,
      hasPrivateKey: !!config.DEPLOYER_PRIVATE_KEY,
      redisConfig: {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        url: config.REDIS_URL
      }
    });
    
  } catch (error) {
    console.error('Configuration Loading Error:', error);
  }
}

/**
 * Example 3: Production deployment scenario
 */
async function productionDeploymentExample() {
  console.log('\n=== Production Deployment Example ===');
  
  // Simulate production environment
  const originalEnv = process.env;
  process.env = {
    ...process.env,
    NODE_ENV: 'production',
    AWS_REGION: 'us-east-1',
    DEPLOY_ENV: 'production'
  };
  
  try {
    console.log('Environment:', {
      NODE_ENV: process.env.NODE_ENV,
      AWS_REGION: process.env.AWS_REGION,
      DEPLOY_ENV: process.env.DEPLOY_ENV
    });
    
    // In production, configuration will be automatically loaded from SSM
    const config = await validateEnv();
    
    console.log('Production Config Loaded:', {
      success: true,
      source: config.USE_SSM ? 'SSM' : 'Environment Variables',
      hasAllRequiredFields: !![
        config.DEPLOYER_PRIVATE_KEY,
        config.TOKEN_MANAGER_ADDRESS,
        config.MODEL_REGISTRY_ADDRESS,
        config.RPC_URL
      ].every(Boolean)
    });
    
  } catch (error) {
    console.log('Production Config Error:', error.message);
    console.log('This is expected if SSM parameters are not set up');
  } finally {
    // Restore original environment
    process.env = originalEnv;
  }
}

/**
 * Example 4: Error handling and retry demonstration
 */
async function errorHandlingExample() {
  console.log('\n=== Error Handling Example ===');
  
  try {
    // Create SSM client with retry configuration
    const ssmClient = createSSMClient('/hokusai/nonexistent/path/');
    
    // This should demonstrate retry logic
    await ssmClient.getAllParameters();
    
  } catch (error) {
    console.log('Expected Error for Non-existent Path:', error.message);
    console.log('The service includes automatic retry with exponential backoff');
  }
  
  // Demonstrate different error scenarios
  const scenarios = [
    {
      name: 'Missing Required Parameter',
      test: async () => {
        const client = createSSMClient('/test/missing/');
        return await client.getParameter('required_param', true);
      }
    },
    {
      name: 'Optional Parameter Not Found',
      test: async () => {
        const client = createSSMClient('/test/missing/');
        return await client.getParameter('optional_param', false);
      }
    },
    {
      name: 'Network Connection Error',
      test: async () => {
        // This would test network error handling in a real scenario
        console.log('Network error handling would be tested here');
        return null;
      }
    }
  ];
  
  for (const scenario of scenarios) {
    try {
      const result = await scenario.test();
      console.log(`${scenario.name}: Success -`, result);
    } catch (error) {
      console.log(`${scenario.name}: Error -`, error.message);
    }
  }
}

/**
 * Main example runner
 */
async function main() {
  console.log('AWS SSM Parameter Store Integration Examples');
  console.log('==========================================\n');
  
  // Only run if we're in a suitable environment
  if (process.env.NODE_ENV === 'test') {
    console.log('Skipping SSM examples in test environment');
    return;
  }
  
  await directSSMUsage();
  await configurationLoadingExample();
  await productionDeploymentExample();
  await errorHandlingExample();
  
  console.log('\n=== Examples Complete ===');
  console.log('To use SSM in production:');
  console.log('1. Set NODE_ENV=production');
  console.log('2. Configure AWS credentials');
  console.log('3. Create SSM parameters in AWS Console or CLI');
  console.log('4. Start the service - it will automatically load from SSM');
}

// Run examples if this file is executed directly
if (require.main === module) {
  main().catch(console.error);
}

export {
  directSSMUsage,
  configurationLoadingExample,
  productionDeploymentExample,
  errorHandlingExample
};