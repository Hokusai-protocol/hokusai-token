# Contract Deployer Service

Service for listening to contract deployment requests from a Redis queue and deploying Hokusai token contracts on Ethereum.

## Overview

This service:
- Listens to a Redis queue for deployment requests
- Validates incoming requests
- Deploys new HokusaiToken contracts using a factory pattern
- Registers deployed contracts with the ModelRegistry
- Handles retries and error cases
- Provides health checks and monitoring endpoints

## Setup

### Prerequisites

- Node.js >= 18.0.0
- Redis server
- Ethereum RPC endpoint (e.g., Infura)
- Private key with ETH for gas fees

### Installation

```bash
npm install
```

### Configuration

The service supports two configuration methods:

#### 1. Environment Variables (Development)

Copy `.env.example` to `.env` and configure the required parameters:

```bash
cp .env.example .env
```

Key configuration parameters:
- `REDIS_URL`: Redis connection URL
- `RPC_URL`: Ethereum RPC endpoint
- `DEPLOYER_PRIVATE_KEY`: Deployer wallet private key
- `TOKEN_MANAGER_ADDRESS`: Address of the TokenManager contract
- `MODEL_REGISTRY_ADDRESS`: Address of the ModelRegistry contract
- `VALID_API_KEYS`: Comma-separated list of valid API keys

#### 2. AWS SSM Parameter Store (Production)

For production deployments, the service automatically loads configuration from AWS SSM Parameter Store. Set the following environment variables:

```bash
NODE_ENV=production
AWS_REGION=us-east-1
DEPLOY_ENV=production  # optional, defaults to NODE_ENV
```

Or enable SSM in development:
```bash
USE_SSM=true
```

**Required SSM Parameters:**
- `/hokusai/{environment}/contracts/deployer_key` - Private key for contract deployment
- `/hokusai/{environment}/contracts/token_manager_address` - TokenManager contract address
- `/hokusai/{environment}/contracts/model_registry_address` - ModelRegistry contract address
- `/hokusai/{environment}/contracts/rpc_endpoint` - Ethereum RPC URL
- `/hokusai/{environment}/contracts/redis_url` - Redis connection URL
- `/hokusai/{environment}/contracts/api_keys` - Comma-separated API keys

**Optional SSM Parameters:**
- `/hokusai/{environment}/contracts/jwt_secret` - JWT signing secret
- `/hokusai/{environment}/contracts/webhook_url` - Webhook notification URL
- `/hokusai/{environment}/contracts/webhook_secret` - Webhook signing secret

The service includes automatic retry logic and error handling for SSM parameter retrieval.

### Development

```bash
# Run in development mode with hot reload
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Lint code
npm run lint

# Format code
npm run format
```

### Production

```bash
# Build the project
npm run build

# Start the service
npm start
```

## Architecture

### Directory Structure

```
src/
├── config/          # Configuration management
├── services/        # Core business logic
├── utils/           # Utility functions
├── middleware/      # Express middleware
├── types/           # TypeScript type definitions
└── index.ts         # Application entry point
```

### Core Components

- **QueueListener**: Polls Redis queue for deployment requests
- **ContractDeployer**: Handles the actual contract deployment
- **HealthChecker**: Monitors service health
- **Server**: Express server for API endpoints

## API Endpoints

### Health Check
```
GET /health
```

### Metrics (if enabled)
```
GET /metrics
```

### Deploy Contract (Manual)
```
POST /api/deploy
Authorization: Bearer <API_KEY>
Content-Type: application/json

{
  "modelId": "model-123",
  "name": "Model Token",
  "symbol": "MDL",
  "initialSupply": "1000000000000000000000"
}
```

## Queue Message Format

The service expects messages in the Redis queue to have the following format:

```json
{
  "modelId": "unique-model-id",
  "name": "Token Name",
  "symbol": "TKN",
  "initialSupply": "1000000000000000000000",
  "metadata": {
    "description": "Optional description",
    "additionalData": {}
  }
}
```

## Error Handling

The service implements robust error handling:
- Automatic retries with exponential backoff
- Dead letter queue for failed deployments
- Comprehensive logging
- Graceful shutdown on errors

## Monitoring

The service provides:
- Health check endpoint
- Prometheus metrics (optional)
- Structured logging with Winston
- Error tracking

## Security

- API key authentication for manual deployments
- Rate limiting on API endpoints
- Input validation with Joi
- Secure configuration management

## Testing

The project includes comprehensive tests:
- Unit tests for individual components
- Integration tests for full workflows
- Test coverage reporting

Run tests with:
```bash
npm test
```

## Deployment

The service can be deployed using:
- Docker (see Dockerfile)
- Kubernetes
- Traditional VPS

Ensure proper environment variables are set in production.

## License

MIT