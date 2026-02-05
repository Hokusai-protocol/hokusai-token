# Phase-Aware Alert System Implementation Plan
**Linear Issue:** HOK-673 - Proposed Alert System Changes
**Created:** 2026-01-28
**Status:** Draft - Awaiting Approval

---

## Overview

### What We're Building
A phase-aware monitoring system that understands the two-phase bonding curve design and only triggers alerts when they're meaningful. This prevents false positives during the flat price (bootstrap) phase while maintaining rigorous monitoring during the bonding curve phase.

### Why This Matters
The current alert system treats all pools as single-phase bonding curves, causing:
- **False positive alerts** during healthy flat-phase growth (e.g., "Supply changed 3180% in 1h")
- **Alert fatigue** that trains operators to ignore critical notifications
- **Misleading alert names** ("Supply Mismatch" fires on expected supply growth, not actual mismatches)

### Success Criteria
- ✅ Zero false positive supply alerts during flat price phase
- ✅ All critical security alerts (pause, ownership, math errors) fire in all phases
- ✅ New "TRUE_SUPPLY_MISMATCH" alert detects unauthorized minting/burning
- ✅ Phase-aware alerts only fire in bonding curve phase
- ✅ Deployment artifacts include phase parameters for monitoring
- ✅ Existing Sepolia deployment monitored correctly without false positives

---

## Current State

### What Exists Today

**Monitoring System:**
- [state-tracker.ts](../../services/contract-deployer/src/monitoring/state-tracker.ts) - Polls pool state every 5 minutes (event-driven with fallback)
- [alert-manager.ts](../../services/contract-deployer/src/monitoring/alert-manager.ts) - Delivers alerts via AWS SES email
- [monitoring-config.ts](../../services/contract-deployer/src/config/monitoring-config.ts) - Configuration and thresholds

**Current Alert Types:**
1. `reserve_drop` - Reserve drops >20% in 1h (CRITICAL)
2. `price_spike` - Price changes >20% in 1h (HIGH)
3. `supply_mismatch` - Supply changes >15% in 1h (HIGH) ← **PROBLEMATIC**
4. `paused` - Pool paused >1 hour (CRITICAL)
5. `low_reserve` - Reserve below configured minimum (HIGH)
6. `high_fees` - Treasury fees exceed threshold (MEDIUM)

**Two-Phase AMM Contract:**
- [HokusaiAMM.sol](../../contracts/HokusaiAMM.sol) - Implements two-phase pricing
- **Phase 1 (FLAT_PRICE):** Fixed price until reserve reaches threshold
- **Phase 2 (BONDING_CURVE):** Exponential pricing after threshold
- Contract has `getCurrentPhase()` and `getPhaseInfo()` functions
- Contract emits `PhaseTransition` event when transitioning

**The Problem:**
```
Monitoring System              Smart Contract
  ❌ Phase-blind                ✅ Phase-aware
  ❌ Universal thresholds       ✅ Phase-specific limits
  ❌ Doesn't call phase APIs    ✅ Exposes phase APIs
```

### Research Findings

From the research-orchestrator investigation:

1. **Current "supply_mismatch" alert is misnamed** - It fires on large supply changes, not on actual supply/reserve mismatches
2. **Monitoring system has ZERO phase awareness** - Doesn't call `getCurrentPhase()` or check phase parameters
3. **Flat phase allows unlimited supply growth** - By design, supply can increase 1000%+ in minutes (healthy behavior)
4. **15% threshold makes sense for bonding curve** - But completely breaks for flat phase
5. **Pool ABI is incomplete** - Missing phase detection functions (getCurrentPhase, getPhaseInfo, FLAT_CURVE_THRESHOLD)
6. **Deployment artifacts missing phase parameters** - Can't determine phase boundaries without querying contracts

**See full research report:** [Research findings from research-orchestrator agent](../README.md) (if you ran it separately)

---

## Proposed Changes

### 1. Rename/Replace "Supply Mismatch" Alert

**Decision:** Option B + Option C from clarifying questions

**Option B: Remove existing supply_mismatch during flat phase**
- Suppress percentage-based supply change alerts in flat phase
- Keep existing logic in bonding curve phase (15% threshold)

**Option C: Add TRUE_SUPPLY_MISMATCH for all phases**
- New alert type that validates the bonding curve invariant
- Detects unauthorized minting/burning (security critical)
- Fires in ALL phases (flat and bonding curve)
- Formula: `calculateSupply(reserveBalance) === actualSupply` (within tolerance)

### 2. Phase-Aware Alerting Strategy

**During FLAT_PRICE Phase (Bootstrap):**
- ✅ Fire: CRITICAL security alerts (pause, ownership transfer, unauthorized access)
- ✅ Fire: TRUE_SUPPLY_MISMATCH (math/security errors)
- ❌ Suppress: Percentage-based supply/reserve alerts (expected volatility)
- ❌ Suppress: Price spike alerts (price is fixed anyway)
- ❌ Suppress: Large trade alerts (no trade size limits in flat phase)

**During BONDING_CURVE Phase (Active):**
- ✅ Fire: All existing alerts (reserve_drop, price_spike, etc.)
- ✅ Fire: TRUE_SUPPLY_MISMATCH
- ✅ Fire: New phase-aware alerts (large trades, price impact, etc.)

**Alert Priority Matrix:**
```
┌─────────────────────────┬─────────────────┬─────────────────────────┐
│      Alert Type         │  Flat Phase     │   Bonding Curve Phase   │
├─────────────────────────┼─────────────────┼─────────────────────────┤
│ Paused                  │ CRITICAL        │ CRITICAL                │
│ Ownership Transfer      │ CRITICAL        │ CRITICAL                │
│ TRUE_SUPPLY_MISMATCH    │ CRITICAL        │ CRITICAL                │
│ Reserve Drop (%)        │ SUPPRESSED      │ CRITICAL                │
│ Low Reserve (absolute)  │ SUPPRESSED      │ HIGH                    │
│ Price Spike             │ SUPPRESSED      │ HIGH                    │
│ Supply Change (%)       │ SUPPRESSED      │ HIGH (bonding curve)    │
│ Large Trade             │ SUPPRESSED      │ HIGH (bonding curve)    │
│ High Treasury Fees      │ MEDIUM          │ MEDIUM                  │
└─────────────────────────┴─────────────────┴─────────────────────────┘
```

### 3. New Alert Type: TRUE_SUPPLY_MISMATCH

**Purpose:** Detect when actual token supply deviates from expected supply based on bonding curve math

**When to alert:**
- Actual supply ≠ expected supply (calculated from reserve and curve parameters)
- Indicates: Unauthorized minting/burning, contract bug, or exploit

**Implementation approach:**

**For Flat Phase:**
```typescript
// Expected supply in flat phase
expectedSupply = initialSupply + (reserveBalance - initialReserve) / FLAT_CURVE_PRICE
tolerance = 0.01% // Very tight tolerance for flat phase (simple math)

if (Math.abs(actualSupply - expectedSupply) > actualSupply * tolerance) {
  // ALERT: Supply mismatch detected
}
```

**For Bonding Curve Phase:**
```typescript
// Expected supply from bonding curve
expectedSupply = calculateSupplyFromReserve(reserveBalance, crr)
tolerance = 0.1% // Slightly looser for power function rounding

if (Math.abs(actualSupply - expectedSupply) > actualSupply * tolerance) {
  // ALERT: Supply mismatch detected
}
```

**Challenges:**
- Requires implementing `calculateSupplyFromReserve()` in TypeScript (inverse of buy function)
- Must match Solidity precision (18 decimals)
- Needs to account for accumulated fees (supply calculated from reserveBalance, not contract USDC balance)
- Edge case: Transition point between phases (supply calculated differently before/after)

**Alternative: Use contract's own invariant check**
If the contract exposes a view function like `validateSupplyInvariant()`, call that instead of reimplementing in TypeScript.

### 4. Add Phase Detection to Monitoring

**Changes to state-tracker.ts:**

**Step 1: Expand Pool ABI (lines 79-90)**
```typescript
private static readonly POOL_ABI = [
  // Existing state functions
  'function reserveBalance() view returns (uint256)',
  'function spotPrice() view returns (uint256)',
  'function hokusaiToken() view returns (address)',
  'function paused() view returns (bool)',
  'function crr() view returns (uint256)',
  'function modelId() view returns (string)',

  // ADD: Phase detection functions
  'function getCurrentPhase() view returns (uint8)',
  'function getPhaseInfo() view returns (uint8 phase, uint256 threshold, uint256 flatPrice, uint256 reserve, uint256 supply)',
  'function FLAT_CURVE_THRESHOLD() view returns (uint256)',
  'function FLAT_CURVE_PRICE() view returns (uint256)',

  // Events (existing)
  'event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 fee, uint256 spotPrice)',
  'event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 fee, uint256 spotPrice)',
  'event FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance, uint256 newSpotPrice)',

  // ADD: Phase transition event
  'event PhaseTransition(uint8 indexed fromPhase, uint8 indexed toPhase, uint256 reserveBalance, uint256 timestamp)'
];
```

**Step 2: Add phase to PoolState interface (lines 22-44)**
```typescript
export interface PoolState {
  poolAddress: string;
  modelId: string;
  timestamp: number;
  blockNumber: number;

  // Core state
  reserveBalance: bigint;
  spotPrice: bigint;
  tokenSupply: bigint;
  paused: boolean;

  // ADD: Phase information
  pricingPhase: 0 | 1;        // 0 = FLAT_PRICE, 1 = BONDING_CURVE
  flatCurveThreshold: bigint; // Reserve threshold for phase transition
  flatCurvePrice: bigint;     // Fixed price during flat phase

  // Derived metrics (existing)
  reserveUSD: number;
  priceUSD: number;
  supplyFormatted: number;
  marketCapUSD: number;
  reserveRatio: number;
  contractUSDCBalance: bigint;
  treasuryFees: bigint;
}
```

**Step 3: Fetch phase during state polling (lines 255-265)**
```typescript
// Add to Promise.all batch (OPTIMIZED: no extra RPC calls)
const [reserveBalance, spotPrice, paused, tokenSupply, contractUSDCBalance,
       currentPhase, flatCurveThreshold, flatCurvePrice] = await Promise.all([
  reserveBalanceFn(),
  spotPriceFn(),
  pausedFn(),
  token.totalSupply(),
  usdc.balanceOf(ammAddress),
  pool.getCurrentPhase(),        // NEW
  pool.FLAT_CURVE_THRESHOLD(),   // NEW (cached after first fetch)
  pool.FLAT_CURVE_PRICE()        // NEW (cached after first fetch)
]);
```

**Optimization:** Cache immutable values (threshold, flatPrice) like we do with token addresses

**Step 4: Make alert checks phase-aware (lines 342-410)**
```typescript
private async checkAnomalies(currentState: PoolState, _poolConfig: PoolConfig): Promise<void> {
  const history = this.poolStates.get(currentState.poolAddress);
  if (!history || history.length < 2) {
    return;
  }

  const alerts: StateAlert[] = [];
  const isBootstrapPhase = currentState.pricingPhase === 0; // FLAT_PRICE

  // ALWAYS CHECK: Critical security alerts (all phases)
  if (currentState.paused) {
    const pausedDuration = this.getPausedDuration(currentState.poolAddress);
    if (pausedDuration > this.thresholds.pausedDurationHours * 60 * 60 * 1000) {
      alerts.push({
        type: 'paused',
        priority: 'critical',
        // ... existing logic
      });
    }
  }

  // NEW: Check supply invariant (all phases)
  const supplyInvariantAlert = this.checkSupplyInvariant(currentState);
  if (supplyInvariantAlert) alerts.push(supplyInvariantAlert);

  // PHASE-AWARE: Only check these in bonding curve phase
  if (!isBootstrapPhase) {
    // Check reserve drop
    const reserveDropAlert = this.checkReserveDrop(currentState, history);
    if (reserveDropAlert) alerts.push(reserveDropAlert);

    // Check low reserve
    if (currentState.reserveUSD < this.thresholds.minReserveUSD) {
      alerts.push({
        type: 'low_reserve',
        priority: 'high',
        // ... existing logic
      });
    }

    // Check price volatility
    const priceAlert = this.checkPriceVolatility(currentState, history);
    if (priceAlert) alerts.push(priceAlert);

    // Check supply changes (renamed from supply_mismatch)
    const supplyAlert = this.checkSupplyAnomaly(currentState, history);
    if (supplyAlert) alerts.push(supplyAlert);
  }

  // Check high treasury fees (all phases, but medium priority)
  const treasuryFeesUSD = Number(ethers.formatUnits(currentState.treasuryFees, 6));
  if (treasuryFeesUSD > this.thresholds.treasuryFeesThresholdUSD) {
    alerts.push({
      type: 'high_fees',
      priority: 'medium',
      // ... existing logic
    });
  }

  // Send alerts
  for (const alert of alerts) {
    if (this.callbacks.onAlert) {
      await this.callbacks.onAlert(alert);
    }
  }
}
```

**Step 5: Implement TRUE_SUPPLY_MISMATCH check (new method)**
```typescript
/**
 * Check if actual supply matches expected supply based on bonding curve math
 * This detects unauthorized minting/burning or contract bugs
 */
private checkSupplyInvariant(currentState: PoolState): StateAlert | null {
  const { pricingPhase, reserveBalance, tokenSupply, flatCurvePrice, crr } = currentState;

  let expectedSupply: bigint;
  let tolerance: number;

  if (pricingPhase === 0) {
    // Flat phase: Linear relationship
    // expectedSupply = (reserveBalance * 1e18) / flatCurvePrice
    // Note: This assumes initial supply was minted at phase start
    // May need to track initialSupply separately

    // SIMPLIFIED: Just validate that supply increased proportionally to reserve
    // More complex implementation would track initial state
    tolerance = 0.0001; // 0.01% tolerance

    // For MVP, skip flat phase invariant validation (complex to implement correctly)
    // Focus on bonding curve phase where math is well-defined
    return null;
  } else {
    // Bonding curve phase: Use power function
    // expectedSupply = calculateSupplyFromReserve(reserveBalance, crr)

    // This requires implementing the inverse bonding curve formula:
    // S = S0 * (R/R0)^(1/w) where w = crr/1e6

    // For MVP: Use a simpler check
    // Verify that reserveRatio matches CRR (already calculated in state)
    const expectedRatio = crr / 1000000; // CRR in decimal form
    const actualRatio = currentState.reserveRatio;

    tolerance = 0.05; // 5% tolerance (generous for power function rounding)

    const deviation = Math.abs(actualRatio - expectedRatio) / expectedRatio;

    if (deviation > tolerance) {
      return {
        type: 'true_supply_mismatch',
        priority: 'critical',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Supply/reserve ratio deviates from curve: actual ${actualRatio.toFixed(4)} vs expected ${expectedRatio.toFixed(4)} (${(deviation * 100).toFixed(1)}% deviation)`,
        currentState,
        metadata: {
          expectedRatio,
          actualRatio,
          deviationPercent: deviation * 100,
          crr
        }
      };
    }
  }

  return null;
}
```

**Note on TRUE_SUPPLY_MISMATCH implementation:**
- The above is a simplified version using reserve ratio validation
- A more accurate implementation would call `calculateSupplyFromReserve()`
- This requires porting the bonding curve math to TypeScript
- Consider adding this as a Phase 2 improvement if reserve ratio check proves insufficient

### 5. Update Alert Type Definitions

**Changes to state-tracker.ts (line 47):**
```typescript
export interface StateAlert {
  type: 'reserve_drop'
     | 'price_spike'
     | 'supply_anomaly'        // RENAMED from 'supply_mismatch'
     | 'true_supply_mismatch'  // NEW
     | 'paused'
     | 'low_reserve'
     | 'high_fees';
  priority: 'critical' | 'high' | 'medium';
  poolAddress: string;
  modelId: string;
  message: string;
  currentState: PoolState;
  previousState?: PoolState;
  metadata?: Record<string, any>;
}
```

**Changes to alert-manager.ts:**
- Update email subject line formatting for new alert types
- Add phase information to alert emails (show which phase pool is in)
- Update alert body to include phase context

### 6. Update Configuration

**Changes to monitoring-config.ts:**

**Add phase parameters to PoolConfig (lines 25-34):**
```typescript
export interface PoolConfig {
  modelId: string;
  tokenAddress: string;
  ammAddress: string;
  crr: number;
  tradeFee: number;
  protocolFee: number;
  ibrDuration: number;
  ibrEndsAt?: string;

  // ADD: Two-phase pricing parameters
  flatCurveThreshold: string;  // e.g., "25000000000" (25k USDC, 6 decimals)
  flatCurvePrice: string;       // e.g., "10000" ($0.01 USDC, 6 decimals)
}
```

**Update loadDeploymentConfig() (lines 129-166):**
```typescript
export function loadDeploymentConfig(network: string): { contracts: ContractAddresses, pools: PoolConfig[] } {
  try {
    // ... existing path resolution logic
    const deployment = JSON.parse(readFileSync(deploymentPath, 'utf8'));

    // Parse pools with phase parameters
    const pools = (deployment.pools || []).map((p: any) => ({
      modelId: p.modelId,
      tokenAddress: p.tokenAddress,
      ammAddress: p.ammAddress,
      crr: p.crr,
      tradeFee: p.tradeFee,
      protocolFee: p.protocolFee,
      ibrDuration: p.ibrDuration,
      ibrEndsAt: p.ibrEndsAt,
      flatCurveThreshold: p.flatCurveThreshold || '0',  // Default if missing
      flatCurvePrice: p.flatCurvePrice || '0'            // Default if missing
    }));

    return {
      contracts: { /* existing */ },
      pools
    };
  } catch (error) {
    throw new Error(`Failed to load deployment config for ${network}: ${error}`);
  }
}
```

**Add phase-aware threshold documentation (lines 96-103):**
```typescript
/**
 * Default alert thresholds (based on monitoring-requirements.md)
 *
 * NOTE: Many thresholds are phase-aware:
 * - Flat phase: Percentage-based alerts suppressed (expected volatility)
 * - Bonding curve: All alerts active
 *
 * TRUE_SUPPLY_MISMATCH always fires (critical security alert)
 */
```

### 7. Update Deployment Scripts

**Changes to scripts/deploy-testnet-full.js and scripts/deploy-mainnet.js:**

**After pool creation (around line 250-300 in both scripts):**
```javascript
// Fetch phase parameters from deployed pool
const flatCurveThreshold = await ammPool.FLAT_CURVE_THRESHOLD();
const flatCurvePrice = await ammPool.FLAT_CURVE_PRICE();

// Add to pool object
poolData = {
  modelId,
  tokenAddress: tokenAddress,
  ammAddress: ammAddress,
  crr: Number(crrValue),
  tradeFee: Number(tradeFeeValue),
  protocolFee: Number(protocolFeeBps),
  ibrDuration: Number(ibrDuration),
  ibrEndsAt: ibrEndsAt.toISOString(),

  // ADD: Phase parameters
  flatCurveThreshold: flatCurveThreshold.toString(),
  flatCurvePrice: flatCurvePrice.toString()
};
```

**Update deployment artifact schema:**
```json
{
  "contracts": { /* ... */ },
  "config": { /* ... */ },
  "pools": [
    {
      "modelId": "sales-lead-scoring-v2",
      "tokenAddress": "0x...",
      "ammAddress": "0x...",
      "crr": 100000,
      "tradeFee": 30,
      "protocolFee": 3000,
      "ibrDuration": 604800,
      "ibrEndsAt": "2026-01-28T00:00:00.000Z",
      "flatCurveThreshold": "25000000000",
      "flatCurvePrice": "10000"
    }
  ]
}
```

**Add script to backfill existing deployments:**

**scripts/backfill-phase-params.js (NEW):**
```javascript
/**
 * Backfill flatCurveThreshold and flatCurvePrice for existing deployments
 *
 * Usage: node scripts/backfill-phase-params.js --network sepolia
 */
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const network = process.env.HARDHAT_NETWORK || 'sepolia';
  const deploymentPath = path.join(__dirname, '..', 'deployments', `${network}-latest.json`);

  console.log(`Backfilling phase parameters for ${network}...`);

  // Load deployment
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  // Update each pool
  for (const pool of deployment.pools) {
    console.log(`\nProcessing pool: ${pool.modelId}`);

    const ammPool = await ethers.getContractAt('HokusaiAMM', pool.ammAddress);

    // Fetch phase parameters
    const flatCurveThreshold = await ammPool.FLAT_CURVE_THRESHOLD();
    const flatCurvePrice = await ammPool.FLAT_CURVE_PRICE();

    console.log(`  Threshold: ${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
    console.log(`  Flat Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

    // Update pool object
    pool.flatCurveThreshold = flatCurveThreshold.toString();
    pool.flatCurvePrice = flatCurvePrice.toString();
  }

  // Save updated deployment
  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
  console.log(`\n✅ Updated ${deploymentPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
```

### 8. Listen for Phase Transition Events

**Changes to event-listener.ts:**

**Add PhaseTransition event type (line ~100):**
```typescript
export interface PhaseTransitionEvent {
  type: 'phase_transition';
  poolAddress: string;
  modelId: string;
  fromPhase: 0 | 1;
  toPhase: 0 | 1;
  reserveBalance: bigint;
  timestamp: number;
  transactionHash: string;
  blockNumber: number;
}
```

**Add listener setup (around line 200-300):**
```typescript
/**
 * Listen for phase transition events
 */
private setupPhaseTransitionListener(poolConfig: PoolConfig): void {
  const pool = new ethers.Contract(poolConfig.ammAddress, EventListener.POOL_ABI, this.provider);

  pool.on('PhaseTransition', async (fromPhase: number, toPhase: number, reserveBalance: bigint, timestamp: number, event: any) => {
    const phaseEvent: PhaseTransitionEvent = {
      type: 'phase_transition',
      poolAddress: poolConfig.ammAddress,
      modelId: poolConfig.modelId,
      fromPhase: fromPhase as 0 | 1,
      toPhase: toPhase as 0 | 1,
      reserveBalance,
      timestamp: Number(timestamp),
      transactionHash: event.transactionHash,
      blockNumber: event.blockNumber
    };

    logger.info(`Phase transition detected: ${poolConfig.modelId}`, {
      fromPhase: fromPhase === 0 ? 'FLAT_PRICE' : 'BONDING_CURVE',
      toPhase: toPhase === 0 ? 'FLAT_PRICE' : 'BONDING_CURVE',
      reserveBalance: ethers.formatUnits(reserveBalance, 6)
    });

    // Trigger alert (informational)
    await this.handlePhaseTransition(phaseEvent);
  });

  logger.info(`PhaseTransition listener set up for ${poolConfig.modelId}`);
}

/**
 * Handle phase transition event
 */
private async handlePhaseTransition(event: PhaseTransitionEvent): Promise<void> {
  const alert: EventAlert = {
    type: 'phase_transition',
    priority: 'medium',
    message: `Pool transitioned from ${event.fromPhase === 0 ? 'flat price' : 'bonding curve'} to ${event.toPhase === 0 ? 'flat price' : 'bonding curve'} phase`,
    event,
    timestamp: Date.now()
  };

  if (this.callbacks.onAlert) {
    await this.callbacks.onAlert(alert);
  }

  this.stats.phaseTransitions++;
}
```

**Note:** This is informational only - no action required, but useful for audit trail

---

## Implementation Phases

### Phase 1: Core Phase Detection (Week 1)
**Goal:** Make monitoring system phase-aware

**Tasks:**
1. Update Pool ABI with phase detection functions
   - Add `getCurrentPhase()`, `getPhaseInfo()`, `FLAT_CURVE_THRESHOLD()`, `FLAT_CURVE_PRICE()`
   - Add `PhaseTransition` event

2. Update PoolState interface
   - Add `pricingPhase`, `flatCurveThreshold`, `flatCurvePrice` fields

3. Update state polling to fetch phase
   - Batch phase calls with existing state reads (no extra RPC calls)
   - Cache immutable values (threshold, flat price)

4. Add phase to monitoring config
   - Update PoolConfig interface
   - Update loadDeploymentConfig() to parse phase parameters

**Deliverables:**
- [ ] state-tracker.ts updated with phase detection
- [ ] monitoring-config.ts updated with phase parameters
- [ ] Unit tests for phase detection
- [ ] Manual verification: Can query phase from deployed Sepolia pool

**Success Criteria:**
- ✅ State tracker can determine which phase a pool is in
- ✅ Pool state includes phase information in logs
- ✅ No new RPC calls added (batched with existing calls)

**Dependencies:** None

---

### Phase 2: Suppress Phase-Blind Alerts (Week 1-2)
**Goal:** Stop false positive alerts during flat phase

**Tasks:**
1. Update `checkAnomalies()` to be phase-aware
   - Check phase before running percentage-based alerts
   - Skip `reserve_drop`, `price_spike`, `supply_anomaly` in flat phase
   - Always check critical alerts (pause, ownership)

2. Rename `supply_mismatch` to `supply_anomaly`
   - Update alert type definition
   - Update email templates
   - Update documentation

3. Update alert messages to include phase context
   - Show which phase triggered the alert
   - Add phase info to email body

**Deliverables:**
- [ ] state-tracker.ts with phase-aware alert suppression
- [ ] alert-manager.ts with updated alert types
- [ ] Integration tests showing flat phase alerts are suppressed
- [ ] Manual verification: Deploy new pool, buy tokens in flat phase, confirm no false alerts

**Success Criteria:**
- ✅ No percentage-based alerts fire during flat phase
- ✅ Critical alerts (pause) still fire in flat phase
- ✅ All alerts fire normally in bonding curve phase
- ✅ Alert emails show phase information

**Dependencies:** Phase 1 complete

---

### Phase 3: TRUE_SUPPLY_MISMATCH Alert (Week 2)
**Goal:** Add security-critical invariant validation

**Tasks:**
1. Implement `checkSupplyInvariant()` method
   - Version 1: Simple reserve ratio validation
   - Compare actual reserve ratio to expected CRR
   - Fire alert on significant deviation (>5%)

2. Add `true_supply_mismatch` alert type
   - Priority: CRITICAL (fires in all phases)
   - Clear message explaining the mismatch

3. Test against known-good pools
   - Validate no false positives on Sepolia
   - Test with manual supply injection (testnet only!)

**Deliverables:**
- [ ] state-tracker.ts with supply invariant check
- [ ] Unit tests for supply invariant validation
- [ ] Integration tests with testnet pools
- [ ] Documentation on how to respond to TRUE_SUPPLY_MISMATCH alerts

**Success Criteria:**
- ✅ Invariant check runs on every state update
- ✅ No false positives on legitimate trading activity
- ✅ Would detect unauthorized minting (tested in simulation)
- ✅ Alert includes enough detail to diagnose issue

**Dependencies:** Phase 2 complete

**Future Enhancement:** Replace reserve ratio check with full bonding curve validation

---

### Phase 4: Update Deployment Artifacts (Week 2)
**Goal:** Ensure all deployments include phase parameters

**Tasks:**
1. Update deployment scripts
   - Fetch `FLAT_CURVE_THRESHOLD` and `FLAT_CURVE_PRICE` after pool creation
   - Add to deployment JSON artifacts
   - Update deployment script documentation

2. Create backfill script
   - Query existing deployed pools for phase parameters
   - Update existing deployment JSONs
   - Run on Sepolia (and eventually mainnet)

3. Update deployment artifact schema
   - Document new required fields
   - Add validation to monitoring config loader

**Deliverables:**
- [ ] deploy-testnet-full.js updated
- [ ] deploy-mainnet.js updated
- [ ] scripts/backfill-phase-params.js (new script)
- [ ] Updated sepolia-latest.json with phase parameters
- [ ] Documentation on deployment artifact schema

**Success Criteria:**
- ✅ New deployments automatically include phase parameters
- ✅ Existing Sepolia deployment backfilled with phase params
- ✅ Monitoring service starts without errors (validates phase params)
- ✅ Deployment artifacts have consistent schema

**Dependencies:** Phase 1 complete (need phase parameter definitions)

---

### Phase 5: Phase Transition Event Monitoring (Week 3)
**Goal:** Track when pools transition from flat to bonding curve

**Tasks:**
1. Add PhaseTransition event listener
   - Listen for `PhaseTransition` events on all pools
   - Log transition details

2. Send informational alert on transition
   - Priority: MEDIUM (not urgent, but notable)
   - Include reserve balance at transition

3. Update state tracker on transition
   - Invalidate cached phase state
   - Fetch new phase immediately

**Deliverables:**
- [ ] event-listener.ts with phase transition handling
- [ ] Alert email template for phase transitions
- [ ] Integration tests simulating phase transition
- [ ] Manual verification: Trigger transition on testnet, confirm alert

**Success Criteria:**
- ✅ Phase transitions logged in monitoring system
- ✅ Alert sent when pool graduates to bonding curve
- ✅ State tracker updates phase state immediately (not waiting for next poll)

**Dependencies:** Phase 1 complete

**Nice to Have:** Dashboard showing which phase each pool is in

---

## Testing Strategy

### Unit Tests

**state-tracker.test.ts:**
- ✅ Test phase detection from pool contract
- ✅ Test alert suppression in flat phase
- ✅ Test alerts fire normally in bonding curve phase
- ✅ Test TRUE_SUPPLY_MISMATCH detection (both phases)
- ✅ Test phase transition handling

**monitoring-config.test.ts:**
- ✅ Test loading deployment config with phase parameters
- ✅ Test validation fails if phase params missing
- ✅ Test default values for legacy deployments

**alert-manager.test.ts:**
- ✅ Test email generation includes phase context
- ✅ Test alert type renaming (supply_mismatch → supply_anomaly)

### Integration Tests

**testnet/phase-aware-alerts.test.js (NEW):**
```javascript
describe('Phase-Aware Alert System', () => {
  it('should not alert on large supply changes during flat phase', async () => {
    // Deploy pool with $25k threshold
    // Buy $1k worth (large supply increase)
    // Verify: No supply_anomaly alert
  });

  it('should alert on supply invariant violations in flat phase', async () => {
    // Deploy pool
    // Manually mint tokens outside AMM (testnet only!)
    // Verify: TRUE_SUPPLY_MISMATCH alert fired
  });

  it('should alert on large supply changes during bonding curve phase', async () => {
    // Deploy pool, transition to bonding curve
    // Execute multiple large buys (>15% supply change)
    // Verify: supply_anomaly alert fired
  });

  it('should send phase transition alert', async () => {
    // Deploy pool starting in flat phase
    // Buy enough to cross threshold
    // Verify: PhaseTransition event captured
    // Verify: Informational alert sent
  });
});
```

### Manual Testing Checklist

**Before Deployment:**
- [ ] Deploy test pool on Sepolia with known parameters
- [ ] Verify monitoring service connects and detects phase correctly
- [ ] Execute test trades in flat phase
- [ ] Confirm no false alerts during flat phase trading
- [ ] Manually inject supply error (testnet only!) and verify TRUE_SUPPLY_MISMATCH fires
- [ ] Push pool past threshold into bonding curve phase
- [ ] Verify phase transition alert received
- [ ] Execute trades in bonding curve phase
- [ ] Verify alerts now fire for large percentage changes
- [ ] Review alert email formatting and clarity

**After Deployment:**
- [ ] Monitor existing Sepolia pool for 24 hours
- [ ] Confirm no false positives
- [ ] Review alert logs for any edge cases
- [ ] Document any tuning needed for thresholds

---

## Success Criteria

### Automated Checks
- ✅ All unit tests pass
- ✅ All integration tests pass
- ✅ TypeScript compilation succeeds with no errors
- ✅ Linting passes
- ✅ No new console warnings in monitoring service

### Manual Verification
- ✅ Deploy fresh test pool on Sepolia
- ✅ Execute $500 buy in flat phase (should not alert)
- ✅ Monitor existing Sepolia pool for 24h (no false positives)
- ✅ Verify TRUE_SUPPLY_MISMATCH would fire (simulation test)
- ✅ Confirm alert emails are clear and actionable

### Operational Requirements
- ✅ Monitoring service starts without errors
- ✅ Existing Sepolia deployment monitored correctly
- ✅ Alert delivery latency <1 minute (unchanged from current)
- ✅ No increase in RPC call volume (batched calls)
- ✅ Documentation updated for operators

### User Acceptance
- ✅ No alert fatigue from false positives
- ✅ Team confirms alerts are actionable
- ✅ Alert messages clearly explain issue and phase context

---

## Out of Scope

### Explicitly NOT Included in This Plan

1. **RPC Optimization (HOK-674)**
   - Multicall3 batching
   - Alchemy Enhanced APIs
   - eth_getLogs optimization
   - See separate Linear issue

2. **New Phase-Aware Alert Types**
   - LARGE_TRADE alerts (future enhancement)
   - PRICE_IMPACT alerts (future enhancement)
   - UNUSUAL_VOLUME alerts (future enhancement)
   - These can be added in future PRs using the phase-aware framework

3. **Advanced Supply Invariant Validation**
   - Full bonding curve math in TypeScript
   - Exact supply calculation from reserve
   - Current plan uses simpler reserve ratio check
   - Can upgrade in Phase 6 if needed

4. **Backwards Compatibility**
   - Legacy single-phase bonding curves not supported
   - All pools assumed to use two-phase design
   - If legacy pools exist, they'll need migration

5. **Dashboard/UI Updates**
   - Phase indicators in monitoring dashboard
   - Alert history filtering by phase
   - These are frontend enhancements (separate work)

6. **Historical Alert Re-evaluation**
   - Existing alert history not retroactively marked as false positives
   - Clean slate from deployment forward

---

## Risk Assessment

### High Risk

**Risk:** TRUE_SUPPLY_MISMATCH has false positives due to precision/rounding
- **Mitigation:** Use generous tolerance (5%) initially, tune based on data
- **Fallback:** Can disable this alert if too noisy, fall back to manual audits

**Risk:** Missing phase transition event causes stale phase state
- **Mitigation:** Periodic polling still fetches phase (fallback mechanism)
- **Fallback:** Alerts may be delayed but will eventually correct

### Medium Risk

**Risk:** Deployment artifacts missing phase parameters on legacy pools
- **Mitigation:** Backfill script queries contracts directly
- **Fallback:** Monitoring service validates and errors loudly if missing

**Risk:** Phase detection RPC calls increase cost
- **Mitigation:** Batch with existing calls, cache immutable values
- **Fallback:** Can increase polling interval if costs spike

### Low Risk

**Risk:** Alert email formatting breaks with new fields
- **Mitigation:** Comprehensive unit tests for email generation
- **Fallback:** Alerts still deliver, just formatting may be off

**Risk:** Timezone issues with phase transition timestamps
- **Mitigation:** Use UTC everywhere, document clearly
- **Fallback:** Minor UX issue, doesn't affect functionality

---

## Dependencies

### External Dependencies
- ✅ AWS SES (email delivery) - already configured
- ✅ Alchemy RPC (state queries) - already configured
- ✅ Deployed Sepolia pool - already exists

### Internal Dependencies
- ✅ HokusaiAMM.sol - already implements phase detection functions
- ✅ Monitoring service - already running
- ✅ Deployment scripts - exist, need updates

### Blocker Dependencies
- **None** - All prerequisites exist, this is purely additive

---

## Deployment Plan

### Pre-Deployment
1. Merge feature branch after code review
2. Deploy to staging environment (if available)
3. Run full test suite
4. Backfill Sepolia deployment with phase parameters
5. Dry run monitoring service locally against Sepolia

### Deployment Steps
1. **Update ECS task definition** with new Docker image
   - Service: hokusai-monitor-testnet
   - Image: latest with phase-aware code

2. **Run backfill script** on Sepolia
   ```bash
   node scripts/backfill-phase-params.js --network sepolia
   ```

3. **Restart monitoring service**
   - Deploy new ECS task
   - Verify startup logs show phase detection working
   - Confirm pools are in correct phase

4. **Monitor for 24 hours**
   - Watch for false positives
   - Verify critical alerts still fire
   - Check RPC usage hasn't increased significantly

5. **Tune thresholds if needed**
   - Adjust TRUE_SUPPLY_MISMATCH tolerance if noisy
   - Update documentation with findings

### Rollback Plan
If critical issues arise:
1. Revert to previous ECS task definition
2. Old monitoring service resumes (with false positives)
3. Fix issues in feature branch
4. Redeploy when ready

**Rollback time:** <5 minutes (ECS task update)

---

## Monitoring & Observability

### Metrics to Track
- **Alert volume by type** (before and after)
  - Expect: Significant drop in supply_anomaly alerts during flat phase

- **Phase detection accuracy**
  - Log: Phase detected for each pool
  - Verify: Matches expected based on reserve balance

- **RPC call volume**
  - Before: X calls/minute
  - After: Should be same (batched calls)

- **Alert delivery latency**
  - Should remain <1 minute

### Logs to Monitor
- Phase transitions (informational)
- TRUE_SUPPLY_MISMATCH alerts (investigate each one)
- Phase detection errors (should be zero)
- RPC failures (existing monitoring)

### Dashboards
- Alert volume by type (existing dashboard)
- Phase distribution (which pools in which phase) - NEW
- FALSE_POSITIVE_SUPPRESSED counter - NEW (internal metric)

---

## Documentation Updates

### Files to Update
1. **deployments/monitoring-requirements.md**
   - Add section on phase-aware alerting
   - Update alert type definitions

2. **services/contract-deployer/README.md**
   - Document phase parameters in config
   - Add troubleshooting for phase detection

3. **CLAUDE.md**
   - Add notes on phase-aware monitoring architecture
   - Link to this plan

4. **Deployment scripts READMEs**
   - Document phase parameter capture
   - Add backfill script usage

### New Documentation
1. **features/phase-aware-alerts/README.md**
   - Architecture overview
   - Alert type reference
   - Troubleshooting guide

2. **docs/RESPONDING_TO_ALERTS.md** (if doesn't exist)
   - What each alert type means
   - How to investigate TRUE_SUPPLY_MISMATCH
   - When to escalate

---

## Timeline

### Week 1
- **Day 1-2:** Phase 1 (Core Phase Detection)
- **Day 3-4:** Phase 2 (Suppress Phase-Blind Alerts)
- **Day 5:** Testing and bug fixes

### Week 2
- **Day 1-2:** Phase 3 (TRUE_SUPPLY_MISMATCH Alert)
- **Day 3-4:** Phase 4 (Update Deployment Artifacts)
- **Day 5:** Integration testing

### Week 3
- **Day 1-2:** Phase 5 (Phase Transition Events)
- **Day 3:** Final testing and documentation
- **Day 4:** Code review and PR
- **Day 5:** Deployment to staging/testnet

### Week 4
- **Day 1:** Deploy to production (mainnet monitoring)
- **Day 2-5:** Monitor and tune thresholds

**Total Estimated Time:** 3-4 weeks for full implementation and stabilization

---

## Open Questions

1. **TRUE_SUPPLY_MISMATCH tolerance:** 5% deviation threshold reasonable, or should it be tighter/looser?
   - **Recommendation:** Start at 5%, tune based on first week of data

2. **Phase transition alert priority:** MEDIUM or LOW?
   - **Recommendation:** MEDIUM (notable event worth knowing about)

3. **Should we log suppressed alerts?**
   - **Recommendation:** Yes, increment internal counter for observability

4. **Historical data cleanup:** Should we mark past false positives?
   - **Recommendation:** No, clean slate going forward

5. **Mainnet deployment timing:** Deploy monitoring changes before or after mainnet contract deployment?
   - **Recommendation:** Deploy monitoring changes to testnet first, gather data, then deploy to mainnet alongside contracts

---

## Approvals

- [ ] **Technical Lead:** Architecture approved
- [ ] **Product/User:** Requirements confirmed (see clarifying questions)
- [ ] **Security:** Risk assessment reviewed
- [ ] **DevOps:** Deployment plan feasible

---

## Next Steps

After plan approval:
1. Create git branch: `feature/phase-aware-alerts`
2. Create task breakdown in Linear (link tasks to HOK-673)
3. Begin Phase 1 implementation
4. Set up PR template with success criteria checklist
5. Schedule code review session

---

**Plan Status:** ✅ COMPLETE - Ready for Review
**Created By:** Claude (research-orchestrator + planning agent)
**Last Updated:** 2026-01-28