# AMM System Implementation Plan
**Linear Issue**: HOK-650 - Design AMM for calculating usage
**Created**: 2026-01-08
**Status**: Ready for Implementation

---

## Overview

### What We're Building
A Constant-Reserve-Ratio (CRR) Automated Market Maker system for Hokusai tokens that replaces the auction+burn mechanism with a bonding curve backed by USDC. This enables:
- Deterministic pricing via bonding curve mathematics
- Trustless liquidity for token trading
- API usage fees flowing into reserves (raising floor price)
- Performance-based token minting integrated with existing DeltaVerifier

### Why We're Building It
The current auction+burn model requires external market makers and has unpredictable pricing. The AMM system provides:
1. **Transparent pricing**: Anyone can calculate exact buy/sell prices on-chain
2. **Always-available liquidity**: No need to wait for auction rounds
3. **Aligned incentives**: API usage strengthens reserves → higher token value
4. **Performance integration**: DeltaVerifier minting naturally dilutes supply, creating buying pressure

---

## Current State

### Existing Infrastructure
Based on comprehensive codebase research:

1. **TokenManager** ([contracts/TokenManager.sol](contracts/TokenManager.sol))
   - Controller pattern: exclusive mint/burn authority
   - Uses OpenZeppelin AccessControl with `MINTER_ROLE`
   - Currently authorizes: owner and deltaVerifier address
   - Uses **string modelIds**
   - **Gap**: Burns restricted to owner only (line ~89)

2. **ModelRegistry** ([contracts/ModelRegistry.sol](contracts/ModelRegistry.sol))
   - Maps modelId → token address
   - Currently uses **uint256 modelIds** (type mismatch)
   - **Gap**: No pool address tracking

3. **HokusaiToken** ([contracts/HokusaiToken.sol](contracts/HokusaiToken.sol))
   - Standard ERC20 with controller-based mint/burn
   - Only TokenManager can mint/burn
   - Works perfectly for AMM delegation pattern

4. **DeltaVerifier** ([contracts/DeltaVerifier.sol](contracts/DeltaVerifier.sol))
   - Validates performance improvements
   - Mints rewards via TokenManager
   - Has string→uint256 conversion utilities
   - Will continue working alongside AMM

5. **Testing Patterns**
   - Real contract deployments (no mocking of internal contracts)
   - Gas benchmarking via `tx.wait()` and `gasUsed`
   - Role-based access control tests
   - **Missing**: MockUSDC for reserve token testing

### Confirmed Requirements (from user clarifications)

**Parameters**:
- CRR: 10% for all tokens, adjustable post-launch via governance
- IBR: 7 days fixed for all pools
- Trade fee: 25 bps (configurable later)
- Protocol fee: 5% (configurable later)
- Initial liquidity: s0=100,000 tokens, r0=$10,000 (P0=$1.00)

**Architecture**:
- Each AMM pool has its own USDC reserve
- Single Hokusai Treasury collects protocol fees from all pools
- Role-based auth for UsageFeeRouter (FEE_DEPOSITOR_ROLE)
- Deployer initially has admin permissions (multisig/timelock later)

**Model IDs**:
- Standardize on **string** throughout system
- Update ModelRegistry to use string modelIds

---

## Proposed Changes

### New Contracts

#### 1. HokusaiAMM.sol
**Purpose**: Bonding curve AMM for a single Hokusai token
**Key Features**:
- CRR bonding curve math (buy/sell/spot price)
- 7-day Initial Bonding Round (buy-only period)
- Delegates all mint/burn to TokenManager
- USDC reserve management
- Slippage protection and deadline checks
- Emergency pause mechanism

**Critical Design Decisions**:
- Reserve tracking: internal `reserveBalance` synced with actual USDC balance
- Fee handling: trade fees to treasury, protocol cut on deposits
- Security: ReentrancyGuard on all state changes, role-based pause

#### 2. HokusaiAMMFactory.sol
**Purpose**: Deploy AMM pools with consistent initialization
**Key Features**:
- Creates HokusaiAMM instances with standard parameters
- Initializes pools with s0/r0 for IBR launch
- Registers pools with ModelRegistry
- Grants MINTER_ROLE to deployed AMMs via TokenManager
- Validates CRR bounds (5%-50%)

#### 3. UsageFeeRouter.sol
**Purpose**: Route API usage fees to correct AMM pools
**Key Features**:
- Accepts USDC from authorized backend services
- Splits fees: protocol cut → Treasury, remainder → AMM reserve
- Looks up correct pool via ModelRegistry
- Role-based access control (FEE_DEPOSITOR_ROLE)
- Gas-optimized for high-frequency calls

#### 4. MockUSDC.sol (test only)
**Purpose**: USDC mock for testing
**Key Features**:
- ERC20 with 6 decimals (matches real USDC)
- Mint function for test setup
- Standard transfer/approve

### Modified Contracts

#### TokenManager.sol Extensions
**Changes needed**:
```solidity
// Add AMM authorization
function authorizeAMM(address amm) external onlyOwner {
    grantRole(MINTER_ROLE, amm);
}

// Extend burnTokens to allow MINTER_ROLE holders
function burnTokens(string memory modelId, address account, uint256 amount) external {
    require(
        hasRole(MINTER_ROLE, msg.sender) || msg.sender == owner(),
        "TokenManager: unauthorized"
    );
    // ... existing burn logic
}
```

**Rationale**:
- AMM needs to burn tokens on sells (atomic with USDC return)
- MINTER_ROLE already audited via OpenZeppelin
- Symmetry: if you can mint, you can burn

#### ModelRegistry.sol Extensions
**Changes needed**:
```solidity
// Change modelId type from uint256 to string
mapping(string => address) private _modelTokens;
mapping(string => address) public modelPools;

function registerPool(string memory modelId, address pool) external onlyOwner {
    require(modelPools[modelId] == address(0), "Pool already exists");
    modelPools[modelId] = pool;
    emit PoolRegistered(modelId, pool);
}

function getPool(string memory modelId) external view returns (address) {
    return modelPools[modelId];
}
```

**Rationale**:
- Standardizes on string modelIds (no more conversion utilities needed)
- Enables pool lookup by modelId
- Maintains backward compatibility with existing functions

---

## Implementation Phases

### Phase 1: Foundation & Contract Updates (3-4 days)
**Goal**: Prepare existing contracts for AMM integration

**Tasks**:
1. Update ModelRegistry to use string modelIds
   - Change mapping type
   - Update all functions using modelId
   - Add modelPools mapping
   - Add registerPool() and getPool() functions
   - Update tests to use string modelIds

2. Extend TokenManager for AMM authorization
   - Add authorizeAMM() function
   - Modify burnTokens() to allow MINTER_ROLE
   - Add tests for new authorization patterns

3. Create MockUSDC for testing
   - 6 decimal ERC20 implementation
   - Mint function for test setup
   - Deploy helper for tests

**Acceptance Criteria**:
- [x] ModelRegistry uses string modelIds throughout
- [x] TokenManager.burnTokens() allows MINTER_ROLE holders
- [x] TokenManager.authorizeAMM() grants MINTER_ROLE correctly
- [x] MockUSDC matches real USDC interface (6 decimals)
- [x] All existing tests pass with updates (375 passing)
- [x] New authorization tests pass (33 Phase 1 tests)

**Testing Focus**:
- Access control: only MINTER_ROLE can burn
- Registry: pool registration and lookup
- Backward compatibility: existing functionality unaffected

---

### Phase 2: Core AMM Bonding Curve (4-5 days)
**Goal**: Implement HokusaiAMM.sol with accurate bonding curve math

**Tasks**:
1. Implement bonding curve formulas
   - Buy: `T = S × ((1 + E/R)^w - 1)`
   - Sell: `F = R × (1 - (1 - T/S)^(1/w))`
   - Spot: `P = R / (w × S)`
   - Handle fixed-point arithmetic (avoid overflow/underflow)
   - Use SafeMath or Solidity 0.8+ checked math

2. Implement core trading functions
   - `buy()`: deposit USDC, mint tokens via TokenManager
   - `sell()`: burn tokens via TokenManager, return USDC
   - Slippage protection (minOut parameters)
   - Deadline checks
   - Reserve balance tracking

3. Implement quote functions (view)
   - `getBuyQuote()`: calculate tokens out for USDC in
   - `getSellQuote()`: calculate USDC out for tokens in
   - `spotPrice()`: current price from formula
   - `getReserves()`: (reserve, supply) tuple

4. Add state management
   - Reserve balance tracking
   - Fee accumulation
   - Parameter storage (CRR, fees, treasury address)

**Acceptance Criteria**:
- [ ] Buy/sell quotes match bonding curve formulas within 0.01% (1 basis point)
- [ ] Actual buy/sell executions match quotes
- [ ] No overflow/underflow in math operations
- [ ] Slippage protection works (reverts if minOut not met)
- [ ] Deadline enforcement (reverts if expired)
- [ ] Gas: buy < 150k, sell < 100k, quotes < 5k
- [ ] Reserve balance always matches tracked value
- [ ] Comprehensive unit tests (100% coverage on math)

**Testing Focus**:
- Math accuracy: test known input/output pairs
- Edge cases: zero amounts, very large amounts, near-zero reserve
- Slippage: test exact boundaries
- Gas benchmarks: record and compare

**Security Considerations**:
- Fixed-point arithmetic precision
- Overflow protection on exponentials
- Reserve accounting accuracy
- Reentrancy protection

---

### Phase 3: IBR & TokenManager Integration (2-3 days)
**Goal**: Integrate AMM with TokenManager and implement Initial Bonding Round

**Tasks**:
1. Implement IBR mechanism
   - `buyOnlyUntil` timestamp (7 days from deployment)
   - `isSellEnabled()` view function
   - Sell restriction enforcement
   - Clear error messages during IBR

2. TokenManager delegation
   - Call `tokenManager.mintTokens()` in buy()
   - Call `tokenManager.burnTokens()` in sell()
   - Handle authorization (AMM must have MINTER_ROLE)
   - Error handling for failed mint/burn

3. Initialization logic
   - Constructor with all parameters
   - Initial reserve deposit (r0)
   - Initial supply mint to AMM (s0)
   - Parameter validation

**Acceptance Criteria**:
- [ ] Buys succeed during IBR period
- [ ] Sells revert during IBR with clear error message
- [ ] Sells automatically enable after 7 days
- [ ] AMM successfully mints tokens via TokenManager
- [ ] AMM successfully burns tokens via TokenManager
- [ ] Initial reserve and supply set correctly
- [ ] Integration tests: full buy/sell cycle with real TokenManager

**Testing Focus**:
- Time manipulation: test before/after IBR end
- Authorization: verify MINTER_ROLE requirement
- Integration: deploy full stack (Token, Manager, Registry, AMM)
- Error messages: verify user-friendly revert reasons

---

### Phase 4: Factory & Registry Integration (2-3 days)
**Goal**: Factory pattern for consistent pool deployment

**Tasks**:
1. Implement HokusaiAMMFactory
   - `createPool()` function with parameter validation
   - Deploy HokusaiAMM instances
   - Initialize with standard parameters (s0, r0, CRR, fees)
   - Grant MINTER_ROLE to deployed AMM

2. Registry integration
   - Call `modelRegistry.registerPool()` on deployment
   - Add lookup functions (by token, by modelId)
   - Prevent duplicate pool creation
   - Emit PoolCreated events

3. Parameter validation
   - CRR bounds: 5% - 50% (50,000 - 500,000 ppm)
   - Fee bounds: tradeFee < 1000 bps (10%), protocolFee < 5000 bps (50%)
   - Initial reserve/supply > 0

**Acceptance Criteria**:
- [ ] Factory deploys pools with correct initialization
- [ ] Pools automatically registered in ModelRegistry
- [ ] Can lookup pool by token address
- [ ] Can lookup pool by modelId string
- [ ] Cannot create duplicate pools (reverts)
- [ ] CRR validation enforces bounds
- [ ] Fee validation enforces bounds
- [ ] PoolCreated event emitted with all parameters

**Testing Focus**:
- Multiple pool creation
- Parameter validation edge cases
- Registry lookup correctness
- Event emission

---

### Phase 5: Fee Collection System (2-3 days)
**Goal**: Route API usage fees to AMM reserves

**Tasks**:
1. Implement UsageFeeRouter
   - `depositFees()` with role-based auth
   - Protocol cut calculation and transfer to Treasury
   - Remainder deposit to AMM reserve via `amm.depositFees()`
   - ModelRegistry lookup for correct pool
   - Handle non-existent pools gracefully

2. Implement AMM fee deposit
   - `depositFees()` function in HokusaiAMM
   - Increases reserve balance without token inflation
   - Updates spot price automatically
   - Emits FeesDeposited event

3. Treasury management
   - Protocol fee accumulation
   - `withdrawTreasury()` function (owner only)
   - Balance tracking

**Acceptance Criteria**:
- [ ] UsageFeeRouter splits fees correctly (protocol cut vs AMM)
- [ ] Protocol cut transferred to Treasury
- [ ] Remainder deposited to AMM reserve
- [ ] AMM reserve increases correctly (verified via spotPrice)
- [ ] FEE_DEPOSITOR_ROLE required for deposits
- [ ] Gas < 80k for fee deposits
- [ ] Events emitted for fee flows

**Testing Focus**:
- Fee split calculations
- Multiple sequential deposits
- Authorization checks
- Treasury withdrawal
- Integration with AMM reserve updates

---

### Phase 6: Governance & Safety (2-3 days)
**Goal**: Parameter controls and emergency mechanisms

**Tasks**:
1. Parameter adjustment functions
   - `setParameters()` for CRR, tradeFee, protocolFee
   - Validation: enforce bounds on changes
   - Owner-only access
   - Emit ParametersUpdated event

2. Emergency controls
   - Pausable implementation
   - `pause()` / `unpause()` functions
   - Pause blocks trades but allows withdrawals
   - Owner-only pause authority

3. Security hardening
   - ReentrancyGuard on all state-changing functions
   - Input validation on all public functions
   - Slippage protection enforcement
   - Deadline enforcement

**Acceptance Criteria**:
- [ ] CRR adjustable within 5%-50% bounds
- [ ] Fee adjustable within safe limits
- [ ] Parameter changes emit events
- [ ] Emergency pause blocks buys and sells
- [ ] Pause doesn't prevent treasury withdrawal
- [ ] Unpause restores functionality
- [ ] Reentrancy attacks blocked (test with malicious token)
- [ ] Slippage protection cannot be bypassed

**Testing Focus**:
- Parameter change validation
- Pause/unpause state transitions
- Reentrancy attack attempts
- Edge cases for slippage protection

---

### Phase 7: Analytics & View Functions (1-2 days)
**Goal**: Rich view functions for frontend integration

**Tasks**:
1. Enhanced view functions
   - `getPoolState()`: returns (reserve, supply, spotPrice, CRR, fees)
   - `getTradeInfo()`: returns (isSellEnabled, buyOnlyUntil, paused)
   - `calculateBuyImpact()`: price impact % for buy size
   - `calculateSellImpact()`: price impact % for sell size

2. Historical data support
   - Rich event emission for indexing
   - Event parameters support efficient filtering
   - Document event schemas for frontend

3. Gas optimization
   - Batch view function calls
   - Optimize storage reads
   - View functions < 5k gas each

**Acceptance Criteria**:
- [ ] Frontend can query all pool state in single call
- [ ] Price impact calculations accurate
- [ ] Events support efficient filtering (indexed parameters)
- [ ] Gas < 5k for all view functions
- [ ] Event schemas documented

**Testing Focus**:
- View function accuracy
- Gas benchmarks
- Event emission completeness

---

## Success Criteria

### Functional Requirements
- ✅ All 7 phases implemented and tested
- ✅ 100% test coverage on critical functions (math, access control)
- ✅ Gas benchmarks within targets (buy<150k, sell<100k, fees<80k, views<5k)
- ✅ Integration with existing contracts verified (TokenManager, ModelRegistry, DeltaVerifier)

### Economic Requirements
- ✅ Bonding curve prices match specification (within 0.01%)
- ✅ Fee flows reach Treasury correctly
- ✅ IBR mechanism creates 7-day price discovery
- ✅ Performance rewards (DeltaVerifier) integrate smoothly with AMM
- ✅ Initial liquidity (s0=100k, r0=$10k) sets P0=$1.00

### Security Requirements
- ✅ All require statements have tests
- ✅ Reentrancy guards on state changes
- ✅ Access control enforced (roles, ownership)
- ✅ Slippage and deadline protection cannot be bypassed
- ✅ Parameter bounds enforced
- ✅ Emergency pause works without fund loss

---

## Testing Strategy

### Unit Tests (per contract)
**HokusaiAMM**:
- Math accuracy: test 100+ known input/output pairs
- State transitions: buy → sell → fee deposit sequences
- Access control: unauthorized calls revert
- Edge cases: zero amounts, max uint256, near-zero reserve
- Gas benchmarks: record and enforce

**HokusaiAMMFactory**:
- Pool creation with various parameters
- Duplicate prevention
- Parameter validation
- Registry integration

**UsageFeeRouter**:
- Fee split calculations
- Authorization checks
- Pool lookup
- Edge cases (non-existent pool)

**ModelRegistry**:
- String modelId functions
- Pool registration and lookup
- Duplicate prevention

**TokenManager**:
- AMM authorization
- MINTER_ROLE burn permissions
- Access control edge cases

### Integration Tests
**Full Stack Deployment**:
- Deploy: MockUSDC → TokenManager → ModelRegistry → Token → Factory → AMM
- Initialize: seed AMM with r0/s0
- Execute: full buy/sell cycle
- Verify: reserve, supply, balances, events

**Fee Flow Integration**:
- Deploy full stack + UsageFeeRouter
- Backend deposits fees via router
- Verify: Treasury balance, AMM reserve, spot price change

**DeltaVerifier + AMM**:
- DeltaVerifier mints performance rewards
- User buys tokens via AMM
- Verify: supply dilution, price adjustment, reserve stability

### Scenario Tests
**IBR Lifecycle**:
- Deploy pool at t=0
- Multiple users buy during days 1-7
- Attempt sells (should revert)
- Fast-forward to day 8
- Sells succeed

**Performance Reward Dilution**:
- Initial state: 100k tokens, $10k reserve
- DeltaVerifier mints 10k reward tokens (10% dilution)
- Spot price decreases proportionally
- User buys to offset dilution
- Reserve grows, price stabilizes

**Large Trade Slippage**:
- Buy small amount: minimal slippage
- Buy 10% of reserve: significant slippage
- Calculate expected price impact
- Verify quote matches execution

**Parameter Adjustment**:
- Deploy with CRR=10%
- Record prices at various supply levels
- Adjust CRR to 20%
- Verify price curve changed correctly
- Test edge cases (min/max bounds)

### Gas Benchmarks
Target gas usage (track over implementation):

| Operation | Target | Critical |
|-----------|--------|----------|
| buy() | < 150,000 | Yes |
| sell() | < 100,000 | Yes |
| depositFees() | < 80,000 | Yes |
| getBuyQuote() | < 5,000 | No |
| getSellQuote() | < 5,000 | No |
| spotPrice() | < 5,000 | No |
| getPoolState() | < 10,000 | No |

---

## Risks & Mitigations

### Risk 1: Fixed-Point Arithmetic Precision
**Risk**: Bonding curve exponentials may lose precision with Solidity math
**Mitigation**:
- Use high-precision libraries (e.g., PRBMath for fixed-point)
- Test with extreme values (very small/large reserves)
- Document acceptable precision loss (< 1 basis point)

### Risk 2: Reserve Accounting Mismatch
**Risk**: Tracked reserve diverges from actual USDC balance
**Mitigation**:
- Always sync on deposits/withdrawals
- Add `getReserveBalance()` view to check discrepancies
- Include reconciliation function (owner-only emergency)

### Risk 3: IBR Manipulation
**Risk**: Users bypass buy-only period via complex trades
**Mitigation**:
- Enforce IBR at sell() function level (can't be bypassed)
- No transfer restrictions (would break composability)
- Clear error messages for user experience

### Risk 4: Gas Price Volatility
**Risk**: High gas prices make small trades uneconomical
**Mitigation**:
- Optimize storage reads/writes
- Batch operations where possible
- Document minimum trade sizes for gas efficiency

### Risk 5: Front-Running
**Risk**: MEV bots front-run large trades
**Mitigation**:
- Slippage protection (minOut parameter)
- Deadline enforcement (prevents stale txs)
- Future: consider Flashbots/private mempool integration

---

## Dependencies & Prerequisites

### Existing Contracts (Ready)
- ✅ ModelRegistry.sol - needs extension for string modelIds
- ✅ HokusaiToken.sol - ready as-is
- ✅ TokenManager.sol - needs extension for AMM auth
- ✅ DeltaVerifier.sol - ready as-is
- ✅ HokusaiParams.sol - ready as-is (may use for governance later)

### External Dependencies
- OpenZeppelin Contracts v4.x (already in package.json)
  - AccessControl
  - Ownable
  - ReentrancyGuard
  - Pausable
  - ERC20 (for IERC20)

### Testing Dependencies
- Hardhat (already configured)
- @nomicfoundation/hardhat-toolbox (already installed)
- Hardhat time manipulation (`time.increase()`)
- Gas reporter (already configured)

### New Test Utilities Needed
- MockUSDC.sol (6 decimal ERC20)
- Test helper functions for:
  - Bonding curve calculation verification
  - Time manipulation (IBR testing)
  - Balance tracking across multiple accounts

---

## Deployment Plan

### Testnet Deployment Order
1. Update existing contracts (ModelRegistry, TokenManager)
2. Deploy MockUSDC (testnet only)
3. Deploy HokusaiAMMFactory
4. Deploy UsageFeeRouter
5. Create test pool via Factory
6. Verify all integrations
7. Run smoke tests

### Mainnet Deployment Order (future)
1. Audit contracts (external security audit)
2. Deploy to mainnet:
   - HokusaiAMMFactory
   - UsageFeeRouter
3. Update TokenManager and ModelRegistry (if needed)
4. Create pools for existing tokens (via Factory)
5. Grant FEE_DEPOSITOR_ROLE to backend service
6. Monitor initial trades closely
7. Document any issues/learnings

### Deployment Configuration
**Initial Parameters** (all pools):
- CRR: 100,000 (10%)
- Trade Fee: 25 bps
- Protocol Fee: 500 bps (5%)
- IBR Duration: 7 days (604,800 seconds)
- Initial Liquidity: s0=100,000 tokens, r0=$10,000 USDC

**Addresses to Configure**:
- Treasury: [to be provided]
- TokenManager: [existing deployment]
- ModelRegistry: [existing deployment]
- USDC: 0xA0b8...  (depends on network)

---

## Timeline Estimate

| Phase | Effort | Dependencies | Can Parallelize |
|-------|--------|--------------|-----------------|
| 1. Foundation | 3-4 days | None | No (blocks others) |
| 2. Core AMM | 4-5 days | Phase 1 | No (blocks 3,4,5) |
| 3. IBR & Integration | 2-3 days | Phase 1,2 | No (blocks 4) |
| 4. Factory | 2-3 days | Phase 1,2,3 | No (blocks 5) |
| 5. Fee System | 2-3 days | Phase 2,4 | Yes (parallel with 6) |
| 6. Governance | 2-3 days | Phase 2 | Yes (parallel with 5) |
| 7. Analytics | 1-2 days | Phase 2 | Yes (parallel with 5,6) |

**Total Sequential**: ~16-21 days (3-4 weeks)
**With Parallelization**: ~14-18 days (2.5-3.5 weeks)

**Critical Path**: Phase 1 → Phase 2 → Phase 3 → Phase 4 → Phase 5

---

## Out of Scope

**Explicitly NOT included in this implementation**:

1. **Multi-chain deployment**: Single chain only (Ethereum/Polygon TBD)
2. **Governance contracts**: Using simple Ownable, not full DAO governance
3. **Liquidity mining**: No token incentives for LPs (may add later)
4. **Cross-pool arbitrage**: Each pool independent
5. **Flash loan protection**: Relying on ReentrancyGuard only
6. **Price oracles**: Pure bonding curve, no external price feeds
7. **Frontend implementation**: Smart contracts only
8. **Backend API modifications**: UsageFeeRouter interface defined, backend integration separate
9. **Token migration**: Not handling migration of existing test tokens (can recreate)
10. **Advanced fee models**: Simple fixed percentage fees only

---

## Open Questions for Later Resolution

1. **Multisig/Timelock**: When to migrate from deployer to multisig? (post-launch)
2. **Parameter Adjustment Process**: Governance process for CRR/fee changes? (future)
3. **Pool Seeding Strategy**: Who provides initial r0/s0 for new pools? (treasury or automated?)
4. **Fee Optimization**: Are 25bps/5% optimal long-term? (monitor and adjust)
5. **Cross-Pool Routing**: Future: aggregate liquidity across model families? (v2 feature)

---

## Next Steps

1. **Review & Approve**: User approves this implementation plan
2. **Create Feature Branch**: `git checkout -b feature/amm-system-implementation`
3. **Begin Phase 1**: Update ModelRegistry and TokenManager
4. **Daily Progress Updates**: Track completion via `/implement-plan` command
5. **Testing Throughout**: Write tests alongside implementation (TDD approach)

---

## References

- **Design Spec**: [AMM_SYSTEM_REQUIREMENTS.md](../../AMM_SYSTEM_REQUIREMENTS.md)
- **Design Overview**: [amm_token_design.md](../../amm_token_design.md)
- **Existing Contracts**: [/contracts](../../contracts/)
- **Test Patterns**: [/test](../../test/)
- **Codebase Knowledge**: [/project-knowledge/codebase-map.md](../../project-knowledge/codebase-map.md)

---

## Document Change Log

| Date | Change | Author |
|------|--------|--------|
| 2026-01-08 | Initial plan created from AMM requirements + codebase research | Claude |
| 2026-01-08 | Added user clarifications (CRR, IBR, fees, treasury, auth, modelId) | Claude |
| 2026-01-08 | Finalized initial liquidity parameters (s0=100k, r0=$10k) | Claude |
