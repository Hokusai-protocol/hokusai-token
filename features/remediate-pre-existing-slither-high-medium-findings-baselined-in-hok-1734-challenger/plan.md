# Implementation Plan — HOK-1823

## Remediate pre-existing Slither High/Medium findings baselined in HOK-1734

---

## 1. Summary

HOK-1734 added the Slither CI gate and accepted 12 pre-existing High/Medium findings
into `slither-baseline.json` to avoid blocking that issue. This plan triages each of
the 12, fixes the genuine vulnerabilities, confirms the false positives, and
reconciles `slither-baseline.json` so the gate enforces these detector classes going
forward.

All 12 findings were located precisely by running `npm run slither:report` and a
focused `slither --detect ...` pass. Verdicts below are backed by reading each
contract location and inspecting the Slither detector source
(`is_reentrant`, `arbitrary_send`, `_convert_to_id`).

---

## 2. Triage Table (all 12 findings)

| # | Detector | Location | Function | Verdict | Remediation |
|---|----------|----------|----------|---------|-------------|
| 1 | `arbitrary-send-eth` (High) | `TokenManager.sol:118-194` | `deployTokenWithParams` | **fix** | Pull-payment |
| 2 | `arbitrary-send-eth` (High) | `TokenManager.sol:209-296` | `deployTokenWithAllocations` | **fix** | Pull-payment |
| 3 | `arbitrary-send-eth` (High) | `DeployableTokenManager.sol:419-432` | `_collectDeploymentFee` | **fix** | Pull-payment |
| 4 | `reentrancy-eth` (High) | `TokenManager.sol:118-194` | `deployTokenWithParams` | **fix** | `nonReentrant` + CEI |
| 5 | `reentrancy-eth` (High) | `TokenManager.sol:209-296` | `deployTokenWithAllocations` | **fix** | `nonReentrant` + CEI |
| 6 | `reentrancy-eth` (High) | `DeployableTokenManager.sol:108-140` | `deployTokenWithParams` | **fix** | `nonReentrant` + CEI |
| 7 | `reentrancy-eth` (High) | `DeployableTokenManager.sol:142-186` | `deployTokenWithAllocations` | **fix** | `nonReentrant` + CEI |
| 8 | `unchecked-transfer` (High) | `HokusaiAMM.sol:283` | `sell` | **fix** | `require`-wrap return value |
| 9 | `divide-before-multiply` (Med) | `BondingCurveMath.sol:135,141` | `ln` | **fix** | Bit-identical simplification |
| 10 | `incorrect-equality` (Med) | `DataContributionRegistry.sol:286` | `claimContribution` | **false positive** | Document — enum equality |
| 11 | `incorrect-equality` (Med) | `DataContributionRegistry.sol:465` | `getContributorGlobalStats` | **false positive** | Document — keccak string compare |
| 12 | `incorrect-equality` (Med) | `FundingVault.sol:488` | `sweepDust` | **false positive** | Document — benign admin-only balance guard |

**Outcome:** 9 findings fixed (entries removed), 3 confirmed false positives (entries
kept with rewritten justification).

---

## 3. Detailed Finding Analysis & Approach

### 3.1 `reentrancy-eth` ×4 + `arbitrary-send-eth` ×3 — TokenManager & DeployableTokenManager fee handling

**Root cause (shared).** Both managers expose `payable` token-deploy functions callable
by anyone. They currently *push* ETH during the deploy call:

- `feeRecipient.call{value: deploymentFee}("")` — `feeRecipient` is a tainted storage
  variable (mutable via `setFeeRecipient`). Slither's `arbitrary_send_eth` flags ETH
  sent to a tainted, non-`msg.value`, non-immutable destination from an
  *unprotected* function → **3 `arbitrary-send-eth` findings**.
- `msg.sender.call{value: msg.value - deploymentFee}("")` — excess refund. This is
  *not* flagged by `arbitrary-send-eth` (value is `msg.value`-dependent) but it is an
  external call that occurs **before** the state writes (`modelTokens`,
  `tokenToModel`, `modelParams`) → **4 `reentrancy-eth` findings** (an untrusted
  `msg.sender` can re-enter `deployTokenWith*` before `modelTokens[modelId]` is set).

**Verified detector behaviour** (from Slither 0.11.5 source):
- `arbitrary_send_eth.py`: `if func.is_protected(): return []` — an `onlyOwner`
  function is never flagged. Also skips immutable destinations and `msg.value`-tainted
  values.
- `function.py::is_reentrant`: returns `False` when the function carries the
  `nonReentrant` modifier; `reentrancy_eth.py` only emits when `f.is_reentrant` (or the
  written var participates in cross-function reentrancy). `nonReentrant` therefore
  suppresses `reentrancy-eth`, and incidentally `reentrancy-benign` / `reentrancy-events`
  on the same function.

**Fix — pull-payment + reentrancy guard + checks-effects-interactions:**

1. Add `import "@openzeppelin/contracts/security/ReentrancyGuard.sol";` to both
   `TokenManager.sol` and `DeployableTokenManager.sol` (OZ 4.9.6 path — same import
   `HokusaiAMM.sol` and `FundingVault.sol` already use). Add `ReentrancyGuard` to the
   inheritance list of each contract (no constructor argument required).

2. Apply the `nonReentrant` modifier to `deployTokenWithParams` and
   `deployTokenWithAllocations` in **both** contracts → resolves findings 4-7.

3. Convert deployment-fee handling to **pull-payment**:
   - Rewrite `_collectDeploymentFee()` (a new private helper in `TokenManager`,
     mirroring the existing one in `DeployableTokenManager`) so it only validates
     `require(msg.value >= deploymentFee, "Insufficient deployment fee")` and
     **retains** the fee in the contract — it no longer calls `feeRecipient`.
   - Add a private `_refundExcess()` helper that refunds `msg.value - deploymentFee`
     to `msg.sender` and is called **last**, after all state writes / token
     deployment / event emission (checks-effects-interactions). Because the value is
     `msg.value`-dependent, `arbitrary-send-eth` ignores it; because it is last (no
     state write after) and the function is `nonReentrant`, no reentrancy finding can
     fire.
   - Add `function withdrawDeploymentFees() external onlyOwner nonReentrant` that
     sends `address(this).balance` to `feeRecipient`. Because the function is
     `onlyOwner` (`is_protected()` is true), `arbitrary-send-eth` does **not** flag it
     → resolves findings 1-3. Guard with `require(balance > 0, "No fees to withdraw")`
     and emit a new `DeploymentFeesWithdrawn(address recipient, uint256 amount)` event.

4. Refactor `TokenManager`'s currently-inline fee logic (duplicated at lines 135-147
   and 230-242) into the shared `_collectDeploymentFee()` / `_refundExcess()` private
   helpers to remove duplication and keep both managers consistent.

`setFeeRecipient` / `setDeploymentFee` are **kept** — only the *timing* of the payout
changes (deploy-time push → owner-initiated pull). `deploymentFee` defaults to `0` in
both contracts today, so this fee mechanism is currently dormant; the behaviour change
has no effect on live deployments until a fee is configured.

### 3.2 `unchecked-transfer` ×1 — HokusaiAMM.sell

**Location:** `HokusaiAMM.sol:283` —
`IERC20(hokusaiToken).transferFrom(msg.sender, address(this), tokensIn);`
The boolean return value is discarded. (The sibling `buy` function already wraps its
`reserveToken.transferFrom` in `require`.)

**Verdict: genuine — fix.** Wrap the call:
`require(IERC20(hokusaiToken).transferFrom(msg.sender, address(this), tokensIn), "Token transfer failed");`
This matches the existing `require(token.transfer(...), "...")` idiom used in `buy`
and in `FundingVault`. No `SafeERC20` needed — the codebase consistently uses explicit
`require` on boolean returns. (The adjacent `approve` call's unused return is a
separate `unused-return` finding that is **out of scope** for this issue and stays
baselined.)

### 3.3 `divide-before-multiply` ×1 — BondingCurveMath.ln

**Location:** `BondingCurveMath.sol:135` and `:141` inside `ln(uint256)`:
- L135: `scaled = (scaled * PRECISION) / (3 * PRECISION);`
- L141: `scaled = (scaled * 3 * PRECISION) / PRECISION;`

Slither flags the loop-carried pattern (a divided `scaled` is multiplied on the next
iteration).

**Verdict: genuine but trivially fixable — fix via bit-identical simplification.**
Both expressions reduce *exactly* (Solidity integer arithmetic, for all non-overflowing
inputs) to:
- L135: `(scaled * PRECISION) / (3 * PRECISION)` ≡ `scaled / 3`
  (`floor(s·P / 3P) = floor(s/3)`).
- L141: `(scaled * 3 * PRECISION) / PRECISION` ≡ `scaled * 3` (`3·P` is divisible by `P`).

Replace L135 with `scaled = scaled / 3;` and L141 with `scaled = scaled * 3;`. This is
**bit-identical** for every realistic input, removes the redundant `* PRECISION`
factor, eliminates an overflow edge case, and removes the Slither finding. The
"frozen for compatibility" comment (lines 118-121 / 161-163) concerns the *scaling
factor* (`+ k` vs `+ k·ln(3)`) in the final `return`, not the `/3` scaling loop — that
return statement is **not** changed. Update the loop comments to record that the
simplification preserves exact values.

> Conservative alternative (not chosen): keep the code and document
> `divide-before-multiply` as a false positive. Rejected because the simplification is
> provably behaviour-preserving and lets the baseline entry be removed, satisfying the
> issue's goal of gate enforcement (REQ-F5).

### 3.4 `incorrect-equality` ×3 — confirmed false positives

The `incorrect-equality` detector warns about strict `==`/`!=` an attacker can
manipulate (e.g. forcing `balanceOf(x) == n` false by sending 1 wei). None of the
three flagged sites are exploitable:

| # | Site | Why it is a false positive |
|---|------|----------------------------|
| 10 | `DataContributionRegistry.claimContribution:286` — `contributions[id].status == ContributionStatus.Verified` | Comparison of an **enum** value. An enum has a fixed finite domain and cannot be "manipulated"; strict equality is the only correct way to test a state-machine status. No range comparison is meaningful. |
| 11 | `DataContributionRegistry.getContributorGlobalStats:465` — `keccak256(bytes(seenModels[j])) == keccak256(bytes(modelId))` | The canonical Solidity idiom for **string equality**. `keccak256` hashes must be compared with `==`; there is no range or tracked-accounting alternative. |
| 12 | `FundingVault.sweepDust:488` — `dust == 0` where `dust = token.balanceOf(this)` | `sweepDust` is `onlyRole(DEFAULT_ADMIN_ROLE)` + `nonReentrant`. `dust == 0` is a benign early-return optimisation; the only alternative branch (`token.transfer(recipient, dust)`) is harmless regardless of the balance. An attacker forcing `dust != 0` by sending dust tokens gains nothing — the admin simply sweeps slightly more. No value can be extracted. |

**Verdict for all three: false positive — keep baselined, rewrite justification.** No
contract code changes. `DataContributionRegistry.sol` and `FundingVault.sol` are
therefore **not edited**, so these three baseline entries keep stable finding IDs.

---

## 4. Files to Modify

### Contract source (4 files)
- `contracts/TokenManager.sol` — `ReentrancyGuard`; `nonReentrant` on 2 deploy fns;
  `_collectDeploymentFee()` + `_refundExcess()` private helpers; `withdrawDeploymentFees()`;
  `DeploymentFeesWithdrawn` event; CEI reordering.
- `contracts/DeployableTokenManager.sol` — same set of changes; rewrite existing
  `_collectDeploymentFee()` to pull-payment.
- `contracts/HokusaiAMM.sol` — `require`-wrap the `transferFrom` return in `sell`.
- `contracts/libraries/BondingCurveMath.sol` — simplify the two `ln` scaling lines;
  update comments.

### Data / docs
- `slither-baseline.json` — remove 9 fixed entries; re-sync IDs of remaining entries
  whose line numbers shifted; rewrite the 3 `incorrect-equality` justifications.
- `docs/slither-static-analysis.md` — update the "Baselined High / Medium Findings"
  table to reflect what is now resolved.

### Tests
- `test/TokenManagerParams.test.js`, `test/TokenManager.allocations.test.js` — update
  fee-flow expectations to pull-payment.
- `test/Phase-Security-ReentrancyAttacks.test.js` — new reentrancy test for the deploy
  functions.
- New `withdrawDeploymentFees` tests (in the TokenManager test files).
- `test/Phase*` AMM suite — new `sell` unchecked-transfer test (may need a mock ERC20
  that returns `false` from `transferFrom`, added under `contracts/mocks/`).
- `test/libraries/BondingCurveMath.test.js` — assert `ln` outputs unchanged.

**Files explicitly NOT modified:** `contracts/DataContributionRegistry.sol`,
`contracts/FundingVault.sol` (false-positive sites — keeps their baseline IDs stable).

---

## 5. The Baseline-ID Reconciliation Problem (critical)

Slither finding `id`s are `sha3_256` hashes that **include each element's source
mapping** (verified in `slither/utils/output.py::_convert_to_id`). Editing a contract
shifts the line numbers of every finding below the edit **in the same file**, which
changes those findings' `id`s. `scripts/slither-gate.js` matches baseline entries
purely by `id`, so a stale `id` makes a still-valid accepted finding resurface as a
**gating** finding and fail the gate.

Editing `TokenManager.sol`, `DeployableTokenManager.sol`, and `HokusaiAMM.sol` will
shift the IDs of the *other* baselined findings in those files (`unused-return`,
`reentrancy-no-eth`, `reentrancy-benign`, `reentrancy-events`, `shadowing-local`).
`BondingCurveMath.sol`'s only baselined finding is the `divide-before-multiply` one
being removed, so its edit needs no re-sync. Unedited files keep stable IDs.

Additionally, applying `nonReentrant` to the 4 deploy functions removes not only the
4 `reentrancy-eth` findings but also the `reentrancy-benign` and `reentrancy-events`
findings on those same functions (Slither skips reentrancy reporting for guarded
functions) — those baseline entries must also be removed.

**Reconciliation procedure (Phase 6):**
1. **Before any edit**, capture a snapshot:
   `slither . --config-file slither.config.json --json /tmp/slither-before.json`.
2. After all code fixes compile, capture:
   `slither . --config-file slither.config.json --json /tmp/slither-after.json`.
3. For every baseline entry, look up its finding in the *before* snapshot to get a
   line-independent fingerprint: `(check, contract, function canonical name,
   description text with line numbers stripped)`.
4. Match each fingerprint to a finding in the *after* snapshot:
   - Match found → update the entry's `id` to the new `id`.
   - No match → the finding was resolved (fixed or `nonReentrant`-silenced) → remove
     the entry.
5. Any *after* finding with no matching baseline entry is either an expected ID-shift
   (already handled in step 4) or a **genuinely new** finding — investigate; per the
   task packet, a new High/Medium finding must stop work and be reported, not
   silently baselined.
6. Re-run `npm run slither` (gate mode) — it must exit `0`. Iterate 2-6 until clean.

A small throwaway Node script doing the fingerprint diff of the two JSON files is
recommended over manual editing (~24 entries shift) for reliability.

---

## 6. Implementation Phases

### Phase 0 — Pre-flight
- Confirm Slither 0.11.5 installed; run `npm run slither:report`; confirm exactly the
  12 in-scope findings present.
- Capture `/tmp/slither-before.json` snapshot (Section 5, step 1).
- Branch already exists (`task/remediate-...`).

### Phase 1 — TokenManager.sol (findings 1, 2, 4, 5)
- Add `ReentrancyGuard` import + inheritance.
- Add `DeploymentFeesWithdrawn` event.
- Add private `_collectDeploymentFee()` (pull-payment validation only) and
  `_refundExcess()` helpers; replace inline fee blocks in both deploy functions.
- Add `nonReentrant` to `deployTokenWithParams` / `deployTokenWithAllocations`.
- Reorder so `_refundExcess()` is the final statement (CEI).
- Add `withdrawDeploymentFees() external onlyOwner nonReentrant`.

### Phase 2 — DeployableTokenManager.sol (findings 3, 6, 7)
- Same changes as Phase 1; rewrite the existing `_collectDeploymentFee()` to
  pull-payment and add `_refundExcess()`.
- Run `npm run size-contracts`; confirm `DeployableTokenManager` stays under the
  EIP-170 24576-byte runtime limit (it is the size-sensitive variant). If it exceeds,
  flag and mitigate (e.g. trim revert strings) before proceeding.

### Phase 3 — HokusaiAMM.sol (finding 8)
- Wrap the `sell` `transferFrom` return value in `require(..., "Token transfer failed")`.

### Phase 4 — BondingCurveMath.sol (finding 9)
- Simplify `ln` lines 135/141 to `scaled / 3` and `scaled * 3`; update comments.

### Phase 5 — incorrect-equality false positives (findings 10-12)
- No contract changes. Handled in the baseline update (Phase 6) by rewriting the
  `justification` of the 3 `incorrect-equality` entries with the Section 3.4 rationale
  and keeping `followUp: "HOK-1823"`.

### Phase 6 — Baseline reconciliation
- Execute the Section 5 procedure: remove the 9 fixed entries + the `nonReentrant`-
  silenced `reentrancy-benign`/`reentrancy-events` entries on the 4 deploy functions;
  re-sync shifted IDs; rewrite the 3 false-positive justifications.
- Keep `slither-baseline.json` valid JSON; do not rename schema fields
  (`id`, `check`, `justification`, `reviewedBy`, `followUp`).
- `npm run slither` must exit `0`.

### Phase 7 — Tests
- See Section 7. Each genuine reentrancy / unchecked-transfer fix gets a test that
  fails pre-fix and passes post-fix (REQ-F9).

### Phase 8 — Docs
- Update `docs/slither-static-analysis.md`: in the "Baselined High / Medium Findings"
  table, remove `arbitrary-send-eth`, `reentrancy-eth`, `unchecked-transfer`, and
  `divide-before-multiply` rows (now fixed); keep `incorrect-equality` noted as a
  confirmed false positive; leave `unused-return` / `reentrancy-no-eth` rows as
  still-tracked (those are out of this issue's scope).

### Phase 9 — Full verification
- `npx hardhat compile` — clean.
- `npm test` — full Hardhat suite green (especially `test/Phase-Security-*`).
- `npm run slither` — exit `0`.
- `npm run size-contracts` — all contracts within EIP-170.

---

## 7. Test Scenarios

**Reentrancy (REQ-F9 — fail pre-fix, pass post-fix)**
- A malicious contract that re-enters `deployTokenWithParams` from its `receive()` when
  it gets the excess refund must cause the outer call to revert
  (`ReentrancyGuard: reentrant call`). Add to `test/Phase-Security-ReentrancyAttacks.test.js`
  for both `TokenManager` and `DeployableTokenManager`.

**Pull-payment fee flow**
- After a paid deploy: `feeRecipient` balance unchanged; manager contract balance
  equals `deploymentFee`.
- Caller sending more than `deploymentFee` is refunded the exact excess.
- Caller sending less than `deploymentFee` reverts ("Insufficient deployment fee").
- `withdrawDeploymentFees()` by the owner transfers the full accrued balance to
  `feeRecipient` and emits `DeploymentFeesWithdrawn`.
- `withdrawDeploymentFees()` from a non-owner reverts.
- `withdrawDeploymentFees()` with zero balance reverts ("No fees to withdraw").
- Update existing fee assertions in `test/TokenManagerParams.test.js` and
  `test/TokenManager.allocations.test.js` from push to pull semantics.

**Unchecked-transfer (REQ-F9)**
- `sell` reverts with "Token transfer failed" when the model token's `transferFrom`
  returns `false`. Likely needs a mock ERC20 returning `false` from `transferFrom`
  under `contracts/mocks/` (mocks are excluded from Slither analysis).

**Divide-before-multiply**
- `test/libraries/BondingCurveMath.test.js` `ln` cases continue to pass unchanged
  (existing coverage proves bit-identical behaviour); add an explicit assertion on a
  representative `ln` input if not already covered.

**Edge cases**
- `deploymentFee == 0` (default): deploy succeeds, no fee retained, no refund call,
  `withdrawDeploymentFees` reverts on zero balance.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Baseline ID drift breaks the gate for unrelated findings | Phase 6 snapshot-diff reconciliation; final `npm run slither` exit-0 is the gate. |
| `DeployableTokenManager` exceeds EIP-170 after additions | `npm run size-contracts` checked in Phase 2 before continuing. |
| Pull-payment changes deployment-fee UX | `deploymentFee` defaults to `0` (dormant); behaviour change is inert on current deployments; documented in PR. |
| A code fix introduces a new Slither finding | Phase 6 step 5 detects unmatched findings; new High/Medium → stop and report (per task packet). |
| `divide-before-multiply` rewrite alters pricing | Rewrite is provably bit-identical; full AMM/library test suite verifies; the frozen `+k` return line is untouched. |
| Slither not installable in coding environment | Fall back to CI Slither artifact and document, per `docs/slither-static-analysis.md`. |

---

## 9. Release Readiness

- **database_change_risk:** `none`
- **env_changes:** `none`
- **config_changes:** `slither-baseline.json` (Slither baseline data — entries removed
  / re-synced / rejustified); `slither.config.json` unchanged.
- **manual_steps:** `none` for this PR. Note (informational, out of scope): the
  contract bytecode changes mean live networks would need a contract redeployment for
  the fixes to take effect on-chain — tracked separately from this source-remediation
  issue.

---

## 10. Success Criteria (maps to task packet REQ-F1…F9)

- [ ] All 12 findings triaged with verdict + rationale (Section 2 table → PR body).
- [ ] 4 `reentrancy-eth` fixed via `nonReentrant` + CEI; reentrant attack reverts.
- [ ] 3 `arbitrary-send-eth` fixed via pull-payment; no unprotected function sends ETH
      to a tainted stored address.
- [ ] 1 `unchecked-transfer` fixed; `false`-returning `transferFrom` reverts `sell`.
- [ ] 1 `divide-before-multiply` fixed via bit-identical simplification.
- [ ] 3 `incorrect-equality` documented as false positives with concrete justification
      and `followUp: "HOK-1823"`.
- [ ] `slither-baseline.json` updated (9 entries removed, IDs re-synced, justifications
      rewritten); valid JSON; `node scripts/slither-gate.js` exits `0`.
- [ ] New tests fail pre-fix / pass post-fix for each genuine reentrancy &
      unchecked-transfer fix.
- [ ] `npx hardhat compile` + `npm test` pass; contract sizes within EIP-170.
- [ ] `docs/slither-static-analysis.md` updated.
- [ ] No unrelated changes; commits reference `HOK-1823`.
