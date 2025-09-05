import { SSMParameterStore, createSSMClient, loadSSMConfiguration } from '../../src/config/aws-ssm';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

// Mock the AWS SDK
jest.mock('@aws-sdk/client-ssm');

const mockSSMClient = {
  send: jest.fn(),
};

const MockedSSMClient = SSMClient as jest.MockedClass<typeof SSMClient>;

describe('SSMParameterStore', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    MockedSSMClient.mockImplementation(() => mockSSMClient as any);
  });

  describe('getParameter', () => {
    it('should successfully retrieve a parameter', async () => {
      const mockResponse = {
        Parameter: {
          Name: '/hokusai/development/contracts/deployer_key',
          Value: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
        },
      };

      mockSSMClient.send.mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.getParameter('deployer_key');
      
      expect(result).toBe('0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12');
      expect(mockSSMClient.send).toHaveBeenCalledWith(
        expect.any(GetParameterCommand)
      );
    });

    it('should throw error for missing required parameter', async () => {
      const mockError = { name: 'ParameterNotFound' };
      mockSSMClient.send.mockRejectedValueOnce(mockError);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      await expect(ssm.getParameter('missing_param', true))
        .rejects.toThrow('Required SSM parameter not found');
    });

    it('should return undefined for missing optional parameter', async () => {
      const mockError = { name: 'ParameterNotFound' };
      mockSSMClient.send.mockRejectedValueOnce(mockError);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.getParameter('optional_param', false);
      expect(result).toBeUndefined();
    });

    it('should retry on failure and eventually succeed', async () => {
      const mockError = new Error('Network error');
      const mockResponse = {
        Parameter: {
          Name: '/hokusai/development/contracts/deployer_key',
          Value: 'test-value',
        },
      };

      mockSSMClient.send
        .mockRejectedValueOnce(mockError)
        .mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
        retryConfig: {
          maxAttempts: 2,
          baseDelay: 10,
          maxDelay: 100,
        },
      });

      const result = await ssm.getParameter('deployer_key');
      expect(result).toBe('test-value');
      expect(mockSSMClient.send).toHaveBeenCalledTimes(2);
    });
  });

  describe('getParameters', () => {
    it('should successfully retrieve multiple parameters', async () => {
      const mockResponse = {
        Parameters: [
          {
            Name: '/hokusai/development/contracts/deployer_key',
            Value: 'deployer-key-value',
          },
          {
            Name: '/hokusai/development/contracts/token_manager_address',
            Value: '0x1234567890123456789012345678901234567890',
          },
        ],
        InvalidParameters: [],
      };

      mockSSMClient.send.mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.getParameters(['deployer_key', 'token_manager_address']);
      
      expect(result).toEqual({
        deployer_key: 'deployer-key-value',
        token_manager_address: '0x1234567890123456789012345678901234567890',
      });
    });

    it('should handle invalid parameters gracefully', async () => {
      const mockResponse = {
        Parameters: [
          {
            Name: '/hokusai/development/contracts/deployer_key',
            Value: 'deployer-key-value',
          },
        ],
        InvalidParameters: ['/hokusai/development/contracts/invalid_param'],
      };

      mockSSMClient.send.mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.getParameters(['deployer_key', 'invalid_param']);
      
      expect(result).toEqual({
        deployer_key: 'deployer-key-value',
      });
    });
  });

  describe('getAllParameters', () => {
    it('should retrieve all required and optional parameters', async () => {
      const mockResponse = {
        Parameters: [
          {
            Name: '/hokusai/development/contracts/deployer_key',
            Value: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
          },
          {
            Name: '/hokusai/development/contracts/token_manager_address',
            Value: '0x1234567890123456789012345678901234567890',
          },
          {
            Name: '/hokusai/development/contracts/model_registry_address',
            Value: '0x0987654321098765432109876543210987654321',
          },
          {
            Name: '/hokusai/development/contracts/rpc_endpoint',
            Value: 'https://ethereum-rpc.com',
          },
          {
            Name: '/hokusai/development/contracts/redis_url',
            Value: 'redis://localhost:6379',
          },
          {
            Name: '/hokusai/development/contracts/api_keys',
            Value: 'key1,key2,key3',
          },
          {
            Name: '/hokusai/development/contracts/jwt_secret',
            Value: 'jwt-secret-value',
          },
        ],
        InvalidParameters: [],
      };

      mockSSMClient.send.mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.getAllParameters();
      
      expect(result).toEqual({
        deployer_key: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
        token_manager_address: '0x1234567890123456789012345678901234567890',
        model_registry_address: '0x0987654321098765432109876543210987654321',
        rpc_endpoint: 'https://ethereum-rpc.com',
        redis_url: 'redis://localhost:6379',
        api_keys: 'key1,key2,key3',
        jwt_secret: 'jwt-secret-value',
        webhook_url: undefined,
        webhook_secret: undefined,
      });
    });

    it('should throw error when required parameters are missing', async () => {
      const mockResponse = {
        Parameters: [
          {
            Name: '/hokusai/development/contracts/deployer_key',
            Value: 'deployer-key-value',
          },
          // Missing other required parameters
        ],
        InvalidParameters: [],
      };

      mockSSMClient.send.mockResolvedValueOnce(mockResponse);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      await expect(ssm.getAllParameters())
        .rejects.toThrow('Missing required SSM parameters');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection is successful', async () => {
      const mockError = { name: 'ParameterNotFound' };
      mockSSMClient.send.mockRejectedValueOnce(mockError);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.testConnection();
      expect(result).toBe(true);
    });

    it('should return false when connection fails', async () => {
      const mockError = new Error('Network error');
      mockSSMClient.send.mockRejectedValueOnce(mockError);

      const ssm = new SSMParameterStore({
        pathPrefix: '/hokusai/development/contracts/',
      });

      const result = await ssm.testConnection();
      expect(result).toBe(false);
    });
  });
});

describe('loadSSMConfiguration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset environment variables
    delete process.env.NODE_ENV;
    delete process.env.USE_SSM;
    MockedSSMClient.mockImplementation(() => mockSSMClient as any);
  });

  it('should return null in development environment', async () => {
    process.env.NODE_ENV = 'development';
    process.env.USE_SSM = 'false';

    const result = await loadSSMConfiguration();
    expect(result).toBeNull();
  });

  it('should load configuration in production environment', async () => {
    process.env.NODE_ENV = 'production';

    const mockResponse = {
      Parameters: [
        {
          Name: '/hokusai/production/contracts/deployer_key',
          Value: 'prod-deployer-key',
        },
        {
          Name: '/hokusai/production/contracts/token_manager_address',
          Value: '0x1234567890123456789012345678901234567890',
        },
        {
          Name: '/hokusai/production/contracts/model_registry_address',
          Value: '0x0987654321098765432109876543210987654321',
        },
        {
          Name: '/hokusai/production/contracts/rpc_endpoint',
          Value: 'https://ethereum-prod-rpc.com',
        },
        {
          Name: '/hokusai/production/contracts/redis_url',
          Value: 'redis://prod-redis:6379',
        },
        {
          Name: '/hokusai/production/contracts/api_keys',
          Value: 'prod-key1,prod-key2',
        },
      ],
      InvalidParameters: [],
    };

    // Mock test connection (ParameterNotFound = success)
    mockSSMClient.send
      .mockRejectedValueOnce({ name: 'ParameterNotFound' })
      .mockResolvedValueOnce(mockResponse);

    const result = await loadSSMConfiguration();
    
    expect(result).toBeDefined();
    expect(result!.deployer_key).toBe('prod-deployer-key');
    expect(result!.rpc_endpoint).toBe('https://ethereum-prod-rpc.com');
  });

  it('should load configuration when USE_SSM is true', async () => {
    process.env.NODE_ENV = 'development';
    process.env.USE_SSM = 'true';

    const mockResponse = {
      Parameters: [
        {
          Name: '/hokusai/development/contracts/deployer_key',
          Value: 'dev-deployer-key',
        },
        {
          Name: '/hokusai/development/contracts/token_manager_address',
          Value: '0x1234567890123456789012345678901234567890',
        },
        {
          Name: '/hokusai/development/contracts/model_registry_address',
          Value: '0x0987654321098765432109876543210987654321',
        },
        {
          Name: '/hokusai/development/contracts/rpc_endpoint',
          Value: 'https://ethereum-dev-rpc.com',
        },
        {
          Name: '/hokusai/development/contracts/redis_url',
          Value: 'redis://dev-redis:6379',
        },
        {
          Name: '/hokusai/development/contracts/api_keys',
          Value: 'dev-key1,dev-key2',
        },
      ],
      InvalidParameters: [],
    };

    // Mock test connection and getAllParameters
    mockSSMClient.send
      .mockRejectedValueOnce({ name: 'ParameterNotFound' })
      .mockResolvedValueOnce(mockResponse);

    const result = await loadSSMConfiguration();
    
    expect(result).toBeDefined();
    expect(result!.deployer_key).toBe('dev-deployer-key');
  });
});

describe('createSSMClient', () => {
  it('should create SSMParameterStore with default configuration', () => {
    const client = createSSMClient();
    expect(client).toBeInstanceOf(SSMParameterStore);
  });

  it('should create SSMParameterStore with custom path prefix', () => {
    const client = createSSMClient('/custom/path/');
    expect(client).toBeInstanceOf(SSMParameterStore);
  });
});