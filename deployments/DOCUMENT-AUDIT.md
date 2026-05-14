# Deployments Directory Document Audit

Audit date: 2026-05-14

This audit classifies files in `deployments/` after the May 14 cleanup. It is based on the current deploy flow in `scripts/deploy-mainnet.js`, `scripts/deploy-sepolia.js`, `scripts/lib/deploy-stack.js`, and `scripts/lib/deployment-artifact.js`.

Current live-deployable stack:

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

Current artifact writer writes live deployments as:

- `deployments/<network>-<ISO timestamp>.json`
- `deployments/<network>-latest.json`

## Active Files

| File | Status | Reason |
| --- | --- | --- |
| `mainnet-template.json` | Keep active, minor update optional | Closest match to the current artifact shape. It includes `TokenDeploymentFactory`, `_tokenManagerImpl`, `RewardVestingVault`, `InfrastructureReserve`, `InfrastructureCostOracle`, and detailed role blocks. Update after any custody changes or if `deploy-stack.js` artifact schema changes. |
| `sepolia-latest.json` | Active compatibility pointer, requires regeneration | Updated to point at the newest checked-in v2 Sepolia deployment so scripts no longer read the older February artifact. It is still marked `legacy-v2-current-pointer` and must be regenerated with `npm run deploy:sepolia` before production custody rehearsal. |
| `sepolia-v2-2026-04-28.json` | Keep as historical artifact | Newer than the removed legacy `sepolia-*` artifacts and includes the v2 infrastructure contracts except `RewardVestingVault`. Keep for historical traceability until a fresh current deployment exists. |
| `sepolia-v2-latest.json` | Keep temporarily | Retained only as the source historical v2 pointer. Prefer canonical `sepolia-latest.json` for all new scripts/docs. |
| `testnet-deployment-guide.md` | Updated | Rewritten around `npm run deploy:sepolia`, current artifact shape, custody rehearsal, and supported monitoring deployment. |
| `TESTNET-CHECKLIST.md` | Updated | Rewritten as a current Sepolia rehearsal checklist. |
| `monitoring-requirements.md` | Updated | Rewritten as current mainnet monitoring requirements for the live-deployable stack. |
| `testnet-quickstart.sh` | Updated | Replaced with a safe wrapper around the supported flow instead of bespoke AWS/ECS setup. |
| `monitor-testnet.sh` | Updated | Replaced with a simpler configurable dashboard script. |

## Still Needs Follow-Up

| File | Issue | Update needed |
| --- | --- | --- |
| `sepolia-latest.json` | It is a validated pointer to the newest checked-in v2 deployment, not a fresh artifact from the current deploy script. | Regenerate with `npm run deploy:sepolia` before custody rehearsal sign-off. |
| `sepolia-v2-latest.json` | Retained temporarily and still not aligned with current artifact schema. | Remove after a fresh canonical `sepolia-latest.json` exists and scripts no longer need v2 compatibility. |
| `sepolia-v2-2026-04-28.json` | Historical artifact is useful, but schema is partially behind current deploy output. | Keep as historical or remove after a fresh current Sepolia deployment is committed. |

## Deleted In Cleanup

These files were removed because git history is sufficient for recovery:

| File | Reason |
| --- | --- |
| `hardhat-2026-01-12.json` | Local Hardhat artifact for the old 7-contract stack. Superseded by current deploy stack. |
| `hardhat-latest.json` | Stale alias to `hardhat-2026-01-12.json`. It is not produced by the current deployment commands unless local hardhat deploys are run again. |
| `sepolia-2026-01-12.json` | Legacy Sepolia artifact for old 7-contract stack. |
| `sepolia-2026-01-21.json` | Legacy Sepolia artifact for old 7-contract stack. |
| `sepolia-2026-02-04.json` | Legacy Sepolia artifact for old 7-contract stack. |
| `DEPLOYMENT-UPDATE.md` | Historical LSCOR/two-phase deployment note, superseded by current mainnet and custody docs. |
| `testnet-monitoring-status.md` | Point-in-time January monitoring report, no longer current operational state. |
| `MONITORING-UPDATE-DEPLOYMENT.md` | Historical feature rollout guide for phase-aware monitoring. |
| `gas-benchmark-sepolia.json` | Historical gas benchmark for an older stack. |
| `sepolia-two-phase-deployment.log` | Historical log for a previous two-phase deployment. Keep as evidence, but archive out of active docs. |

## Recommended Cleanup Order

1. Run or prepare a fresh current Sepolia deployment so `deployments/sepolia-latest.json` matches the current artifact schema.
2. Update scripts that read `sepolia-latest.json` to tolerate the current artifact shape and the `DeployableTokenManager` implementation.
3. Regenerate current gas benchmarks if needed for launch.
4. Decide whether to remove `sepolia-v2-*` after the fresh canonical artifact exists.
