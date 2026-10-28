# Upgradeable-AMM Redeploy: Rehearsal and Operator Runbook (HOK-3290)

This runbook rehearses the fresh full-stack redeploy with one proxy per AMM pool. The release under test is `main` after the HOK-3289 re-review (`9650643`; reviewed pricing at `71dc6b9`).

It covers:
- the exact commands;
- what each phase proves;
- where the machine-readable evidence lives.

The mainnet cutover itself is HOK-3291. No step here writes to mainnet.

## Evidence

| Rehearsal | Result | Evidence |
| --- | --- | --- |
| Mainnet fork, block 26,285,984, 48h production timelock | **35/35** | `deployments/rehearsal/fork-26285984/` (`report.json`, `deployment.json`, `verify-governance*.json`, `posture-*.json`, `records.json`, `safe-bundles.json`, `handoff-actions.json`), `deployments/legacy-drain/dry-run-26285984.json` |
| Sepolia, launch through fees | PASS | `deployments/sepolia-latest.json`, `deployments/governance-verification-sepolia-latest.json` (90/90), `deployments/launch-posture-sepolia-latest.json`, `deployments/rehearsal/sepolia/state.json` |
| Sepolia, sell and Safe-signed upgrade flow | **31/31** | `deployments/rehearsal/sepolia/` (`state.json`, `safe-*.json`, `records.json`, `verify-governance-after-upgrade.json`) |

## Prerequisites

- **Env files:** `.env.mainnet` and `.env.sepolia` in the repo root (worktrees symlink them). The KMS keys are `KMS_DEPLOYER_*` and `KMS_BACKEND_*`, and AWS credentials must be able to sign with them.
- **KMS signer build:** `services/contract-deployer` must be built (`npm run build`) so `dist/blockchain/kms-signer.js` exists.
- **RPC:** use one reachable from the operator machine.
  - The `RPC_URL` in `.env.sepolia` is origin-allowlisted and rejects local requests ("Unspecified origin not on whitelist").
  - The Sepolia rehearsal used `https://ethereum-sepolia-rpc.publicnode.com`. Tenderly's free Sepolia gateway rate-limited the deploy.
  - Load-balanced RPCs can serve reads from a node behind the latest block. `create-mainnet-pools.js` now waits for a new token's and pool's code before reading them.
- **Mainnet fork:** `MAINNET_RPC_URL=https://mainnet.gateway.tenderly.co` (the `.env.mainnet` value returns 403).
- **Governance inputs.** These must be set explicitly, never defaulted to the deployer (HOK-3289 GOV-M3):
  - `TREASURY_ADDRESS`;
  - `VERIFIER_ADDRESS`;
  - `BACKEND_SERVICE_ADDRESS`;
  - `TIMELOCK_ADDRESS` (the redeploy reuses the existing timelock).

## 1. Mainnet-fork rehearsal (no keys)

```bash
FORK_MAINNET=1 MAINNET_RPC_URL=https://mainnet.gateway.tenderly.co FORK_BLOCK=<recent block> \
  npx hardhat run scripts/rehearsal/fork-redeploy.js
```

`scripts/rehearsal/fork-redeploy.js` runs in one process, in cutover order.

**Accounts.**
- The deployer is a local fork account.
- The admin Safe, emergency Safe, backend and buyers are impersonated.
- The reused July timelock (`0xcd80…27C8`) keeps its 48h delay. The script skips time forward; it never shortens the delay.

**Phases.**
1. **Legacy drain dry run (HOK-3287).** HROUT was already drained, so its seller has nothing left to sell. HMESS and HLEAD drain from about $10 to about $0.86 each.
2. **Deploy.** The full stack is deployed with `deploy-mainnet.js`'s config and `deploy-stack.js`.
3. **Timelock.** The July timelock is reused, and its 48h delay is checked.
4. **Pools.** `create-mainnet-pools.js` `runLaunchDeploy` creates HMESS, HLEAD and HROUT. Its artifact paths are redirected to the run directory, so `deployments/mainnet-latest.json` is not touched.
5. **Posture.** The posture plan is executed by the deployer, then the pre-handoff gate runs.
6. **Handoff and governance.** The handoff is followed by `verify-governance` (90/90) and the post-handoff posture check.
7. **Trading.**
   - The admin Safe whitelists the buyers.
   - Three $9k buys graduate HMESS, and a $1k buy goes to HLEAD.
   - Sells are blocked during the IBR, then open after it.
   - The buyer who crossed the threshold exits without profit (AMM-H1). The flat-phase buyer's result is logged for information.
   - The pool sells back below the threshold.
   - A $1,000 router fee is fully accounted for (pool $200, infra $800, treasury $0) and the router keeps no balance.
8. **Upgrade flow.** Every step goes through the timelock as the admin Safe:
   - Queue the upgrade, check its ID against `hashOperationBatch`, then cancel it.
   - The emergency Safe pauses HMESS with no delay.
   - Requeue the upgrade and an unpause. Executing before the delay reverts.
   - After the delay, `ProxyAdmin.upgrade` from the timelock reverts with "Pool exit is closed", and the timelock execution fails.
   - A direct Safe call to `ProxyAdmin.upgrade` reverts with "Ownable: caller is not the owner".
   - Execute the unpause, then the upgrade. This emits `Upgraded(V2)`, and `initializeV2` runs through `factory.callPool`.
   - Pool state (reserve, anchor, treasury, owner, spot) is unchanged, HLEAD keeps its implementation, and HMESS still trades.
   - Freeze HMESS (`UpgradesFrozen`). A later upgrade reverts with "Upgrades frozen".
   - With V2 recorded in `upgrades.approvedPoolImplementations`, `verify-governance` passes 90/90.
9. **Records.**
   - Code hashes of every contract.
   - EIP-1967 implementation and admin slots per pool.
   - The V2 hash and gas.
   - The Safe bundles each step would use.

### Gas (fork, mainnet pricing applies on the day)

| Step | Gas |
| --- | --- |
| Full stack deploy (13 contracts plus wiring) | 36.3M |
| HokusaiAMMPoolDeployer (includes the implementation) | 5.10M |
| Buy (flat / crossing) | 204k–294k |
| Sell after graduation | 218k |
| Router `depositFee` | 302k |
| Timelock execute of upgrade + `callPool` reinit | 129k |

## 2. Sepolia rehearsal

The Sepolia timelock (`0x7c59…3eFe`) has a 300s delay. Its proposer, executor and canceller are all the admin Safe `0x158B…66E2`, a 2-of-3 Safe whose owners are people (no KMS key). The Sepolia launch config uses a 1-day IBR so that sells and upgrades can follow the next day.

Run these commands from the repo root:

```bash
export RPC_URL=https://ethereum-sepolia-rpc.publicnode.com SEPOLIA_RPC_URL=$RPC_URL
export TIMELOCK_ADDRESS=0x7c5938F4f34EaB427fD8bbD5AfFc78A0E5743eFe
export TREASURY_ADDRESS=0x158B985CC667b4E022AD05B99E89007790da66E2
export VERIFIER_ADDRESS=<backend KMS address> BACKEND_SERVICE_ADDRESS=<backend KMS address>

# Deploy, reuse the timelock, create pools, apply posture, pre-handoff gate
node scripts/launch-mainnet.js --network sepolia --yes --to verify-posture-pre

# Trade before the handoff: the deployer still holds the whitelist admin role
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js trade

# Irreversible handoff, then verify-governance and the post-handoff posture gate.
# --yes deliberately cannot confirm a handoff, so pipe the word in.
echo HANDOFF | node scripts/launch-mainnet.js --network sepolia --from confirm-handoff

# Fee settlement from the backend KMS key
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js fees

# After the 1-day IBR
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js sell

# Upgrade flow. Each phase checks the previous step on-chain and writes
# deployments/rehearsal/sepolia/safe-<step>.json for the Safe Transaction
# Builder. Sign 2-of-3 and execute before running the next phase.
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-1   # -> 01 schedule upgrade
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-2   # -> 02 cancel
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-3   # -> 03 pause + requeue upgrade + queue unpause
#   wait 300s
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-4   # paused rejection (simulated) -> 04 execute unpause, then upgrade
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-5   # V2 checks -> 05 schedule freeze
#   wait 300s
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js upgrade-6   # -> 06 execute freeze
HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js final       # frozen rejection, approve V2, verify-governance, records
```

### Sepolia results (2026-10-27)

**Launch.**
- A fresh stack was deployed. Pools:
  - HMESS `0x613F…F7DA`
  - HLEAD `0x5302…6154`
  - HROUT `0x89d5…60E4`
- The pre-handoff posture check passed.

**Trades.**
- Three $9k buys graduated HMESS (reserve $27,019, spot $0.01266).
- HLEAD's $1k buy left it in the flat phase.
- Sells are blocked during the IBR.

**Handoff.**
- 53 actions.
- `verify-governance` 90/90.
- The post-handoff posture check passed.

**Fees.** A $1,000 deposit went to the pool ($200) and infra ($800), and the router kept nothing.

### Sepolia sell and upgrade flow (2026-10-28)

**Sell.** Sells opened when the IBR ended. One HMESS sell took the graduated pool back below the threshold (reserve $23,705).

**Upgrade flow.** The V2 test implementation is `HokusaiAMMV2Mock` at `0x163D…1333`. Each bundle was signed 2-of-3 by people on the admin Safe and executed from it:

| Bundle | What it did | Safe transaction |
| --- | --- | --- |
| 01 | Schedule `ProxyAdmin.upgrade` + `factory.callPool(initializeV2)`; operation ID matches `hashOperationBatch` | `0xeaea233c…bb4b` |
| 02 | Cancel it | `0xb97cd429…d5c3` |
| 03 | Pause HMESS (immediate), requeue the upgrade, queue an unpause | `0x2d11837d…0af9` |
| 04 | Execute the unpause, then the upgrade | `0xe63a58e1…e659` |
| 05 | Schedule `freezeUpgrades(HMESS)` | `0xe7a629b0…8945` |
| 06 | Execute the freeze | `0x5320f663…a9fb` |

Between bundles, `sepolia-redeploy.js` checked on-chain and by simulation that:
- executing before the 300s delay reverts ("operation is not ready");
- `ProxyAdmin.upgrade` from the timelock reverts on a paused pool ("Pool exit is closed"), so the queued upgrade fails while paused;
- the admin Safe calling `ProxyAdmin.upgrade` directly reverts ("Ownable: caller is not the owner");
- after bundle 04, HMESS points at V2, emitted `Upgraded(V2)`, ran `initializeV2`, kept its reserve, graduation and anchor supplies, treasury and owner, and took a $500 buy; HLEAD kept the original implementation;
- after bundle 06, `UpgradesFrozen(HMESS)` was emitted and a further upgrade reverts ("Upgrades frozen");
- with V2 added to `upgrades.approvedPoolImplementations` in `deployments/sepolia-latest.json`, `verify-governance` passes 90/90.

**Operator notes.**
- Run each phase only after the previous bundle is executed. `upgrade-4` and `upgrade-6` need the 300s delay to have passed; `upgrade-4` run early records the early-execution rejection and exits.
- A batch that unpauses and then upgrades must keep both calls, in that order, in one Safe transaction. The upgrade alone cannot be simulated while the pool is paused.

## 3. What the rehearsal found

**Fixed on this branch.**
- **RPC reads after deploy.** Pool creation aborted when a load-balanced RPC answered a read from a node that had not seen the new token yet. `create-mainnet-pools.js` now waits for the code.
- **Drain dry-run gas.** The dry run's transactions took ethers' fee estimate, which trails the fork's base fee in a long run. It now pins `maxFeePerGas`.
- **Reuse as libraries.**
  - `launch-mainnet.js` gains `--to <phase>`.
  - `deploy-mainnet.js` exports its config.
  - `drain-dry-run.js` exports `runDrainDryRun`.
  - `get-deploy-signer.js` gains `getKmsSigner(hre, role)`.

**For HOK-3291 (cutover).**
- **Governance inputs:** decide `TREASURY_ADDRESS`, `VERIFIER_ADDRESS` and `BACKEND_SERVICE_ADDRESS`. In July the deployer held all three, which is now refused. The fork used the admin Safe as treasury and the mainnet backend as verifier and backend.
- **Pool CRRs:** confirm them in `mainnet-launch-tokens.json`: HMESS 30%, HLEAD 10%, HROUT 20%.
- **Timelock on a reused deployment:** with `TIMELOCK_ADDRESS` set, `deploy-timelock.js` exits without writing `governance` into the artifact. The handoff writes it later, so the env var must stay set from deploy through handoff.
- **Supplier distribution:** the mainnet tokens use `distributionTiming: post-verification`. Their supplier mints are left as pending actions (`pending-actions.json`), as in July. They need their own timelock bundle at cutover.
- **Monitoring:** the contract-deployer monitor does not watch `Upgraded`, `UpgradesFrozen`, `PoolPaused` or timelock `CallScheduled`/`CallExecuted`. Decision 2026-10-27: add these listeners in HOK-3291, once the pending monitoring work lands. Until then, the rehearsal reads `Upgraded`, `UpgradesFrozen` and trade events directly from chain as evidence.
- **Posture config:** `scripts/configs/mainnet-launch-posture.json` still describes the July deployment. Its `ownershipAudit` has no `PoolProxyAdmin`, though `verify-governance` checks it, and the July deployer is hard-coded.
- **Fee deposits (HOK-3289 AMM-L4):** keep each router fee deposit small relative to the pool reserve.
