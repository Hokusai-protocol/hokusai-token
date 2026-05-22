# Task Packet: HOK-1827_c — Add burnAMMTokens to DeployableTokenManager and prove AMM sell path

> Note: Automated expansion via `expand-issue.ts` was not possible — the task
> identifier `HOK-1827_c` is a challenger-variant slug, not a canonical Linear
> identifier (`TEAM-123`). This packet is assembled from the seeded
> `selected-task.json` description, which already contains a problem statement,
> required fix, and acceptance criteria.

## Problem

The fresh Sepolia stack deploys `DeployableTokenManager` (the EIP-170 size-safe
manager variant). `HokusaiAMM.sell()` calls `tokenManager.burnAMMTokens(...)`.
The legacy `TokenManager` implements `burnAMMTokens`, but `DeployableTokenManager`
does **not** — it only implements `burnTokens` and `burnInvestorTokens`.

Consequences:
- AMM **buys** succeed (`mintTokens` exists on both managers).
- AMM **sells** revert once the AMM calls the missing `burnAMMTokens` selector
  after the IBR (Initial Bonding Round) buy-only period ends.

## Relevant code

- `contracts/HokusaiAMM.sol` — `sell()` calls `tokenManager.burnAMMTokens(modelId, address(this), tokensIn)` (line ~291). The `tokenManager` field is typed `TokenManager` but only the selector matters at the call site.
- `contracts/TokenManager.sol` — implements `burnAMMTokens` (lines ~580-598) and the private `_burnAMMToken` helper (lines ~754-763).
- `contracts/DeployableTokenManager.sol` — implements `burnTokens`, `burnInvestorTokens`, `_burnInvestorToken`; **missing** `burnAMMTokens` / `_burnAMMToken`.
- `contracts/HokusaiToken.sol` — `burnAMM(from, amount)` reduces `investorMinted` first, then `rewardMinted`; supplier-distributed tokens are untracked and burned via ERC20 `_burn`.
- `contracts/interfaces/IManagedHokusaiToken.sol` — already declares `burnAMM(address,uint256)`.

## Required fix

Add to `DeployableTokenManager`:

```solidity
function burnAMMTokens(string memory modelId, address account, uint256 amount) external {
    require(
        hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner() || msg.sender == deltaVerifier,
        "Caller is not authorized to burn"
    );
    ValidationLib.requireNonEmptyString(modelId, "model ID");
    ValidationLib.requireNonZeroAddress(account, "account");
    ValidationLib.requirePositiveAmount(amount, "amount");

    address tokenAddress = modelTokens[modelId];
    require(tokenAddress != address(0), "Token not deployed for this model");

    _burnAMMToken(tokenAddress, account, amount);
    emit TokensBurned(modelId, account, amount);
}
```

plus the private helper `_burnAMMToken`, identical to `TokenManager._burnAMMToken`
(uses `IManagedHokusaiToken`; legacy unlimited-supply mode → `burnFrom`, cap-based
mode → `burnAMM`). Same authorization (`MINTER_ROLE` / owner / `deltaVerifier`),
same validation, same `TokensBurned` event.

## Acceptance criteria

1. `DeployableTokenManager` exposes `burnAMMTokens(string,address,uint256)` with
   the same selector and behavior as legacy `TokenManager`.
2. `HokusaiAMM.sell()` succeeds against a `DeployableTokenManager`-backed pool.
3. A local deployed-stack / e2e test uses `DeployableTokenManager`, buys tokens,
   advances past IBR (or configures zero IBR), executes a sell, and verifies
   reserve / supply / accounting invariants.
4. Test covers reward / supplier token holders selling, OR explicitly documents
   any unsupported sell provenance.
5. The Sepolia e2e token suite can run a real sell after IBR (or a local
   equivalent) without skipping due to manager incompatibility.
6. Fresh deployment artifacts and ABI guards are updated if needed.

## Notes

- The test work is part of this issue — the passing test is the proof that the
  contract wiring is fixed.
- This is a Solidity smart-contract change. No database, no migrations.
