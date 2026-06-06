# Environment & SSM Configuration

This document describes all environment variables used by the `hokusai-contracts-development` ECS service and how they map to AWS SSM Parameter Store parameters.

## SSM Parameter Store

### Path Convention

SSM parameters follow the pattern:

```
/hokusai/<environment>/contracts/<parameter_name>
```

Where `<environment>` is set by the `DEPLOY_ENV` env var (defaults to `NODE_ENV`).

### Parameters Loaded from SSM

The service loads these parameters from SSM when `NODE_ENV=production` or `USE_SSM=true`.

| SSM Parameter | Env Var | Required | Description |
|---|---|---|---|
| `deployer_key` | `DEPLOYER_PRIVATE_KEY` | Yes | Deployer wallet private key |
| `token_manager_address` | `TOKEN_MANAGER_ADDRESS` | Yes | DeployableTokenManager contract |
| `model_registry_address` | `MODEL_REGISTRY_ADDRESS` | Yes | ModelRegistry contract |
| `rpc_endpoint` | `RPC_URL` | Yes | Blockchain RPC endpoint |
| `redis_url` | `REDIS_URL` | Yes | Redis connection string |
| `api_keys` | `API_KEYS` | Yes | Comma-separated API keys |
| `jwt_secret` | `JWT_SECRET` | No | JWT signing secret |
| `webhook_url` | `WEBHOOK_URL` | No | Deployment webhook URL |
| `webhook_secret` | `WEBHOOK_SECRET` | No | Webhook HMAC secret |
| `usage_fee_router_address` | `USAGE_FEE_ROUTER_ADDRESS` | No | UsageFeeRouter contract |

### Parameters Set via Environment Only

These are set directly in the ECS task definition or `.env` and are **not** loaded from SSM:

| Env Var | Default | Description |
|---|---|---|
| `CHAIN_ID` | `11155111` | Target chain (Sepolia) |
| `NETWORK_NAME` | `sepolia` | Network name |
| `MODEL_SUPPLIER_ALLOCATION` | `2500000000000000000000000` | Supplier allocation (wei) |
| `MODEL_SUPPLIER_RECIPIENT` | `0x000...` | Recipient of supplier tokens |
| `INVESTOR_ALLOCATION` | `10000000000000000000000000` | Investor allocation cap (wei) |
| `TOKENS_PER_DELTA_ONE` | `5000000000000000000000` | Tokens per delta-one improvement |
| `INFRASTRUCTURE_ACCRUAL_BPS` | `8000` | Infra accrual in bps (80%) |
| `INITIAL_ORACLE_PRICE_PER_THOUSAND_USD` | `0` | Oracle price per 1000 calls |
| `LICENSE_HASH` | `0x00...` | License hash (bytes32) |
| `LICENSE_URI` | (empty) | License URI |
| `GOVERNOR_ADDRESS` | `0x000...` | Governor for GOV_ROLE |
| `GAS_PRICE_MULTIPLIER` | `1.2` | Gas price safety multiplier |
| `MAX_GAS_PRICE_GWEI` | `500` | Max gas price cap |
| `CONFIRMATION_BLOCKS` | `2` | Blocks to wait for confirmation |

## Contract Address Variables

Current Sepolia addresses are recorded in `deployments/sepolia-v2-latest.json`. The env vars correspond to:

| Env Var | Deployment JSON Key |
|---|---|
| `MODEL_REGISTRY_ADDRESS` | `contracts.ModelRegistry` |
| `TOKEN_MANAGER_ADDRESS` | `contracts.TokenManager` |
| `DELTA_VERIFIER_ADDRESS` | `contracts.DeltaVerifier` |
| `USAGE_FEE_ROUTER_ADDRESS` | `contracts.UsageFeeRouter` |

## ECS Service

- **Service name:** `hokusai-contracts-development`
- **ECR:** `932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts`
- **Build:** `docker buildx build --platform linux/amd64 -t hokusai/contracts --load .`
- **Deploy scripts:** `services/contract-deployer/scripts/build-and-push.sh` and `deploy.sh`

## Pre-Deploy Checklist

Before redeploying the ECS service after contract changes:

1. Update SSM parameters under `/hokusai/<env>/contracts/` with current addresses from `sepolia-v2-latest.json`
2. Set `MODEL_SUPPLIER_RECIPIENT` and `GOVERNOR_ADDRESS` to the correct operational addresses
3. Set `LICENSE_HASH` and `LICENSE_URI` for the target model license
4. Verify `DEPLOYER_PRIVATE_KEY` account has:
   - Sufficient ETH for gas
   - The `DEPLOYER_ROLE` on the TokenManager contract
5. Build AMD64 image: `services/contract-deployer/scripts/build-and-push.sh`
6. Deploy: `services/contract-deployer/scripts/deploy.sh`
7. Verify via ECS console that the new task is running and healthy
