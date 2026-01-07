# Hokusai CRR AMM System - Implementation Requirements

**Replaces Linear Backlog Items #2-9**

## Executive Summary

Implement a Constant-Reserve-Ratio (CRR) Automated Market Maker system for Hokusai tokens that replaces the auction+burn mechanism with a bonding curve backed by USDC. This enables deterministic pricing, trustless liquidity, and integrates API usage fees directly into token economics.

---

## System Overview

### Core Mechanism
- Each Hokusai token has a dedicated AMM pool with USDC reserves
- Pricing follows bonding curve formulas (CRR model)
- API usage fees flow into reserves (not token burns)
- Performance rewards (DeltaOne) mint new tokens through existing TokenManager
- Initial 7-day buy-only period for price discovery

### Economic Model
- **Buy**: Users deposit USDC → AMM mints tokens via TokenManager
- **Sell**: Users return tokens → AMM burns via TokenManager, returns USDC
- **API Fees**: Usage fees in USDC → deposited to reserves (raises floor price)
- **Performance**: DeltaVerifier mints rewards → dilutes supply unless offset by demand

---

## Contract Architecture

### New Contracts to Implement

#### 1. HokusaiAMM.sol (per token pool)
**Purpose**: Core bonding curve AMM logic for a single Hokusai token

**State Variables**:
- `address public reserveToken` (USDC)
- `address public hokusaiToken` (the model's token)
- `address public tokenManager` (for mint/burn delegation)
- `address public treasury` (fee recipient)
- `uint256 public reserveBalance` (tracked USDC)
- `uint256 public crr` (reserve ratio in ppm, default 100000 = 10%)
- `uint256 public tradeFee` (in bps, default 25)
- `uint16 public protocolFeeBps` (on deposits, default 500 = 5%)
- `uint256 public buyOnlyUntil` (timestamp for IBR end)
- `bool public paused`

**Core Functions**:
```solidity
// Trading
function buy(uint256 reserveIn, uint256 minTokensOut, address to, uint256 deadline) external returns (uint256 tokensOut)
function sell(uint256 tokensIn, uint256 minReserveOut, address to, uint256 deadline) external returns (uint256 reserveOut)

// Pricing & Quotes
function spotPrice() external view returns (uint256)
function getBuyQuote(uint256 reserveIn) external view returns (uint256 tokensOut)
function getSellQuote(uint256 tokensIn) external view returns (uint256 reserveOut)

// Fee Management
function depositFees(uint256 amount) external // called by UsageFeeRouter
function withdrawTreasury(uint256 amount) external onlyOwner

// Governance
function setParameters(uint256 newCrr, uint256 newTradeFee, uint16 newProtocolFee) external onlyOwner
function pause() external onlyOwner
function unpause() external onlyOwner

// View Functions
function getReserves() external view returns (uint256 reserve, uint256 supply)
function isSellEnabled() external view returns (bool)
```

**Key Requirements**:
- Must delegate all mint/burn to TokenManager (AMM never calls token.mint directly)
- Enforce buy-only mode during IBR period (7 days)
- Slippage protection (minOut parameters)
- Deadline checks for all trades
- Reentrancy guards on all state-changing functions
- Emit detailed events for all trades and parameter changes

**Bonding Curve Math**:
```
Buy:  T = S × ((1 + E/R)^w - 1)
Sell: F = R × (1 - (1 - T/S)^(1/w))
Spot: P = R / (w × S)

Where:
  T = tokens to mint/burn
  S = current supply
  R = reserve balance
  E = USDC deposited
  F = USDC returned
  w = CRR (reserve ratio)
```

---

#### 2. HokusaiAMMFactory.sol
**Purpose**: Deploy and register AMM pools for tokens

**Core Functions**:
```solidity
function createPool(
    address token,
    uint256 modelId,
    uint256 initialReserve,
    uint256 initialSupply,
    uint256 crr,
    uint256 tradeFee,
    uint16 protocolFeeBps
) external returns (address pool)

function getPool(address token) external view returns (address)
function getPoolByModel(uint256 modelId) external view returns (address)
```

**Requirements**:
- Register pools with ModelRegistry upon creation
- Initialize with minimal (s0, r0) for IBR launch
- Validate CRR bounds (5%-50%)
- Emit PoolCreated events
- Only owner or authorized deployers can create pools

---

#### 3. UsageFeeRouter.sol
**Purpose**: Route API usage fees from backend to correct AMM pools

**Core Functions**:
```solidity
function depositFees(address token, uint256 amount) external onlyAuthorized
function depositFeesForModel(uint256 modelId, uint256 amount) external onlyAuthorized
function setProtocolCut(uint16 bps) external onlyOwner
function setTreasury(address newTreasury) external onlyOwner
```

**Requirements**:
- Accept USDC from authorized API backend addresses
- Split fees: protocol cut to Treasury, remainder to AMM reserve
- Lookup correct pool via ModelRegistry
- Handle cases where pool doesn't exist (revert or queue)
- Gas-efficient for high-frequency calls

---

### Modified Existing Contracts

#### TokenManager.sol Extensions
**New Requirements**:
- Grant MINTER_ROLE to AMM contracts when pools are created
- Add `authorizeAMM(address amm)` function
- Validate AMM authorization on mint/burn calls
- Keep DeltaVerifier authorization separate

**Integration Pattern**:
```solidity
// AMM calls TokenManager
tokenManager.mintTokens(modelId, recipient, amount);
tokenManager.burnTokens(modelId, account, amount);

// TokenManager validates
require(authorizedAMMs[msg.sender] || msg.sender == deltaVerifier);
```

#### ModelRegistry.sol Extensions
**New Requirements**:
- Add pool address tracking: `mapping(uint256 => address) public modelPools`
- Add `registerPool(uint256 modelId, address pool)` function
- Add `getPool(uint256 modelId)` view function

---

## Implementation Phases

### Phase 1: Core AMM Logic (3-5 days)
**Deliverable**: HokusaiAMM.sol with bonding curve math
- Implement CRR formulas (buy/sell/spot)
- State management (reserves, supply tracking)
- Quote functions (gas-optimized view functions)
- Comprehensive unit tests for math accuracy

**Acceptance Criteria**:
- Buy/sell quotes match bonding curve formulas within 1 basis point
- Gas < 150k for buys, < 100k for sells
- Edge cases handled (zero amounts, overflow, underflow)
- 100% test coverage on math functions

---

### Phase 2: TokenManager Integration (2-3 days)
**Deliverable**: AMM can mint/burn via TokenManager
- Extend TokenManager with AMM authorization
- Implement mint/burn delegation in AMM
- Add role-based access control
- Integration tests with real token/manager

**Acceptance Criteria**:
- AMM can buy (mint) tokens through TokenManager
- AMM can sell (burn) tokens through TokenManager
- DeltaVerifier remains authorized for performance rewards
- Unauthorized contracts cannot mint/burn

---

### Phase 3: Factory & Registry (2-3 days)
**Deliverable**: Factory pattern for deploying pools
- Implement HokusaiAMMFactory
- Extend ModelRegistry for pool tracking
- Pool registration on deployment
- Factory tests (multiple pool creation)

**Acceptance Criteria**:
- Factory deploys pools with correct initialization
- Pools automatically registered in ModelRegistry
- Can lookup pool by token or modelId
- Cannot create duplicate pools

---

### Phase 4: Initial Bonding Round (1-2 days)
**Deliverable**: 7-day buy-only mechanism
- Implement IBR timestamp tracking
- Add sellsEnabled() modifier
- Time-based sell restrictions
- IBR lifecycle tests

**Acceptance Criteria**:
- Buys succeed during IBR period
- Sells revert during IBR with clear error
- Sells automatically enable after 7 days
- Timestamp manipulation tests pass

---

### Phase 5: Fee Collection System (2-3 days)
**Deliverable**: UsageFeeRouter + Treasury integration
- Implement UsageFeeRouter contract
- Add depositFees() function to AMM
- Protocol fee skimming logic
- Fee routing tests

**Acceptance Criteria**:
- API fees split correctly (protocol cut vs reserve)
- depositFees() increases reserve without token inflation
- Treasury balances track correctly
- Gas < 80k for fee deposits

---

### Phase 6: Governance & Safety (2-3 days)
**Deliverable**: Parameter controls and emergency functions
- Implement parameter adjustment with bounds
- Add pause mechanism
- Slippage protection
- Reentrancy guards
- Governance tests

**Acceptance Criteria**:
- CRR adjustable within 5%-50% bounds
- Fee rates adjustable within safe limits
- Emergency pause works without bricking contract
- Reentrancy attacks blocked
- All changes emit events

---

### Phase 7: Analytics & Monitoring (1-2 days)
**Deliverable**: View functions and events for frontends
- Rich view functions for pool state
- Reserve ratio tracking
- Historical price helpers
- Event indexing structure

**Acceptance Criteria**:
- Frontend can query all pool stats in single call
- Events support efficient filtering
- Gas < 5k for all view functions
- Documented event schemas

---

## Testing Requirements

### Unit Tests (per contract)
- Math accuracy (bonding curve formulas)
- State transitions (buy → sell → fee deposit)
- Access control (authorization checks)
- Edge cases (zero amounts, max values)
- Revert conditions (all require statements)

### Integration Tests (cross-contract)
- Full buy/sell cycle with TokenManager
- DeltaVerifier minting + AMM interaction
- Factory deployment + registry lookup
- Fee routing from UsageFeeRouter to AMM
- Treasury withdrawal flows

### Scenario Tests (economic behavior)
- IBR lifecycle (7-day buy-only → normal operation)
- Performance reward dilution + usage fee offset
- Large trades (slippage behavior)
- Concurrent operations (multiple users trading)
- Parameter changes (CRR adjustment mid-operation)

### Gas Benchmarks
- Buy: < 150,000 gas
- Sell: < 100,000 gas
- Fee deposit: < 80,000 gas
- Quotes: < 5,000 gas each

---

## Security Considerations

### Critical Requirements
1. **No Direct Minting**: AMM must always delegate to TokenManager
2. **Reentrancy Protection**: All external calls must be guarded
3. **Slippage Protection**: Users set minimum outputs
4. **Deadline Checks**: Prevent stale transaction execution
5. **Reserve Accounting**: Track USDC balance accurately
6. **Parameter Bounds**: CRR (5%-50%), fees (< 10%)
7. **Pause Safety**: Emergency stop without fund loss

### Audit Focus Areas
- Bonding curve math (overflow/underflow)
- Reserve balance manipulation
- Fee calculation rounding errors
- IBR timestamp bypass attempts
- TokenManager authorization bypass
- Reentrancy attack vectors

---

## Dependencies

### Existing (Already Deployed)
- ✅ ModelRegistry.sol
- ✅ HokusaiToken.sol
- ✅ TokenManager.sol
- ✅ DeltaVerifier.sol
- ✅ HokusaiParams.sol

### External (OpenZeppelin)
- @openzeppelin/contracts/token/ERC20/IERC20.sol
- @openzeppelin/contracts/access/Ownable.sol
- @openzeppelin/contracts/security/ReentrancyGuard.sol
- @openzeppelin/contracts/security/Pausable.sol

### Test Dependencies
- Mock USDC token for testing
- Hardhat time manipulation helpers
- Gas reporter for benchmarks

---

## Success Metrics

### Functional
- [ ] All 7 phases implemented and tested
- [ ] 100% test coverage on critical functions
- [ ] Gas benchmarks within targets
- [ ] Integration with existing contracts verified

### Economic
- [ ] Bonding curve prices match specification
- [ ] Fee flows reach Treasury correctly
- [ ] IBR mechanism creates price discovery
- [ ] Performance rewards integrate smoothly

### Security
- [ ] All require statements have tests
- [ ] Reentrancy guards on state changes
- [ ] Access control enforced
- [ ] Audit-ready documentation

---

## Estimated Timeline

**Total Effort**: 14-21 days (2-3 weeks)

| Phase | Effort | Priority |
|-------|--------|----------|
| 1. Core AMM | 3-5 days | P0 (foundation) |
| 2. TokenManager Integration | 2-3 days | P0 (critical path) |
| 3. Factory & Registry | 2-3 days | P0 (required) |
| 4. IBR Mechanism | 1-2 days | P0 (core feature) |
| 5. Fee Collection | 2-3 days | P1 (revenue) |
| 6. Governance & Safety | 2-3 days | P1 (security) |
| 7. Analytics | 1-2 days | P2 (UX enhancement) |

**Parallel Work Opportunities**:
- Phase 5 (Fee Router) can start during Phase 3-4
- Phase 7 (Analytics) can be done after Phase 1-4 complete
- Tests can be written alongside implementation

---

## Related Documentation

- **Design Spec**: [amm_token_design.md](amm_token_design.md)
- **Existing Contracts**: `/contracts` directory
- **Test Patterns**: `/test` directory (see existing patterns)
- **Deployment**: Will need new deployment scripts in `/scripts`

---

## Questions for Resolution

1. **CRR Default**: Confirm 10% (100,000 ppm) is optimal for launch
2. **IBR Duration**: 7 days or configurable per token?
3. **Fee Splits**: 25bps trade + 5% protocol cut confirmed?
4. **Treasury Address**: Single treasury or per-token treasuries?
5. **Backend Integration**: API service ready to call UsageFeeRouter?
6. **Oracle Needs**: Any off-chain price feeds required?

---

## Next Steps

1. **Review & Approve**: Stakeholders approve this consolidated spec
2. **Create Feature Branch**: `feature/amm-system-implementation`
3. **Generate PRD**: Use prd-writer agent with this spec
4. **Generate Tasks**: Break phases into detailed task list
5. **Begin Phase 1**: Start with core AMM bonding curve math
