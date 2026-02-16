# HOK-681: Token Issuance Testing - Test Results Summary

**Date:** 2026-02-16
**Branch:** `task/token-issuance-testing`
**Final Result:** 1042 passing, 0 failing, 84 pending (testnet skipped on local)

---

## 1. Initial Test Run

**Starting state:** 762 passing, 93 failing

All 93 failures traced to a single root cause: the **Infrastructure Cost Accrual System v2.0.0** merge (PR #39) changed contract APIs but tests were not updated.

### Categories of Failures

| Category | Count | Root Cause |
|----------|-------|------------|
| Missing `infrastructureAccrualBps` field | ~30 | Struct field renamed from `infraMarkupBps` |
| Value out of range | ~8 | Range changed from 0-1000 to 5000-10000 |
| Function not found | ~4 | `infraMarkupBps()` renamed to `infrastructureAccrualBps()` |
| `governor()` not found | ~8 | Getter removed in v2 |
| Testnet decode errors | ~30 | Testnet tests running on local Hardhat |
| CRR custom errors | 3 | String reverts changed to custom errors |
| UsageFeeRouter constructor | 1 | Completely restructured (4 params to 3) |
| Flash loan assertion | 1 | Fee percentage changed (0.25% to 0.30%) |

## 2. Fixes Applied

### Test Files Modified (25 files)

**API rename fixes (12 files):**
- `BackwardCompatibility.test.js` - struct field + values
- `HokusaiToken.test.js` - deploy value + getter
- `DeltaVerifier.registry.integration.test.js` - deploy value
- `DeltaVerifierParams.test.js` - struct field
- `ParamsIntegration.test.js` - struct, function, event, values
- `TokenManagerParams.test.js` - struct, getters, error messages
- `token.test.js` - deploy value
- `integration.test.js` - deploy value
- `integration.walletAddress.test.js` - deploy value
- `tokenmanager.test.js` - deploy value
- `deltaverifier.test.js` - deploy value
- `deltaVerifier.multiContributor.test.js` - deploy value

**Custom error fixes (2 files):**
- `Phase2-AMM-BondingCurve.test.js` - CRR validation uses `ValueOutOfBounds` custom error
- `Phase3-IBR-Integration.test.js` - CRR + trade fee custom errors

**Architecture change fixes (2 files):**
- `Phase5-FeeCollection.test.js` - complete rewrite for new UsageFeeRouter API
- `Phase-Security-FlashLoanAttacks.test.js` - updated fee assertion

**Testnet network guards (9 files):**
- All `test/testnet/*.test.js` files - added `network.name !== "sepolia"` skip guards

### New Test Files (2 files)

- `Phase6-TokenIssuance-GapCoverage.test.js` - 33 new tests covering identified gaps
- `scripts/validate-lscor-comprehensive.js` - comprehensive Sepolia validation script

## 3. Sepolia Live Validation

### LSCOR Token On-Chain State (15 checks, 14 passed)

| Check | Result | Detail |
|-------|--------|--------|
| Token name | PASS | "Hokusai LSCOR" |
| Token symbol | PASS | "LSCOR" |
| Total supply > 0 | PASS | 2,494,215.47 LSCOR |
| Controller is TokenManager | PASS | 0xe08d...5Db08 |
| Model 21 in ModelRegistry | FAIL | Model not registered (see note) |
| Threshold ($25,000) | PASS | $25,000 |
| Flat price ($0.01) | PASS | $0.01 |
| CRR (10%) | PASS | 10.0% |
| Graduated | PASS | hasGraduated=true |
| Phase BONDING_CURVE | PASS | phase=1 |
| Bonding curve pricing | PASS | 953.98 tokens/$100 (not 10,000 flat) |
| TokenManager model mapping | PASS | Maps model 21 to LSCOR |
| DeltaVerifier set | PASS | 0x8dE6...637b |
| DeltaVerifier -> TokenManager | PASS | Correct |
| DeltaVerifier -> ModelRegistry | PASS | Correct |

**Note on ModelRegistry:** Model 21 is registered in TokenManager's internal `modelTokens` mapping (set during `deployToken()`) but not in the standalone `ModelRegistry` contract. This is expected - `TokenManager.deployTokenWithParams()` does not call `ModelRegistry.registerModel()` because ModelRegistry uses `uint256` model IDs while TokenManager uses `string` model IDs. Not a bug, but a design asymmetry worth noting.

### Pool State Summary
- **Reserve:** $26,022.00 (above $25k threshold)
- **Phase:** BONDING_CURVE (permanently graduated)
- **Buy quote for $100:** ~954 tokens (bonding curve pricing active)
- **hasGraduated:** true (permanent, won't revert even if reserve drops)

## 4. Gap Coverage Tests Added (33 tests)

### Multi-Contributor Distribution Accuracy (5 tests)
- Extreme weight ratio 9999:1 (documents rounding bug - see bugs below)
- Moderate weight ratio 9000:1000
- Equal-weight distribution across 10 contributors (no dust loss)
- Zero-weight contributor rejection
- Maximum contributor count handling

### Token Supply Invariants (5 tests)
- totalSupply == sum of all balances after multiple mints
- Supply tracking after mint and burn cycle
- Controller change authorization
- Non-controller mint rejection
- Controller identity verification

### TokenManager Authorization (8 tests)
- Unauthorized mint/burn/batch rejection
- Authorized AMM minting
- Post-revocation mint rejection
- Zero amount/address rejection
- Non-existent model rejection

### AMM Phase Transition Edge Cases (4 tests)
- Initial FLAT_PRICE state with hasGraduated=false
- PhaseTransition event on threshold crossing
- Graduation permanence after sell drops reserve below threshold
- Flat vs bonding curve pricing comparison

### Infrastructure Accrual Boundary Values (6 tests)
- Minimum boundary (5000) acceptance
- Maximum boundary (10000) acceptance
- Below minimum (4999) rejection
- Above maximum (10001) rejection
- Governor update within bounds
- Event emission on update

### Batch Minting Edge Cases (5 tests)
- Correct batch mint with total tracking
- BatchMinted event with correct totals
- Mismatched array length rejection
- Zero address in batch rejection
- Zero amount in batch rejection

## 5. Bugs Found

### BUG: Multi-Contributor Rounding to Zero (Severity: Medium)

**Location:** `DeltaVerifier.sol:192` + `TokenManager.sol:272`

**Description:** When a contributor has a very small weight relative to the total reward, their individual reward `(totalReward * weight) / 10000` can round to zero. When this happens, `batchMintTokens()` reverts with `InvalidAmount("amount")` because `ValidationLib.requirePositiveAmount()` rejects zero amounts. This causes the entire multi-contributor submission to fail - no contributor receives tokens.

**Reproduction:** Submit evaluation with contributors `[{weight: 9999}, {weight: 1}]`. The minority contributor's reward rounds to 0, reverting the entire batch.

**Impact:** Prevents valid multi-contributor submissions with very skewed weight distributions. Could block legitimate data contributors from receiving rewards.

**Recommendation:** Either:
1. Skip zero-amount mints in `batchMintTokens()` instead of reverting
2. Enforce a minimum weight per contributor (e.g., 100 bps = 1%)
3. Assign dust amounts to the last contributor to avoid rounding loss

## 6. Test Configuration Notes

- **Testnet tests (84 pending):** All 9 testnet test files have network guards that skip on non-Sepolia. These tests require `npx hardhat test --network sepolia` to execute.
- **Compilation warnings:** 2 minor warnings in DeltaVerifier.sol (unused variables in internal functions). Non-blocking.
- **Gas usage:** All tests run within Hardhat default gas limits. No gas-related failures.

## 7. Summary

| Metric | Value |
|--------|-------|
| Tests passing | 1042 |
| Tests failing | 0 |
| Tests pending | 84 (testnet, expected) |
| New tests added | 33 |
| Files modified | 25 |
| Files created | 2 |
| Bugs found | 1 (medium severity) |
| Sepolia checks passed | 14/15 |
