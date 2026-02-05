# Security Audit Plan: HokusaiAMM Mathematical Functions
**Linear Issue:** HOK-653
**Created:** 2026-01-09
**Status:** Ready for Implementation

---

## Overview

### What We're Auditing
Comprehensive security audit of the HokusaiAMM bonding curve implementation, focusing on:
1. Mathematical correctness of `_pow()`, `_ln()`, and `_exp()` functions
2. Potential economic attack vectors (flash loans, sandwich attacks, MEV)
3. Smart contract vulnerabilities (reentrancy, access control, edge cases)
4. Reserve/supply accounting integrity across all operations

### Why This Matters
The AMM controls user funds through a custom bonding curve implementation using Taylor series approximations for power functions. Any mathematical imprecision or security vulnerability could lead to:
- **Fund loss** from exploitable precision errors
- **Economic attacks** via arbitrage, flash loans, or MEV
- **Contract breakage** from edge case inputs causing reverts or gas exhaustion
- **Loss of user trust** if reserve accounting is corrupted

### Success Criteria
**Automated Checks:**
- ✅ All new security tests pass (target: 100% pass rate)
- ✅ No new test reduces coverage (maintain 615+ passing tests)
- ✅ Gas benchmarks within acceptable ranges (<10M gas per transaction)
- ✅ Mathematical precision errors within documented tolerances

**Manual Verification:**
- ✅ All critical concerns from research report addressed
- ✅ Previous arbitrage vulnerability fix verified as complete
- ✅ No new similar vulnerability patterns exist
- ✅ Code review completed with documented findings

---

## Current State

### Existing Security Measures (Strengths)
From research report and codebase analysis:

**Access Control:**
- ✅ OpenZeppelin `Ownable` for governance functions
- ✅ OpenZeppelin `Pausable` for emergency stops
- ✅ OpenZeppelin `ReentrancyGuard` on trading functions
- ✅ IBR time-lock for sell operations
- ✅ Deadline enforcement on trades
- ✅ Slippage protection (user-controlled)

**Mathematical Safeguards:**
- ✅ Multiple precision optimizations (binomial expansion for small exponents)
- ✅ Scaling strategies in `_ln()` and `_exp()` to prevent overflow
- ✅ Early termination in Taylor series when converged
- ✅ Explicit `require()` checks for undefined operations (e.g., ln(0))
- ✅ Solidity 0.8+ checked arithmetic (automatic overflow/underflow revert)

**Testing:**
- ✅ 615 passing tests (confirmed via npm test)
- ✅ Dedicated security test suite ([test/Phase2-Power-Function-Security.test.js](../../test/Phase2-Power-Function-Security.test.js))
- ✅ Tests cover: approximation errors, exploitation attempts, edge cases
- ✅ Bonding curve behavior validated ([test/Phase2-AMM-BondingCurve.test.js](../../test/Phase2-AMM-BondingCurve.test.js))

### Known Gaps (From Research)

**🔴 Critical Concerns:**
1. **Gas exhaustion attack** - Unbounded while loops in `_ln()` and `_exp()` (lines 652-661, 695-698)
2. **No max trade size** - Single transaction can consume entire reserve
3. **No circuit breakers** - Flash crash scenarios unchecked
4. **Single owner control** - Centralization risk (no multisig/timelock)

**🟡 Medium Concerns:**
5. **Fee-on-transfer compatibility** - Reserve accounting assumes standard ERC20
6. **No slippage hard limit** - Users can set minOut=0 (footgun)
7. **Treasury withdrawal edge case** - No explicit check for accounting errors
8. **Timestamp manipulation** - IBR relies on block.timestamp (minor, 15s window)

**🟢 Low Concerns:**
9. **View function gas** - `getBuyQuote()` could be exploited for DoS in on-chain integrations
10. **Decimal precision loss** - No documented acceptable error bounds
11. **Limited reentrancy testing** - Malicious ERC20 interactions not tested

### Previous Vulnerability Status ✅ VERIFIED

**Vulnerability:** Power function arbitrage exploit (commit 72b4a79, Jan 8 2026)
**Severity:** 🔴 CRITICAL - Allowed $175 profit from repeated trades
**Root Cause:** Linear approximations in `_pow()` created systematic mathematical errors
**Fix:** Replaced with Taylor series (ln/exp) with 8-10 term accuracy
**Status:** ✅ FIXED AND VERIFIED - See [previous-vulnerability-report.md](./previous-vulnerability-report.md)

**Attack Scenarios (Reproduced):**
- Single round-trip: $36 profit (expected: $5 loss)
- Repeated trades: $175 profit (expected: $50 loss)

**Fix Verification:**
- Round-trip now: $4 loss ✅
- Repeated trades now: $49 loss ✅
- All 7 security tests passing ✅
- No similar patterns found in other contracts ✅

---

## Proposed Changes

### Implementation Phases

---

## **Phase 1: Gas Exhaustion Testing** (Priority: Critical)
**Goal:** Prevent DoS attacks via extreme inputs causing out-of-gas errors

### Changes:
**File:** `test/Phase2-Power-Function-Security.test.js`

**New Test Suite:** "Gas Exhaustion & DoS Protection"

#### Test 1: Gas benchmark for extreme inputs
```javascript
it("Should measure gas consumption for extreme power function inputs", async function () {
  const extremeCases = [
    { base: parseEther("1000000"), exp: parseEther("0.5"), desc: "Very large base" },
    { base: parseEther("0.000001"), exp: parseEther("2"), desc: "Very small base" },
    { base: parseEther("1.5"), exp: parseEther("100"), desc: "Large exponent" },
    { base: parseEther("0.99"), exp: parseEther("0.001"), desc: "Small exp, base near 1" },
  ];

  for (const testCase of extremeCases) {
    // Attempt buy that would trigger pow with extreme values
    // Measure gas and ensure it's < 10M gas limit
  }
});
```

#### Test 2: Loop iteration limits
```javascript
it("Should limit iterations in ln() scaling loop", async function () {
  // Try to trigger maximum while loop iterations in _ln()
  // Verify it doesn't exceed reasonable gas cost
});

it("Should limit iterations in exp() scaling loop", async function () {
  // Try to trigger maximum while loop iterations in _exp()
  // Verify it doesn't exceed reasonable gas cost
});
```

### Success Criteria:
- ✅ All extreme inputs complete within 10M gas limit
- ✅ Document max gas costs for each function
- ✅ If any inputs cause out-of-gas, add explicit bounds to contract

---

## **Phase 2: Maximum Trade Size Limits** (Priority: Critical) ✅ DECISION MADE
**Goal:** Prevent market manipulation via massive single-transaction trades

**Decision:** **Hard limit (reverts)** - Recommended: **20% of reserve**

**Rationale:**
- Hard limit prevents whale manipulation and flash loan attacks
- 20% balances liquidity access with price stability
- Governance-adjustable for different pool sizes/maturities
- Can be increased to 50% for mature pools with deep liquidity

### Changes:
**File:** `contracts/HokusaiAMM.sol`

**Implementation: Hard Limit with Governance Control**
```solidity
uint256 public maxTradeBps = 2000; // 20% of reserve in basis points (adjustable)
uint256 public constant MAX_TRADE_BPS_LIMIT = 5000; // Never exceed 50%

function buy(...) external ... {
    require(reserveIn > 0, "Reserve amount must be > 0");

    // Check trade size limit
    uint256 maxTradeSize = (reserveBalance * maxTradeBps) / 10000;
    require(reserveIn <= maxTradeSize, "Trade exceeds max size limit");

    // ... rest of buy logic
}

function sell(...) external ... {
    require(tokensIn > 0, "Token amount must be > 0");

    // Calculate USDC out first to check limit
    uint256 reserveOut = getSellQuote(tokensIn);
    uint256 maxTradeSize = (reserveBalance * maxTradeBps) / 10000;
    require(reserveOut <= maxTradeSize, "Trade exceeds max size limit");

    // ... rest of sell logic
}

function setMaxTradeBps(uint256 newMaxTradeBps) external onlyOwner {
    require(newMaxTradeBps > 0, "Max trade bps must be > 0");
    require(newMaxTradeBps <= MAX_TRADE_BPS_LIMIT, "Max trade bps too high");

    emit MaxTradeBpsUpdated(maxTradeBps, newMaxTradeBps);
    maxTradeBps = newMaxTradeBps;
}

event MaxTradeBpsUpdated(uint256 oldBps, uint256 newBps);
```

**Test Suite:** `test/Phase-Security-TradeSizeLimits.test.js`
- Test trades at 19%, 20%, 21% of reserve (verify 21% reverts)
- Test both buy() and sell() limits
- Test updating maxTradeBps governance function
- Test bounds (cannot set > 50%)
- Test edge cases (exactly at limit, 1 wei over)

### Success Criteria:
- ✅ Hard limit implemented in buy() and sell()
- ✅ Governance function with proper bounds (max 50%)
- ✅ Tests cover edge cases (exactly at limit, 1 wei over)
- ✅ Event emitted when limit adjusted
- ✅ Document rationale in code comments

---

## **Phase 3: Flash Loan Attack Testing** (Priority: Critical)
**Goal:** Verify AMM cannot be drained via flash loan arbitrage

### Changes:
**File:** `test/Phase2-Power-Function-Security.test.js`

**New Test Suite:** "Flash Loan & MEV Attack Scenarios"

#### Test 1: Flash loan arbitrage attempt
```javascript
it("Should prevent profit from flash loan buy-sell cycle", async function () {
  // Simulate flash loan scenario:
  // 1. Borrow $1M USDC
  // 2. Buy tokens (price increases)
  // 3. Immediately sell tokens (price decreases)
  // 4. Repay loan + fee
  //
  // Expected: Net loss due to:
  // - Trade fees (0.25% x 2 = 0.5%)
  // - Price impact (bonding curve slippage)
  // - No arbitrage opportunity should exist

  const flashLoanAmount = parseUnits("1000000", 6); // $1M
  const flashLoanFee = flashLoanAmount / 1000n; // 0.1% typical fee

  // Attacker buys with flash loan
  await hokusaiAMM.connect(attacker).buy(flashLoanAmount, 0, attacker.address, deadline);
  const tokenBalance = await hokusaiToken.balanceOf(attacker.address);

  // Fast-forward past IBR (can't sell during IBR)
  await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);

  // Attacker immediately sells all
  await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokenBalance);
  await hokusaiAMM.connect(attacker).sell(tokenBalance, 0, attacker.address, deadline);

  const usdcAfter = await mockUSDC.balanceOf(attacker.address);
  const profit = usdcAfter - flashLoanAmount - flashLoanFee;

  console.log(`Flash loan arbitrage result: ${profit > 0 ? 'PROFIT' : 'LOSS'} of $${Math.abs(profit / 1e6)}`);

  // Critical: Must not be profitable
  expect(profit).to.be.lte(0);
});
```

#### Test 2: Sandwich attack simulation
```javascript
it("Should measure sandwich attack profitability", async function () {
  // Front-runner sees victim's $10k buy in mempool
  // 1. Front-runner buys $50k (front-run)
  // 2. Victim's $10k buy executes (higher price)
  // 3. Front-runner sells $50k (back-run)
  //
  // Measure: Did front-runner profit from victim's trade?
});
```

#### Test 3: Same-block buy-sell (MEV)
```javascript
it("Should enforce IBR prevents same-block arbitrage", async function () {
  // During IBR, cannot sell in same block as buy
  // After IBR, measure if single-block arbitrage is profitable
});
```

### Success Criteria:
- ✅ Flash loan attack results in net loss for attacker
- ✅ Sandwich attacks limited by slippage protection
- ✅ IBR effectively prevents immediate arbitrage
- ✅ Document expected behavior in test comments

---

## **Phase 4: Reentrancy Attack Testing** (Priority: High)
**Goal:** Verify reentrancy guards protect against malicious ERC20 tokens

### Changes:
**File:** `test/Phase-Security-Reentrancy.test.js` (new file)

**Create Malicious ERC20 Mock:**
```solidity
// contracts/mocks/MaliciousERC20.sol
contract MaliciousERC20 is ERC20 {
    address public target;
    bool public attackEnabled;

    function enableAttack(address _target) external {
        target = _target;
        attackEnabled = true;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        // Attempt reentrancy during transfer
        if (attackEnabled) {
            attackEnabled = false; // Prevent infinite loop
            IHokusaiAMM(target).buy(1000e6, 0, msg.sender, block.timestamp + 300);
        }
        return super.transfer(to, amount);
    }
}
```

**Test Suite:**
```javascript
it("Should block reentrancy attack during buy()", async function () {
  // Deploy AMM with malicious reserve token
  // Attempt buy() that triggers reentrant buy() call
  // Expected: Reverts with "ReentrancyGuard: reentrant call"
});

it("Should block reentrancy attack during sell()", async function () {
  // Deploy AMM with malicious Hokusai token
  // Attempt sell() that triggers reentrant sell() call
  // Expected: Reverts with reentrancy error
});

it("Should block cross-function reentrancy (buy->sell)", async function () {
  // Attempt buy() that calls sell() during execution
  // Expected: Reverts (also should fail due to IBR)
});
```

### Success Criteria:
- ✅ All reentrancy attempts revert with clear error
- ✅ Guards protect all external token interactions
- ✅ Cross-function reentrancy blocked
- ✅ Document assumptions about token standards

---

## **Phase 5: Reserve Accounting Invariant Testing** (Priority: High)
**Goal:** Ensure reserve balance never diverges from actual USDC balance

### Changes:
**File:** `test/Phase-Security-InvariantTesting.test.js` (new file)

**Invariant:** `reserveBalance <= USDC.balanceOf(AMM)` (always true except during transfers)

**Test Strategy: Fuzzing with random operations**
```javascript
describe("Reserve Accounting Invariants", function () {
  it("Should maintain reserve balance accuracy across 1000 random operations", async function () {
    // Perform 1000 random operations:
    const operations = ['buy', 'sell', 'depositFees', 'withdrawTreasury'];

    for (let i = 0; i < 1000; i++) {
      const op = operations[Math.floor(Math.random() * operations.length)];
      const amount = randomAmount();

      try {
        await executeOperation(op, amount);
      } catch (e) {
        // Some operations expected to fail (e.g., sell during IBR)
      }

      // Verify invariant after each operation
      const reserveBalance = await hokusaiAMM.reserveBalance();
      const actualBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());
      const treasuryHeld = actualBalance - reserveBalance;

      expect(reserveBalance).to.be.lte(actualBalance);
      expect(treasuryHeld).to.be.gte(0);
    }
  });
});
```

**Specific Edge Cases:**
```javascript
it("Should handle treasury withdrawal when reserve = actual balance", async function () {
  // Edge case: No fees accumulated, treasury tries to withdraw
  // Expected: Reverts with "Insufficient treasury balance"
});

it("Should prevent reserve corruption via fee-on-transfer tokens", async function () {
  // Deploy AMM with mock fee-on-transfer USDC
  // Buy with 1000 USDC, but AMM receives 990 USDC (10 USDC fee)
  // Expected: reserveBalance should match actual received amount
  // Current code may break - needs balance delta checks
});
```

### Success Criteria:
- ✅ Invariant holds across 1000+ random operations
- ✅ All edge cases tested
- ✅ Fee-on-transfer token issue documented (may require contract changes)
- ✅ Clear error messages for accounting failures

---

## **Phase 6: Decimal Precision Testing** (Priority: Medium)
**Goal:** Document acceptable precision loss and test extreme decimal cases

### Changes:
**File:** `test/Phase2-Power-Function-Security.test.js`

**New Test Suite:** "Decimal Precision & Rounding"

```javascript
describe("Decimal Precision Edge Cases", function () {
  it("Should handle 1 wei USDC buy", async function () {
    const oneWei = 1n; // Smallest possible USDC unit
    const quote = await hokusaiAMM.getBuyQuote(oneWei);
    // May return 0 tokens (acceptable if amount too small)
    console.log(`1 wei USDC -> ${quote} tokens`);
  });

  it("Should handle maximum uint256 reserve (theoretical)", async function () {
    // This won't actually work (requires minting max USDC), but test the math
    // Use a separate test contract that exposes _pow() directly
    // Test: _pow(very large base, typical exponent)
  });

  it("Should maintain precision across 100 sequential small buys", async function () {
    // Accumulate precision loss over many small operations
    // Compare: 100x $1 buys vs 1x $100 buy
    // Difference should be < 0.1% (acceptable rounding error)
  });

  it("Should document maximum acceptable precision loss", async function () {
    // Test various trade sizes and measure precision loss
    // Create table of results for documentation:
    // | Trade Size | Expected Tokens | Actual Tokens | Error (bps) |
    // Document acceptable thresholds in comments
  });
});
```

### Success Criteria:
- ✅ All extreme decimal cases handled gracefully (no reverts)
- ✅ Precision loss documented and within acceptable bounds (<10 bps)
- ✅ Rounding errors do not accumulate to exploit level
- ✅ Code comments document expected precision

---

## **Phase 7: Previous Vulnerability Investigation** ✅ COMPLETE
**Goal:** Find, document, and verify fix for mentioned arbitrage vulnerability

**Status:** ✅ **COMPLETED** - See [previous-vulnerability-report.md](./previous-vulnerability-report.md)

### Investigation Results:

✅ **Task 7.1: Team Information**
- Vulnerability: Power function arbitrage exploit
- Discovered: During Phase 2 AMM implementation (Jan 8, 2026)
- Fixed: Commit 72b4a79fab878ca4a2a00cce7a584c0e0e8885c3
- Tests: 7 security tests in `test/Phase2-Power-Function-Security.test.js`

✅ **Task 7.2: Git Archaeology**
- Found commit: "SECURITY: Fix power function to eliminate arbitrage exploit"
- PR #28: "feat: Implement CRR-based AMM system (HOK-650)"
- 393 lines changed (155 in HokusaiAMM.sol, 267 in security tests)

✅ **Task 7.3: Pattern Analysis**
- Regression tests already exist (7 tests covering exploitation scenarios)
- Similar patterns checked in: DeltaVerifier, TokenManager, HokusaiAMMFactory, UsageFeeRouter
- Result: No similar vulnerabilities found (only HokusaiAMM uses power functions)

✅ **Task 7.4: Documentation**
- Complete report: [previous-vulnerability-report.md](./previous-vulnerability-report.md)
- Includes: vulnerability details, attack scenarios, fix explanation, verification results
- Similar patterns documented: None found (power functions unique to AMM)

### Key Findings:
- **Root cause:** Linear approximations in `_pow()` created systematic 0.5-1% errors
- **Exploitation:** $175 profit from repeated trades, $36 from single round-trip
- **Fix:** Taylor series (8-term ln, 10-term exp) with 3rd-order binomial for small exponents
- **Verification:** Round-trip now loses $4 (expected), repeated trades lose $49 (expected)

### Success Criteria:
- ✅ Vulnerability fully documented
- ✅ Fix verified as complete
- ✅ Regression tests already exist (7 tests)
- ✅ No similar patterns found elsewhere
- ✅ Investigation complete

---

## **Phase 8: Access Control & Governance Testing** (Priority: Medium)
**Goal:** Verify owner privileges cannot be abused and are properly restricted

### Changes:
**File:** `test/Phase6-Governance.test.js` (expand existing tests)

**New Tests:**
```javascript
describe("Owner Privilege Security", function () {
  it("Should prevent non-owner from pausing", async function () {
    await expect(
      hokusaiAMM.connect(attacker).pause()
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("Should prevent non-owner from changing parameters", async function () {
    await expect(
      hokusaiAMM.connect(attacker).setParameters(150000, 50, 1000)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("Should enforce parameter bounds even for owner", async function () {
    // Try to set CRR to 51% (> MAX_CRR of 50%)
    await expect(
      hokusaiAMM.setParameters(510000, 25, 500)
    ).to.be.revertedWith("CRR out of bounds");

    // Try to set trade fee to 11% (> MAX_TRADE_FEE of 10%)
    await expect(
      hokusaiAMM.setParameters(100000, 1100, 500)
    ).to.be.revertedWith("Trade fee too high");
  });

  it("Should allow owner to transfer ownership", async function () {
    await hokusaiAMM.transferOwnership(other.address);
    expect(await hokusaiAMM.owner()).to.equal(other.address);

    // Old owner can no longer pause
    await expect(
      hokusaiAMM.connect(owner).pause()
    ).to.be.revertedWith("Ownable: caller is not the owner");

    // New owner can pause
    await hokusaiAMM.connect(other).pause();
    expect(await hokusaiAMM.paused()).to.be.true;
  });
});

describe("Pause Mechanism Security", function () {
  it("Should block buy() when paused", async function () {
    await hokusaiAMM.pause();
    await expect(
      hokusaiAMM.connect(buyer).buy(parseUnits("1000", 6), 0, buyer.address, deadline)
    ).to.be.revertedWith("Pausable: paused");
  });

  it("Should block sell() when paused", async function () {
    // Setup: buy first, wait for IBR, pause, try to sell
  });

  it("Should allow depositFees() when paused", async function () {
    // Fee deposits should work even when paused (emergency liquidity injection)
    await hokusaiAMM.pause();
    await mockUSDC.approve(await hokusaiAMM.getAddress(), parseUnits("1000", 6));
    await hokusaiAMM.depositFees(parseUnits("1000", 6));
    // Should succeed
  });

  it("Should allow owner functions when paused", async function () {
    await hokusaiAMM.pause();
    // Owner should still be able to withdraw treasury during pause
    await hokusaiAMM.withdrawTreasury(amount);
    // Should succeed
  });
});
```

### Success Criteria:
- ✅ All owner-only functions properly restricted
- ✅ Parameter bounds enforced for all inputs
- ✅ Pause mechanism blocks user operations but not emergency functions
- ✅ Ownership transfer works and is irreversible
- ✅ Document owner privilege scope in code comments

---

## **Phase 9: Integration Testing with Malicious Contracts** (Priority: Medium)
**Goal:** Test AMM interactions with non-standard or malicious external contracts

### Changes:
**File:** `test/Phase-Security-MaliciousContracts.test.js` (new file)

**Create Malicious Contract Mocks:**

#### Mock 1: Fee-on-Transfer USDC
```solidity
contract FeeOnTransferUSDC is ERC20 {
    uint256 public transferFeePercent = 1000; // 10%

    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * transferFeePercent) / 10000;
        super.transfer(to, amount - fee);
        super.transfer(treasury, fee); // Fee goes to treasury
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * transferFeePercent) / 10000;
        super.transferFrom(from, to, amount - fee);
        super.transferFrom(from, treasury, fee);
        return true;
    }
}
```

#### Mock 2: Reverting USDC
```solidity
contract RevertingUSDC is ERC20 {
    bool public shouldRevert = false;

    function enableRevert() external { shouldRevert = true; }

    function transfer(address to, uint256 amount) public override returns (bool) {
        require(!shouldRevert, "Transfer disabled");
        return super.transfer(to, amount);
    }
}
```

#### Mock 3: Always-Failing USDC
```solidity
contract AlwaysFailingUSDC is ERC20 {
    function transfer(address to, uint256 amount) public override returns (bool) {
        return false; // Return false but don't revert
    }
}
```

**Test Suite:**
```javascript
describe("Malicious Contract Integration", function () {
  it("Should detect fee-on-transfer and revert or adjust accounting", async function () {
    // Deploy AMM with fee-on-transfer USDC
    // Buy with 1000 USDC, AMM receives 900 USDC
    // Current code will set reserveBalance = 1000 (wrong!)
    // Should either:
    // (a) Revert with clear error, or
    // (b) Adjust reserveBalance to actual received amount (balance delta check)
  });

  it("Should handle failed transfers gracefully", async function () {
    // Deploy AMM with always-failing USDC
    // Try to buy
    // Expected: Reverts with "Reserve transfer failed"
  });

  it("Should handle reverting treasury address", async function () {
    // Set treasury to contract that rejects USDC
    // Try to buy (which sends fee to treasury)
    // Expected: Transaction reverts (fee transfer fails)
    // Question: Should we allow fee burns if treasury can't receive?
  });
});
```

### Success Criteria:
- ✅ All malicious contract interactions handled safely
- ✅ Fee-on-transfer issue documented (may require contract fix)
- ✅ Failed transfers cause revert with clear error message
- ✅ No silent failures or accounting corruption
- ✅ Document assumptions about token standards

---

## **Phase 10: Mathematical Function Formal Verification** (Priority: Low)
**Goal:** Validate mathematical correctness of power/ln/exp functions

### Approach:
This phase requires specialized tools and may be deferred to external auditors.

**Option A: Property-Based Testing (Feasible)**
```javascript
describe("Mathematical Properties", function () {
  it("Should satisfy: pow(a, b) * pow(a, c) ≈ pow(a, b+c)", async function () {
    // Test exponent addition property
    // Allow small precision error (e.g., 0.01%)
  });

  it("Should satisfy: pow(pow(a, b), c) ≈ pow(a, b*c)", async function () {
    // Test exponent multiplication property
  });

  it("Should satisfy: pow(a, b) * pow(c, b) ≈ pow(a*c, b)", async function () {
    // Test base multiplication property
  });

  it("Should satisfy: ln(a * b) ≈ ln(a) + ln(b)", async function () {
    // Test logarithm addition property
  });

  it("Should satisfy: exp(ln(x)) ≈ x", async function () {
    // Test inverse function property
    // This is already implicitly tested via pow(x,y) = exp(y*ln(x))
  });
});
```

**Option B: External Formal Verification (Recommended for production)**
Tools:
- **Certora Prover** - Formal verification for Solidity
- **K Framework** - Formal semantics for EVM
- **SMT Solvers** (Z3, CVC4) - Mathematical property verification

Task: Create specification for formal verification
```
// Certora spec example
methods {
    _pow(uint256, uint256) returns uint256 envfree
    _ln(uint256) returns int256 envfree
    _exp(int256) returns uint256 envfree
}

rule powMonotonicity(uint256 base, uint256 exp1, uint256 exp2) {
    require exp2 > exp1;
    require base > 1e18;

    uint256 result1 = _pow(base, exp1);
    uint256 result2 = _pow(base, exp2);

    assert result2 > result1;
}
```

### Success Criteria:
- ✅ All mathematical property tests pass (Option A)
- ✅ Document acceptable precision bounds for each property
- ✅ If pursuing Option B: Spec written and submitted to formal verification service
- ✅ Results documented in audit report

---

## Out of Scope

Explicitly NOT addressing in this audit:

### 1. **External Audit Preparation**
- Not creating formal audit reports for third parties
- Not engaging external auditors (Trail of Bits, OpenZeppelin, etc.)
- Not producing PDF documents or executive summaries

### 2. **Economic Mechanism Design**
- Not evaluating if CRR bonding curve is optimal economic model
- Not comparing to alternative AMM designs (Uniswap, Balancer, etc.)
- Not assessing token incentive structures

### 3. **Off-Chain Systems**
- Not auditing backend services (contract-deployer, APIs)
- Not reviewing frontend security (React app, wallet integration)
- Not testing database or Redis queue security

### 4. **Gas Optimization**
- Not focused on reducing gas costs (unless security-critical)
- Not refactoring for efficiency (unless necessary for safety)
- Primary concern: security, not performance

### 5. **Contract Upgradeability**
- Not implementing proxy patterns or upgrade mechanisms
- Current contracts are immutable by design (per architecture)
- Governance changes via parameter updates only

### 6. **Multi-Chain Deployment**
- Testing on single network (Hardhat local or testnet)
- Not addressing cross-chain bridge security
- Not testing network-specific issues (e.g., Polygon gas spikes)

### 7. **Regulatory Compliance**
- Not assessing securities law compliance
- Not reviewing KYC/AML requirements
- Not evaluating tax implications

---

## Implementation Strategy

### Test-First Approach
For each phase:
1. **Write failing tests first** - Document expected behavior
2. **Get human approval** - Review test scenarios before implementation
3. **Run tests** (expect failures initially)
4. **Fix code if needed** - Only modify contracts if tests reveal issues
5. **Verify tests pass** - Confirm fix is correct
6. **Document findings** - Add comments and update this plan

### Commit Discipline
- **One phase per commit** - Don't mix changes from multiple phases
- **Clear commit messages:**
  - `SECURITY: Phase 1 - Add gas exhaustion tests`
  - `SECURITY: Phase 2 - Add max trade size limit`
  - `SECURITY: Phase 4 - Fix reentrancy in malicious token scenario`
- **All tests must pass** before committing
- **No commented-out code** in commits

### Branch Strategy
```bash
git checkout -b feature/security-audit-hok-653
# Work through phases 1-10
git push -u origin feature/security-audit-hok-653
# Create PR when complete
```

### Testing Commands
```bash
# Run all tests
npm test

# Run only security tests
npx hardhat test test/Phase2-Power-Function-Security.test.js
npx hardhat test test/Phase-Security-*.test.js

# Run with gas reporting
REPORT_GAS=true npm test

# Run with coverage
npx hardhat coverage
```

---

## Dependencies

### Required Before Starting:
- ✅ Team clarification on previous vulnerability (Phase 7)
- ✅ Decision on max trade size approach (Phase 2: soft vs hard limit)
- ✅ Access to test environment with sufficient USDC/ETH for large trades

### External Dependencies:
- **Hardhat** - Test framework (already installed)
- **OpenZeppelin** - Security libraries (already using)
- **Ethers.js** - Blockchain interactions (already installed)
- **Chai** - Assertion library (already installed)

### Optional (for Phase 10):
- **Certora Prover** - Formal verification (requires license)
- **Echidna** - Fuzzing tool (can install if needed)
- **Slither** - Static analysis (can install if needed)

---

## Risk Mitigation

### What Could Go Wrong:

**Risk 1: Tests reveal critical vulnerability**
- **Likelihood:** Medium (that's why we're auditing)
- **Impact:** High (requires contract fix and redeployment)
- **Mitigation:**
  - Phase-based approach allows catching issues early
  - Comprehensive testing before production deployment
  - Plan for emergency pause if vulnerability discovered post-deployment

**Risk 2: Mathematical functions require significant changes**
- **Likelihood:** Low (existing tests pass, functions seem correct)
- **Impact:** Very High (affects all bonding curve calculations)
- **Mitigation:**
  - Phase 10 validates math is correct before changing anything
  - Property-based testing catches edge cases
  - Defer to formal verification experts if needed

**Risk 3: Cannot reproduce previous vulnerability**
- **Likelihood:** Medium (no git history found)
- **Impact:** Medium (incomplete audit)
- **Mitigation:**
  - Phase 7 prioritized early to get team input
  - Interview developers who implemented fix
  - Review all PRs around AMM implementation date

**Risk 4: Tests find issue requiring contract redeployment**
- **Likelihood:** Low-Medium
- **Impact:** High (existing deployments affected)
- **Mitigation:**
  - This audit happens before production deployment (per Linear backlog order)
  - If post-deployment: use pause mechanism, plan migration strategy
  - Document all findings clearly for decision-making

**Risk 5: Scope creep into out-of-scope areas**
- **Likelihood:** Medium (security audits can expand)
- **Impact:** Low (time management issue)
- **Mitigation:**
  - Strict adherence to phase plan
  - "Out of Scope" section clearly defined
  - Focus: contract security only, not economic design

---

## Success Metrics

### Quantitative:
- ✅ **Test count:** Add 50+ new security test cases
- ✅ **Test coverage:** Maintain 100% of existing tests passing (615+)
- ✅ **Code coverage:** Aim for 100% line coverage on HokusaiAMM.sol
- ✅ **Gas benchmarks:** All operations < 10M gas
- ✅ **Precision bounds:** Document acceptable error (< 10 bps)

### Qualitative:
- ✅ **All critical concerns addressed** (from research report)
- ✅ **Previous vulnerability verified** fixed
- ✅ **No new vulnerabilities** introduced by fixes
- ✅ **Code comments** document security assumptions
- ✅ **Team confidence** in contract safety

### Deliverables:
1. ✅ Updated test suite in `test/Phase-Security-*.test.js`
2. ✅ Contract changes (if needed) in `contracts/HokusaiAMM.sol`
3. ✅ Documentation in `features/security-audit-hok-653/findings.md`
4. ✅ Previous vulnerability report (if found) in `features/security-audit-hok-653/previous-vulnerability-report.md`
5. ✅ Updated `project-knowledge/codebase-map.md` with security learnings

---

## Timeline Estimate

**Total Effort:** 3-5 days (assuming full-time focus)

| Phase | Time Est. | Complexity | Can Parallelize? |
|-------|-----------|------------|------------------|
| Phase 1: Gas exhaustion | 4-6 hours | Medium | No (needs research) |
| Phase 2: Trade size limits | 3-4 hours | Low | After Phase 1 |
| Phase 3: Flash loan tests | 6-8 hours | High | After Phase 1 |
| Phase 4: Reentrancy tests | 6-8 hours | High | Parallel with Phase 3 |
| Phase 5: Invariant testing | 8-12 hours | Very High | After Phase 4 |
| Phase 6: Decimal precision | 4-6 hours | Medium | Parallel with Phase 5 |
| Phase 7: Vulnerability investigation | 4-8 hours | Unknown | Parallel (start early) |
| Phase 8: Access control | 3-4 hours | Low | Parallel with Phase 6 |
| Phase 9: Malicious contracts | 6-8 hours | High | After Phase 4 |
| Phase 10: Formal verification | 12-24 hours | Very High | Optional (can defer) |

**Critical Path:** Phase 7 (needs team input) → Phase 1 → Phase 3 → Phase 4 → Phase 5

**Recommended Order:**
1. Start Phase 7 immediately (interview team)
2. Phase 1 (gas benchmarks - foundational)
3. Phases 3 & 4 in parallel (attack scenarios)
4. Phase 5 (invariant testing - most complex)
5. Phases 2, 6, 8 as time permits (lower priority)
6. Phase 9 (malicious contracts - depends on Phase 4)
7. Phase 10 (optional, can defer to external experts)

---

## Next Steps

### Immediate Actions:
1. ✅ **Review this plan** with team - COMPLETE
2. ✅ **Answer Phase 7 question:** Power function arbitrage (commit 72b4a79) - COMPLETE
3. ✅ **Decide Phase 2 approach:** Hard limit at 20% of reserve - COMPLETE
4. ✅ **Approve plan** to proceed with implementation - READY

### Ready to Start:
1. Create git branch: `feature/security-audit-hok-653`
2. Begin Phase 1 (Gas exhaustion testing)
3. Continue with phases in recommended order (1→3→4→5→2,6,8,9→10)
4. Update this plan with findings after each phase
5. Create PR when all phases complete

---

## Questions for Team ✅ ANSWERED

**1. Previous Vulnerability (Phase 7):** ✅ ANSWERED
   - **What:** Power function arbitrage exploit - linear approximations in `_pow()`
   - **When:** Jan 8, 2026 (commit 72b4a79)
   - **Fix:** Replaced with Taylor series (8-term ln, 10-term exp)
   - **Tests:** Yes - 7 security tests in `test/Phase2-Power-Function-Security.test.js`
   - **Details:** See [previous-vulnerability-report.md](./previous-vulnerability-report.md)

**2. Max Trade Size (Phase 2):** ✅ ANSWERED
   - **Decision:** Hard limit (reverts)
   - **Percentage:** 20% of reserve (2000 bps)
   - **Governance:** Yes - adjustable by owner up to 50% max
   - **Rationale:** Prevents whale manipulation while allowing reasonable liquidity

**3. Production Status:** ✅ ANSWERED
   - **Mainnet:** No - contracts not deployed to production yet
   - **Timeline:** TBD - this audit is pre-deployment
   - **Emergency plan:** N/A for now, but plan includes pause mechanism

**4. Risk Tolerance:**
   - **Precision error:** <0.1% acceptable (well below 0.25% fee)
   - **Owner control:** Current approach OK for launch, can add multisig later
   - **Formal verification:** Tests sufficient for now, Phase 10 optional

**5. Scope Confirmation:**
   - **Additions:** None - scope is comprehensive
   - **Additional concerns:** None beyond research report

---

**Status:** ✅ Plan Approved, Ready for Implementation
**Next:** Create branch and begin Phase 1
**Owner:** Security audit team
**Linear Issue:** HOK-653
