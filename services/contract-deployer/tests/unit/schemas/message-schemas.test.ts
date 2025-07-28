import { 
  ModelReadyToDeployMessage, 
  TokenDeployedMessage,
  validateModelReadyToDeployMessage,
  validateTokenDeployedMessage,
  createTokenDeployedMessage
} from '../../../src/schemas/message-schemas';

describe('Message Schemas', () => {
  describe('ModelReadyToDeployMessage Validation', () => {
    const validMessage: ModelReadyToDeployMessage = {
      model_id: 'model_123',
      token_symbol: 'HKAI-123',
      metric_name: 'accuracy',
      baseline_value: 0.854,
      current_value: 0.884,
      model_name: 'enhanced_classifier_v1',
      model_version: '1.1.0',
      mlflow_run_id: 'run_abc123',
      improvement_percentage: 3.51,
      contributor_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
      experiment_name: 'iris_classification',
      tags: { framework: 'tensorflow', dataset: 'iris' },
      timestamp: '2024-01-27T10:00:00.000Z',
      message_version: '1.0'
    };

    test('should validate a correct message', () => {
      const result = validateModelReadyToDeployMessage(validMessage);
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(validMessage);
    });

    test('should reject message without required fields', () => {
      const invalidMessage = {
        model_id: 'model_123',
        // missing token_symbol and other required fields
      };
      const result = validateModelReadyToDeployMessage(invalidMessage);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('token_symbol');
    });

    test('should reject message with invalid improvement percentage', () => {
      const invalidMessage = { ...validMessage, improvement_percentage: -1 };
      const result = validateModelReadyToDeployMessage(invalidMessage);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('improvement_percentage');
    });

    test('should reject message with invalid contributor address', () => {
      const invalidMessage = { ...validMessage, contributor_address: 'invalid_address' };
      const result = validateModelReadyToDeployMessage(invalidMessage);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('contributor_address');
    });

    test('should accept message without optional contributor address', () => {
      const messageWithoutAddress = { ...validMessage };
      delete messageWithoutAddress.contributor_address;
      const result = validateModelReadyToDeployMessage(messageWithoutAddress);
      expect(result.error).toBeUndefined();
    });

    test('should validate token symbol format', () => {
      const invalidSymbol = { ...validMessage, token_symbol: 'invalid symbol with spaces' };
      const result = validateModelReadyToDeployMessage(invalidSymbol);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('token_symbol');
    });

    test('should validate metric values are positive', () => {
      const negativeCurrent = { ...validMessage, current_value: -0.5 };
      const result = validateModelReadyToDeployMessage(negativeCurrent);
      expect(result.error).toBeDefined();
    });

    test('should validate timestamp format', () => {
      const invalidTimestamp = { ...validMessage, timestamp: 'invalid date' };
      const result = validateModelReadyToDeployMessage(invalidTimestamp);
      expect(result.error).toBeDefined();
    });

    test('should validate message version', () => {
      const invalidVersion = { ...validMessage, message_version: '2.0' };
      const result = validateModelReadyToDeployMessage(invalidVersion);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('version');
    });
  });

  describe('TokenDeployedMessage Validation', () => {
    const validMessage: TokenDeployedMessage = {
      event_type: 'token_deployed',
      model_id: 'model_123',
      token_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
      token_symbol: 'HKAI-123',
      token_name: 'Hokusai Model 123',
      transaction_hash: '0x7b1203ad2b29d6f24b07b46ec2f970eb37e1e9c8f2a3d4e5f6789012345678ab',
      registry_transaction_hash: '0x8c2314be3c30e7d35c18c57fd3f081fc48f2f0d9d3b4e5d67890123456789abcd',
      mlflow_run_id: 'run_abc123',
      model_name: 'enhanced_classifier_v1',
      model_version: '1.1.0',
      deployment_timestamp: '2024-01-27T10:01:30.000Z',
      deployer_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
      network: 'polygon',
      block_number: 12345678,
      gas_used: '2845632',
      gas_price: '35000000000',
      contributor_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
      performance_metric: 'accuracy',
      performance_improvement: 3.51,
      message_version: '1.0'
    };

    test('should validate a correct message', () => {
      const result = validateTokenDeployedMessage(validMessage);
      expect(result.error).toBeUndefined();
      expect(result.value).toEqual(validMessage);
    });

    test('should reject message with invalid event type', () => {
      const invalidMessage = { ...validMessage, event_type: 'wrong_type' };
      const result = validateTokenDeployedMessage(invalidMessage);
      expect(result.error).toBeDefined();
    });

    test('should validate ethereum addresses', () => {
      const invalidAddress = { ...validMessage, token_address: 'not_an_address' };
      const result = validateTokenDeployedMessage(invalidAddress);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('token_address');
    });

    test('should validate transaction hashes', () => {
      const invalidTxHash = { ...validMessage, transaction_hash: 'invalid' };
      const result = validateTokenDeployedMessage(invalidTxHash);
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain('transaction_hash');
    });

    test('should validate network values', () => {
      const invalidNetwork = { ...validMessage, network: 'invalid_network' };
      const result = validateTokenDeployedMessage(invalidNetwork);
      expect(result.error).toBeDefined();
    });

    test('should validate numeric string values', () => {
      const invalidGasUsed = { ...validMessage, gas_used: 'not_a_number' };
      const result = validateTokenDeployedMessage(invalidGasUsed);
      expect(result.error).toBeDefined();
    });
  });

  describe('createTokenDeployedMessage', () => {
    test('should create a valid TokenDeployedMessage from deployment data', () => {
      const deploymentData = {
        model_id: 'model_123',
        token_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        token_symbol: 'HKAI-123',
        token_name: 'Hokusai Model 123',
        transaction_hash: '0x7b1203ad2b29d6f24b07b46ec2f970eb37e1e9c8f2a3d4e5f6789012345678ab',
        registry_transaction_hash: '0x8c2314be3c30e7d35c18c57fd3f081fc48f2f0d9d3b4e5d67890123456789abcd',
        mlflow_run_id: 'run_abc123',
        model_name: 'enhanced_classifier_v1',
        model_version: '1.1.0',
        deployer_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        network: 'polygon',
        block_number: 12345678,
        gas_used: '2845632',
        gas_price: '35000000000',
        contributor_address: '0x742d35Cc6634C0532925a3b844Bc9e7595f82b3d',
        performance_metric: 'accuracy',
        performance_improvement: 3.51
      };

      const message = createTokenDeployedMessage(deploymentData);
      
      expect(message.event_type).toBe('token_deployed');
      expect(message.model_id).toBe(deploymentData.model_id);
      expect(message.token_address).toBe(deploymentData.token_address);
      expect(message.message_version).toBe('1.0');
      expect(message.deployment_timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test('should handle optional fields correctly', () => {
      const minimalData = {
        model_id: 'model_123',
        token_address: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        token_symbol: 'HKAI-123',
        token_name: 'Hokusai Model 123',
        transaction_hash: '0x7b1203ad2b29d6f24b07b46ec2f970eb37e1e9c8f2a3d4e5f6789012345678ab',
        registry_transaction_hash: '0x8c2314be3c30e7d35c18c57fd3f081fc48f2f0d9d3b4e5d67890123456789abcd',
        mlflow_run_id: 'run_abc123',
        model_name: 'enhanced_classifier_v1',
        model_version: '1.1.0',
        deployer_address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
        network: 'polygon',
        block_number: 12345678,
        gas_used: '2845632',
        gas_price: '35000000000',
        performance_metric: 'accuracy',
        performance_improvement: 3.51
      };

      const message = createTokenDeployedMessage(minimalData);
      expect(message.contributor_address).toBeUndefined();
    });
  });
});