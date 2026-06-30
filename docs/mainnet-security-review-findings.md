# Hokusai Pre-Mainnet Security Review — Findings Register

**Review date:** 2026-06-29
**Candidate release commit:** `2000295` (NOT yet frozen)
**Method:** 9 domain-specialized review passes (AMM math, token caps, role/governance, fee routing, vesting/escrow, registry, emergency controls, launch scripts, Echidna/static coverage) + numerical verification of disputed AMM math + retest gate (compile, full `hardhat test`, Slither gate).
**Reviewer:** Claude orchestrated sweep — **all findings require human confirmation before sign-off.**

> **Severity policy.** Critical/High = hard launch blocker. Medium = needs written risk-acceptance from @timogilvie to ship. Low/Info = ship with tracked follow-up. **"Governance-trust" items are mitigated post-handoff by the 48h timelock — they require confirming the timelock wiring + public disclosure, not necessarily a code change.**

---

## Retest Gate Status (candidate commit `2000295`)

| Gate | Result |
|------|--------|
| `npx hardhat compile` | ✅ PASS (exit 0) |
| `npx hardhat test` (full suite) | ✅ **1789 passing, 0 failing**, 98 pending (re-run 2026-06-30 after H-5/H-6 work). The previously-noted `Governance.test.js` `verifyTimelockRoles` failure is **RESOLVED**: it was a test-hermeticity bug — hardhat loaded `.env(.sepolia)` `ADMIN_SAFE_ADDRESS`/`TIMELOCK_ADDRESS` ops vars, which `getGovernanceContext` preferred over the test's self-contained deployment, so the pre-flight checked a Safe the test timelock never granted. Fix clears those env keys in a `before`/`after` and reconciles the DeltaVerifier admin path to the H-3 decision (admin stays at the Safe). See `test/governance/Governance.test.js`. |
| `npm run slither` (gate vs baseline) | ✅ PASS — only Informational (naming, too-many-digits) + Optimization (immutable-states); no new High/Medium. Gate is genuinely blocking. **Note:** the H-2/H-4 Solidity edits shifted `UsageFeeRouter` line numbers, re-hashing 7 already-accepted `reentrancy-no-eth`/`unused-return`/`reentrancy-benign` findings on the (unchanged) `depositFee`/`batchDepositFees` paths; baseline refreshed with those 7 IDs + justifications (`slither-baseline.json`, 166→173 accepted). This is the documented baseline-fragility (location-hash IDs) — no new vulnerability. The refreshed baseline must travel with the frozen commit. |
| `npm run echidna:all` | ⏳ **NOT RUN this pass** (Docker, long) — MUST run on frozen commit. PR gate runs only the shallow 50k pass; trigger the 5M `fuzz-long` via `workflow_dispatch` on the release commit. |
| Numerical AMM round-trip conservation | ✅ PASS — 0.0000% extraction across CRR 5/10/20/50% incl. the ln-scaling region (deposit up to 20× reserve). |

---

## Severity Summary (deduplicated across domains)

| Sev | Count | IDs |
|-----|-------|-----|
| **Launch-sequence gates (BLOCKING)** | 2 | G-1 verify governance handoff + deployer revocation · G-2 `disableLegacyMints()` called & asserted |
| **Critical (code)** | 0 confirmed | AMM C-1/C-2 raised → **defused** (Appendix A) |
| **High** | 6 | H-1 governor token-controller hijack · H-2 `updateModel` desync · H-3 posture gate omits ownership/revocation · H-4 oracle unbounded/staleness-blind fee split · H-5 FundingVault traps user USDC (no recovery) · H-6 fund-holding contracts + Timelock have no Echidna invariants |
| **Medium** | 11 | M-1 escrow `rescue` drain scope · M-2 FundingVault `claim` balance clamp · M-3 reward cap mutable · M-4 contribution dedup · M-5 batch weight-sum · M-6 allocation drift vs lock doc · M-7 reentrancy tests are dead code · M-8 batch fee/pay DoS · M-9 infra-reserve drain (setTreasury+emergencyWithdraw) · M-10 factory `createPool` vs `graduate` role mismatch · M-11 `renounceOwnership`/one-step transfer brick risk |
| **Low/Info** | many | per-domain sections below |

---

## LAUNCH-SEQUENCE GATES (must be satisfied & evidenced before go-live)

These are not code bugs — they are the controls that convert a "single-EOA-controls-everything" deploy into a safe one. The contracts grant `owner`/`DEFAULT_ADMIN_ROLE` to the **deployer EOA** in every constructor; safe posture depends entirely on these steps running and being verified.

### G-1 — Verify governance handoff + deployer revocation on mainnet (BLOCKING)
Run `scripts/governance/transfer-governance.js`, then gate launch on `verify-governance.js` passing for **every** contract in `governance-policy.json`: `owner()`/`DEFAULT_ADMIN_ROLE`/`GOV_ROLE` == 48h `TimelockController`, and `hasRole(deployer) == false`. Archive the verifier output as a launch artifact. **Until this passes, a single deployer EOA can mint, drain (`emergencyWithdraw`, `rescue`), set params (`emergencySetParam`), and pause/unpause everything.** Note H-3: the *launch-posture* gate does NOT check these — `verify-governance.js` is a separate gate that must be run and read.

### G-2 — Call & assert `DeltaVerifier.disableLegacyMints()` before enabling trading (BLOCKING)
Legacy `submitEvaluation*` paths ([DeltaVerifier.sol:297,310,340](contracts/DeltaVerifier.sol#L297-L340)) are gated only by `SUBMITTER_ROLE` (a hot backend key) and mint via `mintReward`/`batchMintReward` **without** attester signatures and **without** the per-model `mintBudgetRemaining` check — bounded only by `maxReward` + a rate limit. They stay live until `disableLegacyMints()` ([:880](contracts/DeltaVerifier.sol#L880)) is called (one-way latch). The launch-posture verifier already asserts `legacyMintsDisabled` ([launch-posture.js:238](scripts/lib/launch-posture.js#L238)) — so this gate is *covered if posture verify is run on mainnet and is green.* Confirm SUBMITTER_ROLE custody regardless.

---

## HIGH FINDINGS

### H-1 — Per-model `governor` can hijack the token controller and bypass mint-budget controls (factory path)
- **Location:** [HokusaiToken.sol:127-131](contracts/HokusaiToken.sol#L127-L131) (`setController` is `onlyOwner`), [TokenDeploymentFactory.sol:56](contracts/TokenDeploymentFactory.sol#L56) (`transferOwnership(governor)`)
- On the mainnet factory path, the token's Ownable owner becomes the per-model `governor` while `controller` stays the TokenManager. A malicious/compromised governor can `setController(attacker)` and mint directly, bypassing the DeltaVerifier attester + per-model budget gate. Reward cap is itself governor-movable (`tokensPerDeltaOne` via GOV_ROLE), so issuance can reach ~1e9 tokens. (Non-factory path: owner is the TokenManager contract, no `setController` caller → safe.)
- **Fix:** don't transfer token ownership to the per-model governor (keep admin Safe/timelock), or make `controller` immutable. **At minimum, assert `governor == admin Safe` for every launch model and add that to the posture verifier.**
- **Status:** ✅ MITIGATED (cheapest path implemented 2026-06-29):
  1. `scripts/configs/mainnet-launch-tokens.json` — added top-level `requiredGovernor` = admin Safe `0x158B…66E2` and set all three token `governor` fields to it (so the pre-handoff token owner is the trusted Safe, identical trust to the controller path).
  2. [launch-tokens.js `loadLaunchTokensConfig`](scripts/lib/launch-tokens.js) — fail-closed: rejects any token whose `governor != requiredGovernor` (regression tests in `test/scripts/launch-tokens.unit.test.js`).
  3. [launch-posture.js](scripts/lib/launch-posture.js) — per-model on-chain assertion that the token `owner()` is the expected authority and not the deployer. Originally `== adminSafe`; reconciled under H-3 to a configurable `expectedTokenOwner` (default `ADMIN_SAFE` for the pre-handoff/test phase, `TIMELOCK` post-handoff on mainnet) so the same check is correct in both launch phases.
  - **Residual (follow-up, not blocking):** the robust contract fix (don't hand token ownership to the per-model governor at all, or make `controller` immutable) remains a recommended post-launch hardening. The mitigation reduces the trust boundary to "compromise the admin Safe," which is the same as every other admin power. ~~Still fill the placeholder `supplierRecipient` addresses before launch.~~ ✅ Filled 2026-06-30 (all three → `0xD1Eb…8136`; loader unit tests green).

### H-2 — `updateModel` / `updateStringModel` silently desyncs pool / genesis / downstream token mappings
- **Location:** [ModelRegistry.sol:506-517](contracts/ModelRegistry.sol#L506-L517)
- `_updateModel` repoints `tokenAddress` + reverse index but not `modelPools`/`poolToStringModel`, `weightGenesis`, or the independent `TokenManager.tokenToModel` / `FundingVault.proposals[].tokenAddress`. Result: AMM pool trades the OLD token while registry/DeltaVerifier mint the NEW one → `ModelTokenMismatch` revert (unmintable) or value misattribution. Owner-key only, but a fat-finger suffices.
- **Fix:** block `updateModel`/`updateStringModel` once a pool is registered, or make it an atomic migration. **Given no production need to re-point tokens, disable for mainnet** and confirm it's not in the runbook.
- **Status:** ✅ MITIGATED (durable, reworkable — implemented 2026-06-29):
  - [ModelRegistry.sol](contracts/ModelRegistry.sol) — added `bool public modelUpdatesEnabled` defaulting to **false**, a `whenModelUpdatesEnabled` modifier on both `updateModel` and `updateStringModel`, and an `onlyOwner setModelUpdatesEnabled(bool)` governance toggle (emits `ModelUpdatesEnabledSet`). Safe-by-default: mainnet is protected with no reliance on a post-deploy step; the gate is a clean seam to rework later (flip on alongside a migration, or replace the gate with a "no pool registered yet" precondition).
  - Confirmed `updateModel`/`updateStringModel` are used by **no** deploy/ops script — only tests (now opt-in via the toggle in their setup).
  - New regression suite `test/ModelRegistry.updateGate.test.js` (default-disabled, blocks both paths, governance can enable/re-disable, event, owner-only, ownership-precedes-gate). Full affected set: **115 passing, 0 failing**; 17 contracts compile clean.
  - **Residual (follow-up):** the proper atomic-migration version of `_updateModel` (clears `modelPools`/`poolToStringModel`/`weightGenesis` + paired TokenManager/FundingVault update) remains the eventual rework; the toggle is the seam for it.

### H-3 — `verify-launch-posture` does not assert ownership-handoff / deployer-revocation (split-gate trap)
- **Location:** [scripts/lib/launch-posture.js:233-441](scripts/lib/launch-posture.js#L233-L441)
- The posture gate checks DeltaVerifier mint posture thoroughly but never checks any Ownable `owner()` or deployer-revocation on ModelRegistry/TokenManager/Factory/tokens/Params/Reserve/Router. Those live in a separate `verify-governance.js`. An operator treating `verify:launch-posture:mainnet` as "the final gate" gets a green light while the deployer EOA may still own everything.
- **Fix:** make posture a composite gate (invoke `verifyGovernance`, or chain npm scripts so non-zero exit fails), or add the ownership/revocation assertions to the posture roleAudit. Ties directly to gate **G-1**.
- **Status:** ✅ MITIGATED (single composite gate — implemented 2026-06-29, decision: DeltaVerifier + DataContributionRegistry admin intentionally stay at the admin Safe; everything else → timelock; deployer revoked everywhere):
  - [launch-posture.js](scripts/lib/launch-posture.js) — the posture verifier now also asserts, as part of the same gate:
    - A new opt-in `ownershipAudit` block: Ownable `owner()` == expected (and ≠ deployer) for ModelRegistry/TokenManager/HokusaiAMMFactory; AccessControl `DEFAULT_ADMIN_ROLE` held by expected (and not by deployer) for InfrastructureReserve/UsageFeeRouter/InfrastructureCostOracle.
    - Per-token: configurable `expectedTokenOwner` (token `owner()`) and `expectedParamsAdmin` (HokusaiParams admin), both required ≠ deployer.
    - New `TIMELOCK` resolver (→ `deployment.governance.timelock`).
  - [mainnet-launch-posture.json](scripts/configs/mainnet-launch-posture.json) — populated `ownershipAudit` (6 contracts → timelock), `expectedTokenOwner: "TIMELOCK"`, `expectedParamsAdmin: "TIMELOCK"`. So a single `verify:launch-posture:mainnet` run (post-handoff) now verifies mint posture **and** full ownership/deployer-revocation.
  - [governance-policy.json](scripts/governance/governance-policy.json) — reconciled DeltaVerifier + DataContributionRegistry `DEFAULT_ADMIN_ROLE` from `TIMELOCK` → `ADMIN_SAFE` (they intentionally stay at the Safe; deployer still revoked) so the two gates no longer contradict each other.
  - Tests: `test/scripts/launchPosture.test.js` "ownership audit (H-3)" — 4 new cases (ownable pass via timelock resolver, ownable **fail when deployer still owns**, accesscontrol pass, token-owner fail→pass on handoff). Posture suite **16 passing** (12 prior + 4). Opt-in design keeps test/sepolia configs unaffected. Script/config only — no Solidity change.
  - **Operator note:** the timelock address must be present at `deployment.governance.timelock` before running the gate; the gate is the post-handoff final check (runbook step 6).
  - **Residual:** still resolve the separate pre-existing `Governance.test.js` `verifyTimelockRoles` failure so `verifyGovernance` itself is exercised end-to-end.

### H-4 — Oracle-driven fee split is unbounded and staleness-blind → can route 100% of fees to infra (starve holders)
- **Location:** [UsageFeeRouter.sol:307-317](contracts/UsageFeeRouter.sol#L307-L317); [InfrastructureCostOracle.sol:89-119](contracts/InfrastructureCostOracle.sol#L89-L119) (`setEstimatedCost` — no max), [:180-187](contracts/InfrastructureCostOracle.sol#L180-L187) (`getEstimatedCost` — no staleness)
- `infrastructureAmount = min(estimatedCost, amount)` where `estimatedCost = costPer1000Calls * callCount / 1000`. No upper bound on cost, no staleness gate (`getLastUpdated` exists but is ignored), and `callCount` is caller-supplied. A high cost (rogue/buggy GOV update or inflated `callCount`) sets `profitAmount = 0` → 100% of usage fees divert to the reserve, token holders accrue nothing. Silent, ongoing — not a revert.
- **Fix:** cap `setEstimatedCost`; consult `getLastUpdated` and fall back/revert when stale; bound `callCount`; add a profit floor so infra can't take 100%. Post-handoff GOV == timelock mitigates the *rogue-update* path but not stale-feed or `callCount` inflation.
- **Status:** ✅ MITIGATED (implemented 2026-06-29; defaults preserve behavior, controls are opt-in by governance):
  - [InfrastructureCostOracle.sol](contracts/InfrastructureCostOracle.sol) — `setEstimatedCost` now requires `costPerThousandCalls <= MAX_COST_PER_THOUSAND_CALLS` (1,000,000 USDC/1000 calls), an always-on hard sanity bound against fat-finger/compromised cost values.
  - [UsageFeeRouter.sol](contracts/UsageFeeRouter.sol) — added two governance knobs (`DEFAULT_ADMIN_ROLE` setters + events):
    - `maxInfraShareBps` (default 10000 = no floor) caps the infra share **in oracle mode**, so a high/stale/manipulated cost or inflated `callCount` can never starve holders below their residual. Applies only to the oracle path; the percentage fallback is already bounded by the model's `infrastructureAccrualBps`.
    - `maxCostAgeSeconds` (default 0 = off) makes the router treat an oracle cost older than the window as stale and fall back to percentage splitting (reads `getLastUpdated`).
  - Note: at launch the configs set `initialOraclePricePerThousandUsd = 0`, so the **percentage fallback (infra 80%) is what runs** — the oracle path is latent, so this hardens it for when it's activated.
  - Tests: `test/UsageFeeRouter.test.js` "Oracle hardening (H-4)" (7 cases: cost cap, infra-share ceiling, staleness fallback, fresh-still-oracle, defaults, setter bounds/events/access) — **fee-routing + oracle suites 121 passing, 0 failing**.
  - **Required at launch IF oracle pricing is activated (checklist item):** set `maxInfraShareBps` (e.g. to the model's `infrastructureAccrualBps`) and a sane `maxCostAgeSeconds` (> the oracle epoch) via governance. Defaults leave both off. `callCount` remains caller-supplied (FEE_DEPOSITOR_ROLE-gated) — the infra-share ceiling bounds its impact.
  - **Residual (follow-up):** consider validating `callCount` against a plausibility bound at the source.

### H-5 — `FundingVault`: announce-without-graduate permanently traps depositor USDC (no recovery path)
- **Location:** [FundingVault.sol:262-284](contracts/FundingVault.sol#L262-L284) (withdraw), [:356-416](contracts/FundingVault.sol#L356-L416) (graduate)
- `announceGraduation()` sets `graduationAnnounced = true`, permanently blocking `withdraw()`; `claim()` requires `graduated == true`, set only inside `graduate()`. If `graduate()` never succeeds (model deactivated, `createPool` reverts, initial AMM buy reverts on slippage/whitelist, etc.), depositors can neither withdraw nor claim. FundingVault has **no Pausable and no rescue/cancel/refund** — zero escape hatch.
- **Fix:** add an admin/timelock `cancelGraduation` (clears the flag while `graduated==false`) or an emergency refund of snapshotted commitments. **Confirm whether FundingVault is on the launch path** — `governance-policy.json` marks it `optional: true`. If used at launch, this is a blocking High; if not, drop to tracked follow-up.
- **Status:** ✅ MITIGATED (escape hatch implemented 2026-06-30):
  - [FundingVault.sol](contracts/FundingVault.sol) — added `cancelGraduation(modelId)` (GRADUATOR_ROLE): requires `graduationAnnounced && !graduated`, clears `graduationAnnounced`, resets `snapshotTotalCommitted`/`claimableAccounts`, emits `GraduationCancelled`. Re-opens `deposit`/`withdraw` so trapped depositors recover. Deliberately does **not** gate on model-active, so it works even after the model is deactivated (the core trap). Live `commitments`/`totalCommitted` untouched → withdrawals stay exact; a later `announceGraduation` re-snapshots cleanly.
  - Tests: `test/FundingVault.test.js` "cancelGraduation (H-5 escape hatch)" — 9 cases incl. the deactivated-model recovery path; **FundingVault suite 73 passing, 0 failing**.
  - **Still confirm launch-path usage** (policy `optional: true`); the escape hatch makes it safe to include either way.

### H-6 — Fund-holding contracts + Timelock have zero Echidna invariants (coverage gap for the "Echidna complete" gate)
- **Uncovered, fund-holding:** `RewardVestingVault` (deep time-state — highest concern), `PendingClaimsEscrow`, `FundingVault`, `UsageFeeRouter`. **Uncovered, critical:** `HokusaiTimelockController` (guards every privileged op — no delay/role invariants fuzzed).
- Existing harnesses (DeltaVerifier, InfrastructureReserve, AMM trio, Token/Manager) are **high quality and meaningfully gating** — the problem is *breadth, not invariant depth*. The InfrastructureReserve conservation pattern (`balance == accrued − paid`, no-overpayment) is directly portable.
- **Fix before holding mainnet funds:** add conservation harnesses for the four fund-holding contracts (vesting first) + a Timelock delay/role harness. This is material to your "Echidna & static testing all completed" launch criterion.
- **Status:** ✅ HARNESSES ADDED (2026-06-30; compile clean — campaigns must run on the frozen commit, Docker daemon was down locally):
  - [EchidnaRewardVestingVault.sol](contracts/echidna/EchidnaRewardVestingVault.sol) — `balance == Σcreated − Σclaimed`, per-schedule `claimed ≤ total` / `vested ≤ total`, `claimable + claimed == vested`, no pre-cliff credit, create/claim access control. (Vesting-first, as recommended.)
  - [EchidnaPendingClaimsEscrow.sol](contracts/echidna/EchidnaPendingClaimsEscrow.sol) — `balance + Σreleased + Σrescued == float`, `totalReleased` accounting, pause blocks releases, role-gating.
  - [EchidnaFundingVault.sol](contracts/echidna/EchidnaFundingVault.sol) — pre-graduation USDC conservation + the H-5 announce→deactivate→cancel→withdraw escape-hatch property.
  - [EchidnaUsageFeeRouter.sol](contracts/echidna/EchidnaUsageFeeRouter.sol) — split conservation + `infra ≤ amount` + H-4 oracle ceiling + staleness fallback.
  - [EchidnaTimelockController.sol](contracts/echidna/EchidnaTimelockController.sol) — no premature/unscheduled execution, `minDelay` enforced, schedule/execute role-gated.
  - Wired into `package.json` (`echidna:vesting|escrow|funding|router|timelock`, all added to `echidna:all`) and `contracts/echidna/README.md`. The `echidna.yml` PR gate runs `echidna:all`, so this branch's PR exercises them.
  - **Residual:** run `npm run echidna:all` (+ 5M `fuzz-long` dispatch) on the frozen commit and record per-harness PASS.

---

## MEDIUM FINDINGS

- **M-1 — `PendingClaimsEscrow.rescue()` drain scope.** [PendingClaimsEscrow.sol:158-168](contracts/PendingClaimsEscrow.sol#L158-L168). `rescue(token,to,amount)` (DEFAULT_ADMIN) can move ANY token (incl. obligated contributor reward tranches) to any address, and works while paused. Post-handoff it's behind the 48h timelock (observable/cancellable), so governance-trust — but restrict to surplus (`balance − outstandingObligations`) or non-protocol tokens. *(Raised by both role-controls and emergency-controls passes.)*
- **M-2 — `FundingVault.claim()` doesn't clamp transfer to held balance.** [FundingVault.sol:453-459](contracts/FundingVault.sol#L453-L459). Floor-division payouts are safe with vanilla fixed-supply HokusaiToken; risk only under fee/rebasing tokens or `sweepDust` misuse. One-line clamp fixes it.
- **M-3 — Reward "cap" recomputed live from mutable param.** [HokusaiToken.sol:154-163,269-275](contracts/HokusaiToken.sol#L154-L163). `rewardCap = REWARD_CAP_MULTIPLIER * tokensPerDeltaOne()`; raising the param (GOV, no delay) unlocks more headroom → reward supply is governance-bounded, not a hard cap. Store immutable cap if a true ceiling is intended, else document.
- **M-4 — Contribution hash double-count.** [DataContributionRegistry.sol:101-156](contracts/DataContributionRegistry.sol#L101-L156). No uniqueness check on `contributionHash`; aggregates inflate on re-record. `RECORDER_ROLE`-gated. Add `require(hashToContribution[hash]==0)`.
- **M-5 — Batch weight sum can exceed 100%.** [DataContributionRegistry.sol:204-242](contracts/DataContributionRegistry.sol#L204-L242). Per-record capped at 10000 bps but batch sum unchecked. **Escalates to HIGH if DeltaVerifier reward math sums these additively — confirm.**
- **M-6 — Launch allocations contradict the signed parameter-lock doc.** `mainnet-launch-tokens.json` (HMESS 2.5M/10M, HLEAD 1.25M/5M, HROUT 5M/20M) vs [parameter-lock doc:30-32](docs/mainnet-launch-token-parameter-lock.md#L30-L32) (1M/10M). The drift-guard test only checks `tokensPerDeltaOne`/vesting/maxReward/budget — allocation drift passes CI silently and `maxSupply` derives from it. Configs also still contain `0xPLACEHOLDER_*` supplier/governor addresses (fail-closed at runtime) and placeholder attester/relayer/weight-genesis in `mainnet-launch-posture.json` (writing a placeholder weight-genesis is **write-once**). Reconcile + re-sign; fill placeholders; extend the consistency test to allocations.
- **M-7 — Reentrancy tests are dead code (false assurance).** [ReentrantFeeRecipient.sol](contracts/mocks/ReentrantFeeRecipient.sol) reenters via ETH `receive()`, but the flow is ERC20 push — the mock is referenced by **no test**. The "reentrancy protection" tests are happy-path only. Guards (`nonReentrant`) ARE present and `reserveToken` is immutable USDC, so residual risk is low — but don't represent this as reentrancy coverage. Wire a real malicious-ERC20 reentrancy test or delete the mock + document the trusted-token assumption.
- **M-8 — Batch fee/pay DoS.** [UsageFeeRouter.sol:217-267](contracts/UsageFeeRouter.sol#L217-L267) and `InfrastructureReserve.batchPayInfrastructureCosts`. One reverting pool/payee (paused pool, USDC-blacklisted address) reverts the whole batch. Add per-item `try/catch` or pull payments; keep batches small + pre-validated.
- **M-9 — Infra reserve redirect-then-drain.** [InfrastructureReserve.sol:495-503,523-537](contracts/InfrastructureReserve.sol#L495-L537). `setTreasury` + `emergencyWithdraw` (both DEFAULT_ADMIN, the latter not even `whenPaused`) let admin drain the reserve anywhere. Protocol funds, not user deposits → governance-trust. Timelock-gate + require `whenPaused` on `emergencyWithdraw`.
- **M-10 — Factory `createPool*` (`onlyOwner`) vs `FundingVault.graduate()`.** [HokusaiAMMFactory.sol:142-267](contracts/HokusaiAMMFactory.sol#L142-L267) vs [FundingVault.sol:371](contracts/FundingVault.sol#L371). Post-handoff factory owner = timelock, so `graduate()`'s `createPool` call reverts; making FundingVault the owner instead would brick factory admin/pause. Add a dedicated `POOL_CREATOR_ROLE`. Conditional on FundingVault being on the launch path (see H-5).
- **M-11 — `renounceOwnership` / one-step transfer brick risk.** Factory/Registry/TokenManager/tokens are plain `Ownable` (not `Ownable2Step`) with `renounceOwnership` un-overridden. Owner can permanently brick pause/admin; one-step handoff has no acceptance step. Migrate to `Ownable2Step` + override `renounceOwnership` to revert, or operationally guarantee renounce is never called and double-verify the handoff address.

---

## LOW / INFO (selected)

- **AMM L-1:** `sell()` with `minReserveOut=0` + zero quote burns tokens for 0 USDC — add `require(reserveOut>0)`. [HokusaiAMM.sol:289](contracts/HokusaiAMM.sol#L289)
- **AMM L-2:** Fees round to zero on sub-~334µUSDC dust — round fees up / min trade size. [FeeLib.sol:62-64](contracts/libraries/FeeLib.sol#L62-L64)
- **AMM L-3:** `spotPrice()` unit scale differs flat vs curve (~1e14× discontinuity at graduation) — normalize; confirm no on-chain consumer keys slippage off raw value.
- **AMM L-4 (cosmetic):** Misleading comment at [HokusaiAMM.sol:299](contracts/HokusaiAMM.sol#L299) ("fee stays in reserve" — actually goes to treasury; math correct).
- **AMM L-5:** Permissionless `depositFees` can force permanent graduation (by design; benefits holders) — document/optionally gate. [HokusaiAMM.sol:610](contracts/HokusaiAMM.sol#L610)
- **Registry L-1:** AMM whitelist gates `msg.sender` but not `to` — confirm payer-only KYC vs recipient gating. **Whitelist enforcement is also fuzz-disabled** (`purchaserWhitelist=address(0)` in AMM harnesses) — fuzz with it ON if launch is permissioned.
- **Registry L-2:** `_isCanonicalStringModelId` accepts leading-zero strings ("007"→7 aliasing) — reject leading zeros.
- **Vesting L-1:** vesting `start` = creation time, not earn-time (policy — confirm). FundingVault uses raw ERC20 returns vs SafeERC20 (fine for USDC).
- **Slither baseline:** 166 accepted findings, dominated by reentrancy-family (benign). **Manually re-eyeball the 17 baselined `unused-return` + 4 `incorrect-equality` on fund-handling code** — a swallowed transfer/approve return is exactly the class that matters at launch.
- **Echidna depth:** `testLimit=50000, seqLen=100` is thin for IBR→graduation crossing and DeltaVerifier lineage; the 5M `fuzz-long` runs only on schedule/dispatch, **not** the release PR. Echidna PR trigger is path-filtered on `contracts/**` — a script/config-only release commit won't trigger it.

### Verified SAFE (notable positives)
- ✅ **No hardcoded 500k** anywhere; `tokensPerDeltaOne` config-bounded [100, 10,000,000] whole tokens; launch configs all use **250000** and a blocking CI test asserts `!= 500000`. (Pin + assert post-deploy.)
- ✅ modelId-0 / address(0) edge **safe** (guarded by `isTokenRegistered`).
- ✅ Investor/supplier/reward allocations **independent — no cross-pool leak**; vesting claim **replay/double-claim safe** (CEI + nonReentrant); DeltaVerifier mint-request **replay-safe** (idempotency key + EIP-712 deadline + ascending-signer threshold); mint-budget **no double-spend/off-by-one**.
- ✅ Fee-routing **sum-to-100% conserves wei** (no dust bucket); infra payout **no double-claim / no pay-before-accrual** (CEI).
- ✅ Slither gate **genuinely blocking** (keyed by finding hash, not detector); Timelock config correct (48h mainnet, closed proposer/executor = Safe, deployer TIMELOCK_ADMIN revoked, no standing timelock admin).
- ✅ **No missing access-control** on any fund-moving function (only intentional permissionless: `buy`/`sell`/`depositFees`, `applyPendingUpdates`, `suggestCostAdjustment`).

---

## Appendix A — Disputed AMM "Criticals" (raised → investigated → defused)

**C-1 "Sell fee drains reserve" → FALSE POSITIVE.** [HokusaiAMM.sol:297-325](contracts/HokusaiAMM.sol#L297-L325): `reserveAfterFee + feeAmount == reserveOut`; seller gets `reserveAfterFee`, treasury gets `feeAmount` (total = `reserveOut`), and `reserveBalance -= reserveOut`. Tracked reserve and actual USDC drop by exactly the same amount — standard symmetric fee, seller pays it. No value at risk (only the misleading comment, AMM L-4).

**C-2 "Broken `ln()` scaling (off by k·ln3)" → REAL deviation, NOT exploitable.** [BondingCurveMath.sol:161-163](contracts/libraries/BondingCurveMath.sol#L161-L163) adds `k*PRECISION` instead of `k*ln(3)` outside `[1/3,3]`. But buy and sell use the *same* `ln`, so the curve is self-consistent. **Numerically verified** buy→sell round-trips across CRR 5/10/20/50% and trade sizes to 20× reserve (forcing `k≠0`): worst-case extraction **0.0000%**; sells always return ≤ deposit. The curve simply isn't the textbook Bancor formula. **Follow-up (not a blocker):** migrate to a vetted fixed-point pow (PRBMath/Bancor) and extend Phase2-Power-Function-Security to the ln-scaling region — do NOT alter the formula on a live pool without migration.

---

## Open Actions Before Freeze

| # | Action | Owner | Done |
|---|--------|-------|------|
| G-1 | Run + verify governance handoff (`verify-governance.js` green for all policy contracts; deployer revoked) | | ☐ |
| G-2 | Call + assert `disableLegacyMints()` on mainnet before trading | | ☐ |
| H-1 | Confirm `governor == admin Safe` for all launch models (or change factory handoff) | | ✅ mitigated (config+guard+posture assertion); fill `supplierRecipient`s |
| H-2 | Disable/gate `updateModel`/`updateStringModel` for mainnet | | ✅ done (default-off `modelUpdatesEnabled` toggle + tests) |
| H-3 | Add ownership/revocation assertions to posture gate (or chain `verify-governance`) | | ✅ done (composite gate: `ownershipAudit` + token/params owner checks + policy reconciled; 16 posture tests) |
| H-4 | Cap oracle cost + staleness gate + profit floor in fee router | | ✅ done (cost cap + `maxInfraShareBps` + `maxCostAgeSeconds`); set the two router knobs IF oracle pricing is enabled |
| H-5 | Confirm FundingVault launch-path; if used, add cancel/refund recovery | | ✅ `cancelGraduation` escape hatch + 9 tests (still confirm launch-path usage) |
| H-6 | Add Echidna harnesses for vault/escrow/funding-vault/router + Timelock; run 5M fuzz-long on frozen commit | | ✅ 5 harnesses added + wired (compile clean); ☐ run campaigns on frozen commit |
| M-5 | Confirm whether contribution weights feed on-chain payouts (escalates M-4/M-5) | | ☐ |
| M-6 | Reconcile launch allocations vs lock doc + re-sign; fill all placeholder addresses | | ☐ |
| — | Run `npm run echidna:all` (+ fuzz-long dispatch) on frozen commit; record results | | ☐ |
| — | Sepolia delta check from frozen commit (`verify:launch-posture:sepolia`) | | ☐ |
| — | Review 17 baselined `unused-return` + 4 `incorrect-equality` on fund-handling code | | ☐ |
| — | **Declare freeze; tag `mainnet-rc1`; record approver signature** | | ☐ |
