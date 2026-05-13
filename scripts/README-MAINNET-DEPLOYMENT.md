# Mainnet Deployment Guide

This deployment flow now matches the current live-deployable stack:

1. `ModelRegistry`
2. `TokenDeploymentFactory`
3. `DeployableTokenManager`
4. `RewardVestingVault`
5. `DataContributionRegistry`
6. `HokusaiAMMFactory`
7. `InfrastructureReserve`
8. `InfrastructureCostOracle`
9. `UsageFeeRouter`
10. `DeltaVerifier`

`DeployableTokenManager` is the size-safe replacement for the oversized `TokenManager`. The deployment artifact still records its address under `contracts.TokenManager` for downstream compatibility, with `_tokenManagerImpl: "DeployableTokenManager"` as a disambiguator.

`RewardVestingVault` is deployed and recorded, but currently inert. `DeployableTokenManager` does not yet expose `setVestingVault` or vesting-aware reward minting, so the vault is a reserved address for follow-up wiring work.

## Prerequisites

Set the required environment variables in `.env` or `.env.sepolia`:

```bash
DEPLOYER_PRIVATE_KEY=0x...
TREASURY_ADDRESS=0x...
BACKEND_SERVICE_ADDRESS=0x...
INFRASTRUCTURE_GROSS_MARGIN_BPS=1500

# Mainnet only
MAINNET_RPC_URL=https://...

# Optional
SEPOLIA_RPC_URL=https://...
SEPOLIA_USDC_ADDRESS=0x...
MAX_GAS_PRICE_GWEI=100
DRY_RUN=true
SKIP_ARTIFACT_WRITE=true
```

Mainnet deploys require a wallet with at least `0.5 ETH`. Sepolia deploys require at least `0.1 ETH`.

## Commands

Compile and run tests first:

```bash
npx hardhat compile
npm test
```

Dry-run the mainnet script on the in-memory hardhat network:

```bash
DRY_RUN=true npx hardhat run scripts/deploy-mainnet.js
```

Dry-run against a local mainnet fork:

```bash
npx hardhat node --fork "$MAINNET_RPC_URL"
DRY_RUN=true npx hardhat run scripts/deploy-mainnet.js --network localhost
```

Run a live mainnet deployment:

```bash
npm run deploy:mainnet
```

Run a Sepolia deployment:

```bash
npm run deploy:sepolia
```

If `SEPOLIA_USDC_ADDRESS` is unset, the Sepolia script deploys `MockUSDC` and mints test funds to the deployer.

## Safety checks

The deployment scripts:

- reject wrong chain ids
- only relax the chain guard for `DRY_RUN=true` on chain id `31337`
- skip the mainnet confirmation pause in dry-run mode
- warn when gas price exceeds `MAX_GAS_PRICE_GWEI`
- collect gas usage for deployments and wiring transactions
- record git SHA, dirty state, and script SHA in the artifact

## Artifact shape

Successful deploys write:

- `deployments/<network>-<timestamp>.json`
- `deployments/<network>-latest.json` for live deploys only

Dry-runs write:

- `deployments/<network>-dryrun-<timestamp>.json`

Artifacts include:

- all deployed contract addresses
- role assignments
- deployment config values
- per-contract and per-wiring gas usage
- `git.sha` and `git.dirty`
- `scriptSha`

Pool creation remains a separate step handled by `scripts/create-mainnet-pools.js`.
