# Implementation Plan: Two-Phase Bonding Curve System

**Issue:** HOK-666
**Status:** Ready for Implementation
**Priority:** High
**Created:** 2026-01-20
**Timeline:** 2-3 weeks

---

## Overview

### What We're Building

A two-phase pricing system for HokusaiAMM that enables zero-capital token launches and eliminates overflow issues with large trades.

**Phase 1: Fixed Price Period** ($0 → $25,000 USDC reserve)
- Simple fixed pricing: `tokens = USDC / fixedPrice`
- Unlimited trade sizes (no overflow risk)
- Enables $0 launches
- Gas-efficient calculations

**Phase 2: Bonding Curve** ($25,000+ USDC reserve)
- Exponential pricing using existing CRR formula
- Price increases with demand
- Full AMM mechanics
- Automatic transition from Phase 1

### Why This Approach

**Solves Two Problems:**
1. ✅ **Cold Start**: Tokens can launch with $0 initial capital
2. ✅ **Overflow**: No complex exponentials during flat period = no overflow
3. ✅ **Large Trades**: Unlimited trade sizes during flat period
4. ✅ **Better UX**: Predictable pricing for early participants

**Industry-Proven Pattern:**
- Bancor uses bootstrap phases
- Pump.fun uses virtual reserves (similar concept)
- Our approach combines best of both

---

## Current State

### Existing Implementation

**Contracts:**
- [HokusaiAMM.sol](../../contracts/HokusaiAMM.sol) - Single-phase bonding curve AMM
- [HokusaiAMMFactory.sol](../../contracts/HokusaiAMMFactory.sol) - Pool factory
- [TokenManager.sol](../../contracts/TokenManager.sol) - Minting/burning controller

**Current Limitations:**
- ❌ Requires initial capital (can't start at $0)
- ❌ `getBuyQuote()` returns 0 for large trades (>150% of reserve)
- ❌ Overflow in `_pow()` when `E/R > 2.0`
- ❌ Poor UX for new token launches

**Test Pools:**
- LSCOR pool on Sepolia (5k initial) - has no usage to preserve
- Can be replaced with new implementation

### Research Findings

From research-orchestrator analysis:
- Clean implementation path identified
- 6 contract functions need modification
- Extensive test infrastructure available (17 test files, 105+ test cases)
- Risk level: LOW-MEDIUM
- No breaking changes to existing patterns

---

## Proposed Changes

### Architecture Changes

#### New State Variables
```solidity
// Immutable (set in constructor, never change)
uint256 public immutable FLAT_CURVE_THRESHOLD;  // e.g., $25,000 USDC (6 decimals)
uint256 public immutable FLAT_CURVE_PRICE;      // e.g., $0.01 per token (6 decimals)
```

#### New Enum
```solidity
enum PricingPhase {
    FLAT_PRICE,      // 0: Before threshold
    BONDING_CURVE    // 1: After threshold
}
```

#### New Functions
```solidity
function getCurrentPhase() public view returns (PricingPhase)
function getPhaseInfo() external view returns (...)
function _calculateFlatPriceTokens(uint256 reserveIn) internal view returns (uint256)
function _calculateBondingCurveTokens(...) internal view returns (uint256)
```

#### Modified Functions
```solidity
constructor(..., uint256 _flatCurveThreshold, uint256 _flatCurvePrice)
function getBuyQuote(uint256 reserveIn) - Add three-case logic
function getSellQuote(uint256 tokensIn) - Add flat phase handling
function spotPrice() - Return fixed price during flat phase
function buy(...) - Emit PhaseTransition event if crossing
function sell(...) - Handle flat price sells
```

### Trade Calculation Logic

**Case 1: Entirely in Flat Phase**
```solidity
if (futureReserve <= FLAT_CURVE_THRESHOLD) {
    return _calculateFlatPriceTokens(reserveIn);
}
```

**Case 2: Entirely in Bonding Curve**
```solidity
if (reserveBalance >= FLAT_CURVE_THRESHOLD) {
    return _calculateBondingCurveTokens(reserveIn, reserveBalance, supply);
}
```

**Case 3: Crossing Threshold (Hybrid)**
```solidity
// Split trade into two portions
uint256 flatPortion = FLAT_CURVE_THRESHOLD - reserveBalance;
uint256 curvePortion = reserveIn - flatPortion;

// Calculate tokens from each portion
uint256 tokensFromFlat = _calculateFlatPriceTokens(flatPortion);
uint256 adjustedSupply = supply + tokensFromFlat;
uint256 tokensFromCurve = _calculateBondingCurveTokens(
    curvePortion,
    FLAT_CURVE_THRESHOLD,
    adjustedSupply
);

return tokensFromFlat + tokensFromCurve;
```

---

## Implementation Phases

### Phase 1: Contract Implementation (Week 1)
**Goal:** Update contracts to support two-phase pricing

#### Tasks:
1. **Update HokusaiAMM.sol**
   - Add new state variables (FLAT_CURVE_THRESHOLD, FLAT_CURVE_PRICE)
   - Add PricingPhase enum
   - Add getCurrentPhase() and getPhaseInfo() functions
   - Implement _calculateFlatPriceTokens() helper
   - Implement _calculateBondingCurveTokens() helper
   - Update constructor to accept new parameters
   - Update getBuyQuote() with three-case logic
   - Update getSellQuote() for flat phase
   - Update spotPrice() for flat phase
   - Add PhaseTransition event
   - Update buy() to emit PhaseTransition
   - Update sell() for flat phase

2. **Update HokusaiAMMFactory.sol**
   - Add flatCurveThreshold parameter to createPool()
   - Add flatCurvePrice parameter to createPool()
   - Update default parameters struct
   - Update pool creation logic

3. **Update Deployment Scripts**
   - Add new parameters to deployment config
   - Update deployment documentation

**Completion Criteria:**
- ✅ Contracts compile without errors
- ✅ All existing tests still pass
- ✅ New parameters properly validated in constructor
- ✅ Code review completed

**Estimated Time:** 3-4 days

---

### Phase 2: Comprehensive Testing (Week 1-2)
**Goal:** Ensure all edge cases are covered

#### Test Categories:

**A. Unit Tests - Flat Price Phase**
- [x] Start in FLAT_PRICE phase with 0 reserve
- [x] Calculate fixed price quote correctly
- [x] Handle large trades without overflow ($100k trade with $100 reserve)
- [x] Maintain fixed price across multiple trades
- [x] Allow unlimited trade size during flat period
- [x] Sell at fixed price during flat period (post-IBR)

**B. Unit Tests - Threshold Crossing**
- [x] Handle trades that cross threshold (hybrid calculation)
- [x] Emit PhaseTransition event when crossing
- [x] Stay in BONDING_CURVE phase after crossing
- [x] Calculate correct token amounts for split trades
- [x] No price discontinuity at transition point

**C. Unit Tests - Bonding Curve Phase**
- [x] Use bonding curve pricing after threshold
- [x] Price increases with each trade
- [x] Calculate spot price using bonding curve formula
- [x] Handle large trades in bonding curve phase
- [x] Match original behavior for pools starting above threshold

**D. Integration Tests**
- [x] Complete token lifecycle ($0 → $100k reserve)
- [x] Multiple sequential large trades
- [x] Phase info view function accuracy
- [x] Factory creates pools with correct parameters
- [x] Gas cost benchmarks (flat vs curve)

**E. Edge Cases**
- [x] Trade exactly at threshold
- [x] Trade 1 wei under threshold
- [x] Trade 1 wei over threshold
- [x] Zero initial reserve behavior
- [x] Large threshold values ($100k, $1M)
- [x] Small threshold values ($100, $1k)
- [x] Sell before any buys (should fail appropriately)

**Completion Criteria:**
- ✅ Test coverage >95%
- ✅ All edge cases documented and tested
- ✅ Gas benchmarks within acceptable range (<10% increase)
- ✅ No regressions in existing functionality

**Estimated Time:** 4-5 days

---

### Phase 3: Testnet Deployment (Week 2)
**Goal:** Deploy and validate on Sepolia testnet

#### Tasks:

1. **Pre-deployment Checks**
   - Run full test suite
   - Compile contracts
   - Generate gas reports
   - Review all code changes
   - Update documentation

2. **Deploy to Sepolia**
   - Deploy new HokusaiAMM implementation
   - Deploy new HokusaiAMMFactory
   - Update factory references
   - Verify contracts on Etherscan

3. **Create Test Pool**
   - Create pool with $0 initial reserve
   - Set flatCurveThreshold = $25,000 USDC
   - Set flatCurvePrice = $0.01
   - Document pool address and parameters

4. **Manual Testing**
   - Test small buy ($100)
   - Test medium buy ($5,000)
   - Test large buy ($10,000)
   - Test threshold crossing buy ($26,000 total)
   - Test buy after threshold ($5,000)
   - Test sells in flat phase (after IBR ends)
   - Test sells in bonding curve phase
   - Verify all events emitted correctly
   - Check phase transitions on Etherscan

5. **Integration Validation**
   - Test with frontend (if available)
   - Verify price quotes match expectations
   - Check phase indicator UI
   - Validate error handling

**Completion Criteria:**
- ✅ Contracts deployed and verified on Sepolia
- ✅ Test pool created with $0 initial reserve
- ✅ All manual tests pass
- ✅ Events visible on Etherscan
- ✅ No unexpected behavior observed

**Estimated Time:** 2-3 days

---

### Phase 4: Documentation & Frontend Support (Week 3)
**Goal:** Enable frontend integration and document changes

#### Tasks:

1. **Contract Documentation**
   - Update inline comments with two-phase logic
   - Document new parameters
   - Add deployment examples
   - Update README with new features

2. **Frontend Integration Guide** (if needed)
   - Update HokusaiAMM service types
   - Add getPhaseInfo() method
   - Document phase indicator UI patterns
   - Provide example React components
   - Add error handling patterns

3. **User Documentation**
   - Explain two-phase system to token creators
   - Provide configuration examples
   - Document trade size implications
   - Create FAQ section

4. **Migration Guide** (for future mainnet)
   - Document differences from old contract
   - Provide deployment checklist
   - List configuration recommendations
   - Add monitoring suggestions

**Completion Criteria:**
- ✅ All inline documentation complete
- ✅ Frontend integration guide published
- ✅ User documentation available
- ✅ Migration guide ready for mainnet

**Estimated Time:** 3-4 days

---

## Configuration Options

### Standard Configuration (Recommended)
```javascript
{
  // Token details
  name: "AI Model Token",
  symbol: "AIMT",
  modelId: "model-123",

  // Initial setup
  initialReserve: 0,  // ✅ Start with ZERO!

  // AMM parameters
  crr: 200000,              // 20% CRR
  tradeFee: 30,             // 0.30%
  protocolFeeBps: 3000,     // 30%
  ibrDuration: 172800,      // 48 hours

  // Two-phase parameters
  flatCurveThreshold: parseUnits("25000", 6),  // $25,000 USDC
  flatCurvePrice: parseUnits("0.01", 6),       // $0.01 per token
}
```

### Alternative Configurations

| Use Case | Threshold | Fixed Price | CRR | Notes |
|----------|-----------|-------------|-----|-------|
| **Small/Experimental** | $10,000 | $0.005 | 20% | Community projects |
| **Standard** | $25,000 | $0.01 | 20% | Most models |
| **Premium** | $50,000 | $0.02 | 20% | High-value models |
| **Enterprise** | $100,000 | $0.05 | 30% | Flagship products |
| **Immediate Curve** | $0 | N/A | 20% | Skip flat phase entirely |

---

## Success Criteria

### Automated Checks
- ✅ All tests pass (>95% coverage)
- ✅ Contracts compile without warnings
- ✅ Gas costs within acceptable range
- ✅ No security vulnerabilities detected
- ✅ Code follows Solidity style guide

### Manual Verification
- ✅ Tokens can launch with $0 initial reserve
- ✅ Large trades succeed without errors ($50k with $100 reserve)
- ✅ Fixed price maintained across all early trades
- ✅ Smooth transition at threshold (no price discontinuity)
- ✅ Bonding curve calculations accurate after threshold
- ✅ Zero "0 tokens" or "Infinity" price errors
- ✅ Phase indicators work correctly

### Production Readiness
- ✅ 10+ successful trades on Sepolia
- ✅ $50k+ in testnet volume
- ✅ Zero critical bugs reported
- ✅ Documentation complete
- ✅ Code review approved

---

## Risk Assessment

### Technical Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Hybrid calculation bug (threshold crossing) | Medium | High | Extensive testing with exact threshold values |
| Gas cost increase | Low | Medium | Use simple division for flat phase, benchmark |
| Price discontinuity at transition | Low | High | Mathematical proof + empirical testing |
| Frontend integration issues | Medium | Medium | Provide clear documentation and examples |
| Confusion about phase behavior | Medium | Low | Clear UI indicators and documentation |

### Operational Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Wrong threshold configuration | Medium | Medium | Provide tested defaults and configuration guide |
| Users expect instant bonding curve | Low | Low | Clear messaging in UI and docs |
| Large trade still fails (after threshold) | Low | Medium | Existing maxTradeBps still applies |
| Testnet out of funds | Low | Low | Use faucets, document requirements |

### Security Risks

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| Arithmetic overflow/underflow | Low | High | Use Solidity 0.8+ built-in checks |
| Reentrancy attack | Low | Critical | ReentrancyGuard already in place |
| Price manipulation | Low | Medium | Same protections as current system |
| Front-running threshold crossing | Low | Low | Transaction atomicity prevents this |

**Overall Risk Level:** LOW-MEDIUM

---

## Out of Scope

### Explicitly NOT Included in This Feature

1. **PRBMath Integration** - Not needed since flat phase avoids overflow
2. **Virtual Reserves** - Two-phase system is simpler
3. **Dynamic Threshold Adjustment** - Threshold is immutable
4. **Multi-tier Pricing** - Only two phases (flat + curve)
5. **Mainnet Deployment** - Only Sepolia for now
6. **External Audit** - Future milestone for mainnet
7. **Frontend Implementation** - Guidance only, not building UI
8. **Migration of Existing Pools** - New deployments only
9. **Governance for Threshold** - Owner controls pools individually
10. **Advanced Fee Structures** - Keep existing fee model

---

## Open Questions & Decisions Needed

### Decision Points

1. **Threshold Value**
   - **Question:** Should we make $25k configurable per pool or enforce a standard?
   - **Recommendation:** Make it configurable (pass in constructor)
   - **Rationale:** Different models may need different thresholds
   - **Status:** ✅ DECIDED - Configurable via constructor

2. **Fixed Price Value**
   - **Question:** Should we allow any fixed price or enforce minimums?
   - **Recommendation:** Allow any value >0, no minimum
   - **Rationale:** Let market decide, some tokens may start at $0.001
   - **Status:** ✅ DECIDED - Any positive value allowed

3. **Skip Flat Phase Option**
   - **Question:** How do we skip flat phase for pools wanting immediate curve?
   - **Recommendation:** Set `flatCurveThreshold = initialReserve`
   - **Rationale:** If already above threshold, starts in bonding curve
   - **Status:** ✅ DECIDED - Documented pattern

4. **Sell Behavior in Flat Phase**
   - **Question:** Should sells use flat price or curve formula?
   - **Recommendation:** Use flat price for consistency
   - **Rationale:** Matches buy behavior, simpler to reason about
   - **Status:** ✅ DECIDED - Flat price for sells

5. **Event Emission**
   - **Question:** Should we emit events for quote calculations?
   - **Recommendation:** No, only emit on actual trades
   - **Rationale:** Views shouldn't emit events, gas waste
   - **Status:** ✅ DECIDED - Events only on state changes

### Questions for Stakeholders

1. **Testnet Timeline**
   - How long should we test on Sepolia before considering mainnet?
   - **Suggested:** 2-4 weeks with real usage

2. **Frontend Priority**
   - Should we block on frontend integration or proceed with backend-only?
   - **Suggested:** Proceed with backend, frontend can integrate later

3. **Documentation Depth**
   - How detailed should user-facing documentation be?
   - **Suggested:** Comprehensive for token creators, basic for traders

4. **Mainnet Plans**
   - When do we plan mainnet deployment?
   - What audit requirements exist?
   - **Suggested:** After successful Sepolia period + audit

---

## Testing Strategy

### Test Structure

```
test/
├── HokusaiAMM.test.ts              # Existing tests (ensure still pass)
├── HokusaiAMM.twophase.test.ts     # NEW: Two-phase specific tests
├── HokusaiAMMFactory.test.ts       # Update for new parameters
├── integration/
│   ├── LargeTrades.test.ts         # NEW: Large trade scenarios
│   └── TokenLifecycle.test.ts      # NEW: Full lifecycle tests
└── fixtures/
    └── twophase-scenarios.ts       # NEW: Test data and scenarios
```

### Test Coverage Goals

- **Line Coverage:** >95%
- **Branch Coverage:** >90%
- **Function Coverage:** 100%
- **Statement Coverage:** >95%

### Key Test Scenarios

**Flat Phase Tests:**
1. Launch with $0 reserve
2. First buy at $100
3. Large buy at $50,000 (with $100 reserve)
4. Multiple sequential buys maintaining fixed price
5. Sell at fixed price (post-IBR)

**Threshold Crossing Tests:**
6. Trade crossing from $24k → $30k
7. Trade exactly at threshold
8. Trade 1 wei under threshold
9. Trade 1 wei over threshold
10. Multiple trades approaching threshold

**Bonding Curve Tests:**
11. First trade after crossing threshold
12. Price increases with sequential trades
13. Large trades after threshold (within maxTradeBps)
14. Sells in bonding curve phase
15. Spot price calculation accuracy

**Edge Cases:**
16. Zero reserve with zero supply
17. Threshold = 0 (immediate curve)
18. Threshold = MAX_UINT256 (never activate curve)
19. Very small fixed price ($0.000001)
20. Very large fixed price ($100)

---

## Deployment Checklist

### Pre-Deployment
- [ ] All tests passing
- [ ] Code review completed
- [ ] Gas benchmarks acceptable
- [ ] Documentation updated
- [ ] Deployment scripts tested
- [ ] Configuration validated

### Sepolia Deployment
- [ ] Deploy HokusaiAMM contract
- [ ] Deploy HokusaiAMMFactory contract
- [ ] Verify on Etherscan
- [ ] Create test pool
- [ ] Execute test trades
- [ ] Monitor for 48 hours

### Post-Deployment
- [ ] Document contract addresses
- [ ] Update frontend configuration (if applicable)
- [ ] Announce to team
- [ ] Create monitoring dashboard
- [ ] Write deployment retrospective

---

## Timeline Summary

| Week | Phase | Tasks | Deliverables |
|------|-------|-------|--------------|
| **Week 1** | Implementation & Testing Start | Contract updates, basic tests | Updated contracts, unit tests |
| **Week 2** | Testing & Deployment | Integration tests, Sepolia deploy | Deployed contracts, test results |
| **Week 3** | Documentation & Wrap-up | Docs, frontend guide, validation | Complete documentation, demo |

**Total Duration:** 2-3 weeks
**Start Date:** TBD
**Target Completion:** TBD

---

## Dependencies

### External Dependencies
- OpenZeppelin Contracts (already installed)
- Hardhat (already configured)
- Etherscan API (for verification)
- Sepolia testnet access

### Internal Dependencies
- HokusaiToken contract (no changes needed)
- TokenManager contract (no changes needed)
- ModelRegistry contract (no changes needed)
- USDC mock for testing (already exists)

### Tooling Dependencies
- Node.js >= 18
- Hardhat >= 2.0
- Ethers.js v6
- TypeScript >= 5.0

---

## Rollback Plan

### If Critical Issues Found

**During Development:**
- Revert commits
- Return to current implementation
- Document issues for future attempt

**During Testing:**
- Halt deployment
- Analyze failures
- Fix and re-test
- Only proceed when all tests pass

**On Testnet:**
- Deploy new fixed version
- Update factory to use new implementation
- Keep old contracts for reference
- Document incident

**Rollback Triggers:**
- Security vulnerability discovered
- Mathematical error in calculations
- Gas costs >20% higher than expected
- Unpredictable behavior observed
- Test coverage falls below 90%

---

## Success Metrics

### Phase 1 Success (Contract Implementation)
- ✅ Contracts compile without errors
- ✅ New parameters validated correctly
- ✅ All existing tests still pass
- ✅ Code review approved

### Phase 2 Success (Testing)
- ✅ Test coverage >95%
- ✅ All edge cases covered
- ✅ Gas costs within 10% of current implementation
- ✅ Zero critical bugs found

### Phase 3 Success (Testnet Deployment)
- ✅ Successful deployment to Sepolia
- ✅ 10+ successful test trades
- ✅ $50k+ in testnet volume
- ✅ Phase transitions work correctly
- ✅ No unexpected behavior

### Overall Success
- ✅ Feature complete and tested
- ✅ Documentation published
- ✅ Zero-capital launches working
- ✅ Large trades no longer overflow
- ✅ Team approval for mainnet consideration

---

## Next Steps

### Immediate Actions (This Week)
1. ✅ Review and approve this plan
2. Create feature branch: `feature/bonding-curve-improvements`
3. Set up project board in Linear
4. Schedule kickoff meeting
5. Assign tasks to team members

### After Approval
1. Begin Phase 1 implementation
2. Set up test infrastructure
3. Create progress tracking system
4. Schedule daily standups (if needed)

---

## References

### Internal Documents
- [/docs/BONDING_CURVE_IMPROVEMENTS.md](../../docs/BONDING_CURVE_IMPROVEMENTS.md) - Complete specification
- [/docs/BONDING_CURVE_OVERFLOW_FIX.md](../../docs/BONDING_CURVE_OVERFLOW_FIX.md) - Alternative approach
- [/contracts/HokusaiAMM.sol](../../contracts/HokusaiAMM.sol) - Current implementation

### External Resources
- [Bancor Protocol Whitepaper](https://storage.googleapis.com/website-production/uploads/2018/06/bancor_protocol_whitepaper_en.pdf)
- [Pump.fun Documentation](https://docs.pump.fun/)
- [Uniswap V2 Core](https://github.com/Uniswap/v2-core)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)

---

## Approval

**Plan Created:** 2026-01-20
**Plan Status:** Ready for Review

**Approvals Needed:**
- [ ] Technical Lead: ___________________ Date: _______
- [ ] Product Owner: ___________________ Date: _______
- [ ] Security Reviewer (if applicable): ___________________ Date: _______

---

**Next Command:** `/implement-plan` (after approval)