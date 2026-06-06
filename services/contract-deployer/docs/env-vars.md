# Environment Variables Reference

This document describes all environment variables for the contract-deployer service. For security, **never commit secrets to version control**.

## Blockchain Configuration

### Required
- **RPC_URL**: Ethereum JSON-RPC endpoint (e.g., Alchemy or Infura URL for Sepolia)
  - Stored in SSM: `/hokusai/[env]/contracts/rpc_endpoint`
  - Example: `https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY`

### Optional
- **CHAIN_ID**: Network identifier (default: `11155111` for Sepolia)
- **NETWORK_NAME**: Human-readable network name (default: `sepolia`)

## Contract Addresses

All addresses should be checksummed 20-byte Ethereum addresses (0x prefix).

### Required
- **MODEL_REGISTRY_ADDRESS**: ModelRegistry contract address
  - Stored in SSM: `/hokusai/[env]/contracts/model_registry_address`
  - Sepolia: `0x8E891850C0677c2D9581c953bF1Df5446cB4c54f`

- **TOKEN_MANAGER_ADDRESS**: DeployableTokenManager contract address
  - Stored in SSM: `/hokusai/[env]/contracts/token_manager_address`
  - Sepolia: `0x4ebC3558Ec08c81AbB9F220fd2C98c838b96De68`

### Optional
- **DELTA_VERIFIER_ADDRESS**: DeltaVerifier contract address
  - Stored in SSM: `/hokusai/[env]/contracts/delta_verifier_address`
  - Sepolia: `0x4812263c7A4317E971F461E611ACD2A51679F7af`

- **USAGE_FEE_ROUTER_ADDRESS**: UsageFeeRouter contract address (for fee depositor role)
  - Stored in SSM: `/hokusai/[env]/contracts/usage_fee_router_address`
  - Sepolia: `0x31258B9A4eF51cDfa09fb8d479CE1Cd19f5ab8c5`
  - Required for integration tests and fee deposit workflows

- **DEPLOY_FACTORY_ADDRESS**: TokenDeploymentFactory contract address (reserved for future use)
  - Stored in SSM: `/hokusai/[env]/contracts/deploy_factory_address`

## Private Keys

**⚠️ CRITICAL: Never commit private keys to version control. Always use AWS SSM Parameter Store in production.**

### Required
- **DEPLOYER_PRIVATE_KEY**: Private key for token deployment transactions
  - Stored in SSM: `/hokusai/[env]/contracts/deployer_key` (encrypted)
  - Must have sufficient ETH for gas and rights to call TokenManager functions

### Optional
- **DEPOSITOR_PRIVATE_KEY**: Private key for fee deposits (defaults to DEPLOYER_PRIVATE_KEY)
  - Stored in SSM: `/hokusai/[env]/contracts/depositor_key` (encrypted)
  - Must have `FEE_DEPOSITOR_ROLE` on UsageFeeRouter contract

## AWS/SSM Configuration

- **USE_SSM**: Enable SSM Parameter Store loading (`true`/`false`, default: `false`)
- **AWS_REGION**: AWS region (default: `us-east-1`)
- **DEPLOY_ENV**: Deployment environment for SSM path resolution (default: NODE_ENV)
  - Example: `development`, `staging`, `production`
  - Affects SSM path: `/hokusai/{DEPLOY_ENV}/contracts/...`

## Gas Configuration

- **GAS_PRICE_MULTIPLIER**: Multiplier for estimated gas price (default: `1.2`)
  - Range: 1.0–5.0
  - Used to ensure transactions are not underpriced during network congestion

- **MAX_GAS_PRICE_GWEI**: Maximum acceptable gas price in Gwei (default: `500`)
  - Capped to prevent overpaying during market spikes

- **DEFAULT_GAS_LIMIT**: Default gas limit for transactions (default: `5000000`)
- **CONFIRMATION_BLOCKS**: Number of block confirmations to await (default: `2`)

## Server & Logging

- **NODE_ENV**: Environment mode (`development`/`test`/`production`)
- **PORT**: HTTP server port (default: `8002`)
- **LOG_LEVEL**: Logging level (`error`/`warn`/`info`/`debug`, default: `info`)
- **LOG_FORMAT**: Log output format (`json`/`simple`, default: `json`)

## Redis Configuration

- **REDIS_HOST**: Redis server hostname (default: `localhost`)
- **REDIS_PORT**: Redis server port (default: `6379`)
- **REDIS_URL**: Full Redis URL (alternative to REDIS_HOST + REDIS_PORT)
  - Stored in SSM: `/hokusai/[env]/redis_url`

## Queue Configuration

- **QUEUE_NAME**: Deployment queue name (default: `contract-deployments`)
- **QUEUE_PREFIX**: Queue key prefix (default: `hokusai`)
- **MINT_REQUEST_QUEUE**: Mint request queue name (default: `hokusai:mint_requests`)
- **MINT_REQUEST_PROCESSING_QUEUE**: Processing queue (default: `hokusai:mint_requests:processing`)
- **MINT_REQUEST_DLQ**: Dead-letter queue (default: `hokusai:mint_requests:dlq`)
- **MINT_REQUEST_PROCESSED_SET**: Processed set for deduplication (default: `hokusai:mint_requests:processed`)
- **MINT_REQUEST_MAX_RETRIES**: Max retry attempts (default: `3`)

## Rate Limiting & CORS

- **RATE_LIMIT_WINDOW_MS**: Rate limit window (default: `900000` = 15 min)
- **RATE_LIMIT_MAX_REQUESTS**: Max requests per window (default: `100`)
- **CORS_ORIGINS**: Allowed CORS origins (default: `*`)
- **CORS_ENABLED**: Enable CORS (default: `true`)
- **RATE_LIMIT_ENABLED**: Enable rate limiting (default: `true`)

## API Authentication

- **ENABLE_AUTH**: Require authentication (default: `false`)
- **API_KEYS**: Comma-separated API keys (for simple key auth)
  - Stored in SSM: `/hokusai/[env]/api_keys`

- **JWT_SECRET**: Secret for JWT signing
  - Stored in SSM: `/hokusai/[env]/jwt_secret` (encrypted)
  - Used for token-based authentication

- **JWT_EXPIRY**: JWT token expiry duration (default: `24h`)

## Webhooks

- **WEBHOOK_URL**: Webhook endpoint for deployment events
  - Stored in SSM: `/hokusai/[env]/webhook_url`

- **WEBHOOK_SECRET**: Secret for webhook HMAC signing
  - Stored in SSM: `/hokusai/[env]/webhook_secret` (encrypted)

## Monitoring

- **METRICS_ENABLED**: Enable Prometheus metrics (default: `false`)
- **METRICS_PORT**: Metrics endpoint port (default: `9091`)
- **HEALTH_CHECK_INTERVAL**: Health check interval (default: `30000` ms)
- **HEALTH_CHECK_TIMEOUT**: Health check timeout (default: `5000` ms)

## Service Identification

- **SERVICE_NAME**: Service identifier (default: `contract-deployer`)

## SSM Parameter Paths

When using SSM, parameters are resolved with the pattern:
```
/hokusai/{DEPLOY_ENV}/contracts/{parameter_name}
```

### Required Parameters
- `rpc_endpoint` → RPC_URL
- `model_registry_address` → MODEL_REGISTRY_ADDRESS
- `token_manager_address` → TOKEN_MANAGER_ADDRESS
- `deployer_key` → DEPLOYER_PRIVATE_KEY (encrypted)
- `redis_url` → REDIS_URL
- `api_keys` → API_KEYS

### Optional Parameters
- `usage_fee_router_address` → USAGE_FEE_ROUTER_ADDRESS
- `jwt_secret` → JWT_SECRET (encrypted)
- `webhook_url` → WEBHOOK_URL
- `webhook_secret` → WEBHOOK_SECRET (encrypted)

## Example: Local Development

```bash
# .env.local
NODE_ENV=development
RPC_URL=http://localhost:8545
CHAIN_ID=31337

MODEL_REGISTRY_ADDRESS=0x5FbDB2315678afccb333f8a9c90c1a6003Cf07cb
TOKEN_MANAGER_ADDRESS=0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512

DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb476caded642d4f141d8f3a04f5c
DEPOSITOR_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb476caded642d4f141d8f3a04f5c

REDIS_URL=redis://localhost:6379
USE_SSM=false
```

## Example: Sepolia Testnet

```bash
# .env.sepolia
NODE_ENV=production
RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY
CHAIN_ID=11155111
NETWORK_NAME=sepolia

# See deployments/sepolia-v2-latest.json for current addresses
MODEL_REGISTRY_ADDRESS=0x8E891850C0677c2D9581c953bF1Df5446cB4c54f
TOKEN_MANAGER_ADDRESS=0x4ebC3558Ec08c81AbB9F220fd2C98c838b96De68
USAGE_FEE_ROUTER_ADDRESS=0x31258B9A4eF51cDfa09fb8d479CE1Cd19f5ab8c5

# Load from SSM in production
USE_SSM=true
DEPLOY_ENV=sepolia
AWS_REGION=us-east-1

# Private keys loaded from SSM, never set in .env
```

## Validation

On startup, the service validates:
1. All required environment variables are present
2. All addresses are valid Ethereum checksummed addresses
3. Private keys are 66-character hex strings (0x prefix + 64 hex)
4. RPC endpoint is reachable
5. If SSM is enabled, all required parameters are accessible

Validation errors will cause the service to exit with a non-zero status.
