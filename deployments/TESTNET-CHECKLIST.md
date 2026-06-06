# Sepolia Rehearsal Checklist

Use this checklist before any mainnet deployment rehearsal. It is intentionally short; detailed custody steps live in [docs/mainnet-custody-runbook.md](../docs/mainnet-custody-runbook.md).

## Environment

- [ ] `npm install` completed
- [ ] `npx hardhat compile` passes
- [ ] `npm test` passes, or failures are documented and accepted
- [ ] `SEPOLIA_RPC_URL` configured
- [ ] `DEPLOYER_PRIVATE_KEY` configured for the rehearsal deployer
- [ ] Deployer has at least `0.1 ETH`
- [ ] `TREASURY_ADDRESS` set to Sepolia Safe for custody rehearsal
- [ ] `BACKEND_SERVICE_ADDRESS` set to backend fee depositor rehearsal address
- [ ] `VERIFIER_ADDRESS` set to verifier/backend operator rehearsal address
- [ ] `SEPOLIA_USDC_ADDRESS` set, or MockUSDC fallback is acceptable

## Deploy Infrastructure

- [ ] Dry run completed:
  ```bash
  DRY_RUN=true npx hardhat run scripts/deploy-sepolia.js
  ```
- [ ] Live Sepolia deployment completed:
  ```bash
  npm run deploy:sepolia
  ```
- [ ] `deployments/sepolia-latest.json` created or updated
- [ ] [docs/canonical-model-registration.md](../docs/canonical-model-registration.md) reviewed
- [ ] Artifact contains `contracts._tokenManagerImpl = "DeployableTokenManager"`
- [ ] Artifact contains `TokenDeploymentFactory`
- [ ] Artifact contains `RewardVestingVault`
- [ ] Artifact contains `InfrastructureReserve`
- [ ] Artifact contains `InfrastructureCostOracle`
- [ ] Artifact contains `git`, `scriptSha`, `roles`, and `gasUsed`

## Verify Infrastructure

- [ ] `ModelRegistry.owner()` recorded
- [ ] `TokenManager.owner()` recorded
- [ ] `HokusaiAMMFactory.owner()` recorded
- [ ] `InfrastructureReserve.treasury()` matches expected treasury/Safe
- [ ] `UsageFeeRouter.factory()` matches factory
- [ ] `UsageFeeRouter.infraReserve()` matches reserve
- [ ] `ModelRegistry.poolRegistrars(factory)` returns `true`
- [ ] `TokenManager.deltaVerifier()` matches `DeltaVerifier`
- [ ] `TokenManager.vestingVault()` matches `RewardVestingVault`
- [ ] `DataContributionRegistry.RECORDER_ROLE` granted to `DeltaVerifier`
- [ ] `InfrastructureReserve.DEPOSITOR_ROLE` granted to `UsageFeeRouter`
- [ ] `UsageFeeRouter.FEE_DEPOSITOR_ROLE` granted to backend fee depositor

## Launch Rehearsal Token/Pool

- [ ] Launch config reviewed and approved
- [ ] Token deployed through current launch flow
- [ ] Pool created through current launch flow
- [ ] Token address recorded in artifact/operator notes
- [ ] Params address recorded
- [ ] Pool address recorded
- [ ] `ModelRegistry.isStringRegistered(modelId)` returns `true`
- [ ] `ModelRegistry.isRegistered(uint256(modelId))` returns `true`
- [ ] `TokenManager.getTokenAddress(modelId)` returns token address
- [ ] `ModelRegistry.getTokenAddress(uint256(modelId))` returns the same token address
- [ ] `HokusaiAMMFactory.getPool(modelId)` returns pool address
- [ ] `ModelRegistry.getPool(modelId)` returns the same pool address
- [ ] `npm run smoke:sepolia` verifies canonical registration for models `27`, `28`, and `30`
- [ ] Pool reserve/token balances match launch config
- [ ] Supplier distribution timing reviewed and expected AMM spot-price impact recorded before pool launch
- [ ] `pool.paused()` returns `false`
- [ ] `pool.owner()` recorded
- [ ] Pool owner has an executable pause/unpause path

## Custody Rehearsal

- [ ] Sepolia Safe threshold and signers recorded
- [ ] Safe granted required `DEFAULT_ADMIN_ROLE` roles
- [ ] Ownable contracts transferred to Safe where required
- [ ] Deployer role revocation transactions rehearsed from Safe
- [ ] Deployer no longer has long-lived admin roles unless exception is documented
- [ ] Backend fee depositor can call `UsageFeeRouter.depositFee`
- [ ] Unauthorized address cannot call `UsageFeeRouter.depositFee`
- [ ] Rehearsal transaction hashes recorded in custody runbook

## Emergency Drill

- [ ] Safe can pause affected AMM pool, or pool pause-path blocker is documented
- [ ] Unauthorized address cannot pause AMM pool
- [ ] Trading is blocked while pool is paused
- [ ] Safe can unpause AMM pool
- [ ] Trading resumes after unpause
- [ ] Safe can pause/unpause `InfrastructureReserve`
- [ ] Safe can pause/unpause `DeltaVerifier`
- [ ] Monitoring alerts received for `Paused`
- [ ] Monitoring alerts received for `Unpaused`

## Monitoring

- [ ] Monitoring deployment completed through `services/contract-deployer/scripts/deploy-monitoring.sh`
- [ ] Health endpoint responds
- [ ] Monitored pool count matches rehearsal artifact
- [ ] Event listener sees pool events
- [ ] Role/ownership transfer alerts configured
- [ ] Pause/unpause alerts configured
- [ ] Backend fee deposit visible in logs/metrics
- [ ] 24-48 hour burn-in completed if this rehearsal gates mainnet

## Sign-Off

- [ ] Trust model reviewed: [docs/deltaverifier-trust-model.md](../docs/deltaverifier-trust-model.md)
- [ ] Final `deployments/sepolia-latest.json` archived in release notes
- [ ] Known issues documented
- [ ] Pool pause-path status explicitly approved
- [ ] Custody owner approved
- [ ] Technical reviewer approved
- [ ] Mainnet deployment window approved
