import { ContractDeployListener } from '../../src/contract-deploy-listener';
import { RedisClientType } from 'redis';
import { ethers } from 'ethers';
import { ModelReadyToDeployMessage, TokenDeployedMessage } from '../../src/schemas/message-schemas';

describe('Contract Deploy Listener - Integration Tests', () => {
  let listener: ContractDeployListener;
  let redis: RedisClientType;
  let provider: ethers.Provider;
  
  const INBOUND_QUEUE = 'hokusai:model_ready_queue:test';
  const OUTBOUND_QUEUE = 'hokusai:token_deployed_queue:test';
  const PROCESSING_QUEUE = 'hokusai:processing_queue:test';
  const DLQ = 'hokusai:dlq:test';
  
  // This is an integration test that requires:
  // - Redis running locally
  // - A local blockchain (Hardhat node)
  // - Deployed contracts (ModelRegistry, TokenManager)
  
  beforeAll(async () => {
    // Skip if not in integration test environment
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.log('Skipping integration tests. Set RUN_INTEGRATION_TESTS=true to run.');
      return;
    }
    
    // Initialize Redis
    const { createClient } = await import('redis');
    redis = createClient({ url: 'redis://localhost:6379' });
    await redis.connect();
    
    // Clear test queues
    await redis.del([INBOUND_QUEUE, OUTBOUND_QUEUE, PROCESSING_QUEUE, DLQ]);
    
    // Initialize blockchain provider
    provider = new ethers.JsonRpcProvider('http://localhost:8545');
    
    // Initialize listener
    listener = new ContractDeployListener({
      redis: {
        url: 'redis://localhost:6379'
      },
      blockchain: {
        rpcUrls: ['http://localhost:8545'],
        privateKey: process.env.DEPLOYER_PRIVATE_KEY || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
        tokenManagerAddress: process.env.TOKEN_MANAGER_ADDRESS || '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        modelRegistryAddress: process.env.MODEL_REGISTRY_ADDRESS || '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        gasMultiplier: 1.2,
        maxGasPrice: '100000000000',
        confirmations: 1
      },
      queues: {
        inbound: INBOUND_QUEUE,
        outbound: OUTBOUND_QUEUE,
        processing: PROCESSING_QUEUE,
        deadLetter: DLQ
      }
    });
    
    await listener.initialize();
  });
  
  afterAll(async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) return;
    
    await listener?.stop();
    await redis?.quit();
  });
  
  test('should process model deployment end-to-end', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) {
      console.log('Skipping integration test');
      return;
    }
    
    const modelMessage: ModelReadyToDeployMessage = {
      model_id: `model_${Date.now()}`,
      token_symbol: `HKAI${Date.now()}`,
      metric_name: 'accuracy',
      baseline_value: 0.854,
      current_value: 0.884,
      model_name: 'test_classifier',
      model_version: '1.0.0',
      mlflow_run_id: 'run_test123',
      improvement_percentage: 3.51,
      timestamp: new Date().toISOString(),
      message_version: '1.0'
    };
    
    // Add message to queue
    await redis.lPush(INBOUND_QUEUE, JSON.stringify(modelMessage));
    
    // Start listener
    const processingPromise = listener.start();
    
    // Wait for message to be processed
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Check outbound queue for deployment message
    const deployedMessage = await redis.rPop(OUTBOUND_QUEUE);
    expect(deployedMessage).toBeTruthy();
    
    const tokenDeployed: TokenDeployedMessage = JSON.parse(deployedMessage!);
    expect(tokenDeployed.event_type).toBe('token_deployed');
    expect(tokenDeployed.model_id).toBe(modelMessage.model_id);
    expect(tokenDeployed.token_symbol).toBe(modelMessage.token_symbol);
    expect(tokenDeployed.token_address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(tokenDeployed.transaction_hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    expect(tokenDeployed.mlflow_run_id).toBe(modelMessage.mlflow_run_id);
    
    // Verify on blockchain
    const tokenContract = new ethers.Contract(
      tokenDeployed.token_address,
      ['function symbol() view returns (string)', 'function name() view returns (string)'],
      provider
    ) as ethers.Contract & {
      symbol(): Promise<string>;
      name(): Promise<string>;
    };
    
    const symbol = await tokenContract.symbol();
    const name = await tokenContract.name();
    
    expect(symbol).toBe(modelMessage.token_symbol);
    expect(name).toBe(`Hokusai ${modelMessage.model_id}`);
    
    // Stop listener
    listener.stop();
    await processingPromise;
  }, 30000);
  
  test('should handle invalid messages', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) return;
    
    const invalidMessage = {
      invalid: 'message',
      missing: 'required fields'
    };
    
    await redis.lPush(INBOUND_QUEUE, JSON.stringify(invalidMessage));
    
    const processingPromise = listener.start();
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Check DLQ
    const dlqMessage = await redis.rPop(DLQ);
    expect(dlqMessage).toBeTruthy();
    
    const dlqEntry = JSON.parse(dlqMessage!);
    expect(dlqEntry.originalMessage).toEqual(invalidMessage);
    expect(dlqEntry.error).toContain('validation');
    
    listener.stop();
    await processingPromise;
  });
  
  test('should handle deployment failures gracefully', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) return;
    
    const messageWithBadSymbol: ModelReadyToDeployMessage = {
      model_id: 'model_fail',
      token_symbol: '', // Invalid empty symbol
      metric_name: 'accuracy',
      baseline_value: 0.854,
      current_value: 0.884,
      model_name: 'test_classifier',
      model_version: '1.0.0',
      mlflow_run_id: 'run_fail',
      improvement_percentage: 3.51,
      timestamp: new Date().toISOString(),
      message_version: '1.0'
    };
    
    await redis.lPush(INBOUND_QUEUE, JSON.stringify(messageWithBadSymbol));
    
    const processingPromise = listener.start();
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Should eventually end up in DLQ after retries
    const dlqDepth = await redis.lLen(DLQ);
    expect(dlqDepth).toBeGreaterThan(0);
    
    listener.stop();
    await processingPromise;
  });
  
  test('should recover from Redis disconnection', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) return;
    
    const modelMessage: ModelReadyToDeployMessage = {
      model_id: `model_recovery_${Date.now()}`,
      token_symbol: `HKAIREC${Date.now()}`,
      metric_name: 'accuracy',
      baseline_value: 0.854,
      current_value: 0.884,
      model_name: 'test_classifier',
      model_version: '1.0.0',
      mlflow_run_id: 'run_recovery',
      improvement_percentage: 3.51,
      timestamp: new Date().toISOString(),
      message_version: '1.0'
    };
    
    await redis.lPush(INBOUND_QUEUE, JSON.stringify(modelMessage));
    
    const processingPromise = listener.start();
    
    // Simulate Redis disconnection
    await new Promise(resolve => setTimeout(resolve, 1000));
    await redis.quit();
    
    // Wait for reconnection
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Reconnect Redis
    await redis.connect();
    
    // Message should still be processed
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    const deployedMessage = await redis.rPop(OUTBOUND_QUEUE);
    expect(deployedMessage).toBeTruthy();
    
    listener.stop();
    await processingPromise;
  });
  
  test('should expose accurate health metrics', async () => {
    if (!process.env.RUN_INTEGRATION_TESTS) return;
    
    const health = await listener.getHealth();
    
    expect(health).toEqual({
      status: expect.stringMatching(/healthy|degraded/),
      components: {
        redis: expect.objectContaining({
          status: expect.any(String),
          queues: expect.objectContaining({
            inbound: expect.any(Number),
            processing: expect.any(Number),
            deadLetter: expect.any(Number),
            outbound: expect.any(Number)
          })
        }),
        blockchain: expect.objectContaining({
          status: expect.any(String),
          network: expect.any(String),
          blockNumber: expect.any(Number)
        })
      },
      metrics: expect.objectContaining({
        messagesProcessed: expect.any(Number),
        tokensDeployed: expect.any(Number)
      })
    });
  });
});