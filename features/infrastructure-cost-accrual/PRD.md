# Product Requirements Document: Infrastructure Cost Accrual System

**Feature ID:** HOK-INFRA-ACCRUAL
**Status:** Approved for Implementation
**Created:** 2026-02-05
**Last Updated:** 2026-02-05
**Approved By:** Stakeholder

---

## Executive Summary

Implement a transparent, governance-controlled system for accruing infrastructure costs from API revenue and distributing residual profits to token holders through the AMM reserve. This system ensures infrastructure providers (AWS, Together AI, etc.) can be paid from accrued reserves while token holders benefit from genuine profit after costs.

---

## Business Context

### Problem Statement

Currently, API fees flow directly to the AMM pool with a fixed protocol fee split. This creates several issues:

1. **Infrastructure costs are unpredictable** - providers may charge different amounts based on usage patterns
2. **No dedicated reserve for costs** - infrastructure payments must come from general treasury
3. **Profit is overstated** - token holders receive value before infrastructure costs are paid
4. **No per-model cost tracking** - different models have different cost profiles
5. **Manual payment process lacks transparency** - no on-chain record of costs vs. revenue

### Solution Overview

Implement a **two-reserve system** where API revenue is split into:

1. **Infrastructure Reserve** - Accrues expected costs, pays providers (manual Phase 1)
2. **Profit Share** - Residual after infrastructure → AMM pool (benefits token holders via price appreciation)

**Key Principle:** Infrastructure is an **obligation** (must be paid first), profit is **residual** (what remains).

### Success Metrics

- ✅ All API revenue properly tracked per model
- ✅ Infrastructure accrual covers actual costs (target: 30+ days runway)
- ✅ Transparent on-chain accounting for all payments
- ✅ Governance can adjust cost accrual rates per model
- ✅ Token holders receive genuine profit, not gross revenue

---

## User Stories

### As a Token Holder
- I want to see genuine profit flowing to the AMM after infrastructure costs
- I want transparency into how much revenue goes to costs vs. profit
- I want governance control over cost accrual rates for my model

### As an Infrastructure Provider
- I want to receive predictable payments from accrued reserves
- I want transparency into how much is owed vs. paid
- I want assurance that reserves can cover costs

### As Platform Governance
- I want to set cost accrual rates per model based on actual usage patterns
- I want to monitor accrual health (reserve runway)
- I want emergency controls if accrual is insufficient

### As an API User (Future)
- I want predictable pricing that doesn't fluctuate with token price
- I want to know my usage is funding sustainable infrastructure
- I want to see how my fees benefit token holders

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                   API Revenue (100%)                     │
│            (deposited to UsageFeeRouter)                │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ↓
         ┌────────────────────────────┐
         │    UsageFeeRouter          │
         │  Reads per-model params    │
         └────────┬───────────┬───────┘
                  │           │
        Infrastructure   Profit Residual
        Accrual (80%)    (20%, configurable)
                  │           │
                  ↓           ↓
    ┌──────────────────┐  ┌──────────────────┐
    │ Infrastructure   │  │   HokusaiAMM     │
    │    Reserve       │  │                  │
    │  • Per-model     │  │ depositFees()    │
    │    accounting    │  │ → Reserve ↑      │
    │  • Manual payout │  │ → Price ↑        │
    │  • Invoice track │  │ → Token value ↑  │
    └────────┬─────────┘  └──────────────────┘
             │
             ↓ manual (authorized)
    ┌──────────────────┐
    │   Providers      │
    │ AWS, Together...│
    └──────────────────┘
```

---

## Component Specifications

### 1. HokusaiParams (Modified)

**Purpose:** Store per-model governance parameters including infrastructure cost accrual rate.

#### Current Parameters
```solidity
uint256 tokensPerDeltaOne;     // 100-100,000
uint16 infraMarkupBps;         // 0-1,000 (0-10%) - UNUSED
bytes32 licenseHash;
string licenseURI;
```

#### Proposed Parameters
```solidity
uint256 tokensPerDeltaOne;           // 100-100,000 (unchanged)
uint16 infrastructureAccrualBps;     // 5,000-10,000 (50-100%) NEW
bytes32 licenseHash;                 // (unchanged)
string licenseURI;                   // (unchanged)
```

**Key Changes:**
- **Remove:** `infraMarkupBps` (0-10% range, wrong semantics)
- **Add:** `infrastructureAccrualBps` (50-100% range)
- **Semantics:** "What % of revenue to accrue for infrastructure costs?"
- **Residual:** `profitShareBps = 10000 - infrastructureAccrualBps` (calculated, not stored)

#### Validation Rules
```solidity
MIN_INFRASTRUCTURE_ACCRUAL = 5000  // 50% minimum
MAX_INFRASTRUCTURE_ACCRUAL = 10000 // 100% maximum

// This ensures profit share is between 0-50%
// Models with high infra costs: 90% accrual, 10% profit
// Models with low infra costs: 50% accrual, 50% profit
```

#### Governance Functions
```solidity
function setInfrastructureAccrualBps(uint16 newBps)
    external
    onlyRole(GOV_ROLE)
{
    require(newBps >= MIN_INFRASTRUCTURE_ACCRUAL, "Below minimum");
    require(newBps <= MAX_INFRASTRUCTURE_ACCRUAL, "Above maximum");

    uint16 oldBps = infrastructureAccrualBps;
    infrastructureAccrualBps = newBps;

    emit InfrastructureAccrualBpsSet(oldBps, newBps, msg.sender);
}

// Convenience view
function getProfitShareBps() external view returns (uint16) {
    return 10000 - infrastructureAccrualBps;
}
```

---

### 2. InfrastructureReserve (New Contract)

**Purpose:** Isolated contract for accruing infrastructure costs and making payments to providers.

#### State Variables
```solidity
IERC20 public immutable reserveToken;           // USDC
HokusaiAMMFactory public immutable factory;     // For pool validation
address public treasury;                         // Emergency withdraw recipient

// Per-model accounting
mapping(string => uint256) public accrued;      // Total accrued for infrastructure
mapping(string => uint256) public paid;         // Total paid to providers
mapping(string => address) public provider;     // Current provider per model

// Access control
bytes32 public constant DEPOSITOR_ROLE = keccak256("DEPOSITOR_ROLE");
bytes32 public constant PAYER_ROLE = keccak256("PAYER_ROLE");

// Global statistics
uint256 public totalAccrued;
uint256 public totalPaid;
```

#### Core Functions

**Deposit Function (called by UsageFeeRouter)**
```solidity
function deposit(string memory modelId, uint256 amount)
    external
    onlyRole(DEPOSITOR_ROLE)
    nonReentrant
{
    require(amount > 0, "Amount must be > 0");
    require(factory.hasPool(modelId), "Model pool does not exist");

    // Transfer USDC from router
    require(
        reserveToken.transferFrom(msg.sender, address(this), amount),
        "Transfer failed"
    );

    // Update accounting
    accrued[modelId] += amount;
    totalAccrued += amount;

    emit InfrastructureDeposited(modelId, amount, accrued[modelId]);
}
```

**Batch Deposit (gas optimization)**
```solidity
function batchDeposit(
    string[] memory modelIds,
    uint256[] memory amounts
) external onlyRole(DEPOSITOR_ROLE) nonReentrant {
    require(modelIds.length == amounts.length, "Length mismatch");

    uint256 totalAmount = 0;
    for (uint256 i = 0; i < modelIds.length; i++) {
        accrued[modelIds[i]] += amounts[i];
        totalAmount += amounts[i];
        emit InfrastructureDeposited(modelIds[i], amounts[i], accrued[modelIds[i]]);
    }

    require(
        reserveToken.transferFrom(msg.sender, address(this), totalAmount),
        "Transfer failed"
    );

    totalAccrued += totalAmount;
    emit BatchDeposited(modelIds.length, totalAmount);
}
```

**Payment Function (manual, Phase 1)**
```solidity
function payInfrastructureCost(
    string memory modelId,
    address payee,
    uint256 amount,
    bytes32 invoiceHash,
    string memory memo
) external onlyRole(PAYER_ROLE) nonReentrant {
    require(amount > 0, "Amount must be > 0");
    require(payee != address(0), "Invalid payee");
    require(amount <= accrued[modelId], "Exceeds accrued balance");

    // Update accounting BEFORE transfer (CEI pattern)
    accrued[modelId] -= amount;
    paid[modelId] += amount;
    totalPaid += amount;

    // Transfer USDC to provider
    require(
        reserveToken.transfer(payee, amount),
        "Payment failed"
    );

    emit InfrastructureCostPaid(
        modelId,
        payee,
        amount,
        invoiceHash,
        memo,
        msg.sender
    );
}
```

**Batch Payment (for multiple invoices)**
```solidity
struct Payment {
    string modelId;
    address payee;
    uint256 amount;
    bytes32 invoiceHash;
    string memo;
}

function batchPayInfrastructureCosts(Payment[] memory payments)
    external
    onlyRole(PAYER_ROLE)
    nonReentrant
{
    uint256 totalPaidAmount = 0;

    for (uint256 i = 0; i < payments.length; i++) {
        Payment memory p = payments[i];
        require(p.amount <= accrued[p.modelId], "Exceeds accrued");

        accrued[p.modelId] -= p.amount;
        paid[p.modelId] += p.amount;
        totalPaidAmount += p.amount;

        require(
            reserveToken.transfer(p.payee, p.amount),
            "Payment failed"
        );

        emit InfrastructureCostPaid(
            p.modelId,
            p.payee,
            p.amount,
            p.invoiceHash,
            p.memo,
            msg.sender
        );
    }

    totalPaid += totalPaidAmount;
    emit BatchPaymentCompleted(payments.length, totalPaidAmount);
}
```

#### Provider Management
```solidity
function setProvider(string memory modelId, address _provider)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
{
    require(_provider != address(0), "Invalid provider");
    provider[modelId] = _provider;
    emit ProviderSet(modelId, _provider);
}
```

#### View Functions (Analytics)
```solidity
// Get accrual health (days of runway at current burn rate)
function getAccrualRunway(string memory modelId, uint256 dailyBurnRate)
    external
    view
    returns (uint256 daysOfRunway)
{
    if (dailyBurnRate == 0) return type(uint256).max;
    uint256 currentBalance = accrued[modelId];
    daysOfRunway = currentBalance / dailyBurnRate;
}

// Get net position (accrued - paid)
function getNetAccrual(string memory modelId)
    external
    view
    returns (uint256)
{
    return accrued[modelId]; // Already net after payments
}

// Get total paid to a specific provider
function getProviderPayments(string memory modelId)
    external
    view
    returns (uint256)
{
    return paid[modelId];
}

// Get comprehensive accounting
function getModelAccounting(string memory modelId)
    external
    view
    returns (
        uint256 accruedAmount,
        uint256 paidAmount,
        address currentProvider
    )
{
    return (accrued[modelId], paid[modelId], provider[modelId]);
}
```

#### Emergency Functions
```solidity
function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
    _pause();
}

function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
    _unpause();
}

function emergencyWithdraw(uint256 amount)
    external
    onlyRole(DEFAULT_ADMIN_ROLE)
{
    require(amount <= reserveToken.balanceOf(address(this)), "Insufficient balance");
    require(reserveToken.transfer(treasury, amount), "Withdraw failed");
    emit EmergencyWithdrawal(treasury, amount);
}
```

#### Events
```solidity
event InfrastructureDeposited(
    string indexed modelId,
    uint256 amount,
    uint256 newBalance
);

event InfrastructureCostPaid(
    string indexed modelId,
    address indexed payee,
    uint256 amount,
    bytes32 indexed invoiceHash,
    string memo,
    address payer
);

event BatchDeposited(uint256 modelCount, uint256 totalAmount);
event BatchPaymentCompleted(uint256 paymentCount, uint256 totalAmount);
event ProviderSet(string indexed modelId, address indexed provider);
event EmergencyWithdrawal(address recipient, uint256 amount);
```

---

### 3. UsageFeeRouter (Modified)

**Purpose:** Route API usage fees to infrastructure reserve and AMM profit share based on per-model parameters.

#### Key Changes from Current Design

**OLD Split (Current):**
```solidity
protocolFee = amount * protocolFeeBps / 10000;  // e.g., 5%
poolDeposit = amount - protocolFee;              // e.g., 95%
```

**NEW Split (Proposed):**
```solidity
// Read from HokusaiParams for this model
infrastructureAccrualBps = params.infrastructureAccrualBps(); // e.g., 8000 = 80%

// Calculate splits
infrastructureAmount = amount * infrastructureAccrualBps / 10000;  // 80%
profitAmount = amount - infrastructureAmount;                       // 20%

// Route
infraReserve.deposit(modelId, infrastructureAmount);
ammPool.depositFees(profitAmount);
```

**Critical Design Change:** Protocol fee removed entirely from API usage flow.

#### New State Variables
```solidity
InfrastructureReserve public immutable infraReserve;  // New
// REMOVED: protocolFeeBps (no longer needed)
```

#### Modified Deposit Function
```solidity
function depositFee(string memory modelId, uint256 amount)
    external
    nonReentrant
    onlyRole(FEE_DEPOSITOR_ROLE)
{
    require(amount > 0, "Amount must be > 0");
    require(factory.hasPool(modelId), "Pool does not exist");

    address poolAddress = factory.getPool(modelId);
    HokusaiAMM pool = HokusaiAMM(poolAddress);

    // Get model's infrastructure accrual rate from params
    address paramsAddress = pool.tokenManager().getParamsAddress(modelId);
    require(paramsAddress != address(0), "Params not found");
    IHokusaiParams params = IHokusaiParams(paramsAddress);
    uint16 infraBps = params.infrastructureAccrualBps();

    // Calculate split: infrastructure first, profit is residual
    uint256 infrastructureAmount = (amount * infraBps) / 10000;
    uint256 profitAmount = amount - infrastructureAmount;

    // Transfer total USDC from depositor
    require(
        reserveToken.transferFrom(msg.sender, address(this), amount),
        "Transfer failed"
    );

    // Route to infrastructure reserve
    if (infrastructureAmount > 0) {
        reserveToken.approve(address(infraReserve), infrastructureAmount);
        infraReserve.deposit(modelId, infrastructureAmount);
    }

    // Route profit to AMM (increases reserve, benefits token holders)
    if (profitAmount > 0) {
        reserveToken.approve(poolAddress, profitAmount);
        pool.depositFees(profitAmount);
    }

    // Update statistics
    totalFeesDeposited += amount;
    modelFees[modelId] += amount;

    emit FeeDeposited(
        modelId,
        poolAddress,
        amount,
        infrastructureAmount,
        profitAmount,
        msg.sender
    );
}
```

#### Batch Deposit (Optimized)
```solidity
function batchDepositFees(
    string[] memory modelIds,
    uint256[] memory amounts
) external nonReentrant onlyRole(FEE_DEPOSITOR_ROLE) {
    require(modelIds.length == amounts.length, "Length mismatch");
    require(modelIds.length > 0, "Empty arrays");

    uint256 totalAmount = 0;
    uint256 totalInfra = 0;
    uint256 totalProfit = 0;

    // Pre-calculate totals for single USDC transfer
    for (uint256 i = 0; i < modelIds.length; i++) {
        require(amounts[i] > 0, "Amount must be > 0");
        require(factory.hasPool(modelIds[i]), "Pool does not exist");
        totalAmount += amounts[i];
    }

    // Single transfer from depositor
    require(
        reserveToken.transferFrom(msg.sender, address(this), totalAmount),
        "Transfer failed"
    );

    // Process each model
    string[] memory infraModelIds = new string[](modelIds.length);
    uint256[] memory infraAmounts = new uint256[](modelIds.length);

    for (uint256 i = 0; i < modelIds.length; i++) {
        string memory modelId = modelIds[i];
        uint256 amount = amounts[i];

        address poolAddress = factory.getPool(modelId);
        HokusaiAMM pool = HokusaiAMM(poolAddress);

        // Get infrastructure accrual rate
        address paramsAddress = pool.tokenManager().getParamsAddress(modelId);
        IHokusaiParams params = IHokusaiParams(paramsAddress);
        uint16 infraBps = params.infrastructureAccrualBps();

        // Calculate split
        uint256 infrastructureAmount = (amount * infraBps) / 10000;
        uint256 profitAmount = amount - infrastructureAmount;

        // Accumulate for batch operations
        infraModelIds[i] = modelId;
        infraAmounts[i] = infrastructureAmount;
        totalInfra += infrastructureAmount;
        totalProfit += profitAmount;

        // Deposit profit to AMM immediately (can't batch this)
        if (profitAmount > 0) {
            reserveToken.approve(poolAddress, profitAmount);
            pool.depositFees(profitAmount);
        }

        // Update statistics
        modelFees[modelId] += amount;

        emit FeeDeposited(
            modelId,
            poolAddress,
            amount,
            infrastructureAmount,
            profitAmount,
            msg.sender
        );
    }

    // Batch deposit to infrastructure reserve
    if (totalInfra > 0) {
        reserveToken.approve(address(infraReserve), totalInfra);
        infraReserve.batchDeposit(infraModelIds, infraAmounts);
    }

    totalFeesDeposited += totalAmount;

    emit BatchDeposited(
        totalAmount,
        totalInfra,
        totalProfit,
        modelIds.length,
        msg.sender
    );
}
```

#### Updated Events
```solidity
event FeeDeposited(
    string indexed modelId,
    address indexed poolAddress,
    uint256 totalAmount,
    uint256 infrastructureAmount,  // NEW
    uint256 profitAmount,          // NEW (replaces poolDeposit)
    address indexed depositor
);

event BatchDeposited(
    uint256 totalAmount,
    uint256 totalInfrastructure,   // NEW
    uint256 totalProfit,            // NEW
    uint256 modelCount,
    address indexed depositor
);
```

#### View Functions
```solidity
// Calculate split for a given model and amount
function calculateFeeSplit(string memory modelId, uint256 amount)
    external
    view
    returns (uint256 infrastructureAmount, uint256 profitAmount)
{
    address poolAddress = factory.getPool(modelId);
    require(poolAddress != address(0), "Pool not found");

    HokusaiAMM pool = HokusaiAMM(poolAddress);
    address paramsAddress = pool.tokenManager().getParamsAddress(modelId);
    require(paramsAddress != address(0), "Params not found");

    IHokusaiParams params = IHokusaiParams(paramsAddress);
    uint16 infraBps = params.infrastructureAccrualBps();

    infrastructureAmount = (amount * infraBps) / 10000;
    profitAmount = amount - infrastructureAmount;
}

// Get comprehensive stats for a model
function getModelStats(string memory modelId)
    external
    view
    returns (
        uint256 totalFees,
        uint256 currentInfraBps,
        uint256 currentProfitBps
    )
{
    totalFees = modelFees[modelId];

    address poolAddress = factory.getPool(modelId);
    if (poolAddress != address(0)) {
        HokusaiAMM pool = HokusaiAMM(poolAddress);
        address paramsAddress = pool.tokenManager().getParamsAddress(modelId);

        if (paramsAddress != address(0)) {
            IHokusaiParams params = IHokusaiParams(paramsAddress);
            currentInfraBps = params.infrastructureAccrualBps();
            currentProfitBps = 10000 - currentInfraBps;
        }
    }
}
```

---

## Data Flow Examples

### Example 1: Single API Usage Fee Deposit

**Scenario:** Model "chestx-v1" generates $100 in API revenue, with 80% infrastructure accrual rate.

```
Step 1: Backend calls UsageFeeRouter.depositFee("chestx-v1", 100_000000)
        (100 USDC = 100,000,000 units at 6 decimals)

Step 2: Router reads HokusaiParams for "chestx-v1"
        → infrastructureAccrualBps = 8000 (80%)

Step 3: Router calculates split
        → infrastructureAmount = 100 * 8000 / 10000 = 80 USDC
        → profitAmount = 100 - 80 = 20 USDC

Step 4: Router transfers 100 USDC from backend to itself

Step 5: Router routes 80 USDC to InfrastructureReserve.deposit("chestx-v1", 80)
        → accrued["chestx-v1"] increases by 80 USDC

Step 6: Router routes 20 USDC to HokusaiAMM.depositFees(20)
        → reserveBalance increases by 20 USDC
        → spotPrice increases (benefits all token holders)

Result:
- Infrastructure reserve has $80 for future AWS/Together payments
- Token holders benefit from $20 profit via price appreciation
- All recorded on-chain with events
```

### Example 2: Infrastructure Cost Payment

**Scenario:** AWS invoice for $500 for model "chestx-v1", accrued balance is $800.

```
Step 1: Admin calls InfrastructureReserve.payInfrastructureCost(
            "chestx-v1",
            0xAWS_WALLET,
            500_000000,
            0xINVOICE_HASH,
            "AWS invoice #12345 for Jan 2026"
        )

Step 2: Contract validates
        → accrued["chestx-v1"] = 800 USDC
        → payment amount 500 USDC <= 800 USDC ✓

Step 3: Contract updates accounting (CEI pattern)
        → accrued["chestx-v1"] -= 500 (now 300 USDC)
        → paid["chestx-v1"] += 500
        → totalPaid += 500

Step 4: Contract transfers 500 USDC to AWS wallet

Step 5: Emit InfrastructureCostPaid event with invoice hash

Result:
- AWS receives $500 payment
- Infrastructure reserve has $300 remaining runway
- Payment recorded on-chain with invoice reference
- Can be audited by token holders
```

### Example 3: Governance Adjusts Accrual Rate

**Scenario:** Model "chestx-v1" costs are lower than expected, governance increases profit share.

```
Step 1: Current parameters
        → infrastructureAccrualBps = 8000 (80% infra, 20% profit)

Step 2: Governance calls HokusaiParams.setInfrastructureAccrualBps(7000)
        → New: 70% infrastructure, 30% profit

Step 3: Future fee deposits automatically use new rate
        → Next $100 fee: $70 to infra, $30 to AMM profit

Result:
- Token holders get 30% profit instead of 20%
- Infrastructure still has 70% to cover costs
- Adjustment takes effect immediately on next deposit
```

---

## Implementation Tasks

### Phase 1: Core Infrastructure (Week 1-2)

#### Task 1.1: Update HokusaiParams
- [ ] Add `infrastructureAccrualBps` state variable (uint16, 5000-10000)
- [ ] Remove or deprecate `infraMarkupBps`
- [ ] Add `setInfrastructureAccrualBps()` governance function
- [ ] Add `getProfitShareBps()` convenience view
- [ ] Add validation: MIN=5000, MAX=10000
- [ ] Update events: `InfrastructureAccrualBpsSet`
- [ ] Update interface `IHokusaiParams.sol`

**Files:**
- `contracts/HokusaiParams.sol`
- `contracts/interfaces/IHokusaiParams.sol`

#### Task 1.2: Create InfrastructureReserve Contract
- [ ] Implement state variables (accrued, paid, provider mappings)
- [ ] Implement `deposit()` function
- [ ] Implement `batchDeposit()` function
- [ ] Implement `payInfrastructureCost()` function
- [ ] Implement `batchPayInfrastructureCosts()` function
- [ ] Implement provider management (`setProvider`)
- [ ] Implement view functions (getAccrualRunway, getModelAccounting, etc.)
- [ ] Implement emergency functions (pause, emergencyWithdraw)
- [ ] Add access control (DEPOSITOR_ROLE, PAYER_ROLE)
- [ ] Add comprehensive events
- [ ] Add ReentrancyGuard protection

**Files:**
- `contracts/InfrastructureReserve.sol` (NEW)

#### Task 1.3: Modify UsageFeeRouter
- [ ] Add `infraReserve` immutable reference
- [ ] Update constructor to accept InfrastructureReserve address
- [ ] Modify `depositFee()` to read params and split correctly
- [ ] Modify `batchDepositFees()` to use new split logic
- [ ] Update events (FeeDeposited, BatchDeposited)
- [ ] Add view function `calculateFeeSplit()`
- [ ] Add view function `getModelStats()`
- [ ] Remove `protocolFeeBps` entirely (confirmed: not needed)

**Files:**
- `contracts/UsageFeeRouter.sol`

### Phase 2: Testing (Week 2)

#### Task 2.1: Unit Tests - HokusaiParams
- [ ] Test `setInfrastructureAccrualBps()` with valid values
- [ ] Test bounds validation (< 5000 fails, > 10000 fails)
- [ ] Test governance access control
- [ ] Test `getProfitShareBps()` calculation
- [ ] Test event emission

**Files:**
- `test/HokusaiParams.test.js` (NEW or MODIFIED)

#### Task 2.2: Unit Tests - InfrastructureReserve
- [ ] Test deposit() single model
- [ ] Test batchDeposit() multiple models
- [ ] Test payInfrastructureCost() with sufficient balance
- [ ] Test payInfrastructureCost() fails with insufficient balance
- [ ] Test batchPayInfrastructureCosts()
- [ ] Test access control (only DEPOSITOR_ROLE can deposit)
- [ ] Test access control (only PAYER_ROLE can pay)
- [ ] Test pause/unpause
- [ ] Test emergencyWithdraw
- [ ] Test accounting accuracy (accrued, paid)
- [ ] Test view functions (getAccrualRunway, getModelAccounting)
- [ ] Test event emissions

**Files:**
- `test/InfrastructureReserve.test.js` (NEW)

#### Task 2.3: Unit Tests - UsageFeeRouter
- [ ] Test depositFee() with 80/20 split
- [ ] Test depositFee() with different accrual rates (70/30, 90/10)
- [ ] Test batchDepositFees() with multiple models
- [ ] Test calculateFeeSplit() view function
- [ ] Test getModelStats() view function
- [ ] Test that infrastructure reserve receives correct amount
- [ ] Test that AMM receives correct profit amount
- [ ] Test access control
- [ ] Test event emissions

**Files:**
- `test/UsageFeeRouter.test.js` (MODIFIED)

#### Task 2.4: Integration Tests
- [ ] Test end-to-end flow: deposit fee → split → payment
- [ ] Test governance changes accrual rate → affects future deposits
- [ ] Test multiple models with different accrual rates
- [ ] Test accrual health monitoring after payments
- [ ] Test that AMM price increases correctly from profit deposits

**Files:**
- `test/integration/InfrastructureFlow.test.js` (NEW)

### Phase 3: Deployment & Documentation (Week 3)

#### Task 3.1: Deployment Scripts
- [ ] Create deploy script for InfrastructureReserve
- [ ] Create deploy script for updated UsageFeeRouter
- [ ] Create upgrade script for HokusaiParams (or deploy new with migration)
- [ ] Create initialization script (grant roles, set addresses)
- [ ] Add deployment configuration for testnet (Sepolia)
- [ ] Add deployment configuration for mainnet

**Files:**
- `scripts/deploy-infrastructure-reserve.js` (NEW)
- `scripts/deploy-usage-fee-router-v2.js` (NEW)
- `scripts/upgrade-hokusai-params.js` (NEW)

#### Task 3.2: Documentation
- [ ] Update README with new contracts
- [ ] Create infrastructure accrual guide for governance
- [ ] Create payment guide for administrators
- [ ] Document event schemas for off-chain tracking
- [ ] Create example scripts for common operations
- [ ] Update architecture diagrams

**Files:**
- `docs/infrastructure-accrual.md` (NEW)
- `docs/governance-guide.md` (UPDATED)
- `docs/architecture.md` (UPDATED)
- `README.md` (UPDATED)

#### Task 3.3: Monitoring & Analytics
- [ ] Create Dune Analytics queries for infrastructure accrual tracking
- [ ] Create dashboard for per-model accounting
- [ ] Create alerts for low accrual runway (< 7 days)
- [ ] Document monitoring setup

**Files:**
- `monitoring/dune-queries/` (NEW)
- `monitoring/alerts.md` (NEW)

---

## Security Considerations

### Access Control
- **DEPOSITOR_ROLE** - Can deposit to infrastructure reserve (granted to UsageFeeRouter)
- **PAYER_ROLE** - Can pay infrastructure costs (granted to multisig/treasury)
- **GOV_ROLE** - Can adjust accrual rates (per-model governance)
- **DEFAULT_ADMIN_ROLE** - Can grant/revoke roles, emergency actions

### Economic Safety
1. **Minimum Accrual Rate (50%)** - Prevents governance from setting too low
2. **Payment Cap** - Cannot pay more than accrued balance
3. **Pause Mechanism** - Emergency stop for deposits and payments
4. **Invoice Tracking** - Every payment requires invoice hash for transparency

### Reentrancy Protection
- All external calls use CEI pattern (Checks-Effects-Interactions)
- ReentrancyGuard on all state-changing functions
- No untrusted external calls before state updates

### Precision & Rounding
- All BPS calculations use `(amount * bps) / 10000`
- Residual calculation: `profit = total - infrastructure` (no compound rounding)
- USDC uses 6 decimals, no precision loss issues

---

## Stakeholder Decisions (2026-02-05)

### Design Decisions Confirmed

1. **Protocol Fee on API Usage:** Removed entirely - 100% of API fees split between infrastructure and profit
2. **HokusaiParams Deployment:** New deployment, no backwards compatibility required
3. **Initial Role Assignments:**
   - `PAYER_ROLE`: Treasury address (for infrastructure payments)
   - `DEPOSITOR_ROLE`: UsageFeeRouter contract address
   - `GOV_ROLE`: Per-model governance address (set during token deployment)
4. **Default Infrastructure Accrual:** 8000 bps (80% to infrastructure, 20% to token holders via AMM)
5. **Implementation Timeline:** 3-4 weeks confirmed as acceptable

---

## Open Questions & Future Considerations

### Phase 2+ Features (Out of Scope for Now)

1. **Automated Cost Verification**
   - Oracle integration for AWS/Together invoice validation
   - Automatic payment approval based on verified invoices
   - Multi-sig requirement for large payments

2. **Multi-Provider Support**
   - Split infrastructure costs across multiple providers per model
   - Provider performance tracking
   - Automatic failover and payment routing

3. **Dynamic Accrual Adjustment**
   - Automatic accrual rate adjustment based on actual costs
   - Machine learning for cost prediction
   - Seasonal/usage pattern recognition

4. **User Account System**
   - On-chain user balance tracking
   - Automatic fee deduction per API call
   - Prepaid credits and subscriptions

5. **Cost Reporting & Analytics**
   - Per-model cost breakdown (compute, storage, bandwidth)
   - Cost efficiency metrics
   - Provider cost comparison

---

## Acceptance Criteria

### Must Have (P0)
- ✅ HokusaiParams stores `infrastructureAccrualBps` per model
- ✅ InfrastructureReserve contract deployed and functional
- ✅ UsageFeeRouter splits fees based on per-model parameters
- ✅ Manual infrastructure payment function with invoice tracking
- ✅ All state changes emit comprehensive events
- ✅ >95% test coverage on new contracts
- ✅ Successful testnet deployment

### Should Have (P1)
- ✅ Batch operations for gas efficiency
- ✅ Accrual health monitoring views
- ✅ Emergency pause and withdraw functions
- ✅ Comprehensive integration tests
- ✅ Documentation for governance and admins

### Nice to Have (P2)
- ⭕ Dune Analytics dashboard
- ⭕ Automated monitoring and alerts
- ⭕ Example scripts for common operations
- ⭕ Gas optimization benchmarks

---

## Timeline

**Week 1:** Core contract implementation (HokusaiParams, InfrastructureReserve, UsageFeeRouter)
**Week 2:** Comprehensive testing (unit + integration)
**Week 3:** Deployment scripts, documentation, testnet deployment
**Week 4:** Monitoring setup, governance handoff, mainnet preparation

---

## Appendix A: Interface Definitions

### IHokusaiParams (Updated)
```solidity
interface IHokusaiParams {
    // Existing
    function tokensPerDeltaOne() external view returns (uint256);
    function licenseHash() external view returns (bytes32);
    function licenseURI() external view returns (string memory);
    function licenseRef() external view returns (bytes32 hash, string memory uri);

    function setTokensPerDeltaOne(uint256 newValue) external;
    function setLicenseRef(bytes32 hash, string memory uri) external;

    // New
    function infrastructureAccrualBps() external view returns (uint16);
    function getProfitShareBps() external view returns (uint16);
    function setInfrastructureAccrualBps(uint16 newBps) external;

    // Events
    event TokensPerDeltaOneSet(uint256 oldValue, uint256 newValue, address indexed setter);
    event LicenseRefSet(bytes32 oldHash, bytes32 newHash, string uri, address indexed setter);
    event InfrastructureAccrualBpsSet(uint16 oldBps, uint16 newBps, address indexed setter);
}
```

### IInfrastructureReserve (New)
```solidity
interface IInfrastructureReserve {
    struct Payment {
        string modelId;
        address payee;
        uint256 amount;
        bytes32 invoiceHash;
        string memo;
    }

    // Deposit functions
    function deposit(string memory modelId, uint256 amount) external;
    function batchDeposit(string[] memory modelIds, uint256[] memory amounts) external;

    // Payment functions
    function payInfrastructureCost(
        string memory modelId,
        address payee,
        uint256 amount,
        bytes32 invoiceHash,
        string memory memo
    ) external;

    function batchPayInfrastructureCosts(Payment[] memory payments) external;

    // Provider management
    function setProvider(string memory modelId, address _provider) external;

    // View functions
    function getAccrualRunway(string memory modelId, uint256 dailyBurnRate)
        external view returns (uint256);
    function getNetAccrual(string memory modelId) external view returns (uint256);
    function getModelAccounting(string memory modelId)
        external view returns (uint256 accrued, uint256 paid, address currentProvider);

    // Emergency
    function pause() external;
    function unpause() external;
    function emergencyWithdraw(uint256 amount) external;

    // Events
    event InfrastructureDeposited(string indexed modelId, uint256 amount, uint256 newBalance);
    event InfrastructureCostPaid(
        string indexed modelId,
        address indexed payee,
        uint256 amount,
        bytes32 indexed invoiceHash,
        string memo,
        address payer
    );
    event BatchDeposited(uint256 modelCount, uint256 totalAmount);
    event BatchPaymentCompleted(uint256 paymentCount, uint256 totalAmount);
    event ProviderSet(string indexed modelId, address indexed provider);
    event EmergencyWithdrawal(address recipient, uint256 amount);
}
```

---

## Appendix B: Example Usage Scenarios

### Scenario 1: Initial Setup (Testnet)
```javascript
// 1. Deploy InfrastructureReserve
const infraReserve = await deploy("InfrastructureReserve", [
    USDC_ADDRESS,
    FACTORY_ADDRESS,
    TREASURY_ADDRESS
]);

// 2. Deploy new UsageFeeRouter
const router = await deploy("UsageFeeRouter", [
    FACTORY_ADDRESS,
    USDC_ADDRESS,
    infraReserve.address
]);

// 3. Grant roles
await infraReserve.grantRole(DEPOSITOR_ROLE, router.address);
await infraReserve.grantRole(PAYER_ROLE, MULTISIG_ADDRESS);

// 4. Deploy token with infrastructure params
await tokenManager.deployTokenWithParams(
    "test-model-v1",
    "Test Model Token",
    "TESTM",
    1_000_000e18,
    {
        tokensPerDeltaOne: 1000,
        infrastructureAccrualBps: 8000, // 80% infra, 20% profit
        licenseHash: ethers.utils.id("MIT"),
        licenseURI: "https://license.url",
        governor: GOVERNOR_ADDRESS
    }
);
```

### Scenario 2: Processing API Revenue
```javascript
// Backend receives $100 in API revenue for "test-model-v1"
await usdc.approve(router.address, 100e6);
await router.depositFee("test-model-v1", 100e6);

// Results:
// - InfrastructureReserve has $80 for test-model-v1
// - AMM reserve increased by $20 (token price went up)
```

### Scenario 3: Paying Infrastructure Costs
```javascript
// Multisig pays AWS invoice for $50
await infraReserve.payInfrastructureCost(
    "test-model-v1",
    AWS_WALLET,
    50e6,
    invoiceHash,
    "AWS invoice #12345"
);

// Results:
// - AWS receives $50
// - InfrastructureReserve balance for test-model-v1 is now $30
```

### Scenario 4: Governance Adjusts Split
```javascript
// Model costs are lower than expected, increase profit share
const params = await HokusaiParams.at(paramsAddress);
await params.setInfrastructureAccrualBps(7000); // 70% infra, 30% profit

// Future deposits will use 70/30 split
```

---

**End of PRD**
