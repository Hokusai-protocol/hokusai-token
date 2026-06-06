# Mainnet Monitoring Requirements

Last updated: 2026-05-14

These are the minimum operational monitoring requirements for Hokusai mainnet deployment. They assume the current stack deployed by `scripts/deploy-mainnet.js` and `scripts/deploy-sepolia.js`.

## Contract Coverage

Monitor these contracts from the deployment artifact:

- `ModelRegistry`
- `TokenManager` (`DeployableTokenManager` implementation)
- `RewardVestingVault`
- `DataContributionRegistry`
- `HokusaiAMMFactory`
- every `HokusaiAMM` pool
- every per-token `HokusaiParams`
- `InfrastructureReserve`
- `InfrastructureCostOracle`
- `UsageFeeRouter`
- `DeltaVerifier`

## Critical Alerts

These alerts must page the emergency operator and backup operator immediately.

| Alert | Source | Trigger | Required action |
| --- | --- | --- | --- |
| Ownership transfer | `OwnershipTransferred` | Any owner change on Ownable contracts or pools | Verify against approved custody transaction. |
| Role change | `RoleGranted`, `RoleRevoked`, `RoleAdminChanged` | Any role change on AccessControl contracts | Verify against role matrix and Safe transaction. |
| Pool paused/unpaused | `Paused`, `Unpaused` | Any AMM pool pause-state change | Confirm incident or approved drill. |
| Infrastructure reserve paused/unpaused | `Paused`, `Unpaused` | `InfrastructureReserve` pause-state change | Confirm incident or approved drill. |
| Delta verifier paused/unpaused | `Paused`, `Unpaused` | `DeltaVerifier` pause-state change | Confirm incident or approved drill. |
| Reserve drains | pool state | Reserve drops below approved minimum or by more than approved threshold | Pause affected pool if exploit suspected. |
| Unauthorized mint/burn suspicion | pool/token state | Token supply changes without matching authorized flow | Pause affected pool and verifier if needed. |
| Backend depositor anomaly | `UsageFeeRouter` | Fee deposits from any non-approved depositor, failed deposit spike, or unexpected model ID | Rotate depositor or revoke role if compromised. |
| Oracle/cost anomaly | `InfrastructureCostOracle` and fee split events | Cost-plus split outside expected bounds | Pause fee routing if needed. |

## State Checks

Run state checks at least every block for critical values and at least once per minute for derived metrics.

Required per pool:

- `paused()`
- `reserveBalance()`
- reserve token balance
- token total supply
- spot price
- CRR
- trade fee
- max trade size
- current phase, flat-curve threshold, and flat-curve price
- IBR/sell availability

Required infrastructure:

- `InfrastructureReserve.paused()`
- per-model reserve balances
- total accrued and paid
- `UsageFeeRouter.totalFeesDeposited()`
- per-model fee totals
- current fee depositor role holders
- current payer role holders

Required governance/custody:

- owner of every Ownable contract
- `DEFAULT_ADMIN_ROLE` holders
- `MINTER_ROLE` holders
- `DEPLOYER_ROLE` holders
- `FEE_DEPOSITOR_ROLE` holders
- `RECORDER_ROLE` holders
- `VERIFIER_ROLE` holders
- `SUBMITTER_ROLE` holders
- `GOV_ROLE` holders

## Phase-Aware Pool Alerts

Pool alerts must account for flat-price bootstrap versus bonding-curve phase.

During flat-price phase:

- Do not alert on large expected supply increases caused by normal buys.
- Continue alerting on pause, role changes, reserve drains, failed transactions, and unauthorized supply changes.
- Alert if reserve crosses the flat-curve threshold and the pool does not transition as expected.

During bonding-curve phase:

- Alert on reserve/supply ratio drift.
- Alert on price movement outside approved thresholds.
- Alert on true supply mismatch.
- Alert on repeated max-size trades or likely manipulation patterns.

## Backend And RPC Health

Monitor:

- RPC latency
- RPC error rate
- stale block height
- event listener lag
- missed/replayed events
- service restarts
- queue depth, if enabled
- Redis health, if enabled
- ECS task health, if deployed through ECS

Critical thresholds:

- RPC failure rate above 5% for 5 minutes
- event listener lag above 5 blocks
- no successful state poll for 2 minutes
- monitoring service restart loop

## Alert Channels

Critical alerts:

- Pager or phone/SMS equivalent
- Slack/Discord incident channel
- email

High priority alerts:

- Slack/Discord
- email

Daily reports:

- pool TVL/reserve
- 24h volume
- fee deposits
- infrastructure accrued/paid
- role/ownership diff
- active incidents

## Required Pre-Mainnet Tests

- [ ] Pause/unpause alert fires for a Sepolia AMM pool
- [ ] Pause/unpause alert fires for `InfrastructureReserve`
- [ ] Pause/unpause alert fires for `DeltaVerifier`
- [ ] Ownership transfer alert fires during Sepolia custody rehearsal
- [ ] Role grant/revoke alert fires during Sepolia custody rehearsal
- [ ] Backend fee-deposit smoke test appears in logs/metrics
- [ ] Unauthorized fee-deposit failure is visible
- [ ] Monitoring recovers after process restart
- [ ] Monitoring uses the final `deployments/mainnet-latest.json` artifact path for mainnet

## Operational Notes

- `deployments/sepolia-latest.json` is the canonical Sepolia artifact path for scripts, but it must be regenerated from the current deployment flow before mainnet rehearsal sign-off.
- `deployments/sepolia-v2-latest.json` is retained only as historical compatibility; do not build new runbooks around v2 naming.
- Emergency response starts from [docs/mainnet-custody-runbook.md](../docs/mainnet-custody-runbook.md). Launch-day stop/resume/abandon decisions live in [docs/mainnet-launch-rollback-runbook.md](../docs/mainnet-launch-rollback-runbook.md).
