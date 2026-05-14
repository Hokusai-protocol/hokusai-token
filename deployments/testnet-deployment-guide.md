# Sepolia Deployment Guide

Use this guide for current Sepolia rehearsal deployments. It replaces the legacy flow that copied `deploy-mainnet.js`, hand-created pools with old constructor arguments, and used January 2026 monitoring service assumptions.

## Current Stack

`npm run deploy:sepolia` deploys the current live-deployable infrastructure stack:

1. `ModelRegistry`
2. `TokenDeploymentFactory`
3. `DeployableTokenManager`, recorded as `contracts.TokenManager`
4. `RewardVestingVault`
5. `DataContributionRegistry`
6. `HokusaiAMMFactory`
7. `InfrastructureReserve`
8. `InfrastructureCostOracle`
9. `UsageFeeRouter`
10. `DeltaVerifier`

On Sepolia, if `SEPOLIA_USDC_ADDRESS` is unset, the script deploys `MockUSDC` and mints test funds to the deployer.

## Prerequisites

- Node dependencies installed: `npm install`
- Sepolia RPC configured
- Deployer has at least `0.1 ETH`
- Optional Sepolia ERC20 reserve token address
- Sepolia Safe and role addresses selected if this is a custody rehearsal

Recommended environment:

```bash
SEPOLIA_RPC_URL=https://...
DEPLOYER_PRIVATE_KEY=0x...
TREASURY_ADDRESS=0x...                 # Sepolia Safe for custody rehearsal
BACKEND_SERVICE_ADDRESS=0x...          # Backend fee depositor rehearsal address
VERIFIER_ADDRESS=0x...                 # Backend verifier/operator rehearsal address
INFRASTRUCTURE_GROSS_MARGIN_BPS=1500

# Optional. If unset, MockUSDC is deployed.
SEPOLIA_USDC_ADDRESS=0x...
```

## Preflight

```bash
npx hardhat compile
npm test
```

Run a local dry run:

```bash
DRY_RUN=true npx hardhat run scripts/deploy-sepolia.js
```

## Deploy Sepolia Infrastructure

```bash
npm run deploy:sepolia
```

Successful live deploys write:

- `deployments/sepolia-<timestamp>.json`
- `deployments/sepolia-latest.json`

Dry runs write:

- `deployments/sepolia-dryrun-<timestamp>.json`

After deployment, confirm the artifact includes:

- `contracts._tokenManagerImpl = "DeployableTokenManager"`
- `contracts.TokenDeploymentFactory`
- `contracts.RewardVestingVault`
- `contracts.InfrastructureReserve`
- `contracts.InfrastructureCostOracle`
- `roles` block with current initial role holders
- `git` and `scriptSha`

## Token And Pool Launch

Do not use the old five-argument `factory.createPool(...)` examples. Current pool creation must happen after a token is deployed and registered by the current launch flow.

For rehearsal:

1. Use the same launch script/config path intended for the production launch.
2. Confirm the launch script reads `deployments/sepolia-latest.json`.
3. Confirm the launch token config has approved recipients, supply, params, reserve, CRR, fee, IBR duration, and flat-curve settings.
4. Create exactly the rehearsal token/pool set needed for the mainnet operation being tested.
5. Verify each pool is present in the artifact and on chain.

Required post-launch checks:

- `ModelRegistry.isStringRegistered(modelId) == true`
- `TokenManager.getTokenAddress(modelId) == tokenAddress`
- `HokusaiAMMFactory.getPool(modelId) == poolAddress`
- `pool.owner()` has an executable emergency pause path
- `pool.paused() == false`
- pool reserve/token balances match the launch config

Important: factory-created pools may be owned by `HokusaiAMMFactory`. If `pool.owner()` is the factory and the factory has no callable pause/unpause wrapper, the emergency pool pause path is not operational. Treat this as a Sepolia rehearsal failure until fixed.

## Custody Rehearsal

Before mainnet, complete [docs/mainnet-custody-runbook.md](../docs/mainnet-custody-runbook.md) on Sepolia:

- Safe admin grants
- ownership transfers
- deployer role revocation
- backend fee depositor smoke test
- emergency pause/unpause drill

Record all transaction hashes in the runbook.

## Contract Verification

Verify deployed contracts on Sepolia Etherscan after infrastructure deployment and after any token/pool launch.

```bash
npx hardhat verify --network sepolia <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>
```

Keep constructor arguments in the deployment artifact or linked operator notes.

## Monitoring Deployment

The supported monitoring deploy path is the service-local script:

```bash
cd services/contract-deployer
./scripts/deploy-monitoring.sh
```

Use `deployments/testnet-quickstart.sh` only as a convenience wrapper around the supported script.

Minimum monitoring checks:

- service health endpoint responds
- monitored pool count matches the rehearsal artifact
- `Paused` and `Unpaused` events alert
- role and ownership transfer events alert
- backend fee deposits are visible
- RPC failure and stale event alerts are configured

## Burn-In

For a mainnet readiness rehearsal, run at least a 24-48 hour burn-in after token/pool creation:

- no unexpected service restarts
- no stuck event listeners
- no stale pool state
- no alert storms
- pause/unpause alerts received
- one backend fee-deposit smoke test succeeds
- one unauthorized fee-deposit attempt fails

## Mainnet Readiness Output

Archive these items before approving mainnet:

- final `deployments/sepolia-latest.json`
- custody rehearsal transaction hashes
- emergency pause/unpause transaction hashes
- monitoring burn-in notes
- list of known rehearsal issues and resolutions
