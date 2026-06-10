# Contract Deployer Service

Service for listening to contract deployment requests from a Redis queue and deploying Hokusai token contracts on Ethereum.

## Overview

This service:

- Listens to a Redis queue for deployment requests
- Listens to a Redis queue for benchmark-backed MintRequest submissions
- Validates incoming requests
- Deploys new HokusaiToken contracts using a factory pattern
- Registers deployed contracts with the ModelRegistry
- Submits MintRequest payloads to DeltaVerifier via `submitMintRequest`
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
- `DELTA_VERIFIER_ADDRESS`: Enables the MintRequest consumer when set
- `MINT_REQUEST_QUEUE`: Defaults to `hokusai:mint_requests`
- `MINT_REQUEST_PROCESSING_QUEUE`: Defaults to `hokusai:mint_requests:processing`
- `MINT_REQUEST_DLQ`: Defaults to `hokusai:mint_requests:dlq`
- `MINT_REQUEST_PROCESSED_SET`: Defaults to `hokusai:mint_requests:processed`
- `MINT_REQUEST_RETRY_QUEUE`: Defaults to `hokusai:mint_requests:retry`
- `MINT_REQUEST_SETTLEMENT_QUEUE`: Defaults to `hokusai:mint_request_settlements`
- `MINT_REQUEST_MAX_RETRIES`: Defaults to `3`
- `MINT_BACKOFF_BASE_MS`: Defaults to `1000`
- `MINT_BACKOFF_MAX_MS`: Defaults to `60000`
- `MINT_BACKOFF_MULTIPLIER`: Defaults to `2`
- `MINT_RECORD_KEY_PREFIX`: Defaults to `hokusai:mint_record:`
- `MINT_RECORD_TTL_SECONDS`: Defaults to `2592000` (30 days)
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

For benchmark-backed reward minting, the service also consumes `hokusai:mint_requests` messages containing `model_id_uint`, `eval_id`, attestation and idempotency hashes, normalized score bps values, optional `benchmark_spec_id` / `dataset_hash`, and contributor weights that sum to `10000`.

The canonical completion queue for MintRequest reconciliation is `hokusai:mint_request_settlements` unless `MINT_REQUEST_SETTLEMENT_QUEUE` is overridden.

## Syncing the DeltaVerifier ABI

The bundled `contracts/DeltaVerifier.json` is regenerated from the Hardhat
artifact, not edited by hand. After modifying `contracts/DeltaVerifier.sol`
at the repo root:

```bash
npx hardhat compile                               # from repo root
cd services/contract-deployer
npm run sync:abi                                   # regenerate bundled ABI
npm run sync:abi -- --check                        # CI-safe drift assertion
npm test -- --runTestsByPath tests/unit/blockchain/abi-sync.test.ts
```

The unit suite includes a guard test that pins the `submitMintRequest`
4-byte selector (`0xc9b4e69b`) and asserts the payload tuple still contains
`totalSamples`.

## Error Handling

The service implements robust error handling:

- Automatic retries with bounded Redis-backed exponential backoff and jitter
- Dead letter queue for failed deployments
- Comprehensive logging
- Graceful shutdown on errors

For MintRequest processing specifically:

- Retryable Redis/RPC/gas failures are written to `MINT_REQUEST_RETRY_QUEUE` as delayed entries and promoted back to the inbound queue when due.
- Deterministic failures are sent directly to the DLQ with `reason` and `failureClass`.
- Exhausted retries are sent to the DLQ with an `exhausted (retries=N): ...` reason.
- Reconciliation records are stored at `${MINT_RECORD_KEY_PREFIX}<idempotency_key>` with fields including `tx_hash`, `status`, `reward_amount`, `block_number`, `gas_used`, `error`, and `updated_at`.

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
