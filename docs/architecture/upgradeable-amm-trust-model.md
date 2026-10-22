# Upgradeable AMM trust model

Status: applies to the upgradeable-AMM redeploy (Upgrade AMM infrastructure initiative, HOK-3281 → HOK-3291). The legacy mainnet pools deployed 2026-07-01 are immutable and are not covered here.

This document states who can change what in the Hokusai AMM system, how quickly they can do it, and what holders and integrators must assume. It is written for token holders, frontend/backend integrators and reviewers.

## Summary

- Every model's AMM pool is a `TransparentUpgradeableProxy`. **Its logic can be replaced.** Upgrade authority sits with the governance **timelock (48h on mainnet)**, which only the **admin Safe** can propose to.
- An upgrade can change anything the pool does, including how its USDC reserve is priced, paid out or withdrawn, and it can **move any tokens or USDC that users have approved the pool to spend**. Integrators must use **exact-amount approvals** (see below).
- Holders get at least the timelock delay (48h) of public notice before any upgrade takes effect, and an upgrade cannot execute while the target pool is paused.
- Governance can permanently give up the ability to upgrade a pool (`freezeUpgrades`), pool by pool.
- One pool's upgrade authority cannot mint or burn another model's token: each pool's TokenManager authority is scoped to its own model (HOK-3283).

## Components and authority

| Component | What it controls | Who controls it |
| --- | --- | --- |
| `HokusaiPoolProxyAdmin` | ERC-1967 admin of every pool proxy: `upgrade`, `upgradeAndCall`, `freezeUpgrades`. `changeProxyAdmin` is disabled. | Owner = timelock |
| `HokusaiAMMFactory` | Creates pools; `setPoolImplementation` (implementation for *new* pools only); `callPool` (pool owner functions: params, trade caps, whitelist, treasury withdrawal, pause/unpause); defaults, treasury. | Owner = timelock. `pauser` (emergency Safe) can only pause. |
| `HokusaiAMM` pools | Trading, reserve, fees. | Owner = factory (fixed; `callPool` cannot transfer or renounce it) |
| `ModelRegistry` | Model ↔ token ↔ pool bindings. A pool binding is also the pool's mint/burn authorization for its model. Bindings are write-once. | Owner = timelock; factory is a pool registrar |
| `TokenManager` | Mints/burns model tokens. AMM callers are authorized only for the model whose registry pool they are, and may burn only their own balance. Pools never hold `MINTER_ROLE`. | Owner/`DEFAULT_ADMIN_ROLE` = timelock |
| Timelock (`HokusaiTimelockController`) | Delays and executes everything above. | Admin Safe is proposer, executor and canceller; no timelock admin. |

Governance addresses are reused from the HOK-1829 launch; nothing here redeploys them.

## What an upgrade can do

Upgrade authority is effectively full control of a pool's logic. A malicious or mistaken implementation could:

- change pricing, fees, trade limits or the bonding curve;
- pay out, redirect or lock the pool's USDC reserve;
- transfer **any USDC or model tokens a user has approved the pool to spend** (`buy` pulls USDC and `sell` pulls tokens via `transferFrom`, so pools are approval targets);
- mint or burn **that pool's own model token** through TokenManager (registry-scoped; it cannot touch other models' tokens).

It cannot:

- upgrade, mint or burn for any other model's pool or token;
- move pool ownership away from the factory, or move the proxy to a different admin;
- execute while the pool is paused, or at all once the pool is frozen;
- take effect without a 48h public timelock delay.

## Notice window and pause

Every upgrade, freeze, unpause and pool-parameter change is a timelock operation, visible on-chain (`CallScheduled`) at least 48h before it can execute. Monitoring should alert on any scheduled call targeting `HokusaiPoolProxyAdmin` or `HokusaiAMMFactory`.

Pause stops both buys and sells. That is deliberate: the most likely reason to pause is an active exploit, and stopping sells may be what protects the reserve. Pause is fast (the emergency Safe can pause without delay), and unpause is timelocked.

**Exit-safe pause rule.** `HokusaiPoolProxyAdmin` refuses to upgrade a pool that is paused when the upgrade executes. Governance therefore cannot pause a pool for the whole notice window and then upgrade it in the paused state.

**Accepted residual trust.** Governance could still schedule `[unpausePool, upgrade]` as one timelock batch. Holders would then see the batch 48h in advance but could not sell during that window if the pool stayed paused throughout. Closing this gap would require a minimum unpaused period before an upgrade, which would also block a fast fix of an exploited, paused pool. For the initial release we accept trusting the admin Safe and timelock here (decision 2026-10-22). Monitoring should treat a scheduled batch containing both an unpause and an upgrade as high severity.

**Pauser.** On mainnet the emergency Safe (pauser) is currently the same Safe as the admin Safe. The pauser can only pause pools; it cannot unpause, upgrade, freeze, withdraw or change parameters. We evaluated moving it to distinct signers and left it unchanged for the initial release (decision 2026-10-22).

## Freezing upgrades

`HokusaiPoolProxyAdmin.freezeUpgrades(pool)` permanently disables upgrades for one pool. It is owner-only, so it is itself a 48h timelock operation. It is irreversible (there is no unfreeze), and it applies only to that pool. After a freeze the pool's logic is immutable; pause, unpause and parameter changes through the factory still work.

## Implementation for new pools

`HokusaiAMMFactory.poolImplementation` is the implementation used for pools created from now on, changed only by `setPoolImplementation` (timelocked). Changing it never touches existing pools; upgrading those is a separate `HokusaiPoolProxyAdmin` operation. Each pool's actual implementation is readable from its ERC-1967 implementation slot (`0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`).

## Integrator requirements

- **Frontend: exact-amount approvals.** The website must approve exactly the USDC amount of a buy (and exactly the token amount of a sell) to the pool, never `type(uint256).max` or a standing allowance. An unlimited approval exposes the user's whole balance to a future pool upgrade. This needs a cross-repo follow-up in the website repo.
- Resolve pools via `ModelRegistry.getPool(modelId)`. The pool address is the proxy and never changes across upgrades.
- Read the ABI from the current implementation; check `poolImplementation` / the ERC-1967 slot if behavior matters.

## Verification

`scripts/governance/verify-governance.js` (policy `scripts/governance/governance-policy.json`) checks after handoff that:

- `PoolProxyAdmin` is owned by the timelock and the deployer owns nothing;
- every pool's ERC-1967 admin slot is `PoolProxyAdmin` and its implementation slot is an approved implementation (`contracts.HokusaiAMMImplementation`, or one recorded under `upgrades.approvedPoolImplementations` after a timelocked upgrade);
- every pool is the ModelRegistry pool for its model and holds no TokenManager `MINTER_ROLE`;
- the factory's `poolDeployer`, `poolImplementation`, `modelRegistry` and `tokenManager`, and TokenManager's `registry`, match the deployment;
- the deployer holds no role named anywhere in the policy (TokenManager `MINTER_ROLE`/`DEPLOYER_ROLE`, router `FEE_DEPOSITOR_ROLE`, whitelist and contribution-registry roles included).

## Published addresses

Governance (reused, mainnet):

| Role | Address |
| --- | --- |
| Timelock (48h) | `0xcd8076D7a15E97946fAD0baA32Bf358be3D927C8` |
| Admin Safe (proposer/executor/canceller) | `0x158B985CC667b4E022AD05B99E89007790da66E2` |
| Emergency Safe (pauser) | `0x158B985CC667b4E022AD05B99E89007790da66E2` |

Upgradeable-AMM contracts (filled in at the HOK-3291 cutover from `deployments/mainnet-latest.json`):

| Contract | Address |
| --- | --- |
| `HokusaiPoolProxyAdmin` | _TBD at redeploy_ |
| `HokusaiAMMFactory` | _TBD at redeploy_ |
| `HokusaiAMMPoolDeployer` | _TBD at redeploy_ |
| `HokusaiAMM` implementation (default) | _TBD at redeploy_ |
| `ModelRegistry` | _TBD at redeploy_ |
| `TokenManager` | _TBD at redeploy_ |
| Pool proxies | one per model; resolve with `ModelRegistry.getPool(modelId)` |
