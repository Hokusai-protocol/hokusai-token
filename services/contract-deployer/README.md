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

Copy `.env.example` to `.env` and configure the required parameters:

```bash
cp .env.example .env
```

Key configuration parameters:
- `REDIS_URL`: Redis connection URL
- `RPC_URL`: Ethereum RPC endpoint
- `PRIVATE_KEY`: Deployer wallet private key
- `TOKEN_IMPLEMENTATION_ADDRESS`: Address of the token implementation contract
- `MODEL_REGISTRY_ADDRESS`: Address of the ModelRegistry contract

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