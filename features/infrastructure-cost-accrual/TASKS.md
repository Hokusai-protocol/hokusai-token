# Implementation Tasks: Infrastructure Cost Accrual System

**Feature:** HOK-INFRA-ACCRUAL
**Status:** Ready for Implementation
**Start Date:** 2026-02-05
**Target Completion:** 2026-02-26 (3 weeks)

---

## Week 1: Core Contract Implementation

### Task 1.1: Update HokusaiParams Contract
**Priority:** P0
**Estimated:** 4 hours
**Dependencies:** None

**Subtasks:**
- [ ] Create new `HokusaiParams.sol` with updated parameters
- [ ] Add `infrastructureAccrualBps` state variable (uint16, range 5000-10000)
- [ ] Remove `infraMarkupBps` completely
- [ ] Implement `setInfrastructureAccrualBps(uint16)` governance function
- [ ] Implement `getProfitShareBps()` view function (returns `10000 - infrastructureAccrualBps`)
- [ ] Add constants: `MIN_INFRASTRUCTURE_ACCRUAL = 5000`, `MAX_INFRASTRUCTURE_ACCRUAL = 10000`
- [ ] Add validation in setter function
- [ ] Add event: `InfrastructureAccrualBpsSet(uint16 oldBps, uint16 newBps, address indexed setter)`
- [ ] Update constructor to accept `infrastructureAccrualBps` instead of `infraMarkupBps`
- [ ] Update interface `IHokusaiParams.sol`

**Acceptance Criteria:**
- ✅ Contract compiles without errors
- ✅ Default accrual rate is 8000 (80%)
- ✅ Setter enforces range: 5000 ≤ value ≤ 10000
- ✅ Only GOV_ROLE can call setter
- ✅ Events emit correctly

**Files Modified:**
- `contracts/HokusaiParams.sol`
- `contracts/interfaces/IHokusaiParams.sol`

---

### Task 1.2: Create InfrastructureReserve Contract
**Priority:** P0
**Estimated:** 8 hours
**Dependencies:** None

**Subtasks:**
- [ ] Create `contracts/InfrastructureReserve.sol`
- [ ] Add imports: IERC20, AccessControl, ReentrancyGuard, Pausable
- [ ] Implement state variables:
  - [ ] `reserveToken` (USDC)
  - [ ] `factory` (HokusaiAMMFactory)
  - [ ] `treasury` (emergency recipient)
  - [ ] `accrued` mapping (string => uint256)
  - [ ] `paid` mapping (string => uint256)
  - [ ] `provider` mapping (string => address)
  - [ ] `totalAccrued` and `totalPaid` counters
- [ ] Define roles: `DEPOSITOR_ROLE`, `PAYER_ROLE`
- [ ] Implement constructor
- [ ] Implement `deposit(string modelId, uint256 amount)`:
  - [ ] Role check: DEPOSITOR_ROLE
  - [ ] Transfer USDC from caller
  - [ ] Update accrued[modelId] and totalAccrued
  - [ ] Emit InfrastructureDeposited event
  - [ ] Add nonReentrant modifier
- [ ] Implement `batchDeposit(string[] modelIds, uint256[] amounts)`:
  - [ ] Validate array lengths match
  - [ ] Single USDC transfer for efficiency
  - [ ] Update all accrued balances
  - [ ] Emit events for each model + batch event
- [ ] Implement `payInfrastructureCost(...)`:
  - [ ] Role check: PAYER_ROLE
  - [ ] Validate amount ≤ accrued[modelId]
  - [ ] Update accrued, paid, totalPaid (CEI pattern)
  - [ ] Transfer USDC to payee
  - [ ] Emit InfrastructureCostPaid with invoice hash
- [ ] Implement `batchPayInfrastructureCosts(Payment[] payments)`:
  - [ ] Define Payment struct
  - [ ] Process all payments in single transaction
  - [ ] Emit individual and batch events
- [ ] Implement provider management:
  - [ ] `setProvider(string modelId, address provider)`
  - [ ] Only DEFAULT_ADMIN_ROLE
- [ ] Implement view functions:
  - [ ] `getAccrualRunway(string modelId, uint256 dailyBurnRate)`
  - [ ] `getNetAccrual(string modelId)`
  - [ ] `getModelAccounting(string modelId)`
- [ ] Implement emergency functions:
  - [ ] `pause()` and `unpause()`
  - [ ] `emergencyWithdraw(uint256 amount)`
- [ ] Define all events:
  - [ ] InfrastructureDeposited
  - [ ] InfrastructureCostPaid
  - [ ] BatchDeposited
  - [ ] BatchPaymentCompleted
  - [ ] ProviderSet
  - [ ] EmergencyWithdrawal

**Acceptance Criteria:**
- ✅ Contract compiles without errors
- ✅ All role-based access control enforced
- ✅ CEI pattern followed (no reentrancy vulnerabilities)
- ✅ Cannot pay more than accrued balance
- ✅ Batch operations save gas vs. individual calls
- ✅ All events include proper indexed fields

**Files Created:**
- `contracts/InfrastructureReserve.sol`
- `contracts/interfaces/IInfrastructureReserve.sol`

---

### Task 1.3: Modify UsageFeeRouter Contract
**Priority:** P0
**Estimated:** 6 hours
**Dependencies:** Task 1.1 (IHokusaiParams), Task 1.2 (InfrastructureReserve)

**Subtasks:**
- [ ] Add `infraReserve` immutable state variable
- [ ] Remove `protocolFeeBps` and related code
- [ ] Update constructor signature:
  - [ ] Accept `infraReserve` address
  - [ ] Remove `protocolFeeBps` parameter
  - [ ] Validate infraReserve address
- [ ] Modify `depositFee(string modelId, uint256 amount)`:
  - [ ] Get pool from factory
  - [ ] Get TokenManager from pool
  - [ ] Get HokusaiParams address from TokenManager
  - [ ] Read `infrastructureAccrualBps` from params
  - [ ] Calculate: `infraAmount = amount * infraBps / 10000`
  - [ ] Calculate: `profitAmount = amount - infraAmount`
  - [ ] Transfer total USDC from depositor
  - [ ] Route infraAmount to InfrastructureReserve.deposit()
  - [ ] Route profitAmount to AMM.depositFees()
  - [ ] Update statistics
  - [ ] Emit updated FeeDeposited event
- [ ] Modify `batchDepositFees(string[] modelIds, uint256[] amounts)`:
  - [ ] Single USDC transfer from depositor
  - [ ] Process each model with dynamic split
  - [ ] Accumulate infrastructure amounts for batch deposit
  - [ ] Deposit profits to AMM individually (can't batch)
  - [ ] Call InfrastructureReserve.batchDeposit() once
  - [ ] Emit updated events
- [ ] Update events:
  - [ ] FeeDeposited: add `infrastructureAmount`, `profitAmount` fields
  - [ ] BatchDeposited: add `totalInfrastructure`, `totalProfit` fields
  - [ ] Remove protocol fee fields
- [ ] Implement view functions:
  - [ ] `calculateFeeSplit(string modelId, uint256 amount)` returns (uint256 infra, uint256 profit)
  - [ ] `getModelStats(string modelId)` returns (totalFees, currentInfraBps, currentProfitBps)
- [ ] Remove unused functions:
  - [ ] `setProtocolFee()` (if exists)
  - [ ] Any protocol fee related code

**Acceptance Criteria:**
- ✅ No protocol fee logic remains
- ✅ Reads per-model infrastructure accrual rate dynamically
- ✅ Correctly routes funds to both InfrastructureReserve and AMM
- ✅ Batch operations work efficiently
- ✅ View functions return accurate calculations
- ✅ Events contain all necessary data for off-chain tracking

**Files Modified:**
- `contracts/UsageFeeRouter.sol`

---

## Week 2: Comprehensive Testing

### Task 2.1: Unit Tests - HokusaiParams
**Priority:** P0
**Estimated:** 3 hours
**Dependencies:** Task 1.1

**Test Cases:**
- [ ] **Deployment Tests:**
  - [ ] Can deploy with valid infrastructureAccrualBps (8000)
  - [ ] Cannot deploy with infraAccrual < 5000
  - [ ] Cannot deploy with infraAccrual > 10000
  - [ ] Governor address gets GOV_ROLE
- [ ] **Setter Tests:**
  - [ ] GOV_ROLE can set infrastructureAccrualBps to valid value
  - [ ] Non-GOV_ROLE cannot set infrastructureAccrualBps
  - [ ] Cannot set below minimum (5000)
  - [ ] Cannot set above maximum (10000)
  - [ ] Event emits with correct old/new values
- [ ] **View Function Tests:**
  - [ ] getProfitShareBps() returns 10000 - infrastructureAccrualBps
  - [ ] Returns correct value after update
- [ ] **Edge Cases:**
  - [ ] Setting to current value succeeds
  - [ ] Boundary values (5000, 10000) work correctly

**Files:**
- `test/HokusaiParams.test.js`

---

### Task 2.2: Unit Tests - InfrastructureReserve
**Priority:** P0
**Estimated:** 8 hours
**Dependencies:** Task 1.2

**Test Cases:**
- [ ] **Deployment Tests:**
  - [ ] Deploys with correct immutable addresses
  - [ ] Sets treasury correctly
  - [ ] Deployer gets DEFAULT_ADMIN_ROLE
- [ ] **Deposit Tests:**
  - [ ] DEPOSITOR_ROLE can deposit
  - [ ] Non-DEPOSITOR_ROLE cannot deposit
  - [ ] Accrued balance updates correctly
  - [ ] TotalAccrued updates correctly
  - [ ] Event emits with correct data
  - [ ] Cannot deposit 0 amount
  - [ ] Cannot deposit for non-existent pool
- [ ] **Batch Deposit Tests:**
  - [ ] Can deposit to multiple models
  - [ ] Array length mismatch reverts
  - [ ] Total USDC transfer is sum of amounts
  - [ ] All accrued balances update
  - [ ] Events emit for each model
  - [ ] Batch event emits with totals
- [ ] **Payment Tests:**
  - [ ] PAYER_ROLE can pay infrastructure costs
  - [ ] Non-PAYER_ROLE cannot pay
  - [ ] Payment reduces accrued balance
  - [ ] Payment increases paid balance
  - [ ] USDC transfers to payee
  - [ ] Cannot pay more than accrued
  - [ ] Cannot pay to zero address
  - [ ] Cannot pay 0 amount
  - [ ] Event includes invoice hash
- [ ] **Batch Payment Tests:**
  - [ ] Can pay multiple invoices
  - [ ] All balances update correctly
  - [ ] USDC transfers succeed
  - [ ] Events emit correctly
  - [ ] Reverts if any payment exceeds accrued
- [ ] **Provider Management Tests:**
  - [ ] Admin can set provider
  - [ ] Non-admin cannot set provider
  - [ ] Cannot set zero address
  - [ ] Event emits correctly
- [ ] **View Function Tests:**
  - [ ] getAccrualRunway calculates correctly
  - [ ] getAccrualRunway handles zero burn rate
  - [ ] getNetAccrual returns current accrued
  - [ ] getModelAccounting returns all data
- [ ] **Emergency Function Tests:**
  - [ ] Admin can pause/unpause
  - [ ] Non-admin cannot pause
  - [ ] Deposits blocked when paused
  - [ ] Payments blocked when paused
  - [ ] Admin can emergency withdraw
  - [ ] Cannot withdraw more than balance
  - [ ] Emergency withdraw transfers to treasury

**Files:**
- `test/InfrastructureReserve.test.js`

---

### Task 2.3: Unit Tests - UsageFeeRouter
**Priority:** P0
**Estimated:** 6 hours
**Dependencies:** Task 1.3

**Test Cases:**
- [ ] **Deployment Tests:**
  - [ ] Deploys with InfrastructureReserve reference
  - [ ] No protocolFeeBps parameter
- [ ] **Deposit Fee Tests:**
  - [ ] Reads correct infrastructureAccrualBps from params
  - [ ] Calculates correct infrastructure split (80/20)
  - [ ] Routes correct amount to InfrastructureReserve
  - [ ] Routes correct amount to AMM
  - [ ] Total USDC transferred equals input
  - [ ] Statistics update correctly
  - [ ] Event emits with both amounts
- [ ] **Variable Split Tests:**
  - [ ] Works with 70/30 split (infraBps = 7000)
  - [ ] Works with 90/10 split (infraBps = 9000)
  - [ ] Works with 50/50 split (infraBps = 5000)
  - [ ] Works with 100/0 split (infraBps = 10000)
- [ ] **Batch Deposit Tests:**
  - [ ] Can deposit for multiple models
  - [ ] Each model uses its own accrual rate
  - [ ] Infrastructure reserve gets batched deposit
  - [ ] AMM deposits happen individually
  - [ ] Events emit correctly
  - [ ] Totals are accurate
- [ ] **View Function Tests:**
  - [ ] calculateFeeSplit returns correct split for model
  - [ ] getModelStats returns current parameters
  - [ ] Handles non-existent pool gracefully
- [ ] **Access Control Tests:**
  - [ ] Only FEE_DEPOSITOR_ROLE can deposit
  - [ ] Non-depositor cannot deposit
- [ ] **Integration Points:**
  - [ ] Calls InfrastructureReserve.deposit correctly
  - [ ] Calls AMM.depositFees correctly
  - [ ] AMM reserve balance increases
  - [ ] AMM spot price increases

**Files:**
- `test/UsageFeeRouter.test.js`

---

### Task 2.4: Integration Tests
**Priority:** P1
**Estimated:** 6 hours
**Dependencies:** Tasks 1.1, 1.2, 1.3

**Test Scenarios:**
- [ ] **End-to-End Revenue Flow:**
  - [ ] Deploy all contracts
  - [ ] Deploy token with 80/20 split
  - [ ] Deposit $100 API revenue
  - [ ] Verify $80 in InfrastructureReserve
  - [ ] Verify $20 added to AMM reserve
  - [ ] Verify token price increased
- [ ] **Infrastructure Payment Flow:**
  - [ ] Accrue $500 from API fees
  - [ ] Pay $300 to provider
  - [ ] Verify balance is $200
  - [ ] Verify paid tracking is correct
  - [ ] Verify invoice hash recorded
- [ ] **Governance Adjustment Flow:**
  - [ ] Token deployed with 80/20 split
  - [ ] Deposit $100 (expect 80/20)
  - [ ] Governance changes to 70/30
  - [ ] Deposit $100 (expect 70/30)
  - [ ] Verify both deposits routed correctly
- [ ] **Multiple Models:**
  - [ ] Model A: 80/20 split
  - [ ] Model B: 90/10 split
  - [ ] Batch deposit for both
  - [ ] Verify each gets correct split
  - [ ] Verify independent accounting
- [ ] **Accrual Health Monitoring:**
  - [ ] Accrue $1000
  - [ ] Pay $700
  - [ ] Check runway with $50/day burn
  - [ ] Verify runway = 6 days
- [ ] **AMM Price Impact:**
  - [ ] Record initial spot price
  - [ ] Deposit $100 profit to AMM
  - [ ] Verify spot price increased
  - [ ] Calculate expected price increase
  - [ ] Verify matches formula

**Files:**
- `test/integration/InfrastructureFlow.test.js`

---

## Week 3: Deployment & Documentation

### Task 3.1: Deployment Scripts
**Priority:** P0
**Estimated:** 6 hours
**Dependencies:** All testing complete

**Subtasks:**
- [ ] **Deploy InfrastructureReserve:**
  - [ ] Create `scripts/deploy-infrastructure-reserve.js`
  - [ ] Accept command-line args: USDC address, factory address, treasury address
  - [ ] Deploy contract
  - [ ] Verify constructor arguments
  - [ ] Save deployment address
  - [ ] Log deployment info
- [ ] **Deploy UsageFeeRouter:**
  - [ ] Create `scripts/deploy-usage-fee-router-v2.js`
  - [ ] Accept args: factory, USDC, infraReserve address
  - [ ] Deploy contract
  - [ ] Verify no protocolFeeBps parameter
  - [ ] Save deployment address
  - [ ] Log deployment info
- [ ] **Initialize Contracts:**
  - [ ] Create `scripts/initialize-infrastructure-system.js`
  - [ ] Grant DEPOSITOR_ROLE on InfrastructureReserve to UsageFeeRouter
  - [ ] Grant PAYER_ROLE to treasury multisig
  - [ ] Grant FEE_DEPOSITOR_ROLE on router to backend service
  - [ ] Verify all roles set correctly
  - [ ] Log role assignments
- [ ] **Deploy New HokusaiParams:**
  - [ ] Update `scripts/deploy-token.js` to use new params
  - [ ] Default infrastructureAccrualBps = 8000
  - [ ] Remove infraMarkupBps parameter
- [ ] **Configuration Files:**
  - [ ] Create `deployments/sepolia-infrastructure.json`
  - [ ] Create `deployments/mainnet-infrastructure.json` (template)
  - [ ] Include all contract addresses
  - [ ] Include role assignments
  - [ ] Include default parameters
- [ ] **Verification Scripts:**
  - [ ] Create `scripts/verify-infrastructure-deployment.js`
  - [ ] Check all contracts deployed
  - [ ] Check all roles granted
  - [ ] Check InfrastructureReserve has USDC approval from router
  - [ ] Check router has correct immutable addresses

**Acceptance Criteria:**
- ✅ All scripts run without errors
- ✅ Testnet deployment successful
- ✅ Roles correctly assigned
- ✅ Contracts verified on Etherscan
- ✅ Configuration saved for future reference

**Files:**
- `scripts/deploy-infrastructure-reserve.js`
- `scripts/deploy-usage-fee-router-v2.js`
- `scripts/initialize-infrastructure-system.js`
- `scripts/verify-infrastructure-deployment.js`
- `deployments/sepolia-infrastructure.json`

---

### Task 3.2: Documentation
**Priority:** P1
**Estimated:** 6 hours
**Dependencies:** Task 3.1

**Subtasks:**
- [ ] **Infrastructure Accrual Guide:**
  - [ ] Create `docs/infrastructure-accrual.md`
  - [ ] Explain two-reserve system
  - [ ] Document revenue flow with diagrams
  - [ ] Explain accrual rate semantics
  - [ ] Show example calculations
  - [ ] Document view functions for monitoring
- [ ] **Governance Guide:**
  - [ ] Update `docs/governance-guide.md`
  - [ ] Add section on infrastructure accrual management
  - [ ] Document setInfrastructureAccrualBps function
  - [ ] Explain implications of changing rate
  - [ ] Show recommended ranges per model type
  - [ ] Add decision framework for governance
- [ ] **Payment Guide (Admin):**
  - [ ] Create `docs/infrastructure-payments.md`
  - [ ] Document payment process step-by-step
  - [ ] Explain invoice hash requirement
  - [ ] Show batch payment examples
  - [ ] Document emergency procedures
  - [ ] Include multisig workflow
- [ ] **Event Schemas:**
  - [ ] Create `docs/event-schemas.md`
  - [ ] Document all new events
  - [ ] Include example event data
  - [ ] Explain indexed fields
  - [ ] Show filtering/querying examples
- [ ] **Architecture Documentation:**
  - [ ] Update `docs/architecture.md`
  - [ ] Add infrastructure reserve component
  - [ ] Update data flow diagrams
  - [ ] Document contract interactions
  - [ ] Add sequence diagrams
- [ ] **README Updates:**
  - [ ] Update main README.md
  - [ ] Add infrastructure system to contract list
  - [ ] Link to new documentation
  - [ ] Update architecture overview
- [ ] **Example Scripts:**
  - [ ] Create `examples/deposit-api-fees.js`
  - [ ] Create `examples/pay-infrastructure-cost.js`
  - [ ] Create `examples/check-accrual-health.js`
  - [ ] Create `examples/adjust-accrual-rate.js`

**Files:**
- `docs/infrastructure-accrual.md`
- `docs/governance-guide.md`
- `docs/infrastructure-payments.md`
- `docs/event-schemas.md`
- `docs/architecture.md`
- `README.md`
- `examples/*.js`

---

### Task 3.3: Monitoring & Analytics (Optional P2)
**Priority:** P2
**Estimated:** 4 hours
**Dependencies:** Task 3.1

**Subtasks:**
- [ ] **Dune Analytics Queries:**
  - [ ] Query: Total infrastructure accrued per model
  - [ ] Query: Total infrastructure paid per model
  - [ ] Query: Accrual runway by model
  - [ ] Query: Infrastructure vs profit split over time
  - [ ] Query: Payment history with invoice hashes
  - [ ] Dashboard: Per-model accounting overview
- [ ] **Monitoring Setup:**
  - [ ] Create `monitoring/alerts.md`
  - [ ] Define alert thresholds (e.g., runway < 7 days)
  - [ ] Document alert setup for team
  - [ ] Include webhook/notification options
- [ ] **Analytics Documentation:**
  - [ ] Create `monitoring/README.md`
  - [ ] Link to Dune dashboards
  - [ ] Explain metrics and KPIs
  - [ ] Document how to interpret data

**Files:**
- `monitoring/dune-queries/*.sql`
- `monitoring/alerts.md`
- `monitoring/README.md`

---

## Summary

### Total Estimated Time
- **Week 1 (Implementation):** 18 hours
- **Week 2 (Testing):** 23 hours
- **Week 3 (Deployment & Docs):** 16 hours
- **Total:** ~57 hours (~1.5 weeks of full-time work)

### Critical Path
1. HokusaiParams updates (Task 1.1)
2. InfrastructureReserve creation (Task 1.2)
3. UsageFeeRouter modifications (Task 1.3)
4. All testing (Tasks 2.1-2.4)
5. Deployment (Task 3.1)
6. Documentation (Task 3.2)

### Risk Mitigation
- **Testing Coverage:** >95% coverage on all new contracts
- **Security:** Full audit of CEI patterns, access control, reentrancy protection
- **Integration:** Comprehensive integration tests before deployment
- **Documentation:** Complete before mainnet deployment

### Success Criteria
- ✅ All P0 tasks completed
- ✅ >95% test coverage
- ✅ Successful Sepolia deployment
- ✅ Documentation reviewed and approved
- ✅ Stakeholder sign-off
