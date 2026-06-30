# Hokusai Pre-Mainnet Security Review Checklist

**Status:** IN PROGRESS — sweep running
**Release commit:** `2000295` (feat HOK-2171, Gate 10b Echidna extensions) — **CANDIDATE, not yet frozen**
**Toolchain:** solc 0.8.20, optimizer runs=200, viaIR=true (hardhat.config.js)
**Owner:** @timogilvie
**Gate decision:** Launch is BLOCKED until every Critical/High is `Fixed + Retested` and every section below is checked.

---

## How to use this document

Each item has a state: `[ ]` not started · `[~]` in progress · `[x]` pass · `[!]` finding (see Findings Register). A finding at **Critical** or **High** is a hard launch blocker. **Medium** requires a written risk-acceptance sign-off from @timogilvie to ship. **Low/Info** may ship with a tracked follow-up.

The companion **Findings Register** (`docs/mainnet-security-review-findings.md`) is the authoritative list of issues, severities, and fix/retest status. This file is the *coverage* checklist; that file is the *issue* tracker.

---

## 0. Release Freeze Protocol (governs everything below)

- [ ] Release commit SHA recorded here and in the deployment runbook.
- [ ] All Critical/High findings fixed, re-reviewed, and retested **on the frozen commit**.
- [ ] `npx hardhat compile` clean on frozen commit.
- [ ] `npx hardhat test` 100% green on frozen commit (record pass/fail counts).
- [ ] Slither gate green (no new High/Medium vs baseline) on frozen commit.
- [ ] Echidna suite (`npm run echidna:all`) green on frozen commit (record per-harness status).
- [ ] Sepolia delta check: redeploy/verify-launch-posture on Sepolia from the frozen commit, confirm parity with intended mainnet posture.
- [ ] **FREEZE DECLARED** — commit tagged (e.g. `mainnet-rc1`), approver signature recorded.
- [ ] **Post-freeze rule:** ANY code change after freeze (even one line) voids the freeze and requires a NEW: compile + full test + Slither + Echidna + Sepolia delta check, plus a new tag. No exceptions, no "trivial" carve-outs.

---

## 1. AMM Math (HokusaiAMM, BondingCurveMath, FeeLib, Factory, PoolDeployer)

- [ ] Buy/sell rounding always favors the protocol/pool (no value extractable via round-trip).
- [ ] Constant-product / bonding-curve invariant preserved across buy→sell round trips (no reserve drain).
- [ ] Power/exponent fixed-point math: no overflow, underflow, or precision loss at realistic and extreme inputs.
- [ ] Reserve can never go negative; redeemable supply ≤ reserve at all times.
- [ ] First-trade / empty-pool / single-wei edge cases safe (no div-by-zero, no price spike exploit).
- [ ] Two-phase pricing transition has no off-by-one or boundary-manipulation exploit.
- [ ] Max trade size limit enforced and not bypassable via truncation or multi-tx splitting where it matters.
- [ ] Slippage protection (minOut/maxIn + deadline) present and correctly enforced on every trade path.
- [ ] Fees cannot round to zero on dust, cannot exceed 100%, cannot be double-applied.
- [ ] Buy/sell/swap paths follow CEI / nonReentrant (token transfer ordering safe).
- [ ] Sandwich/MEV exposure understood and documented; slippage defaults sane.

## 2. Token Caps & Supply (HokusaiToken, TokenManager, DeployableTokenManager, DeltaVerifier mint budget)

- [ ] Hard max supply enforced on **every** mint path (no path bypasses the cap).
- [ ] Only the designated controller can mint/burn; controller swap (if any) is access-controlled.
- [ ] `tokensPerDeltaOne` = **250000** everywhere (NOT 500k) — no divergent hardcode. (See memory: locked at 250k.)
- [ ] Mint requests cannot be replayed (nonce + deadline + signature domain all enforced).
- [ ] Mint budget accounting cannot be double-spent or under/overflow on decrement.
- [ ] Burn cannot destroy tokens the caller doesn't own; no burn underflow.
- [ ] Supply math `unchecked` blocks (if any) proven safe.
- [ ] Initialization of cap/controller/supply cannot be re-run or front-run.

## 3. Role Controls & Governance (AccessControlBase, Timelock, all contracts)

- [ ] Every state-changing / fund-moving / config-setting external fn has an access modifier.
- [ ] Role-admin wiring correct (no role can unexpectedly grant itself elevation).
- [ ] Critical setters (params, fees, caps, AMM authorize, pause, upgrade) gated by **timelock**, not a bare EOA.
- [ ] Ownership uses two-step transfer where applicable; no accidental renounce/transfer-to-zero brick.
- [ ] Deployer EOA admin/owner rights are **revoked** post-handoff (verified on-chain).
- [ ] Timelock min-delay, proposer/executor/canceller assignments correct and safe.
- [ ] Centralization powers (mint/pause/drain/param) documented and behind governance/multisig.
- [ ] PRIVILEGED FUNCTION INVENTORY produced (fn → role → behind-timelock?).

## 4. Fee Routing (UsageFeeRouter, FeeLib, RewardSplitLib, InfrastructureReserve/CostOracle)

- [ ] Splits sum to exactly 100%; dust/remainder handling defined and safe.
- [ ] Recipients cannot be set to attacker addresses without auth; zero-address handled.
- [ ] Distribution paths nonReentrant / CEI (ReentrantFeeRecipient mock guard verified).
- [ ] One reverting recipient cannot DoS the whole distribution (pull-over-push where needed).
- [ ] Oracle feed: stale/zero/manipulated values cannot zero-out or inflate fees.
- [ ] Fees cannot be claimed twice, before accrual, or stranded permanently.
- [ ] Basis-point math has no harmful truncation.

## 5. Vesting & Escrow (RewardVestingVault, PendingClaimsEscrow, FundingVault, allocations)

- [ ] Vesting cliff/linear math correct; no claim-before-cliff, no over-claim via rounding.
- [ ] No double-claim/replay; claimed amount tracked per beneficiary.
- [ ] Investor / supplier / reward allocations strictly separated (regression tests cover leak paths).
- [ ] Escrow release authorization correct; cannot release to wrong party or be front-run/drained.
- [ ] Vault verifies it holds enough tokens before promising/releasing (no over-allocation).
- [ ] Revoke/clawback (if present) access-controlled and accounting-consistent.
- [ ] Claim/release nonReentrant / CEI.
- [ ] No path leaves funds permanently unclaimable.

## 6. Registry Consistency (ModelRegistry, DataContributionRegistry, TokenDeploymentFactory, PurchaserWhitelist)

- [ ] modelId↔token↔pool↔params mappings cannot desync or be silently overwritten.
- [ ] modelId 0 / address(0) edge cases safe.
- [ ] Registration/update/deregister authorized; no malicious-token registration or registration hijack/squatting.
- [ ] No duplicate/collision that breaks downstream (AMM auth, fee routing).
- [ ] PurchaserWhitelist cannot be bypassed; batch add/remove correct.
- [ ] Backfill scripts consistent with on-chain enforcement.
- [ ] Data contributions cannot be forged, double-counted, or misattributed (affects reward splits).

## 7. Emergency Controls (pause/unpause, rescue, factory)

- [ ] Value-moving functions (buy/sell/mint/claim/release) gated by `whenNotPaused`.
- [ ] Pause vs unpause roles appropriately split; single EOA cannot grief-DoS the protocol.
- [ ] Emergency withdraw/rescue/sweep cannot drain user/protocol funds; limited to stray tokens; access-controlled.
- [ ] No path traps user funds permanently while paused (or documented exit).
- [ ] State stays consistent across pause mid-operation.
- [ ] PAUSE COVERAGE MATRIX produced (contract → pausable? → who pause/unpause → value fns gated?).

## 8. Launch Scripts & Posture (deploy-mainnet, create-mainnet-pools, init/verify-launch-posture)

- [ ] Role/owner handoff to timelock/multisig scripted; deployer EOA revocation scripted AND verified.
- [ ] Mainnet parameters = locked values (caps, fees, phase params, tokensPerDeltaOne=250k); no sepolia/test leakage.
- [ ] Deploy→register→init→verify ordering leaves no uninitialized/front-runnable window.
- [ ] `verify-launch-posture` asserts the security-critical invariants (deployer revoked, timelock owns, pause works, caps correct, no test addresses) — gaps enumerated.
- [ ] No secrets/keys hardcoded or logged; KMS/custody per runbook.
- [ ] Scripts idempotent / safe to re-run (no double-deploy/double-mint).
- [ ] Pools created with correct token/fee/authorization.
- [ ] Etherscan verification mainnet-portable (HOK-1700).

## 9. Echidna & Static Analysis Completeness (launch gate trust)

- [ ] Every fund-holding contract has an Echidna harness OR a documented reason it doesn't.
- [ ] Harness invariants are meaningful (drain/cap/auth), not tautological.
- [ ] testLimit/seqLen depth adequate for deep-state contracts (vesting, multi-step AMM).
- [ ] Slither gate FAILS build on new High/Medium vs baseline (not advisory); baseline not hiding real bugs.
- [ ] CI (echidna.yml, slither.yml) runs on the release PR to main, not a skippable subset.
- [ ] Gap list for launch produced and triaged.

---

## Retest / Sign-off Ledger (fill on frozen commit)

| Gate | Command | Result | Date | By |
|------|---------|--------|------|-----|
| Compile | `npx hardhat compile` | ✅ PASS (exit 0) | 2026-06-29 | review sweep (candidate `2000295`) |
| Unit/integration tests | `npx hardhat test` | ✅ PASS (exit 0) | 2026-06-29 | review sweep |
| Slither gate | `npm run slither` | ✅ PASS (only Info/Optimization) | 2026-06-29 | review sweep |
| Echidna suite | `npm run echidna:all` | ⏳ NOT RUN — required on frozen commit (+ 5M fuzz-long dispatch) | | |
| Sepolia delta | `npm run verify:launch-posture:sepolia` | ⏳ pending (run from frozen commit) | | |
| Mainnet posture (dry) | `npm run verify:launch-posture:mainnet` | ⏳ pending | | |
| Governance handoff verify | `verify-governance.js` (gate G-1) | ⏳ pending — separate from posture gate (H-3) | | |

> **Verdict on candidate `2000295`:** No confirmed Critical/High *code* defect found (both AMM "Criticals" defused — see Findings Appendix A). **6 High findings + 2 blocking launch-sequence gates** are open; see `mainnet-security-review-findings.md`. **Not clear to freeze until G-1, G-2, and H-1…H-6 are closed or risk-accepted, and Echidna + Sepolia delta run on the frozen commit.**

**Final launch authorization:** _________________  (signature / date — only after all Critical/High closed and freeze declared)
