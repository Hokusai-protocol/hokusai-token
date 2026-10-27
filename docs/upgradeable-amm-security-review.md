# Upgradeable-AMM Release: Security Review (HOK-3289)

**Review date:** 2026-10-22
**Reviewed commit:** `2332beb` (main after PR #241: HOK-3270, 3300, 3281, 2450, 3283, 3285)
**Re-reviewed:** 2026-10-27 on `5fa7048` (HOK-3317, PR #243) and `71dc6b9` (HOK-3323, PR #244). See [Re-review](#re-review).
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

**Clear to rehearse (HOK-3290) on `71dc6b9`.**

- **Highs:**
  - AMM-H1 (early-seller extraction at graduation) is fixed by HOK-3317.
  - GOV-H1 is accepted for the redeploy and documented.
- **Re-review:** found one new Medium, AMM-M2 (pre-graduation fees captured by the graduating buyer). It is fixed by HOK-3323.
- **Everything else:** every other Medium/Low is fixed, accepted in writing, or tracked.

On 2026-10-22 the verdict was "not clear until HOK-3317 lands and this review re-runs".

## Gates on `2332beb`

| Gate | Result |
| --- | --- |
| `npx hardhat compile` | PASS |
| `npm test` | PASS: 1875 passing, 0 failing, 98 pending |
| `npm run validate:upgrades` | PASS. This gate is weak: see PROXY-M1. |
| `npm run slither` (gate vs baseline) | PASS: only informational and optimization findings are new |
| Echidna `fuzz-short` (`npm run echidna:all`) | PASS. Run 39820934117, dispatched on `2332beb`. The Echidna workflow had been disabled by GitHub for inactivity since 2026-07-09, so it did not run on PRs #235–#241. Re-enabled 2026-10-22. |
| Echidna `fuzz-long` (5M per harness) | INCOMPLETE. Same run: no property violated. 6 harnesses finished (TimelockController, UsageFeeRouter, AMMPhase, HokusaiToken, Sanity, PendingClaimsEscrow). 8 hit the 3h job limit and were cancelled (FundingVault, InfrastructureReserve, DeltaVerifier, DeltaVerifierMultiAttester, AMMEconomic, TokenManager, AMMReserve, RewardVestingVault). Full coverage is re-run at the re-review with a longer limit or a smaller test count. |

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
| AMM-H1 | **Graduation price jump lets early sellers drain flat-phase holders.** The flat phase puts exactly `p` into the reserve per token, so at graduation R ≈ p·S, and the curve prices at R/(w·S) ≈ p/w (5× at CRR 20%). PoC (victim buys $16.5k flat; attacker buys $8.6k across the threshold, then sells in chunks in one transaction): attacker **+$13.3k**, victim's tokens redeem for $3.1k. The HOK-3270 latch keeps curve pricing on. Without the latch it is worse: repeated cross-and-dip drains the reserve to $0 (+$16.2k). Natural graduation produces the same bank run. The whitelist does not help, because `sell` and `depositFees` are not gated. | **Fixed in HOK-3317** (PR #243, `5fa7048`). CRR stays 20% and the latch stays. After graduation, the reserve backs the supply along one curve, anchored at the graduation supply, with the price continuous at graduation. The regression tests in `test/security/graduationExtraction.test.js` are un-skipped and pass at CRR 20/50/100%. The new Echidna harness `EchidnaAMMGraduation` passes. |
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
| AMM-M1 | Flat-phase sells pay `p` for unlocked supplier and reward supply the reserve never received, so the reserve is economically undercollateralized for the last sellers. | **Accepted** (decision 2026-10-26: keep flat sells at `p`). After graduation, the reserve backs the supply pro rata and unbacked supply dilutes every holder evenly. Before graduation the exposure remains. It includes the reverse of AMM-M2: unlocks push R/S below `p`, the buy price stays `p`, and graduation reprices to R/S. |

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
| AMM-L1 | `BondingCurveMath.ln` is used outside its convergent range and adds `k` instead of `k·ln3`. Errors favour the pool, but quotes are wrong for large deposits. | **Fixed in HOK-3317**: `pow`/`ln`/`exp` now use PRBMath 4.1.0. |
| AMM-L2 | `sell()` lacks `reserveOut > 0`. | **Fixed in HOK-3317**: such sells revert with "Insufficient output". |
| AMM-L3 | `setParameters` can change CRR after graduation, which rescales the price (the same extraction as AMM-H1). It is timelocked. A HokusaiAMM comment still says the factory forwards only whitelist and pause calls. | **Fixed in HOK-3317**: CRR is fixed after graduation and the comment is corrected. |

### Info

- **SCRIPT-I1:** `scripts/authorize-amm-pools.js` and `check-minter-role.js` encoded the removed pools-hold-`MINTER_ROLE` model. **Removed here.**
- **AMM-I1:** the Echidna AMM harnesses cannot see cross-holder extraction:
  - a single actor;
  - fees go back to the attacker;
  - one-shot sells over the cap revert silently.

  **Fixed in HOK-3317:** `EchidnaAMMGraduation` adds a victim holder, plus an attacker that crosses the threshold, sells in chunks, re-crosses, deposits fees and toggles the whitelist. The harness fails on `2332beb`'s code (attacker +$13,262) and passes after the fix.
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

**Date:** 2026-10-26/27.
**Commits:** `5fa7048` (HOK-3317 merged), then `71dc6b9` (HOK-3323 merged).
**Method:**
- The gates below.
- The un-skipped extraction PoCs.
- The new Echidna harness.
- An independent adversarial pass over the new pricing code by a fresh-context reviewer agent, with each finding reproduced by hand.

### Gates

| Gate | Result |
| --- | --- |
| `npm test` | PASS on `71dc6b9`: 1902 passing, 0 failing, 98 pending. This includes `graduationExtraction` (6, un-skipped) and `HokusaiAMM.continuity` (13). |
| `npm run validate:upgrades` | PASS. The 2 new slots (`graduationSupply`, `anchorBasisSupply`) come after `minTradeCap`, and `__gap` goes from 35 to 33. Checked by hand as well (PROXY-M1 still applies). |
| `npm run slither` | PASS. The only gating IDs were line-shift drift of accepted HokusaiAMM `buy`/`depositFees`/`withdrawTreasury` findings. They were re-accepted with approval on PRs #243 and #244. |
| Echidna `fuzz-short` | PASS on PRs #243 and #244, including `EchidnaAMMGraduation`. In `EchidnaAMMEconomic`, `echidna_sell_does_not_improve_exit_quote` now allows the sub-wei round-down that a pro-rata sell leaves in the reserve (≤ amount/remainingSupply + 1 wei). |
| Echidna `fuzz-long` | PASS on `5fa7048`: run 40432560025, all 15 harnesses complete with no violation. PASS on `71dc6b9` (run 40513691209): all 15 harnesses report no violation. 12 reached the 5M test limit. 3 stopped at the 150-min Echidna timeout instead: AMMEconomic, InfrastructureReserve and RewardVestingVault. 8 of 15 jobs used to be cancelled at the 3h job limit. This branch fixes that: Echidna now stops itself at 150 min with 4 workers, so every job reports a verdict. |

### New findings

| ID | Finding | Status |
| --- | --- | --- |
| AMM-M2 | **Fees deposited before graduation are captured by the graduating buyer.** Fees raise R above S·p, but flat-phase buys still paid `p`. Graduation reprices holders pro rata at R/S, so a buyer just before graduation takes a share of earlier holders' fees. PoC (CRR 20%): Alice buys $5k, $5k of fees is deposited, then Eve buys $15.1k across the threshold and sells everything for **+$3,652**. | **Fixed in HOK-3323** (PR #244, decision 2026-10-26). Flat-phase buys pay max(`p`, R/S) and sells stay at `p`. The flat part of a crossing buy uses the same price, so pricing stays continuous at graduation. Regression tests are in `HokusaiAMM.continuity.test.js`. |
| AMM-L4 | **`depositFees` can be front-run (JIT) after graduation.** Fees are shared pro rata, so buying just before a large deposit and selling after earns about E·F/(R+E) − 2·fee·E. That is profitable once a deposit exceeds about 0.6% of R. PoC: R ≈ $100k and a $5k deposit gives +$709 at the max trade size. | **Accepted.** This is inherent to pro-rata fee sharing (the user ruled that fees count the same as investor money). Mitigate operationally: keep each router deposit small relative to the pool reserve, or drip deposits in. Settlement sizing goes into the HOK-3291 runbook. |
| AMM-I2 | Fees deposited while the redeemable supply is 0 (graduation by fees alone, or after every holder has sold) go to the next buyer. That buyer enters at the flat price and can redeem the whole reserve. | **Accepted.** There are no holders to dilute. Don't route fees to a pool with no holders. |
| AMM-I3 | **Do not upgrade a graduated pool in place from the pre-HOK-3317 implementation.** The anchor slots would read 0, so `_anchorSupply` returns S and the spot price drops from R/(wS) to R/S (5× at CRR 20%), which can be sold into around the upgrade. | **N/A for the redeploy:** every pool is fresh. A future upgrade from a pre-anchor layout needs a reinitializer that sets the anchor. |
| AMM-I4 | In a nearly empty pool (S below roughly S_g/anchor wei), the rescaled anchor can round to 0, and the next buyer is priced at the flat price. | **Accepted.** This is dust. |

### Checked and found sound (pricing)

- **Rounding:**
  - Every `mulDiv` rounds down, in the pool's favour.
  - PRBMath `pow` error is about 1e-17 relative (about 1e-5 wei at R = $1M).
  - 60 round trips at dust size lost 60 wei.
  - Afterwards, a sell of the whole supply quoted exactly R, and R equalled the USDC balance.
- **Solvency and edge cases:**
  - Selling exactly the supply returns R exactly.
  - `tokensIn > supply`, R = 0 and S = 0 return 0 and revert with "Insufficient output".
- **Anchor rescaling:** burning tokens or sending them to the vault always loses the attacker money. Holders stay pro rata, and the vault has no sweep function.
- **Crossing buy:**
  - The flat/curve split is consistent.
  - The fee is taken once on the gross amount.
  - Spot after crossing equals the flat-phase buy price.
- **Views:** `getBuyQuote`/`getSellQuote` share `_buyQuote`/`_sellQuote` with execution, and the impact views match the spot price after the trade.
- **Reentrancy:** the reserve and anchor are written under `nonReentrant`, and there are no token callbacks.
- **DoS:** `pow` overflows only at CRR 5% beyond about 776×S_g (known). At CRR 20% the limit is about 2^48×S_g.

### Known economic consequences (not findings)

- **Thin curve after graduation:** the curve reserve starts at w × threshold, so a $5k buy moves the price ×1.74.
- **CRR:** fixed after graduation.
