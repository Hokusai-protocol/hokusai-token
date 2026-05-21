# Remediate pre-existing Slither High/Medium findings baselined in HOK-1734 - Quick Reference

**Issue ID**: HOK-1823

## Objective

Remediate the 12 pre-existing High/Medium severity Slither findings (`arbitrary-send-eth` ×3, `reentrancy-eth` ×4, `unchecked-transfer` ×1, `divide-before-multiply` ×1, `incorrect-equality` ×3) that were baselined in `slither-baseline.json` during HOK-1734. Each finding must be either fixed in the contract source or formally confirmed as a false positive with documented justification, after which its baseline entry is removed so the CI gate enforces it going forward.

## Key Files

- `slither-baseline.json` — baseline entries to remove/update once findings are resolved
- `contracts/HokusaiAMM.sol` — ETH-handling AMM (likely source of `arbitrary-send-eth` / `reentrancy-eth`)
- `contracts/TokenManager.sol` / `contracts/DeployableTokenManager.sol` — token distribution logic (`incorrect-equality`, `divide-before-multiply`)
- `scripts/slither-gate.js` — CI gate that consumes the baseline
- `docs/slither-static-analysis.md` — baseline workflow runbook to keep in sync

## Critical Constraints

1. Every baseline removal must be backed by either a verifiable contract fix OR a written false-positive justification in the entry's `justification`/`followUp` fields — never silently delete an entry.
2. All existing Hardhat tests (especially `test/Phase-Security-ReentrancyAttacks.test.js` and the full `test/Phase-Security-*` suite) must pass after changes; contract behavior changes must not break AMM pricing or token-distribution invariants.
3. Follow checks-effects-interactions and use OpenZeppelin `ReentrancyGuard` / `SafeERC20` already available in `node_modules`; do not introduce new external dependencies.

## Success Criteria (High-Level)

- [ ] All 12 findings individually triaged as "fixed" or "false positive" with documented rationale
- [ ] Genuine vulnerabilities fixed via contract changes (reentrancy guards, pull-payment, return-value checks, reordered arithmetic, range-based comparisons)
- [ ] Corresponding entries removed from `slither-baseline.json`; remaining entries (if any false positives stay) have updated `followUp` referencing HOK-1823
- [ ] `npm run slither:report` shows no un-baselined High/Medium findings; `node scripts/slither-gate.js` passes
- [ ] `npx hardhat compile` and `npm test` pass; PR created and linked to HOK-1823

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.

---

## 1. Objective

### What
Remediate (fix or formally confirm as false positive) the 12 pre-existing High and Medium severity Slither static-analysis findings that were baselined into `slither-baseline.json` during HOK-1734, and remove their baseline entries so the CI gate enforces them going forward.

### Why
HOK-1734 added a Slither CI gate but accepted 12 pre-existing High/Medium findings into a baseline file to avoid blocking that issue. A baseline that holds High-severity findings (`arbitrary-send-eth`, `reentrancy-eth`, `unchecked-transfer`) means the gate cannot catch regressions in those same detector classes, and — more importantly — genuine vulnerabilities in ETH-handling and token-distribution code may be live in deployable contracts. This issue closes that gap before further mainnet activity, hardening the contract suite and restoring the gate's protective value.

### Scope In
- Triage each of the 12 baselined findings against the current contract source.
- Fix genuine vulnerabilities in Solidity contracts under `contracts/`.
- For confirmed false positives, write an explicit justification in the relevant `slither-baseline.json` entry and set its `followUp` field to reference HOK-1823.
- Remove baseline entries for findings that are fixed (so the gate enforces them).
- Add or extend Hardhat tests that prove each genuine fix (e.g., reentrancy reverts, transfer-failure reverts).
- Update `docs/slither-static-analysis.md` if the baseline workflow or remaining-baseline contents change materially.

### Scope Out
- Remediation of Low / Informational / Optimization Slither findings (not in the 12 listed).
- Changes to the Slither gate logic itself (`scripts/slither-gate.js`) or the workflow `.github/workflows/slither.yml` — only the baseline data file is edited.
- New on-chain features, AMM pricing-model redesign, or governance changes beyond what is strictly required to remove a vulnerability.
- Off-chain TypeScript services under `services/contract-deployer/` (Slither analyzes Solidity only).
- Redeployment to Sepolia or mainnet (handled by a separate deployment task).

---

## 2. Technical Context

### Repository
Single repo: `hokusai-token` (this repository). All work is in the Solidity contracts under `contracts/` and the `slither-baseline.json` data file at repo root.

### Key Files

- `slither-baseline.json` — existing baseline file (added in commit `6cbb9c9`, HOK-1734); contains the 12 entries keyed by detector check name. Entries to be removed or have `justification`/`followUp` updated.
- `scripts/slither-gate.js` — existing CI gate script; consumes `slither-baseline.json`. Read-only reference (do not modify).
- `slither.config.json` — existing Slither configuration. Read-only reference.
- `docs/slither-static-analysis.md` — existing runbook for the baseline workflow; update if remaining baseline contents change.
- `contracts/HokusaiAMM.sol` — existing AMM contract; primary suspect for `arbitrary-send-eth` and `reentrancy-eth` (ETH-denominated buy/sell flows).
- `contracts/HokusaiAMMFactory.sol` — existing factory; possible source of ETH-forwarding findings.
- `contracts/TokenManager.sol` — existing controller contract; possible source of `incorrect-equality` / `divide-before-multiply` in distribution math.
- `contracts/DeployableTokenManager.sol` — existing deployable controller; possible source of equality/arithmetic findings.
- `contracts/FundingVault.sol`, `contracts/RewardVestingVault.sol`, `contracts/InfrastructureReserve.sol`, `contracts/UsageFeeRouter.sol` — existing contracts that move ETH or ERC20 value; candidate sources of `arbitrary-send-eth`, `reentrancy-eth`, `unchecked-transfer`.
- `contracts/libraries/RewardSplitLib.sol` — existing library; candidate source of `divide-before-multiply`.
- `test/Phase-Security-ReentrancyAttacks.test.js` — existing reentrancy test suite; extend with new cases.
- `test/Phase-Security-*.test.js` — existing security suites; regression coverage.
- `contracts/mocks/` — existing mock directory; add a malicious-reentrant mock here if needed for new tests.

> **Note**: The exact contracts and line numbers for each finding are NOT assumed — they MUST be determined by running `npm run slither:report` as Step 1 of implementation. The files above are candidates inferred from the contract inventory and ETH/value-handling responsibilities. CLAUDE.md mentions a `BurnAuction` contract, but no such file appears in the artifacts inventory; do not assume it exists — confirm against `contracts/` directory listing.

### Relevant Subsystem Specs

> ⚠️ **Knowledge Gap**: No subsystem specs (`.wavemill/context/`) were provided for the AMM / token-distribution / Slither-gate areas. After implementation, consider running `wavemill context init --force` to create subsystem documentation and enable persistent downstream acceleration for future security tasks.

### Dependencies
- **Slither** must be installed and runnable locally (`npm run slither:report` — script added in HOK-1734, commit `6cbb9c9`). If the local environment lacks Slither (Python package), install per `docs/slither-static-analysis.md`; if it cannot be installed, fall back to reading the most recent CI Slither artifact and document this in the PR.
- **OpenZeppelin Contracts** — already in `node_modules` (`@openzeppelin/contracts` artifacts present); use `ReentrancyGuard`, `SafeERC20`, and `Address.sendValue` from this package rather than new dependencies.
- HOK-1734 (`6cbb9c9`) — provides the gate, baseline file, and runbook this issue builds on.

### Architecture Notes
- **Controller pattern**: `TokenManager` is the sole mint/burn controller for `HokusaiToken`. Fixes to distribution math must preserve this access-control invariant.
- **Checks-Effects-Interactions (CEI)**: The canonical fix for `reentrancy-eth` is to update all contract state before any external call/ETH transfer. Combine with `ReentrancyGuard.nonReentrant` on externally callable ETH-moving functions.
- **Pull-over-push payments**: For `arbitrary-send-eth`, the safest pattern is to record an entitlement and let the recipient `withdraw()`, rather than pushing ETH to a caller-supplied address. Where push is unavoidable, restrict the destination to a vetted/stored address (not a free function parameter) and use `Address.sendValue`.
- **SafeERC20**: For `unchecked-transfer`, replace raw `token.transfer(...)` / `transferFrom(...)` with `SafeERC20.safeTransfer` / `safeTransferFrom`, or wrap the boolean return in `require(...)`. Note `HokusaiToken` is a known-good in-house ERC20, but external/arbitrary tokens may not return a bool — SafeERC20 handles both.
- **Arithmetic ordering**: For `divide-before-multiply`, reorder to multiply-before-divide where it does not overflow (Solidity ≥0.8 reverts on overflow, so this is generally safe), or use a higher-precision intermediate. Preserve the existing rounding direction expected by AMM/reward tests.
- **Equality on balances**: For `incorrect-equality`, replace strict `==` against balances/`block.timestamp`/token amounts with `>=` / `<=` range checks, or compare against an explicitly tracked accounting variable rather than `address(this).balance` / `token.balanceOf(...)` (which can be manipulated by forced ETH sends or donations).
- Recent commit `8e17cd3` (HOK-1781) shows the codebase already prefers explicit redeemable-supply accounting over raw `totalSupply()` — follow that precedent: prefer tracked accounting state over live balance reads.

---

## 3. Implementation Approach

1. **Inventory the findings.** Run `npm run slither:report` (or `npx slither .` per the runbook). Capture, for each of the 12 baselined findings, the exact contract file, function, and line(s). Cross-reference each against the entries in `slither-baseline.json` so every baseline entry is mapped to a concrete code location. Produce a triage table (detector → location → verdict TBD).

2. **Triage each finding** as **real vulnerability** or **false positive**. For each, write a one-paragraph rationale. A finding is a false positive only when the flagged code path is unreachable, access-controlled to a trusted role such that the "arbitrary" address is in fact constrained, or the detector misreads a safe pattern — and this must be demonstrable.

3. **Fix `reentrancy-eth` (4 findings).** For each affected function: (a) reorder to checks-effects-interactions so all state writes precede the external call/ETH transfer; (b) add `nonReentrant` (OpenZeppelin `ReentrancyGuard`) to the externally callable entry point. Confirm the contract inherits `ReentrancyGuard` and that the constructor/inheritance order is valid.

4. **Fix `arbitrary-send-eth` (3 findings).** For each: prefer converting to a pull-payment (record `pendingWithdrawals[recipient]`, add a `withdraw()` guarded by `nonReentrant`). Where a push is required by design, ensure the destination is a stored, access-controlled address (e.g., set by `owner`/governance), not a raw function argument, and use `Address.sendValue`. If a finding is genuinely safe because the destination is already an access-controlled stored address, classify it as a false positive with that justification.

5. **Fix `unchecked-transfer` (1 finding).** Replace the raw ERC20 `transfer`/`transferFrom` with `SafeERC20.safeTransfer`/`safeTransferFrom` (import `using SafeERC20 for IERC20;`), or wrap in `require(token.transfer(...), "transfer failed")`. Prefer `SafeERC20` for consistency and non-standard-token safety.

6. **Fix `divide-before-multiply` (1 finding).** Reorder the expression to multiply before divide, or introduce a higher-precision intermediate (e.g., scale by `1e18`). Verify against the relevant AMM/reward test that the rounding result is unchanged or strictly more accurate; if rounding direction matters, document the chosen direction.

7. **Fix `incorrect-equality` (3 findings).** Replace strict `==` comparisons on balances/amounts/timestamps with `>=`/`<=` range checks, or compare against tracked accounting variables instead of live `address(this).balance` / `balanceOf`. Ensure no logic depends on exact-equality semantics (e.g., a "fully funded" check should use `>=`).

8. **Add/extend tests.** For each genuine fix, add a focused Hardhat test: a reentrant-attacker mock in `contracts/mocks/` that proves the `nonReentrant`/CEI fix reverts the attack; a failing-ERC20 mock that proves `unchecked-transfer` now reverts; assertions that arithmetic and equality fixes preserve expected outputs. Extend `test/Phase-Security-ReentrancyAttacks.test.js` where it fits.

9. **Update `slither-baseline.json`.** Re-run `npm run slither:report`. For each **fixed** finding, remove its baseline entry. For each **confirmed false positive** that remains, keep the entry but rewrite `justification` with the concrete rationale from Step 2 and set `followUp` to `"HOK-1823"`. Validate the file remains valid JSON.

10. **Update the runbook.** If the set of remaining baselined findings changed, update `docs/slither-static-analysis.md` so its description of the baseline contents stays accurate.

11. **Verify the gate.** Run `npx hardhat compile`, `npm test`, `npm run slither:report`, and `node scripts/slither-gate.js`. Confirm the gate passes with the updated baseline and that no fixed-detector finding reappears un-baselined.

12. **Commit and open PR.** One logical commit per finding class where practical; commit messages reference `HOK-1823`. Open a PR summarizing the triage table (finding → verdict → fix/justification).

---

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** Every one of the 12 baselined findings is mapped to an exact contract location (file + function + line) and assigned a verdict of either `fixed` or `false-positive`, recorded in the PR description as a triage table.
- [ ] **[REQ-F2]** All 4 `reentrancy-eth` findings classified as real are remediated such that a malicious reentrant contract attempting to re-enter the flagged function reverts (via `nonReentrant`) and/or cannot extract value (via checks-effects-interactions ordering).
- [ ] **[REQ-F3]** All 3 `arbitrary-send-eth` findings classified as real are remediated so ETH can only be sent to an access-controlled stored address or via a pull-payment `withdraw()`; no externally callable function sends ETH to an unconstrained caller-supplied address parameter.
- [ ] **[REQ-F4]** The 1 `unchecked-transfer` finding is remediated: the ERC20 `transfer`/`transferFrom` call either uses `SafeERC20` or has its return value `require`-checked, so a token that returns `false` causes the transaction to revert.
- [ ] **[REQ-F5]** The 1 `divide-before-multiply` finding is remediated by reordering arithmetic (multiply before divide) or higher-precision intermediate, with the result verified equal-or-more-accurate against the relevant existing test.
- [ ] **[REQ-F6]** All 3 `incorrect-equality` findings are remediated by replacing strict `==` on balances/amounts/timestamps with range comparisons or tracked-accounting comparisons, OR documented as false positives with concrete justification.
- [ ] **[REQ-F7]** `slither-baseline.json` is updated: every `fixed` finding's entry is removed; every remaining `false-positive` entry has a concrete `justification` and `followUp: "HOK-1823"`. The file is valid JSON.
- [ ] **[REQ-F8]** Running `npm run slither:report` followed by `node scripts/slither-gate.js` exits 0 (gate passes) with the updated baseline, and no detector class that was fixed reports a new un-baselined High/Medium finding.
- [ ] **[REQ-F9]** New Hardhat tests exist that fail against the pre-fix contract code and pass against the post-fix code for each genuine reentrancy and unchecked-transfer fix.

### Non-Functional Requirements
- [ ] Gas cost of remediated functions does not increase by more than ~5k gas per call beyond what `ReentrancyGuard`/`SafeERC20` inherently add (no gratuitous overhead).
- [ ] No change to any contract's public ABI signature for functions consumed by `services/contract-deployer/` or deployment scripts, unless a pull-payment `withdraw()` is added (additive only — no removals or signature changes).
- [ ] All contracts still compile under the existing Solidity version in `hardhat.config.js` and stay within the 24,576-byte deployed-bytecode limit (verify with `npx hardhat run scripts/size-contracts.js` if present).

### Code Quality
- [ ] Follows existing codebase patterns (OpenZeppelin usage, CEI ordering already seen in `test/Phase-Security-ReentrancyAttacks.test.js`).
- [ ] Solidity NatSpec comments added/updated for any function whose payment or arithmetic behavior changed.
- [ ] No new compiler warnings introduced (`npx hardhat compile` clean).

---

## 5. Implementation Constraints

- **Code style**: Match existing Solidity conventions in `contracts/` — pragma version, import style, NatSpec. Use `using SafeERC20 for IERC20;` rather than ad-hoc wrappers. Reentrancy guards via OpenZeppelin `ReentrancyGuard`, not hand-rolled mutexes.
- **Testing**: Every genuine vulnerability fix MUST have a test that demonstrably fails before the fix and passes after. Reentrancy tests MUST use an on-chain malicious mock contract (in `contracts/mocks/`), not a JS-level simulation. Do not weaken or delete existing assertions in `test/Phase-Security-*` to make suites pass — if an existing test breaks, the fix is wrong.
- **Security**: No `arbitrary-send-eth` finding may be removed from the baseline unless the destination is provably access-controlled or converted to pull-payment. Never classify a finding as a false positive without a concrete, written, technically-specific reason — "looks fine" is not acceptable.
- **Baseline integrity**: Never delete a baseline entry without either a corresponding code fix or a documented false-positive justification. The `slither-baseline.json` file must remain valid JSON and retain the schema established in HOK-1734 (do not rename existing fields).
- **Performance**: Prefer multiply-before-divide reordering only where Solidity ≥0.8 overflow checks make it safe; if an intermediate could overflow `uint256`, use a higher-precision approach instead and add a comment explaining why.
- **Backwards compatibility**: Do not change existing public/external function signatures consumed by deployment scripts or `services/contract-deployer/`. Adding a new `withdraw()` is permitted (additive). The mint/burn controller invariant (`TokenManager` is sole controller) must be preserved.
- **Scope discipline**: Touch only contracts that contain one of the 12 findings, plus test/mocks and `slither-baseline.json`/`docs`. Do not opportunistically refactor unrelated code.

---

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] All 12 findings mapped and triaged**

Validation scenario:
1. Setup: Clean working tree on the feature branch; Slither installed (or CI artifact available).
2. Action: Run `npm run slither:report`. Cross-reference every High/Medium finding against the 12 entries in `slither-baseline.json`.
3. Expected result: A triage table in the PR description lists all 12 findings, each with `detector | file:line | function | verdict (fixed|false-positive) | rationale`. Counts match the issue: 3 `arbitrary-send-eth`, 4 `reentrancy-eth`, 1 `unchecked-transfer`, 1 `divide-before-multiply`, 3 `incorrect-equality`.
4. Edge cases:
   - Slither reports a NEW High/Medium finding not in the original 12 → Stop; do not silently baseline it; report it in the PR and treat as out of scope only after explicit note.
   - A baselined entry no longer matches any current finding (code already changed) → Document as "already resolved", remove the entry, note the resolving commit.

**[REQ-F2] `reentrancy-eth` findings remediated**

Validation scenario:
1. Setup: Deploy the affected contract plus a malicious mock (in `contracts/mocks/`) whose `receive()`/fallback re-enters the flagged function.
2. Action: From the mock, call the flagged ETH-moving function and attempt re-entry.
3. Expected result: The transaction reverts with `ReentrancyGuard`'s revert reason (`ReentrancyGuardReentrantCall` or `"ReentrancyGuard: reentrant call"`), OR the re-entry succeeds but state was already updated so no extra value is extracted (balance assertions prove no double-spend).
4. Edge cases:
   - Normal (non-reentrant) call by an EOA → Succeeds unchanged; existing tests still pass.
   - Two legitimate sequential calls in separate transactions → Both succeed (guard resets between txs).

**[REQ-F3] `arbitrary-send-eth` findings remediated**

Validation scenario:
1. Setup: Deploy the affected contract; obtain a non-owner signer.
2. Action: Attempt to trigger an ETH send to an attacker-controlled address via the flagged function as a non-privileged caller.
3. Expected result: Either the function no longer accepts a destination parameter (ETH goes to a stored, owner-set address or to `msg.sender`'s pull-payment balance), or the call reverts for non-authorized callers.
4. Edge cases:
   - Pull-payment path: recipient calls `withdraw()` with zero pending balance → reverts or is a no-op returning without transfer (no revert-on-zero unless intended); recipient with positive balance → receives exact amount, balance zeroed before transfer.
   - Owner updates the stored destination address → subsequent sends go to the new address.

**[REQ-F4] `unchecked-transfer` finding remediated**

Validation scenario:
1. Setup: Deploy the affected contract with a mock ERC20 (in `contracts/mocks/`) whose `transfer`/`transferFrom` returns `false` without reverting.
2. Action: Invoke the contract function that performs the flagged token transfer.
3. Expected result: The transaction reverts (via `SafeERC20` `"SafeERC20: ERC20 operation did not succeed"` or the explicit `require` message). Funds/accounting are not updated.
4. Edge cases:
   - Mock ERC20 that returns `true` → transfer succeeds, behavior unchanged.
   - Non-standard ERC20 that returns no value (void `transfer`) → `SafeERC20` treats it as success; transaction does not revert.

**[REQ-F5] `divide-before-multiply` finding remediated**

Validation scenario:
1. Setup: Identify the affected function and the existing test that exercises its arithmetic (likely an AMM pricing or reward-split test).
2. Action: Run that test before and after the reorder; compute the expected value by hand for one representative input.
3. Expected result: Post-fix output equals or is strictly closer to the exact mathematical result than pre-fix; the existing test passes (update its expected value only if the change is a documented precision improvement).
4. Edge cases:
   - Smallest non-zero input (e.g., 1 wei / 1 token unit) → no division-by-zero, no revert.
   - Large input near `uint256` bounds → no overflow revert from the reordered multiplication; if risk exists, higher-precision intermediate is used instead.

**[REQ-F6] `incorrect-equality` findings remediated**

Validation scenario:
1. Setup: Deploy the affected contract; identify each strict-equality check.
2. Action: For a balance/amount equality, force an unexpected state (e.g., send extra wei directly to the contract to perturb `address(this).balance`) then call the function whose logic used `==`.
3. Expected result: The function behaves correctly using `>=`/`<=` or tracked-accounting comparison — it is not bricked or bypassed by the perturbed balance.
4. Edge cases:
   - Exact-boundary value (balance exactly equals threshold) → range check `>=`/`<=` still treats it as satisfied.
   - Donation/forced-send attack (extra ETH via `selfdestruct`) → logic relying on tracked accounting is unaffected.

**[REQ-F7] `slither-baseline.json` updated correctly**

Validation scenario:
1. Setup: The updated baseline file on the feature branch.
2. Action: Parse the file with `node -e "JSON.parse(require('fs').readFileSync('slither-baseline.json','utf8'))"`. Inspect each remaining entry.
3. Expected result: File parses without error. Every fixed finding's entry is gone. Every remaining entry has a non-empty `justification` and `followUp` containing `"HOK-1823"`.
4. Edge cases:
   - All 12 findings fixed → baseline may be empty for these detectors (or the file may legitimately have only unrelated lower-severity entries).
   - A remaining entry lacks a `followUp` field → add it; do not leave it null.

**[REQ-F8] Slither gate passes with updated baseline**

Validation scenario:
1. Setup: Updated contracts and baseline; contracts compiled.
2. Action: Run `npm run slither:report` then `node scripts/slither-gate.js`; capture exit code.
3. Expected result: `slither-gate.js` exits `0`. No High/Medium finding for a fixed detector class appears outside the baseline.
4. Edge cases:
   - Slither finds a brand-new finding introduced by the fix (e.g., the new `withdraw()` flags `reentrancy-eth`) → must be fixed, not baselined; gate must still pass on genuine merit.
   - Slither unavailable locally → run the gate against the most recent CI Slither JSON artifact and note this in the PR.

**[REQ-F9] New tests fail pre-fix, pass post-fix**

Validation scenario:
1. Setup: Stash the contract fixes (`git stash`), keep the new test files.
2. Action: Run the new tests against pre-fix contracts, then `git stash pop` and run again.
3. Expected result: New reentrancy/unchecked-transfer tests FAIL pre-fix and PASS post-fix. All previously-passing suites still pass post-fix.
4. Edge cases:
   - A new test passes even pre-fix → the test does not actually exercise the vulnerability; strengthen it.

---

### Input/Output Verification

**Valid Inputs:**
- Input: EOA calls a remediated ETH-moving function normally → Expected: succeeds, state and balances correct, existing tests green.
- Input: `withdraw()` called by an account with pending balance `X` → Expected: receives exactly `X`, pending balance set to `0` before the transfer (CEI).
- Input: Standard compliant ERC20 used in the remediated transfer path → Expected: transfer succeeds, no behavior change.

**Invalid Inputs:**
- Input: Malicious contract re-enters a remediated function → Expected: revert (`ReentrancyGuard` reentrant-call error).
- Input: ERC20 mock returning `false` from `transfer` → Expected: revert (`SafeERC20`/`require` failure message).
- Input: Non-owner attempts to set the ETH destination address or send ETH to an arbitrary address → Expected: revert with the contract's access-control error (e.g., `Ownable`/controller revert).
- Input: Malformed `slither-baseline.json` (trailing comma) → Expected: caught by JSON parse validation in CI; fix before merge.

---

### Standard Validation Commands

```bash
# 1. Contracts compile cleanly
npx hardhat compile
# Expected: compiles with no new warnings or errors

# 2. Full test suite passes
npm test
# Expected: all existing + new tests pass

# 3. Targeted security suites
npx hardhat test test/Phase-Security-ReentrancyAttacks.test.js
npx hardhat test test/Phase-Security-EdgeCases.test.js
# Expected: all pass

# 4. Slither report + gate
npm run slither:report
node scripts/slither-gate.js
# Expected: gate exits 0; no un-baselined High/Medium findings

# 5. Baseline JSON validity
node -e "JSON.parse(require('fs').readFileSync('slither-baseline.json','utf8')); console.log('valid JSON')"
# Expected: prints "valid JSON"

# 6. Contract size check (if script exists)
npx hardhat run scripts/size-contracts.js
# Expected: all contracts under 24576-byte limit
```

---

### Manual Verification Checklist

- [ ] The PR description contains a triage table covering all 12 findings with file:line, verdict, and rationale.
- [ ] Each `false-positive` verdict has a technically specific justification (unreachable path / access-controlled destination / detector misread) — not a generic statement.
- [ ] Diff of `slither-baseline.json` shows only removals of fixed entries and `justification`/`followUp` edits on remaining entries — no schema/field renames.
- [ ] Every remediated ETH-moving function follows checks-effects-interactions: all state writes appear before the external call in the source.
- [ ] `docs/slither-static-analysis.md` accurately reflects the post-change baseline contents.
- [ ] No public/external function signature consumed by deployment scripts or `services/contract-deployer/` was changed (grep deployment scripts for affected function names).

---

## 8. Definition of Done

- [ ] All success criteria (REQ-F1 through REQ-F9 and non-functional) met.
- [ ] All validation steps pass with specific, measurable outcomes.
- [ ] Each genuine fix has at least one concrete validation scenario and a test that fails pre-fix / passes post-fix.
- [ ] Edge cases documented and tested.
- [ ] `slither-baseline.json` updated; gate (`scripts/slither-gate.js`) passes.
- [ ] No unrelated changes included.
- [ ] Commit messages reference `HOK-1823`.
- [ ] PR created with the triage table and a summary of fixes vs. confirmed false positives, linked to HOK-1823.

---

## 9. Rollback Plan

- **Revert commit**: `git revert <sha>` for each remediation commit (or revert the merge commit). Because changes are contract-source + a JSON data file + tests, reverting fully restores prior behavior and the prior baseline.
- **Feature flag**: Not applicable — these are contract source changes, not runtime-toggled features.
- **Deployment consideration**: These contracts are not redeployed by this task. If they have already been deployed to a testnet/mainnet before this remediation, the fixes take effect only on the *next* deployment; reverting this PR before redeployment has zero on-chain impact. If contracts were deployed *from* this branch, redeploy the reverted version and update `deployments/*-latest.json` accordingly.
- **Baseline rollback**: If the gate must be unblocked urgently, restore the prior `slither-baseline.json` from `git show 6cbb9c9:slither-baseline.json` — but this re-accepts the High-severity findings and should only be a temporary measure.
- **Data migration rollback**: Not applicable — no database or schema changes.

---

## 10. Release Readiness
- **database_change_risk**: none
- **env_changes**: none
- **config_changes**: none
- **manual_steps**: Redeploy affected contracts to testnet/mainnet on the next deployment cycle (handled by a separate deployment task); update `deployments/*-latest.json` if redeployed from this branch.

---

## 11. Proposed Labels

**Risk Level** (Required):

**Selected**: `Risk: High`

**Justification**: High — modifies ETH-handling and token-distribution logic in deployable smart contracts (reentrancy guards, pull-payment conversion, arithmetic reordering). Smart contract security changes are inherently high-risk and irreversible once deployed; a regression could enable loss of funds.

---

**Files to Modify** (Auto-detected, top 5):
- `slither-baseline.json`
- `contracts/HokusaiAMM.sol`
- `contracts/TokenManager.sol`
- `contracts/DeployableTokenManager.sol`
- `contracts/FundingVault.sol`

**Label**: `Files: slither-baseline.json, HokusaiAMM.sol, TokenManager.sol, DeployableTokenManager.sol, FundingVault.sol`

**Purpose**: Prevents parallel tasks from modifying the same files. Note the precise contract set is confirmed only after Step 1 (`npm run slither:report`); update this label once locations are known.

---

**Architectural Layer** (Recommended):

**Selected**: `Layer: Service` (smart contract business logic) and `Layer: Infra` (CI gate baseline / `slither-baseline.json`)

**Purpose**: Tasks from different layers can run in parallel safely; this task spans contract logic and the CI security gate's data.

---

**Area** (Recommended):

**Selected**: `Area: Security`

**Purpose**: Avoid running 2+ tasks affecting contract security simultaneously.

---

**Test Coverage** (Auto-detected):

**Selected**: `Tests: Unit` and `Tests: Integration` (Hardhat unit + security/integration suites)

**Purpose**: Avoid conflicts with other suites; these run fast and can parallelize with non-overlapping unit tasks.

---

**Component** (Optional):

**Selected**: `Component: HokusaiAMM` (provisional — confirm after Slither triage)

**Purpose**: Avoid running 2+ tasks modifying the same contract.

---

### Label Summary

```
Suggested labels for this task:
- Risk: High
- Files: slither-baseline.json, HokusaiAMM.sol, TokenManager.sol, DeployableTokenManager.sol, FundingVault.sol
- Layer: Service
- Layer: Infra
- Area: Security
- Tests: Unit
- Tests: Integration
- Component: HokusaiAMM
```

**How these labels help the autonomous workflow:**
- **Risk: High** — Should run serially; no other High-risk contract task in parallel.
- **Files: ...** — Prevents file conflicts; refine after Step 1 triage pins exact contracts.
- **Layer: Service / Infra** — Can parallelize with UI/API tasks but not other contract or CI-gate work.
- **Area: Security** — Blocks concurrent security-area tasks.
- **Tests: Unit / Integration** — Coordinates with other test runs.
- **Component: HokusaiAMM** — Prevents conflicts with other AMM tasks (provisional).