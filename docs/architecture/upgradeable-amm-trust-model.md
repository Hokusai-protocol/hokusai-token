# Upgradeable AMM trust model

Status: applies to the upgradeable-AMM redeploy (Upgrade AMM infrastructure initiative, HOK-3281 → HOK-3291). The legacy mainnet pools deployed 2026-07-01 are immutable and are not covered here.

This document states who can change what in the Hokusai AMM system, how quickly they can do it, and what holders and integrators must assume. It is written for token holders, frontend/backend integrators and reviewers.

## Summary

- Every model's AMM pool is a `TransparentUpgradeableProxy`. **Its logic can be replaced.** Upgrade authority sits with the governance **timelock (48h on mainnet)**, which only the **admin Safe** can propose to.
- An upgrade can change anything the pool does, including how its USDC reserve is priced, paid out or withdrawn, and it can **move any tokens or USDC that users have approved the pool to spend**. Integrators must use **exact-amount approvals** (see below).
- Holders get at least the timelock delay (48h) of public notice before any upgrade takes effect, and an upgrade cannot execute while holders of the target pool cannot sell (paused, or still in the pool's buy-only period). This guarantee is bounded by the Safe-held powers listed under [Residual trust outside the timelock](#residual-trust-outside-the-timelock).
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

Every upgrade, freeze, unpause and pool-parameter change is a timelock operation, visible on-chain (`CallScheduled`) at least 48h before it can execute. Monitoring should alert on any scheduled call targeting `HokusaiPoolProxyAdmin` or `HokusaiAMMFactory`, and on the Safe-held powers listed under [Residual trust outside the timelock](#residual-trust-outside-the-timelock).

Pause stops both buys and sells. That is deliberate: the most likely reason to pause is an active exploit, and stopping sells may be what protects the reserve. Pause is fast (the emergency Safe can pause without delay), and unpause is timelocked.

**Exit-safe pause rule.** `HokusaiPoolProxyAdmin` refuses to upgrade a pool whose holders cannot sell when the upgrade executes: the pool is paused, or it is still in its buy-only (IBR) period. Governance therefore cannot pause a pool for the whole notice window and then upgrade it in the paused state, and cannot upgrade a newly created pool before its holders have been able to sell. If the pool's current implementation cannot report its state (its `paused()` or `isSellEnabled()` reverts), the upgrade is allowed, so a broken implementation can still be replaced rather than locking the pool forever.

**Pause blocks a scheduled upgrade.** Because of the rule above, a pause landing before a scheduled upgrade executes makes that upgrade revert. A planned upgrade of a paused pool (for example the fix for an exploit) has to be scheduled as one timelock batch, `[factory.unpausePool, proxyAdmin.upgrade, (optionally) factory.pausePool]`, which is the batch case below.

**Accepted residual trust.** Governance could still schedule `[unpausePool, upgrade]` as one timelock batch. Holders would then see the batch 48h in advance but could not sell during that window if the pool stayed paused throughout. Closing this gap would require a minimum unpaused period before an upgrade, which would also block a fast fix of an exploited, paused pool. For the initial release we accept trusting the admin Safe and timelock here (decision 2026-10-22). Monitoring should treat a scheduled batch containing both an unpause and an upgrade as high severity.

**Pauser.** On mainnet the emergency Safe (pauser) is currently the same Safe as the admin Safe. The pauser can only pause pools; it cannot unpause, upgrade, freeze, withdraw or change parameters. We evaluated moving it to distinct signers and left it unchanged for the initial release (decision 2026-10-22).

## Freezing upgrades

`HokusaiPoolProxyAdmin.freezeUpgrades(pool)` permanently disables upgrades for one pool. It is owner-only, so it is itself a 48h timelock operation. It is irreversible (there is no unfreeze), and it applies only to that pool. After a freeze the pool's logic is immutable; pause, unpause and parameter changes through the factory still work.

The freeze holds only while the frozen implementation has no way to write arbitrary storage (no `delegatecall`, UUPS upgrade function or raw slot write). `HokusaiAMM` has none; any future implementation must keep it that way before a pool running it is frozen.

## Writing upgrades

- The pool owner is the factory, not the ProxyAdmin, so `upgradeAndCall` cannot run an `onlyOwner` reinitializer. Schedule `[proxyAdmin.upgrade, factory.callPool(modelId, reinitializerCalldata)]` as one timelock batch, and keep reinitializers `onlyOwner` so they cannot be front-run between two transactions.
- Use `upgrade`, not `upgradeAndCall` with empty calldata (`HokusaiAMM` has no fallback, so an empty call reverts).
- Append new state variables and shrink `__gap` by the same amount. Run `npm run validate:upgrades` against the released implementation (see HOK-3289: the reference layout is frozen at the HOK-3291 deploy).

## Residual trust outside the timelock

These powers are held directly by the admin Safe (2-of-3), with no timelock delay. They were accepted for launch (H-1, HOK-2409) and remain for the redeploy. Monitoring should alert on each of them.

| Power | Holder | What it allows | Follow-up |
| --- | --- | --- | --- |
| Per-model `HokusaiToken.setController` | Token owner = admin Safe | Point the controller elsewhere: every sell then reverts (`burnAMM` is controller-only), which is a "pause" the ProxyAdmin cannot see, so an upgrade can execute with no exit window. Or make the Safe the controller, mint up to the cap headroom, restore TokenManager and sell into the pool. | HOK-3318. Alert on `ControllerUpdated`. |
| DeltaVerifier admin (attesters, mint budgets, `maxReward`) | Admin Safe | Add an attester and raise a budget, then mint rewards that can be sold into the pool. | HOK-2409. Alert on attester/budget changes. |
| `HokusaiParams` `GOV_ROLE` (incl. `infrastructureAccrualBps`, `tokensPerDeltaOne`) | Admin Safe | Instantly send up to 100% of future usage fees to `InfrastructureReserve` instead of the pool. `PAYER_ROLE` (treasury) can pay any payee up to a model's accrual. Funds already in a pool are not affected. | HOK-2409. Alert on params changes. |
| `HokusaiAMMFactory.pauser` | Emergency Safe (= admin Safe) | Pause any pool (fast), which also blocks a scheduled upgrade from executing. Cannot unpause. | Accepted (decision 2026-10-22). |

Timelocked powers that holders should also know about: TokenManager's owner, `MINTER_ROLE` holders and the DeltaVerifier can burn any account's model tokens without an allowance and mint investor tokens up to the cap. After handoff these sit with the timelock.

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
- the deployer holds no role named anywhere in the policy (TokenManager `MINTER_ROLE`/`DEPLOYER_ROLE`, router `FEE_DEPOSITOR_ROLE`, whitelist and contribution-registry roles included), and no policy symbol (treasury, relayer, backend service, recorded role holders) resolves to the deployer;
- the deployer audited is the one recorded in the deployment artifact, not whichever key is loaded;
- the timelock delay is at least 48h on mainnet, and the deployer holds no timelock role;
- the factory's on-chain pool count matches the pools recorded in the artifact, so no pool goes unchecked.

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
