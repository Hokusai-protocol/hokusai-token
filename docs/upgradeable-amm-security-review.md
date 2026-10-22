# Upgradeable-AMM Release: Security Review (HOK-3289)

**Review date:** 2026-10-22
**Reviewed commit:** `2332beb` (main after PR #241: HOK-3270, 3300, 3281, 2450, 3283, 3285)
**Kind:** internal review. No independent reviewer was engaged (outreach and spend are out of scope for HOK-3289).
**Reviewer:** Claude (Opus 5.5), five read-only domain passes run in parallel, with every Critical/High finding and a sample of others re-verified by hand against the code. Decisions by @timogilvie.
**Method:**
1. Domain passes:
   - proxy/initializer/storage;
   - authority chain and deployment/governance posture;
   - per-model mint/burn scoping;
   - AMM economics and graduation;
   - fee routing and infrastructure reserve.
2. Executable PoCs for economic findings (`test/security/graduationExtraction.test.js`).
3. The release gates listed below.

> **Severity policy** (unchanged from the June review). Critical/High block the release. Medium needs a fix or written risk acceptance. Low/Info ship with a tracked follow-up. Powers that sit behind the 48h timelock are graded as governance trust.

## Verdict

**Not clear to rehearse (HOK-3290) until HOK-3317 lands and this review re-runs on the fixed commit.**

There is one unresolved High: AMM-H1, early-seller extraction at graduation. The other High (GOV-H1) is accepted for the redeploy and documented. The Medium/Low items are fixed on this branch or tracked.

## Gates on `2332beb`

| Gate | Result |
| --- | --- |
| `npx hardhat compile` | PASS |
| `npm test` | PASS: 1875 passing, 0 failing, 98 pending |
| `npm run validate:upgrades` | PASS. This gate is weak: see PROXY-M1. |
| `npm run slither` (gate vs baseline) | PASS: only informational and optimization findings are new |
| Echidna `fuzz-short` (`npm run echidna:all`) | PASS. Run 39820934117, dispatched on `2332beb`. The Echidna workflow had been disabled by GitHub for inactivity since 2026-07-09, so it did not run on PRs #235–#241. Re-enabled 2026-10-22. |
| Echidna `fuzz-long` (5M per harness) | INCOMPLETE. Same run: no property violated. 7 harnesses finished (TimelockController, UsageFeeRouter, AMMPhase, HokusaiToken, Sanity, PendingClaimsEscrow, plus fuzz-short). 8 hit the 3h job limit and were cancelled (FundingVault, InfrastructureReserve, DeltaVerifier, DeltaVerifierMultiAttester, AMMEconomic, TokenManager, AMMReserve, RewardVestingVault). Full coverage is re-run at the re-review with a longer limit or a smaller test count. |

The fuzzers passing while AMM-H1 exists is itself a finding (AMM-I1). The June review's "0% round-trip extraction" check measured a single actor and never a victim holder.

## Findings

Status key:
- **Fixed here:** on this branch (HOK-3289).
- **HOK-3317:** the AMM continuity issue (blocks HOK-3290).
- **HOK-3318:** token ownership under the timelock.
- **HOK-3291:** cutover work.
- **Accepted:** a documented risk.

### High

| ID | Finding | Status |
| --- | --- | --- |
| AMM-H1 | **Graduation price jump lets early sellers drain flat-phase holders.** The flat phase puts exactly `p` into the reserve per token, so at graduation R ≈ p·S, and the curve prices at R/(w·S) ≈ p/w (5× at CRR 20%). PoC (victim buys $16.5k flat; attacker buys $8.6k across the threshold, then sells in chunks in one transaction): attacker **+$13.3k**, victim's tokens redeem for $3.1k. The HOK-3270 latch keeps curve pricing on. Without the latch it is worse: repeated cross-and-dip drains the reserve to $0 (+$16.2k). Natural graduation produces the same bank run. The whitelist does not help, because `sell` and `depositFees` are not gated. | **HOK-3317** (decision 2026-10-22: keep CRR 20% and the latch, and add a targeted continuity fix). Regression tests: `test/security/graduationExtraction.test.js` (skipped until HOK-3317). |
| GOV-H1 | **Safe-held powers bypass the 48h notice.** The per-model token owner (admin Safe) can call `setController` with no delay. It can block every sell (a "pause" the ProxyAdmin cannot see) or mint up to the cap headroom and sell into the pool. DeltaVerifier admin and params `GOV_ROLE` give similar paths. The trust-model doc claimed 48h of notice without qualification. | **Accepted** for the redeploy (decision 2026-10-22). The doc is corrected (Residual trust outside the timelock). Monitoring for `ControllerUpdated` and similar is in HOK-3291. Fix tracked in **HOK-3318**. |

### Medium

| ID | Finding | Status |
| --- | --- | --- |
| PROXY-M1 | `validate:upgrades` compares `HokusaiAMM` with a mock that inherits it, so a layout change can never fail it. There is no released reference layout (no `.openzeppelin` manifest or frozen source). | **HOK-3291**: commit the deployed implementation source (or manifest) at the redeploy and validate against it. Documented under "Writing upgrades". |
| PROXY-M2 | `HokusaiPoolProxyAdmin` needed `paused()` to succeed. An implementation whose `paused()` reverted could never be upgraded again, because the admin is fixed. | **Fixed here**: the state read is wrapped in try/catch, so a reverting implementation can be replaced. Test: `HokusaiPoolProxyAdmin.test.js`. |
| GOV-M1 | The exit-safe rule ignored the buy-only (IBR) period, so a pool could be upgraded before its holders could ever sell. | **Fixed here**: `PoolPauseReader.canExit` requires not paused and `isSellEnabled()`. |
| GOV-M2 | `verify-governance` audited `getSigners()[0]` instead of the recorded deployer. Under Ledger/KMS it would audit the wrong address and pass. | **Fixed here**: it uses `deployment.deployer`. |
| GOV-M3 | `TREASURY_ADDRESS`/`VERIFIER_ADDRESS` fell back to the deployer. That made it the permanent pool treasury and the `InfrastructureReserve` payer, and `deployerRevokedRoles` then exempted it. | **Fixed here**: both are required for mainnet. The handoff refuses, and the verifier fails, when any policy symbol resolves to the deployer. |
| FEE-M1 | `batchDepositFees` reverted when any entry had a zero infrastructure share (oracle model with `callCount=0`, tiny amounts), stalling settlement. | **Fixed here**: zero entries are left out of the reserve batch. |
| AMM-M1 | Flat-phase sells pay `p` for unlocked supplier and reward supply the reserve never received, so the reserve is economically undercollateralized for the last sellers. | **HOK-3317** (settle with the continuity design). |

### Low

| ID | Finding | Status |
| --- | --- | --- |
| PROXY-L1 | Pauser can veto a scheduled upgrade by pausing first. | Accepted and documented (schedule `[unpause, upgrade, pause]` as one batch). |
| PROXY-L2 | `upgradeAndCall` cannot run an `onlyOwner` reinitializer (the owner is the factory). | Documented: batch `upgrade` with `callPool(reinit)`. |
| PROXY-L3 | `setPoolDeployer` (set-once) did not check the deployer is bound to this factory. | **Fixed here**. |
| REG-L1 | Leading-zero model IDs (`"01"`) aliased an existing number for registered/active checks but keyed a separate pool and TokenManager entry. | **Fixed here**: non-canonical IDs are rejected. |
| TM-L1 | Anyone can squat the next model ID in `DeployableTokenManager` (deploy functions are permissionless; `DEPLOYER_ROLE` gates nothing). `create-mainnet-pools.js` refuses a token whose governor is wrong, so the impact is denial of service. | Accepted. Follow-up: gate deploys behind `DEPLOYER_ROLE`. |
| FEE-L1 | The router trusted the pool to pull its approved fees. A faulty upgraded pool could strand USDC in the router. | **Fixed here**: the router requires the pool to take the exact approval. |
| FEE-L2 | `InfrastructureReserve` pause (fast) halts all fee settlement, and unpause is timelocked. | Accepted. Fees stay with the backend. |
| FEE-L3 | `emergencyWithdraw` (timelocked) leaves per-model `accrued` unbacked. | Accepted. Follow-up. |
| GOV-L1 | The verifier only checked pools listed in the artifact. | **Fixed here**: it compares against the factory's on-chain `poolCount`. |
| GOV-L2 | The verifier did not check the timelock delay or the deployer's proposer/executor/canceller roles. `deploy-timelock` ignored `TIMELOCK_ADDRESS`. | **Fixed here**: 48h floor on mainnet, no deployer timelock roles, `TIMELOCK_ADDRESS` honored. |
| GOV-L3 | Launch-posture `ownershipAudit` lacks `PoolProxyAdmin`, and `DEPLOYER` prefers a hard-coded address. | **HOK-3291** (new posture config for the redeploy; the current one describes the July deployment). |
| AMM-L1 | `BondingCurveMath.ln` is used outside its convergent range and adds `k` instead of `k·ln3`. Errors favour the pool, but quotes are wrong for large deposits. | **HOK-3317**. |
| AMM-L2 | `sell()` lacks `reserveOut > 0`. | **HOK-3317**. |
| AMM-L3 | `setParameters` can change CRR after graduation, which rescales the price (the same extraction as AMM-H1). It is timelocked. A HokusaiAMM comment still says the factory forwards only whitelist and pause calls. | **HOK-3317**. |

### Info

- **SCRIPT-I1:** `scripts/authorize-amm-pools.js` and `check-minter-role.js` encoded the removed pools-hold-`MINTER_ROLE` model. **Removed here.**
- **AMM-I1:** the Echidna AMM harnesses cannot see cross-holder extraction:
  - a single actor;
  - fees go back to the attacker;
  - one-shot sells over the cap revert silently.

  HOK-3317 adds a victim-holder property.
- **FEE-I1:** with an oracle cost set, the backend's `callCount` controls the split. Set `maxInfraShareBps` and `maxCostAgeSeconds` before giving any model an oracle cost.
- **FEE-I2:** `suggestCostAdjustment` is permissionless. It emits events only.
- **TM-I1:** the `HokusaiToken.burnFrom` NatSpec says "using allowance"; it does not use one. Privileged burn without allowance is listed in the trust model.
- **PROXY-I1:** a freeze holds only while the implementation has no storage-write primitive. Now documented.

## Checked and found sound

- **Implementation and initialization:**
  - The implementation is locked (`_disableInitializers`).
  - `initialize` runs in the proxy constructor, so it cannot be front-run.
  - The bases are upgradeable variants, with 15 slots plus `__gap[35]`.
  - There are no immutables, `selfdestruct` or `delegatecall`.
- **ProxyAdmin:**
  - `upgrade` and `upgradeAndCall` both run the exit and freeze checks.
  - `changeProxyAdmin` is disabled.
  - The freeze is one-way and per proxy.
  - Users cannot reach the admin functions.
- **`callPool`:** blocks pool `transferOwnership`/`renounceOwnership` (and calldata shorter than a selector). It cannot reach upgrade functions, and unpause through it is timelocked.
- **TokenManager pool scoping:**
  - A pool for model A cannot mint or burn model B's token.
  - The token comes from write-once `modelTokens`.
  - Pools burn only their own balance.
  - Pools hold no `MINTER_ROLE`.
- **Router:**
  - The pool is resolved only through `ModelRegistry.getPool`.
  - Fees are conserved on the single and batch paths, with infra rounded down and the dust going to the pool.
  - It is `nonReentrant`.
  - Approvals are exact.
- **AMM mechanics:**
  - Quotes equal execution.
  - Slippage and deadline are enforced on both sides.
  - `withdrawTreasury` cannot touch `reserveBalance`.
  - The latch is set only by `buy` and `depositFees`.
- **Handoff:** every constructor- or script-granted deployer role is in `revokedFromDeployer`, and the SUBMITTER/RECORDER regression from the July launch is fixed.

## Re-review

HOK-3317 changes pricing, so this review re-runs on its merge commit:
- the gates above;
- the regression tests in `test/security/graduationExtraction.test.js`, un-skipped;
- the new Echidna property;
- `fuzz-long`;
- a focused pass over the new pricing code.
