# DeltaVerifier Mint Request Semantics

Purpose: document the contract semantics that the Hardhat suite locks in for `DeltaVerifier.submitMintRequest`.

Audience: auditors, off-chain settlement service authors, and operators handling retries or budget data.

Last verified against:
- `contracts/DeltaVerifier.sol` around `L296-L314`, `L320-L364`, and `L555-L569`
- `contracts/TokenManager.sol` around `L569-L576`
- Hardhat tests in `test/DeltaVerifier.mintRequest.test.js`

## 1. Idempotency key is burned before the budget check

`DeltaVerifier.submitMintRequest` validates contributor structure first, then marks `processedIdempotencyKeys[payload.anchors.idempotencyKey] = true`, and only after that checks `_isBudgetConstraintViolated(...)`.

Tests that lock this in:
- `consumes idempotency on budget violations and mints nothing`
- `requires a new idempotency key after a budget-blocked submission`
- `reusing a successful key is rejected (control)`

Decision: intended.

Rationale: a budget-blocked submission should not be replayable after cost inputs or operator state change. Burning the key before the budget branch prevents retry probing against mutable budget conditions.

Operator guidance:
- A budget-blocked submission consumes its idempotency key.
- Any corrected resubmit must use a fresh key.
- One safe pattern is `keccak256(previousKey || retryNonce)` generated off-chain.

## 2. Budget enforcement is disabled when `maxCost == 0` or `actualCost == 0`

`DeltaVerifier._isBudgetConstraintViolated` returns `false` when either `maxCostUsdMicro` or `actualCostUsdMicro` is zero.

Tests that lock this in:
- `disables budget enforcement when maxCostUsdMicro == 0 with nonzero actualCost`
- `disables budget enforcement when actualCostUsdMicro == 0 with nonzero maxCost`
- `enforces budget when both costs are positive and actualCost > maxCost (control)`

Decision: intended.

Implications:
- Passing either field as zero disables enforcement for that submission.
- Mixed-zero inputs behave the same as both-zero inputs.
- Client SDKs must not silently default `actualCostUsdMicro` to zero, because that bypasses the budget guard.

## 3. Zero-delta submissions emit acceptance and mint nothing

When `candidateScoreBps <= baselineScoreBps`, the delta is zero, `totalReward` is zero, `DeltaOneAccepted` still emits, and the mint path is skipped because `submitMintRequest` only calls `tokenManager.batchMintReward(...)` when `totalReward > 0`.

`TokenManager.batchMintReward` also skips any zero-amount contributor entries if it is called with them, but the zero-delta `submitMintRequest` path does not call the batch mint function at all.

Tests that lock this in:
- `emits zero-reward acceptance when candidate does not beat baseline`
- `zero-delta (candidate == baseline) emits acceptance but mints nothing`
- `negative-delta (candidate < baseline) emits acceptance but mints nothing`

Decision: intended.

Indexer guidance:
- `DeltaOneAccepted` means the evaluation was accepted for processing.
- Downstream systems must check `rewardAmount > 0` before recording token mint outcomes.

## Cross References

- Primary mint-request coverage: `test/DeltaVerifier.mintRequest.test.js`
- Legacy multi-contributor API coverage: `test/deltaVerifier.multiContributor.test.js`

## Maintenance Note

If line numbers shift, treat the tests as the source of truth for the observable contract behavior and update this document to point at the new locations.
