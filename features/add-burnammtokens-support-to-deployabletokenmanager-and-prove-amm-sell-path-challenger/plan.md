# Implementation Plan: HOK-1827_c — burnAMMTokens on DeployableTokenManager + AMM sell proof

## 1. Summary

`HokusaiAMM.sell()` delegates the token burn to `tokenManager.burnAMMTokens(...)`.
The legacy `TokenManager` implements that function; the size-safe
`DeployableTokenManager` — the manager deployed in the fresh Sepolia stack —
does not. AMM buys work (both managers have `mintTokens`), but any post-IBR sell
reverts on the missing selector.

The fix is to port `burnAMMTokens` (and its private helper `_burnAMMToken`) from
`TokenManager` to `DeployableTokenManager` with identical semantics, then prove
the wired sell path with a local end-to-end test that builds a
`DeployableTokenManager`-backed stack, buys, advances past IBR, and sells.

## 2. Routing / expansion notes

- **Expansion:** `expand-issue.ts HOK-1827_c` was attempted and rejected —
  `HOK-1827_c` is a challenger-variant slug, not a canonical Linear identifier
  (`TEAM-123`). The seeded `selected-task.json` description already contains a
  full problem statement, required fix, and acceptance criteria, so the local
  `task-packet.md` was assembled directly from it.
- **Re-route:** Not performed. Re-routing is only meaningful when expansion
  produces a richer spec; since the spec is unchanged, `.initial-route.json`
  (planner = opus, coder = haiku, reviewer = sonnet, planDepth = deep) remains
  authoritative. No `.post-expansion-route.json` was written.
- **Migrations:** None. This is a Solidity smart-contract change — no database,
  Alembic, or schema work. No `.migration-detected` marker created.

## 3. Codebase research findings

### 3.1 Call site — `HokusaiAMM.sol`
`sell()` (lines ~257-308) does, in order:
1. `require(isSellEnabled())` — reverts during IBR (`block.timestamp >= buyOnlyUntil`).
2. Computes `reserveOut` via `getSellQuote`, applies trade fee, decrements `reserveBalance`.
3. `IERC20(hokusaiToken).transferFrom(msg.sender, address(this), tokensIn)` — pulls tokens to the AMM.
4. `IERC20(hokusaiToken).approve(address(tokenManager), tokensIn)`.
5. `tokenManager.burnAMMTokens(modelId, address(this), tokensIn)` — **the missing selector**.
6. Transfers USDC out, transfers fee to treasury, emits `Sell`.

`tokenManager` is typed `TokenManager` but constructed from `address payable`.
At the call site only the 4-byte selector + ABI encoding matter, so a
`DeployableTokenManager` deployed at that address works as soon as it exposes a
`burnAMMTokens(string,address,uint256)` function. **No change to `HokusaiAMM.sol`
is required.** `DeployableTokenManager` already has `receive() external payable {}`,
so the `address payable` cast is satisfied.

### 3.2 Reference implementation — `TokenManager.sol`
- `burnAMMTokens` (lines ~580-598): auth check (`MINTER_ROLE` / `owner()` /
  `deltaVerifier`), `ValidationLib` checks (non-empty modelId, non-zero account,
  positive amount), resolves `modelTokens[modelId]`, calls `_burnAMMToken`,
  emits `TokensBurned`.
- `_burnAMMToken` (lines ~754-763): if `token.maxSupply() == type(uint256).max`
  (legacy unlimited mode) → `token.burnFrom(account, amount)`; else (cap-based)
  → `token.burnAMM(account, amount)`.

### 3.3 Target — `DeployableTokenManager.sol`
- Has `MINTER_ROLE`, `deltaVerifier`, `modelTokens`, `TokensBurned` event,
  `ValidationLib`, and uses the `IManagedHokusaiToken` interface (it does **not**
  import the concrete `HokusaiToken`).
- Already implements `burnTokens` (lines ~371-384), `burnInvestorTokens`
  (lines ~386-399), and the private `_burnInvestorToken` (lines ~559-567) —
  the exact pattern `burnAMMTokens` / `_burnAMMToken` should follow.
- Legacy `TokenManager._burnAMMToken` already uses `IManagedHokusaiToken`, so the
  helper can be copied verbatim — no concrete-type import needed.

### 3.4 Token burn semantics — `HokusaiToken.sol`
- `burnAMM(from, amount)` (lines ~211-223): for cap-based tokens decrements
  `investorMinted` first (up to its balance), then `rewardMinted` with the
  remainder; supplier-distributed tokens have no counter and are simply `_burn`ed.
  ERC20 `_burn` enforces sufficient balance.
- `burnFrom` is `onlyController` and does a plain `_burn` — used for legacy
  unlimited-supply tokens where there is no investor/reward provenance.

### 3.5 Existing tests / fixtures
- `test/DeployableTokenManager.vesting.test.js` — already builds a
  `DeployableTokenManager` + `TokenDeploymentFactory` + `HokusaiAMM` stack and
  has a reusable `deployAmm` helper (IBR = 0, deposits reserve via `depositFees`).
- `test/e2e/local-mainnet-readiness.test.js` — full cross-contract e2e, but uses
  the **legacy `TokenManager`**; its `"covers AMM buy/sell..."` case is the
  template for the buy → advance-time → sell → invariant flow.
- `test/scripts/deployStack.test.js` — exercises `deployFullStack` (which deploys
  `DeployableTokenManager`, `contracts._tokenManagerImpl === "DeployableTokenManager"`)
  in dry-run mode and creates an AMM pool.
- `test/helpers/tokenDeployment.js` — `buildInitialParams`, `buildVestingConfig`,
  `buildDisabledVestingConfig`, `deployTestToken`/`deployTestTokenAddress`.
- `test/testnet/real-sell-transactions.test.js` & `test/e2e/sepolia-end-to-end.test.js`
  — Sepolia suites; gated on `network.name === "sepolia"` / `SEPOLIA_E2E` env, so
  they do not run in the default CI suite. The local e2e test is the runnable
  proof for CI.

### 3.6 ABI guards / deployment artifacts
- No ABI-snapshot or selector-guard test exists (`grep` for `selector` /
  `abi-guard` / interface guards found nothing under `test/`).
- `tools/deltaone-simulator/abis/TokenManager.json` is a **partial** ABI for the
  simulator and contains no burn functions — not affected.
- `deployments/*.json` artifacts store addresses and config, not ABIs — not
  affected by a source-only change.
- **Conclusion:** criterion 6 ("ABI guards updated if needed") requires no work;
  there is nothing to update. The coding agent should confirm during
  implementation and document this in the PR.

## 4. Approaches considered

### Approach A — Port `burnAMMTokens` directly into `DeployableTokenManager` (CHOSEN)
Copy `burnAMMTokens` + `_burnAMMToken` from `TokenManager`, adapting to the
target's existing `IManagedHokusaiToken`-based style. Minimal, surgical, matches
the issue's "Required fix" verbatim, and keeps the two managers behaviorally
consistent.

### Approach B — Extract a shared base contract / library for burn logic
Refactor the common burn/auth code shared by `TokenManager` and
`DeployableTokenManager` into a base. Rejected: large blast radius, touches the
legacy manager, risks EIP-170 size regressions, and is out of scope — the issue
asks for parity, not a refactor.

### Approach C — Change `HokusaiAMM` to call `burnInvestorTokens` instead
Rejected: `burnInvestorTokens` only restores investor headroom and would revert
(`"Burn exceeds investor minted"`) when reward/supplier tokens are sold.
`burnAMM` is the correct primitive — it tolerates mixed provenance. Also would
diverge from the legacy stack and break already-deployed legacy pools.

**Decision: Approach A.** It satisfies every acceptance criterion with the least
risk and exactly matches the prescribed fix.

## 5. Implementation phases

### Phase 1 — Contract change: `contracts/DeployableTokenManager.sol`
1. Add the external `burnAMMTokens(string memory modelId, address account, uint256 amount)`
   function, placed immediately after `burnInvestorTokens` (after line ~399), for
   locality with the other burn functions.
   - Auth: `require(hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier, "Caller is not authorized to burn")`.
   - Validation: `ValidationLib.requireNonEmptyString(modelId, "model ID")`,
     `requireNonZeroAddress(account, "account")`, `requirePositiveAmount(amount, "amount")`.
   - Resolve `address tokenAddress = modelTokens[modelId]; require(tokenAddress != address(0), "Token not deployed for this model")`.
   - Call `_burnAMMToken(tokenAddress, account, amount)`.
   - `emit TokensBurned(modelId, account, amount)`.
2. Add the private helper `_burnAMMToken(address tokenAddress, address account, uint256 amount)`,
   placed next to `_burnInvestorToken` (after line ~567):
   - `IManagedHokusaiToken token = IManagedHokusaiToken(tokenAddress);`
   - `if (token.maxSupply() == type(uint256).max) { token.burnFrom(account, amount); return; }`
   - `token.burnAMM(account, amount);`
3. Keep the NatSpec comment consistent with the existing `burnInvestorTokens`
   doc style (note: restores investor headroom first, then reward; supplier
   tokens burned without further tracking).
4. Confirm no new imports are needed (`IManagedHokusaiToken`, `ValidationLib`,
   `ModelRegistry` are already imported).

### Phase 2 — Compile & size check
1. `npx hardhat compile` — must succeed cleanly.
2. Verify `DeployableTokenManager` runtime bytecode stays under the EIP-170 limit
   (24,576 bytes). The addition mirrors `burnInvestorTokens` (already present),
   so the delta is small, but the whole point of `DeployableTokenManager` is size
   safety — confirm with the compiler size report (`hardhat-contract-sizer` if
   configured, or inspect artifact `deployedBytecode` length).

### Phase 3 — End-to-end proof test: `test/e2e/deployable-amm-sell.test.js` (NEW)
A dedicated e2e file that builds a `DeployableTokenManager`-backed stack and
exercises the full buy → IBR → sell path. Structure mirrors
`local-mainnet-readiness.test.js` but swaps in `DeployableTokenManager` +
`TokenDeploymentFactory`, and reuses the wiring pattern from
`DeployableTokenManager.vesting.test.js`'s `deployAmm` helper.

Stack per test:
- `ModelRegistry`, `TokenDeploymentFactory`, `DeployableTokenManager`
  (`constructor(registry, tokenDeploymentFactory)`).
- `modelRegistry.setStringModelTokenManager(tokenManager)`.
- `HokusaiAMMFactory(modelRegistry, tokenManager, mockUSDC, treasury)`,
  `modelRegistry.setPoolRegistrar(factory, true)`.
- A token via `deployTokenWithParams` (legacy unlimited mode) and, separately,
  via `deployTokenWithAllocations` (cap-based mode) — see scenarios below.
- `factory.createPoolWithParams(modelId, token, crr, fee, ibrSeconds, flatThreshold, flatPrice)`.
- `tokenManager.authorizeAMM(poolAddress)` so the pool holds `MINTER_ROLE`.
- `MockUSDC` minted/approved to the trader.

Test scenarios:

**Scenario 3.1 — Selector & ABI parity (unit-level guard)**
- Assert `DeployableTokenManager` exposes `burnAMMTokens` and that its 4-byte
  selector equals `TokenManager`'s (`iface.getFunction("burnAMMTokens").selector`
  comparison, or compare against the legacy ABI). This directly proves criterion 1
  and acts as the "ABI guard" for the new surface.

**Scenario 3.2 — Legacy-mode buy → advance past IBR → sell (criteria 2, 3, 5)**
- Deploy a legacy token (`deployTokenWithParams`, `maxSupply == type(uint256).max`).
- Trader `buy()`s with USDC; assert tokens minted, `reserveBalance` increased by
  `reserveIn - fee`, treasury received `fee`.
- Assert a `sell()` **reverts during IBR** with `"Sells not enabled during IBR"`
  (sanity that IBR gating is active).
- `evm_increaseTime` past `buyOnlyUntil`, then `evm_mine`.
- Trader `approve()`s the pool and `sell()`s a portion; assert the `Sell` event,
  USDC received ≈ quote, `reserveBalance` decreased by `reserveOut`,
  `token.totalSupply()` decreased by `tokensIn`, trader token balance decreased
  by `tokensIn`, and `mockUSDC.balanceOf(pool) == reserveBalance + treasuryFees`
  (USDC conservation).
- This is the regression that would have reverted before the fix.

**Scenario 3.3 — Zero-IBR sell variant (criterion 3 "or configures zero IBR")**
- Create a pool with `ibrSeconds = 0`; assert `isSellEnabled()` is immediately
  true and a `sell()` succeeds without time travel. Lightweight confirmation that
  both IBR configurations are covered.

**Scenario 3.4 — Cap-based token: investor / reward / supplier sell provenance (criterion 4)**
- Deploy a cap-based token via `deployTokenWithAllocations` (supplier allocation +
  investor allocation; `maxSupply` finite).
- Mint investor tokens through the AMM `buy()` (drives `investorMinted` up).
- Mint reward tokens via `tokenManager.mintReward(...)` to a reward holder.
- `distributeModelSupplierAllocation(...)` to mint the supplier allocation.
- After IBR, have each holder `sell()` into the AMM and assert:
  - Investor holder sell → `investorMinted` decremented first.
  - Reward holder sell (after investor headroom exhausted) → `rewardMinted`
    decremented.
  - Supplier holder sell → succeeds via untracked `_burn` (no counter); document
    in a test comment that supplier-distributed tokens carry no separate
    provenance counter, matching `HokusaiToken.burnAMM` semantics.
  - `getRedeemableSupply` / `totalSupply` invariants hold after each sell.
- If selling a particular provenance proves economically unsupported, the test
  must explicitly document it (criterion 4 allows this) — but per `burnAMM`
  semantics all three are expected to succeed.

**Scenario 3.5 — Authorization negatives**
- A non-authorized caller calling `tokenManager.burnAMMTokens(...)` directly
  reverts with `"Caller is not authorized to burn"`.
- Validation reverts: empty modelId, zero account, zero amount, and
  unknown/undeployed modelId (`"Token not deployed for this model"`).

### Phase 4 — Full suite & regression check
1. Run the new file: `npx hardhat test test/e2e/deployable-amm-sell.test.js`.
2. Run the existing manager + AMM suites to confirm no regressions:
   `test/DeployableTokenManager.vesting.test.js`, `test/tokenmanager.test.js`,
   `test/scripts/deployStack.test.js`, `test/e2e/local-mainnet-readiness.test.js`,
   and the `Phase*` AMM tests.
3. Full `npm test` should pass.

### Phase 5 — Deployment artifacts / ABI guards review (criterion 6)
1. Confirm there is no ABI-snapshot file or selector-guard test that needs the
   new function added (research in §3.6 found none).
2. `deployments/*.json` store addresses/config, not ABIs — no update needed for
   a source-only change with no redeploy.
3. Document in the PR description that no ABI-guard / artifact changes were
   required, and why (so reviewers see criterion 6 was considered).
4. No Sepolia redeploy is performed in this task; the local e2e test is the
   runnable proof. If/when the stack is redeployed, the new `DeployableTokenManager`
   bytecode will carry `burnAMMTokens` automatically.

## 6. Edge cases & risks

- **EIP-170 size limit:** `DeployableTokenManager` exists specifically to stay
  under 24,576 bytes. The new code is small and mirrors existing `burnInvestorTokens`,
  but Phase 2 explicitly verifies the size budget.
- **Mixed-provenance burns:** `HokusaiAMM.sell()` always burns from
  `address(this)` (the pool), not the original seller, and provenance counters
  (`investorMinted` / `rewardMinted`) are token-global. `burnAMM` handles this by
  draining investor headroom first, then reward; supplier tokens are untracked.
  The test asserts the resulting counters, not per-seller attribution.
- **Legacy vs cap-based dispatch:** `_burnAMMToken` branches on
  `maxSupply == type(uint256).max`. Both branches are covered (Scenario 3.2 legacy,
  3.4 cap-based).
- **IBR gating:** Scenario 3.2 asserts the pre-IBR revert and the post-IBR
  success; Scenario 3.3 covers the zero-IBR config.
- **No `HokusaiAMM.sol` change:** the typed `TokenManager` field resolves the
  selector dynamically; confirmed safe. Avoid touching the AMM to keep
  already-deployed legacy pools unaffected.
- **`deltaVerifier` unset:** `burnAMMTokens` auth tolerates `deltaVerifier` being
  the zero address (the OR check still passes for `MINTER_ROLE`/owner). The AMM
  holds `MINTER_ROLE` via `authorizeAMM`, which is the real sell path.

## 7. Files touched

| File | Change |
|------|--------|
| `contracts/DeployableTokenManager.sol` | Add `burnAMMTokens` external fn + `_burnAMMToken` private helper |
| `test/e2e/deployable-amm-sell.test.js` | **New** e2e test proving the DeployableTokenManager AMM sell path |

No changes to `HokusaiAMM.sol`, `TokenManager.sol`, `HokusaiToken.sol`,
interfaces, deploy scripts, or deployment artifacts.

## 8. Test scenarios summary

| # | Scenario | Criterion |
|---|----------|-----------|
| 3.1 | `burnAMMTokens` selector parity with legacy `TokenManager` | 1 |
| 3.2 | Legacy-mode buy → pre-IBR sell reverts → post-IBR sell succeeds, invariants hold | 2, 3, 5 |
| 3.3 | Zero-IBR pool: sell succeeds immediately | 3 |
| 3.4 | Cap-based token: investor / reward / supplier holders sell; provenance counters asserted/documented | 4 |
| 3.5 | Auth + validation negatives on `burnAMMTokens` | 1 |

## 9. Release Readiness

- `database_change_risk`: none
- `env_changes`: none
- `config_changes`: none
- `manual_steps`: none

Solidity source-only change plus a new Hardhat test. No database, no
environment variables, no config files, no migrations. Deployed contracts are
immutable — picking up `burnAMMTokens` requires a future redeployment of
`DeployableTokenManager`, which is out of scope for this task (the issue scope is
the contract wiring fix + the local test proof). When a fresh stack is next
deployed, the new bytecode carries the fix automatically.

## 10. Validation checklist

- [ ] `npx hardhat compile` succeeds.
- [ ] `DeployableTokenManager` runtime bytecode < 24,576 bytes (EIP-170).
- [ ] `npx hardhat test test/e2e/deployable-amm-sell.test.js` passes.
- [ ] `DeployableTokenManager.vesting`, `tokenmanager`, `deployStack`,
      `local-mainnet-readiness`, and `Phase*` AMM suites still pass.
- [ ] Full `npm test` green.
- [ ] PR notes that no ABI-guard / deployment-artifact changes were needed.
