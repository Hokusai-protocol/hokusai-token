# Phase-Aware Alert System - Implementation Tasks

**Feature:** HOK-673 - Proposed Alert System Changes
**Plan:** [plan.md](./plan.md)
**Created:** 2026-01-28

---

## Task Overview

This document breaks down the implementation plan into specific, actionable tasks. Each task includes:
- **File(s)** to modify
- **Acceptance criteria** (when is it done?)
- **Testing requirements**
- **Estimated effort**

---

## Phase 1: Core Phase Detection

**Goal:** Make monitoring system phase-aware
**Estimated Time:** 2 days

### Task 1.1: Expand Pool ABI with Phase Detection Functions
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 79-90

**Changes:**
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

  // Existing events
  'event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 fee, uint256 spotPrice)',
  'event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 fee, uint256 spotPrice)',
  'event FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance, uint256 newSpotPrice)',

  // ADD: Phase transition event
  'event PhaseTransition(uint8 indexed fromPhase, uint8 indexed toPhase, uint256 reserveBalance, uint256 timestamp)'
];
```

**Acceptance Criteria:**
- [ ] ABI includes `getCurrentPhase()` function
- [ ] ABI includes `FLAT_CURVE_THRESHOLD()` function
- [ ] ABI includes `FLAT_CURVE_PRICE()` function
- [ ] ABI includes `PhaseTransition` event
- [ ] TypeScript compiles without errors
- [ ] Linting passes

**Testing:**
- [ ] Unit test: Can create contract instance with new ABI
- [ ] Integration test: Can call `getCurrentPhase()` on deployed Sepolia pool

**Effort:** 30 minutes

---

### Task 1.2: Update PoolState Interface
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 22-44

**Changes:**
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

**Acceptance Criteria:**
- [ ] PoolState interface includes `pricingPhase` field (0 | 1 type)
- [ ] PoolState interface includes `flatCurveThreshold` field
- [ ] PoolState interface includes `flatCurvePrice` field
- [ ] All existing code using PoolState still compiles
- [ ] TypeScript strict mode passes

**Testing:**
- [ ] Unit test: Can create PoolState object with phase fields
- [ ] Unit test: Type checking enforces 0 | 1 for pricingPhase

**Effort:** 15 minutes

---

### Task 1.3: Add Phase Parameter Caching
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 74-76

**Changes:**
```typescript
// Cache for immutable pool data (reduces RPC calls)
private tokenAddressCache: Map<string, string> = new Map(); // poolAddress -> tokenAddress
private usdcAddressCache: Map<string, string> = new Map();  // poolAddress -> usdcAddress

// ADD: Cache for immutable phase parameters
private flatCurveThresholdCache: Map<string, bigint> = new Map(); // poolAddress -> threshold
private flatCurvePriceCache: Map<string, bigint> = new Map();     // poolAddress -> flatPrice
```

**Acceptance Criteria:**
- [ ] Two new cache Maps added for phase parameters
- [ ] TypeScript compiles
- [ ] Follows existing caching pattern (tokenAddressCache, usdcAddressCache)

**Testing:**
- [ ] Unit test: Cache stores and retrieves values correctly
- [ ] Integration test: Second poll doesn't re-fetch immutable values

**Effort:** 15 minutes

---

### Task 1.4: Fetch Phase in State Polling
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 213-319 (pollPoolState method)

**Changes:**
1. Fetch phase parameters from cache or contract (after token address fetch, around line 240)
2. Add phase calls to Promise.all batch (around line 259)
3. Populate phase fields in state object (around line 286)

**Specific code locations:**

**After line 253 (after USDC address caching):**
```typescript
// Get phase parameters from cache or fetch once
let flatCurveThreshold = this.flatCurveThresholdCache.get(ammAddress);
let flatCurvePrice = this.flatCurvePriceCache.get(ammAddress);

if (!flatCurveThreshold || !flatCurvePrice) {
  // Will fetch in Promise.all below
}
```

**Update Promise.all (line 259-265):**
```typescript
const [reserveBalance, spotPrice, paused, tokenSupply, contractUSDCBalance,
       currentPhase, fetchedThreshold, fetchedPrice] = await Promise.all([
  reserveBalanceFn(),
  spotPriceFn(),
  pausedFn(),
  token.totalSupply(),
  usdc.balanceOf(ammAddress),
  pool.getCurrentPhase(),
  flatCurveThreshold ? Promise.resolve(flatCurveThreshold) : pool.FLAT_CURVE_THRESHOLD(),
  flatCurvePrice ? Promise.resolve(flatCurvePrice) : pool.FLAT_CURVE_PRICE()
]);

// Cache immutable phase parameters
if (!flatCurveThreshold) {
  this.flatCurveThresholdCache.set(ammAddress, fetchedThreshold);
  flatCurveThreshold = fetchedThreshold;
  logger.debug(`Cached flat curve threshold for ${modelId}: ${ethers.formatUnits(fetchedThreshold, 6)} USDC`);
}
if (!flatCurvePrice) {
  this.flatCurvePriceCache.set(ammAddress, fetchedPrice);
  flatCurvePrice = fetchedPrice;
  logger.debug(`Cached flat curve price for ${modelId}: $${ethers.formatUnits(fetchedPrice, 6)}`);
}
```

**Update state object (around line 286-302):**
```typescript
// Create state snapshot
const state: PoolState = {
  poolAddress: ammAddress,
  modelId,
  timestamp,
  blockNumber,
  reserveBalance,
  spotPrice,
  tokenSupply,
  paused,

  // ADD: Phase information
  pricingPhase: currentPhase as 0 | 1,
  flatCurveThreshold: flatCurveThreshold!,
  flatCurvePrice: flatCurvePrice!,

  // Derived metrics
  reserveUSD,
  priceUSD,
  supplyFormatted,
  marketCapUSD,
  reserveRatio,
  contractUSDCBalance,
  treasuryFees
};
```

**Acceptance Criteria:**
- [ ] Phase parameters fetched from cache if available
- [ ] Phase parameters fetched from contract if not cached
- [ ] Phase calls batched with existing Promise.all (no extra RPC calls)
- [ ] Phase parameters cached after first fetch
- [ ] PoolState object includes all phase fields
- [ ] Logger outputs phase info at debug level
- [ ] TypeScript compiles without errors

**Testing:**
- [ ] Unit test: First poll fetches phase params, second poll uses cache
- [ ] Integration test: Can poll Sepolia pool and get phase = 0 or 1
- [ ] Integration test: Cache reduces RPC calls (verify with mock provider)

**Effort:** 1 hour

---

### Task 1.5: Add Phase to PoolConfig Interface
**File:** `services/contract-deployer/src/config/monitoring-config.ts`
**Lines:** 25-34

**Changes:**
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

**Acceptance Criteria:**
- [ ] PoolConfig interface includes `flatCurveThreshold` field (string type)
- [ ] PoolConfig interface includes `flatCurvePrice` field (string type)
- [ ] TypeScript compiles
- [ ] All code creating PoolConfig objects updated (may break initially - that's expected)

**Testing:**
- [ ] Unit test: Can create PoolConfig with phase parameters
- [ ] Type checking enforces required fields

**Effort:** 15 minutes

---

### Task 1.6: Update loadDeploymentConfig() to Parse Phase Parameters
**File:** `services/contract-deployer/src/config/monitoring-config.ts`
**Lines:** 129-166

**Changes:**
```typescript
export function loadDeploymentConfig(network: string): { contracts: ContractAddresses, pools: PoolConfig[] } {
  try {
    // ... existing path resolution logic (lines 132-149)
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

      // ADD: Phase parameters (with defaults for legacy deployments)
      flatCurveThreshold: p.flatCurveThreshold || '0',
      flatCurvePrice: p.flatCurvePrice || '0'
    }));

    return {
      contracts: {
        modelRegistry: deployment.contracts.ModelRegistry,
        tokenManager: deployment.contracts.TokenManager,
        hokusaiParams: deployment.contracts.HokusaiParams,
        ammFactory: deployment.contracts.HokusaiAMMFactory,
        usageFeeRouter: deployment.contracts.UsageFeeRouter,
        deltaVerifier: deployment.contracts.DeltaVerifier,
        usdc: deployment.config?.usdcAddress || deployment.contracts.MockUSDC || deployment.contracts.USDC
      },
      pools
    };
  } catch (error) {
    throw new Error(`Failed to load deployment config for ${network}: ${error}`);
  }
}
```

**Acceptance Criteria:**
- [ ] Phase parameters parsed from deployment JSON
- [ ] Default values ('0') used if phase parameters missing (backwards compat)
- [ ] TypeScript compiles
- [ ] Returns PoolConfig objects with all required fields

**Testing:**
- [ ] Unit test: Loads deployment JSON with phase parameters
- [ ] Unit test: Handles missing phase parameters (defaults to '0')
- [ ] Integration test: Loads actual sepolia-latest.json without errors

**Effort:** 30 minutes

---

### Task 1.7: Add Phase Info to Config Summary
**File:** `services/contract-deployer/src/config/monitoring-config.ts`
**Lines:** 272-312 (getConfigSummary function)

**Changes:**
```typescript
export function getConfigSummary(config: MonitoringConfig): string {
  return `
Monitoring Configuration
========================
Network:        ${config.network} (Chain ID: ${config.chainId})
RPC:            ${config.rpcUrl.substring(0, 50)}...
Backup RPC:     ${config.backupRpcUrl ? 'Configured' : 'None'}

Contracts:
  ModelRegistry:    ${config.contracts.modelRegistry}
  TokenManager:     ${config.contracts.tokenManager}
  AMMFactory:       ${config.contracts.ammFactory}
  UsageFeeRouter:   ${config.contracts.usageFeeRouter}
  USDC:             ${config.contracts.usdc}

Initial Pools:    ${config.initialPools.length} pools
  ${config.initialPools.map(p => {
    const threshold = ethers.formatUnits(p.flatCurveThreshold, 6);
    const price = ethers.formatUnits(p.flatCurvePrice, 6);
    return `- ${p.modelId}: ${p.ammAddress}\n    Threshold: $${threshold}, Flat Price: $${price}`;
  }).join('\n  ')}

Alert Thresholds:
  Reserve Drop:     >${config.thresholds.reserveDropPercentage}% in 1h
  Price Change:     >${config.thresholds.priceChange1hPercentage}% in 1h
  Large Trade:      >$${config.thresholds.largeTradeUSD.toLocaleString()}
  Min Reserve:      $${config.thresholds.minReserveUSD.toLocaleString()}

Polling:
  State Interval:   ${config.statePollingIntervalMs}ms (${config.statePollingIntervalMs / 1000}s)
  Event From Block: ${config.eventPollingFromBlock}

Alerts:
  Email:            ${config.alertEmail}
  AWS SES Region:   ${config.awsSesRegion}

Features:
  Monitoring:       ${config.enabled ? 'ENABLED' : 'DISABLED'}
  Pool Discovery:   ${config.poolDiscoveryEnabled ? 'ENABLED' : 'DISABLED'}
  Event Listeners:  ${config.eventListenersEnabled ? 'ENABLED' : 'DISABLED'}
  State Polling:    ${config.statePollingEnabled ? 'ENABLED' : 'DISABLED'}
  Alerts:           ${config.alertsEnabled ? 'ENABLED' : 'DISABLED'}
========================
`;
}
```

**Acceptance Criteria:**
- [ ] Config summary includes phase parameters for each pool
- [ ] Formatted readably (threshold and flat price in USD)
- [ ] Doesn't break existing summary format

**Testing:**
- [ ] Manual test: Run monitoring service, check startup logs show phase info

**Effort:** 15 minutes

---

### Phase 1 Testing & Verification

**Unit Tests:**
```typescript
// services/contract-deployer/src/monitoring/__tests__/state-tracker.phase-detection.test.ts
describe('Phase Detection', () => {
  it('should fetch phase from contract', async () => {
    // Mock pool contract with getCurrentPhase() returning 0
    // Call pollPoolState
    // Assert: state.pricingPhase === 0
  });

  it('should cache immutable phase parameters', async () => {
    // Poll state twice
    // Assert: FLAT_CURVE_THRESHOLD called once (cached)
    // Assert: FLAT_CURVE_PRICE called once (cached)
  });

  it('should batch phase calls with state reads', async () => {
    // Poll state with mock provider
    // Count RPC calls
    // Assert: Single Promise.all batch (not sequential)
  });
});
```

**Integration Tests:**
```typescript
// services/contract-deployer/src/monitoring/__tests__/integration/phase-detection.test.ts
describe('Phase Detection Integration', () => {
  it('should detect flat phase on new Sepolia pool', async () => {
    // Connect to Sepolia RPC
    // Load deployment config
    // Poll state for sales-lead-scoring-v2 pool
    // Assert: pricingPhase is 0 or 1 (valid)
    // Assert: flatCurveThreshold > 0
  });
});
```

**Manual Verification:**
- [ ] Deploy monitoring service locally
- [ ] Point to Sepolia RPC
- [ ] Check logs show phase detection for existing pool
- [ ] Verify phase is correct (compare to pool reserve balance vs threshold)

**Phase 1 Complete When:**
- ✅ All unit tests pass
- ✅ Integration test connects to Sepolia and detects phase
- ✅ Manual verification shows phase in logs
- ✅ No increase in RPC call count (batched calls)
- ✅ TypeScript compiles with no errors
- ✅ Linting passes

---

## Phase 2: Suppress Phase-Blind Alerts

**Goal:** Stop false positive alerts during flat phase
**Estimated Time:** 1-2 days

### Task 2.1: Make checkAnomalies() Phase-Aware
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 342-410

**Changes:**
```typescript
/**
 * Check for anomalies and trigger alerts
 */
private async checkAnomalies(currentState: PoolState, _poolConfig: PoolConfig): Promise<void> {
  const history = this.poolStates.get(currentState.poolAddress);
  if (!history || history.length < 2) {
    return; // Need at least 2 states to compare
  }

  const alerts: StateAlert[] = [];
  const isBootstrapPhase = currentState.pricingPhase === 0; // FLAT_PRICE

  // Log phase for debugging
  logger.debug(`Checking anomalies for ${currentState.modelId}`, {
    phase: isBootstrapPhase ? 'FLAT_PRICE' : 'BONDING_CURVE',
    reserveUSD: currentState.reserveUSD,
    threshold: Number(ethers.formatUnits(currentState.flatCurveThreshold, 6))
  });

  // ALWAYS CHECK: Critical security alerts (all phases)

  // Check if paused
  if (currentState.paused) {
    const pausedDuration = this.getPausedDuration(currentState.poolAddress);
    if (pausedDuration > this.thresholds.pausedDurationHours * 60 * 60 * 1000) {
      alerts.push({
        type: 'paused',
        priority: 'critical',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Pool has been paused for ${(pausedDuration / (60 * 60 * 1000)).toFixed(1)} hours`,
        currentState,
        metadata: { pausedDurationMs: pausedDuration }
      });
    }
  }

  // PHASE-AWARE: Only check percentage-based alerts in bonding curve phase
  if (!isBootstrapPhase) {
    logger.debug(`Running bonding curve phase alerts for ${currentState.modelId}`);

    // Check reserve drop
    const reserveDropAlert = this.checkReserveDrop(currentState, history);
    if (reserveDropAlert) alerts.push(reserveDropAlert);

    // Check low reserve (absolute minimum)
    if (currentState.reserveUSD < this.thresholds.minReserveUSD && this.thresholds.minReserveUSD > 0) {
      alerts.push({
        type: 'low_reserve',
        priority: 'high',
        poolAddress: currentState.poolAddress,
        modelId: currentState.modelId,
        message: `Reserve below minimum: $${currentState.reserveUSD.toFixed(2)} < $${this.thresholds.minReserveUSD}`,
        currentState
      });
    }

    // Check price volatility
    const priceAlert = this.checkPriceVolatility(currentState, history);
    if (priceAlert) alerts.push(priceAlert);

    // Check supply anomaly (renamed from supply_mismatch)
    const supplyAlert = this.checkSupplyAnomaly(currentState, history);
    if (supplyAlert) alerts.push(supplyAlert);
  } else {
    logger.debug(`Suppressing percentage-based alerts for ${currentState.modelId} (flat phase)`);
  }

  // Check high treasury fees (all phases, but medium priority)
  const treasuryFeesUSD = Number(ethers.formatUnits(currentState.treasuryFees, 6));
  if (treasuryFeesUSD > this.thresholds.treasuryFeesThresholdUSD) {
    alerts.push({
      type: 'high_fees',
      priority: 'medium',
      poolAddress: currentState.poolAddress,
      modelId: currentState.modelId,
      message: `High treasury fees: $${treasuryFeesUSD.toFixed(2)} (threshold: $${this.thresholds.treasuryFeesThresholdUSD})`,
      currentState,
      metadata: { treasuryFeesUSD }
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

**Acceptance Criteria:**
- [ ] Phase checked at start of method: `isBootstrapPhase = currentState.pricingPhase === 0`
- [ ] Critical alerts (paused) always checked (outside phase conditional)
- [ ] Percentage-based alerts wrapped in `if (!isBootstrapPhase)` block
- [ ] Debug logging shows which alerts are suppressed
- [ ] TypeScript compiles

**Testing:**
- [ ] Unit test: Flat phase suppresses reserve_drop alert
- [ ] Unit test: Flat phase suppresses price_spike alert
- [ ] Unit test: Flat phase suppresses supply_anomaly alert
- [ ] Unit test: Flat phase still fires paused alert
- [ ] Unit test: Bonding curve phase fires all alerts

**Effort:** 1 hour

---

### Task 2.2: Rename supply_mismatch to supply_anomaly
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 47, 494

**Changes:**

**Line 47 (StateAlert type definition):**
```typescript
export interface StateAlert {
  type: 'reserve_drop'
     | 'price_spike'
     | 'supply_anomaly'    // CHANGED from 'supply_mismatch'
     | 'paused'
     | 'low_reserve'
     | 'high_fees';
  priority: 'critical' | 'high' | 'medium';
  // ... rest unchanged
}
```

**Line 494 (checkSupplyAnomaly return statement):**
```typescript
return {
  type: 'supply_anomaly',  // CHANGED from 'supply_mismatch'
  priority: 'high',
  // ... rest unchanged
};
```

**Acceptance Criteria:**
- [ ] Type definition uses 'supply_anomaly'
- [ ] checkSupplyAnomaly() returns 'supply_anomaly' type
- [ ] TypeScript compiles (will force updates in alert-manager.ts)

**Testing:**
- [ ] Unit test: Alert type is 'supply_anomaly' not 'supply_mismatch'

**Effort:** 15 minutes

---

### Task 2.3: Update Alert Email Subject for Renamed Alert
**File:** `services/contract-deployer/src/monitoring/alert-manager.ts`
**Lines:** 158-166

**Changes:**
```typescript
/**
 * Build email subject line
 */
private buildEmailSubject(alert: StateAlert | EventAlert): string {
  const priorityPrefix = {
    critical: '🚨 CRITICAL',
    high: '⚠️  HIGH',
    medium: '📊 MEDIUM'
  };

  const prefix = priorityPrefix[alert.priority];

  // Format alert type for display
  const alertTypeDisplay = alert.type
    .replace(/_/g, ' ')
    .replace('supply anomaly', 'SUPPLY ANOMALY')  // Explicit formatting
    .toUpperCase();

  return `${prefix}: Hokusai AMM Alert - ${alertTypeDisplay}`;
}
```

**Acceptance Criteria:**
- [ ] Email subject properly formats 'supply_anomaly' as "SUPPLY ANOMALY"
- [ ] Other alert types still format correctly
- [ ] TypeScript compiles

**Testing:**
- [ ] Unit test: buildEmailSubject() with supply_anomaly alert
- [ ] Manual test: Trigger test alert, verify email subject

**Effort:** 15 minutes

---

### Task 2.4: Add Phase Context to Alert Emails
**File:** `services/contract-deployer/src/monitoring/alert-manager.ts`
**Lines:** 251-311 (buildStateAlertDetails method)

**Changes:**
```typescript
/**
 * Build details for state alerts
 */
private buildStateAlertDetails(alert: StateAlert): string {
  const { currentState, previousState } = alert;

  // ADD: Phase information
  const phaseName = currentState.pricingPhase === 0 ? 'Flat Price (Bootstrap)' : 'Bonding Curve (Active)';
  const phaseColor = currentState.pricingPhase === 0 ? '#10B981' : '#3B82F6';

  return `
    <div class="details">
      <h3>Pool Information</h3>
      <div class="detail-row">
        <span class="detail-label">Pool Address:</span>
        <span class="detail-value">${alert.poolAddress}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Model ID:</span>
        <span class="detail-value">${alert.modelId}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Pricing Phase:</span>
        <span class="detail-value" style="color: ${phaseColor}; font-weight: bold;">${phaseName}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Phase Threshold:</span>
        <span class="detail-value">$${Number(ethers.formatUnits(currentState.flatCurveThreshold, 6)).toLocaleString()}</span>
      </div>
    </div>

    <div class="details">
      <h3>Current State</h3>
      <div class="detail-row">
        <span class="detail-label">Reserve (USD):</span>
        <span class="detail-value">$${currentState.reserveUSD.toLocaleString()}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Spot Price (USD):</span>
        <span class="detail-value">$${currentState.priceUSD.toFixed(6)}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Market Cap (USD):</span>
        <span class="detail-value">$${currentState.marketCapUSD.toLocaleString()}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Token Supply:</span>
        <span class="detail-value">${currentState.tokenSupply.toString()}</span>
      </div>
      <div class="detail-row">
        <span class="detail-label">Paused:</span>
        <span class="detail-value">${currentState.paused ? 'YES ⚠️' : 'No'}</span>
      </div>
    </div>

    ${previousState ? `
      <div class="details">
        <h3>Previous State (for comparison)</h3>
        <div class="detail-row">
          <span class="detail-label">Reserve (USD):</span>
          <span class="detail-value">$${previousState.reserveUSD.toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Spot Price (USD):</span>
          <span class="detail-value">$${previousState.priceUSD.toFixed(6)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Change:</span>
          <span class="detail-value">${this.calculateChangePercent(previousState.reserveUSD, currentState.reserveUSD)}%</span>
        </div>
      </div>
    ` : ''}
  `;
}
```

**Acceptance Criteria:**
- [ ] Alert email includes "Pricing Phase" row showing "Flat Price (Bootstrap)" or "Bonding Curve (Active)"
- [ ] Alert email includes "Phase Threshold" row showing USD value
- [ ] Phase name colored distinctly (green for flat, blue for bonding curve)
- [ ] Existing alert details still render correctly

**Testing:**
- [ ] Unit test: buildStateAlertDetails() includes phase information
- [ ] Manual test: Trigger test alert, verify email HTML

**Effort:** 30 minutes

---

### Task 2.5: Add Internal Counter for Suppressed Alerts
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** Add to class properties, update checkAnomalies()

**Changes:**

**Add to class properties (around line 63-72):**
```typescript
export class StateTracker {
  private provider: ethers.Provider;
  private thresholds: AlertThresholds;
  private callbacks: StateTrackerCallbacks;

  private poolStates: Map<string, PoolState[]> = new Map();
  private maxHistoryLength: number = 300;

  private pollingIntervals: Map<string, NodeJS.Timeout> = new Map();
  private poolContracts: Map<string, ethers.Contract> = new Map();
  private isTracking: boolean = false;

  // Cache for immutable pool data
  private tokenAddressCache: Map<string, string> = new Map();
  private usdcAddressCache: Map<string, string> = new Map();
  private flatCurveThresholdCache: Map<string, bigint> = new Map();
  private flatCurvePriceCache: Map<string, bigint> = new Map();

  // ADD: Statistics for suppressed alerts
  private suppressedAlertCount: number = 0;
  private suppressedAlertsByType: Map<string, number> = new Map();
```

**Update checkAnomalies() to count suppressions (in else block of phase check):**
```typescript
} else {
  // Bootstrap phase: Suppress percentage-based alerts
  logger.debug(`Suppressing percentage-based alerts for ${currentState.modelId} (flat phase)`);

  // Count which alerts were suppressed
  const potentialAlerts = ['reserve_drop', 'price_spike', 'supply_anomaly', 'low_reserve'];
  for (const alertType of potentialAlerts) {
    this.suppressedAlertCount++;
    this.suppressedAlertsByType.set(
      alertType,
      (this.suppressedAlertsByType.get(alertType) || 0) + 1
    );
  }
}
```

**Add getter method (end of class):**
```typescript
/**
 * Get suppressed alert statistics
 */
getSuppressedAlertStats() {
  return {
    total: this.suppressedAlertCount,
    byType: Object.fromEntries(this.suppressedAlertsByType)
  };
}
```

**Acceptance Criteria:**
- [ ] Suppressed alert counter increments in flat phase
- [ ] Counter tracks by alert type
- [ ] Getter method exposes statistics
- [ ] Statistics logged periodically (every 100 suppressions?)

**Testing:**
- [ ] Unit test: Counter increments when alerts suppressed
- [ ] Integration test: Counter accessible via getter

**Effort:** 30 minutes

---

### Phase 2 Testing & Verification

**Unit Tests:**
```typescript
// services/contract-deployer/src/monitoring/__tests__/state-tracker.phase-aware-alerts.test.ts
describe('Phase-Aware Alert Suppression', () => {
  it('should suppress reserve_drop alert in flat phase', async () => {
    // Create state with pricingPhase = 0
    // Simulate large reserve drop
    // Call checkAnomalies
    // Assert: No reserve_drop alert fired
    // Assert: Suppressed counter incremented
  });

  it('should fire reserve_drop alert in bonding curve phase', async () => {
    // Create state with pricingPhase = 1
    // Simulate large reserve drop
    // Call checkAnomalies
    // Assert: reserve_drop alert fired
  });

  it('should always fire paused alert regardless of phase', async () => {
    // Create state with paused = true, pricingPhase = 0
    // Call checkAnomalies
    // Assert: paused alert fired

    // Repeat with pricingPhase = 1
    // Assert: paused alert fired
  });
});
```

**Integration Tests:**
```typescript
// Test with real deployment
describe('Phase-Aware Alerts Integration', () => {
  it('should not alert on large trades in flat phase (Sepolia)', async () => {
    // If Sepolia pool is in flat phase
    // Monitor for 1 hour
    // Assert: No percentage-based alerts
  });
});
```

**Manual Verification:**
- [ ] Deploy monitoring service pointing to Sepolia
- [ ] Check logs for "Suppressing percentage-based alerts" messages
- [ ] Verify suppressed alert counter increases
- [ ] Check alert emails include phase information
- [ ] Confirm no false positive emails received

**Phase 2 Complete When:**
- ✅ All unit tests pass
- ✅ Integration test runs without false positives
- ✅ Manual verification shows no false alerts in flat phase
- ✅ Alert emails include phase context
- ✅ Suppressed alert statistics logged

---

## Phase 3: TRUE_SUPPLY_MISMATCH Alert

**Goal:** Add security-critical invariant validation
**Estimated Time:** 1-2 days

### Task 3.1: Add true_supply_mismatch Alert Type
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** 47

**Changes:**
```typescript
export interface StateAlert {
  type: 'reserve_drop'
     | 'price_spike'
     | 'supply_anomaly'
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

**Acceptance Criteria:**
- [ ] Alert type includes 'true_supply_mismatch'
- [ ] TypeScript compiles

**Testing:**
- [ ] Type checking passes

**Effort:** 5 minutes

---

### Task 3.2: Implement checkSupplyInvariant() Method
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Location:** Add new private method after checkSupplyAnomaly() (around line 506)

**Changes:**
```typescript
/**
 * Check if actual supply matches expected supply based on bonding curve math
 *
 * This detects:
 * - Unauthorized minting/burning outside AMM
 * - Contract bugs that violate curve invariants
 * - Exploits that manipulate supply/reserve relationship
 *
 * Approach: Validate reserve ratio matches CRR
 * Formula: actualRatio = (reserve * 1e18) / (price * supply)
 * Expected: actualRatio ≈ CRR (within tolerance)
 */
private checkSupplyInvariant(currentState: PoolState): StateAlert | null {
  const { pricingPhase, reserveBalance, tokenSupply, spotPrice, crr } = currentState;

  // Skip check if essential values are zero (pool not initialized yet)
  if (reserveBalance === 0n || tokenSupply === 0n || spotPrice === 0n) {
    return null;
  }

  // In flat phase, supply invariant is complex due to fixed pricing
  // For MVP, only validate in bonding curve phase where math is well-defined
  if (pricingPhase === 0) {
    logger.debug(`Skipping supply invariant check for ${currentState.modelId} (flat phase - complex validation)`);
    return null;
  }

  // BONDING CURVE PHASE: Validate reserve ratio
  // The reserve ratio should match CRR: R / (P * S) = w
  // Where w = CRR in decimal form (e.g., 0.1 for 10%)

  const expectedRatio = crr / 1000000; // CRR in decimal form (ppm to decimal)
  const actualRatio = currentState.reserveRatio; // Already calculated in PoolState

  // Tolerance: 5% deviation allowed
  // This accounts for:
  // - Rounding in power function calculations
  // - Small precision losses in fixed-point math
  // - Fee accumulation edge cases
  const tolerance = 0.05;

  const deviation = Math.abs(actualRatio - expectedRatio) / expectedRatio;

  if (deviation > tolerance) {
    logger.warn(`Supply invariant violation detected for ${currentState.modelId}`, {
      expectedRatio,
      actualRatio,
      deviationPercent: (deviation * 100).toFixed(2),
      reserveUSD: currentState.reserveUSD,
      supplyFormatted: currentState.supplyFormatted,
      priceUSD: currentState.priceUSD
    });

    return {
      type: 'true_supply_mismatch',
      priority: 'critical',
      poolAddress: currentState.poolAddress,
      modelId: currentState.modelId,
      message: `Supply/reserve ratio deviates from bonding curve: actual ${actualRatio.toFixed(4)} vs expected ${expectedRatio.toFixed(4)} (${(deviation * 100).toFixed(1)}% deviation). Possible unauthorized minting/burning detected.`,
      currentState,
      metadata: {
        expectedRatio,
        actualRatio,
        deviationPercent: deviation * 100,
        crr,
        reserveBalance: reserveBalance.toString(),
        tokenSupply: tokenSupply.toString(),
        spotPrice: spotPrice.toString()
      }
    };
  }

  // Invariant validated
  logger.debug(`Supply invariant OK for ${currentState.modelId}`, {
    expectedRatio: expectedRatio.toFixed(4),
    actualRatio: actualRatio.toFixed(4),
    deviation: (deviation * 100).toFixed(2) + '%'
  });

  return null;
}
```

**Acceptance Criteria:**
- [ ] Method validates reserve ratio in bonding curve phase
- [ ] Skips flat phase (returns null with debug log)
- [ ] Uses 5% tolerance threshold
- [ ] Returns CRITICAL alert on violation
- [ ] Includes detailed metadata for debugging
- [ ] Logs debug info when check passes
- [ ] TypeScript compiles

**Testing:**
- [ ] Unit test: Returns null when supply/reserve ratio within tolerance
- [ ] Unit test: Returns alert when deviation >5%
- [ ] Unit test: Skips check in flat phase (returns null)
- [ ] Unit test: Handles zero values safely

**Effort:** 1 hour

---

### Task 3.3: Call checkSupplyInvariant() in checkAnomalies()
**File:** `services/contract-deployer/src/monitoring/state-tracker.ts`
**Lines:** Around 365 (in checkAnomalies method, after paused check)

**Changes:**
```typescript
private async checkAnomalies(currentState: PoolState, _poolConfig: PoolConfig): Promise<void> {
  const history = this.poolStates.get(currentState.poolAddress);
  if (!history || history.length < 2) {
    return;
  }

  const alerts: StateAlert[] = [];
  const isBootstrapPhase = currentState.pricingPhase === 0;

  logger.debug(`Checking anomalies for ${currentState.modelId}`, {
    phase: isBootstrapPhase ? 'FLAT_PRICE' : 'BONDING_CURVE',
    reserveUSD: currentState.reserveUSD,
    threshold: Number(ethers.formatUnits(currentState.flatCurveThreshold, 6))
  });

  // ALWAYS CHECK: Critical security alerts (all phases)

  // Check if paused
  if (currentState.paused) {
    // ... existing pause check
  }

  // ADD: Check supply invariant (bonding curve phase only, but always check)
  const supplyInvariantAlert = this.checkSupplyInvariant(currentState);
  if (supplyInvariantAlert) {
    alerts.push(supplyInvariantAlert);
  }

  // PHASE-AWARE: Only check percentage-based alerts in bonding curve phase
  if (!isBootstrapPhase) {
    // ... existing percentage-based checks
  } else {
    // ... suppression logging and counting
  }

  // ... rest of method unchanged
}
```

**Acceptance Criteria:**
- [ ] checkSupplyInvariant() called before phase-aware checks
- [ ] Alert added to alerts array if returned
- [ ] Method called on every state update
- [ ] TypeScript compiles

**Testing:**
- [ ] Unit test: checkAnomalies calls checkSupplyInvariant
- [ ] Integration test: Supply invariant checked on real pool

**Effort:** 15 minutes

---

### Task 3.4: Update Alert Email for TRUE_SUPPLY_MISMATCH
**File:** `services/contract-deployer/src/monitoring/alert-manager.ts`
**Lines:** 158-166 (buildEmailSubject), 251-311 (buildStateAlertDetails)

**Changes:**

**Email subject already handles new alert type (replace underscores with spaces)**

**Add special formatting for true_supply_mismatch in buildStateAlertDetails:**
```typescript
private buildStateAlertDetails(alert: StateAlert): string {
  const { currentState, previousState } = alert;

  const phaseName = currentState.pricingPhase === 0 ? 'Flat Price (Bootstrap)' : 'Bonding Curve (Active)';
  const phaseColor = currentState.pricingPhase === 0 ? '#10B981' : '#3B82F6';

  let specialAlertInfo = '';

  // ADD: Special formatting for TRUE_SUPPLY_MISMATCH
  if (alert.type === 'true_supply_mismatch' && alert.metadata) {
    specialAlertInfo = `
      <div class="details" style="background: #FEE2E2; border-left: 4px solid #DC2626;">
        <h3 style="color: #DC2626;">⚠️  SUPPLY INVARIANT VIOLATION</h3>
        <p style="font-weight: bold; color: #991B1B;">
          This is a CRITICAL security alert. The bonding curve invariant has been violated,
          which may indicate unauthorized minting/burning or a contract exploit.
        </p>
        <div class="detail-row">
          <span class="detail-label">Expected Reserve Ratio:</span>
          <span class="detail-value">${alert.metadata.expectedRatio?.toFixed(4)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Actual Reserve Ratio:</span>
          <span class="detail-value" style="color: #DC2626; font-weight: bold;">${alert.metadata.actualRatio?.toFixed(4)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Deviation:</span>
          <span class="detail-value" style="color: #DC2626; font-weight: bold;">${alert.metadata.deviationPercent?.toFixed(2)}%</span>
        </div>
        <p style="margin-top: 16px; font-weight: bold;">
          🔍 Immediate Action Required: Investigate transaction history for unauthorized minting/burning.
        </p>
      </div>
    `;
  }

  return `
    ${specialAlertInfo}

    <div class="details">
      <h3>Pool Information</h3>
      <!-- ... existing pool info -->
    </div>

    <!-- ... rest of existing details -->
  `;
}
```

**Acceptance Criteria:**
- [ ] TRUE_SUPPLY_MISMATCH alerts have red warning box
- [ ] Alert includes expected vs actual reserve ratio
- [ ] Alert includes deviation percentage
- [ ] Alert includes action guidance
- [ ] Email is visually distinct from other alert types

**Testing:**
- [ ] Unit test: buildStateAlertDetails with true_supply_mismatch alert
- [ ] Manual test: Send test alert, verify email HTML

**Effort:** 30 minutes

---

### Task 3.5: Add Documentation on Responding to TRUE_SUPPLY_MISMATCH
**File:** `docs/RESPONDING_TO_ALERTS.md` (NEW)

**Changes:**
Create new documentation file with:

```markdown
# Responding to Hokusai AMM Alerts

## TRUE_SUPPLY_MISMATCH Alert

**Priority:** CRITICAL
**Expected Response Time:** <15 minutes

### What This Alert Means

The bonding curve invariant has been violated. The actual reserve ratio (R / P*S) deviates significantly from the configured CRR, indicating:

1. **Unauthorized token minting** - Tokens created outside the AMM
2. **Unauthorized token burning** - Tokens destroyed outside the AMM
3. **Contract bug** - Math error in bonding curve calculations
4. **Exploit in progress** - Active attack on the AMM

### Immediate Actions

1. **DO NOT PANIC** - You have time to investigate before taking drastic action
2. **Check the deviation percentage** - >10% is very suspicious, >20% is almost certainly malicious
3. **Review recent transactions** on Etherscan:
   - Look for `Transfer` events from/to zero address (minting/burning)
   - Check if `Buy` and `Sell` events correspond to supply changes
   - Look for unusual contract interactions

### Investigation Steps

#### Step 1: Check if it's a false positive
```bash
# Connect to the pool and manually verify
npx hardhat run scripts/verify-supply-invariant.js --network <mainnet|sepolia>
```

Expected output:
- Reserve balance: [value]
- Token supply: [value]
- Spot price: [value]
- Reserve ratio: [actual] (expected: [CRR])
- Deviation: [percentage]

#### Step 2: Review transaction history
```bash
# Get recent transactions for the pool
npx hardhat run scripts/get-pool-transactions.js --network <mainnet|sepolia> --pool <address> --last 100
```

Look for:
- Mint/burn events not accompanied by Buy/Sell
- Failed transactions (potential exploit attempts)
- Unusual patterns (sandwich attacks, flash loans)

#### Step 3: Check authorization
```bash
# Verify only AMM has MINTER_ROLE
npx hardhat run scripts/check-minter-role.js --network <mainnet|sepolia>
```

Expected: Only the AMM pool should have minting privileges

### Response Actions

**If deviation <10% and no suspicious transactions:**
- Likely a false positive or precision issue
- Monitor closely for 1 hour
- Tune tolerance if repeated false positives

**If deviation 10-20% OR suspicious transactions:**
- **PAUSE THE POOL IMMEDIATELY**
  ```bash
  npx hardhat run scripts/emergency-pause.js --network <mainnet|sepolia> --pool <address>
  ```
- Notify core team
- Begin forensic investigation
- Prepare incident report

**If deviation >20% OR active exploit:**
- **PAUSE ALL POOLS IMMEDIATELY**
  ```bash
  npx hardhat run scripts/emergency-pause-all.js --network <mainnet|sepolia>
  ```
- Notify core team and security auditors
- Do NOT unpause until exploit vector identified and patched
- Prepare public disclosure

### After Resolution

1. Document root cause in incident report
2. Update monitoring tolerances if false positive
3. Add test case to prevent regression
4. Review and update emergency procedures
```

**Acceptance Criteria:**
- [ ] Documentation file created
- [ ] Covers TRUE_SUPPLY_MISMATCH response
- [ ] Includes investigation steps
- [ ] Includes emergency response actions
- [ ] Clear escalation path

**Testing:**
- [ ] Manual review by team
- [ ] Test emergency scripts referenced exist

**Effort:** 1 hour

---

### Phase 3 Testing & Verification

**Unit Tests:**
```typescript
describe('TRUE_SUPPLY_MISMATCH Alert', () => {
  it('should not alert when reserve ratio within tolerance', async () => {
    // Create state with correct reserve ratio
    // Call checkSupplyInvariant
    // Assert: No alert returned
  });

  it('should alert when reserve ratio deviates >5%', async () => {
    // Create state with reserve ratio deviating 6%
    // Call checkSupplyInvariant
    // Assert: Alert returned
    // Assert: Alert priority is 'critical'
    // Assert: Metadata includes deviation details
  });

  it('should skip flat phase supply checks', async () => {
    // Create state with pricingPhase = 0
    // Even with bad reserve ratio
    // Call checkSupplyInvariant
    // Assert: No alert (returns null)
  });
});
```

**Integration Tests:**
```typescript
describe('TRUE_SUPPLY_MISMATCH Integration', () => {
  it('should validate healthy Sepolia pool', async () => {
    // Connect to Sepolia
    // Poll state for existing pool
    // Assert: No supply invariant alert
    // Assert: Reserve ratio within expected tolerance
  });

  // NOTE: Can't easily test actual violation without deploying test pool
  // and manually injecting supply error (only safe on testnet)
});
```

**Manual Verification (Testnet Only):**
- [ ] Deploy test pool on Sepolia with known parameters
- [ ] Monitor pool, confirm no alerts
- [ ] **(TESTNET ONLY)** Manually mint tokens outside AMM to violate invariant
- [ ] Verify TRUE_SUPPLY_MISMATCH alert fires
- [ ] Verify alert email includes correct deviation details
- [ ] Verify alert is CRITICAL priority

**Phase 3 Complete When:**
- ✅ All unit tests pass
- ✅ Integration test validates healthy pool
- ✅ Manual testnet validation shows alert fires on violation
- ✅ Documentation complete and reviewed
- ✅ Email formatting is clear and actionable

---

## Phase 4: Update Deployment Artifacts

**Goal:** Ensure all deployments include phase parameters
**Estimated Time:** 1-2 days

### Task 4.1: Update deploy-testnet-full.js
**File:** `scripts/deploy-testnet-full.js`
**Location:** After pool creation (around line 250-300)

**Changes:**
```javascript
// After pool is created and initial state logged
const ammPool = await ethers.getContractAt('HokusaiAMM', ammAddress);

// Fetch phase parameters from deployed pool
const flatCurveThreshold = await ammPool.FLAT_CURVE_THRESHOLD();
const flatCurvePrice = await ammPool.FLAT_CURVE_PRICE();

console.log(`\nPhase Parameters:`);
console.log(`  Flat Curve Threshold: ${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
console.log(`  Flat Curve Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

// Add to pool object
const poolData = {
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

// ... rest of deployment artifact saving
```

**Acceptance Criteria:**
- [ ] Script fetches phase parameters after pool creation
- [ ] Phase parameters logged to console
- [ ] Phase parameters added to poolData object
- [ ] Parameters saved to deployment JSON
- [ ] Script runs without errors

**Testing:**
- [ ] Dry run on Sepolia (or local hardhat)
- [ ] Verify deployment JSON includes phase parameters
- [ ] Manual inspection of saved artifact

**Effort:** 30 minutes

---

### Task 4.2: Update deploy-mainnet.js
**File:** `scripts/deploy-mainnet.js`
**Location:** After pool creation (similar to deploy-testnet-full.js)

**Changes:**
Same changes as Task 4.1, applied to mainnet deployment script.

**Acceptance Criteria:**
- [ ] Same as Task 4.1 but for mainnet script
- [ ] Includes safety confirmations (mainnet-specific)

**Testing:**
- [ ] Dry run on Sepolia (point mainnet script to testnet for testing)
- [ ] Code review by team

**Effort:** 30 minutes

---

### Task 4.3: Create backfill-phase-params.js Script
**File:** `scripts/backfill-phase-params.js` (NEW)

**Changes:**
```javascript
/**
 * Backfill flatCurveThreshold and flatCurvePrice for existing deployments
 *
 * This script:
 * 1. Loads existing deployment JSON
 * 2. Queries each pool for phase parameters
 * 3. Updates the JSON with phase parameters
 * 4. Saves updated deployment artifact
 *
 * Usage: npx hardhat run scripts/backfill-phase-params.js --network sepolia
 */
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const network = process.env.HARDHAT_NETWORK || hre.network.name;
  const deploymentPath = path.join(__dirname, '..', 'deployments', `${network}-latest.json`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backfilling Phase Parameters`);
  console.log(`Network: ${network}`);
  console.log(`Deployment: ${deploymentPath}`);
  console.log(`${'='.repeat(60)}\n`);

  // Check if deployment file exists
  if (!fs.existsSync(deploymentPath)) {
    console.error(`❌ Deployment file not found: ${deploymentPath}`);
    process.exit(1);
  }

  // Load deployment
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  if (!deployment.pools || deployment.pools.length === 0) {
    console.log('No pools found in deployment. Nothing to backfill.');
    process.exit(0);
  }

  console.log(`Found ${deployment.pools.length} pool(s) to process\n`);

  // Track updates
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Update each pool
  for (const pool of deployment.pools) {
    console.log(`Processing pool: ${pool.modelId}`);
    console.log(`  Address: ${pool.ammAddress}`);

    try {
      // Check if already has phase parameters
      if (pool.flatCurveThreshold && pool.flatCurvePrice) {
        console.log(`  ℹ️  Already has phase parameters - skipping`);
        console.log(`     Threshold: ${ethers.formatUnits(pool.flatCurveThreshold, 6)} USDC`);
        console.log(`     Price: $${ethers.formatUnits(pool.flatCurvePrice, 6)}`);
        skippedCount++;
        continue;
      }

      // Fetch phase parameters from contract
      const ammPool = await ethers.getContractAt('HokusaiAMM', pool.ammAddress);

      const flatCurveThreshold = await ammPool.FLAT_CURVE_THRESHOLD();
      const flatCurvePrice = await ammPool.FLAT_CURVE_PRICE();

      console.log(`  ✅ Fetched phase parameters:`);
      console.log(`     Threshold: ${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
      console.log(`     Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

      // Update pool object
      pool.flatCurveThreshold = flatCurveThreshold.toString();
      pool.flatCurvePrice = flatCurvePrice.toString();

      updatedCount++;
    } catch (error) {
      console.error(`  ❌ Error fetching parameters: ${error.message}`);
      errorCount++;
    }

    console.log(); // Blank line between pools
  }

  // Save updated deployment
  const backupPath = deploymentPath.replace('.json', '.backup.json');
  fs.writeFileSync(backupPath, JSON.stringify(deployment, null, 2));
  console.log(`Backup saved to: ${backupPath}`);

  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backfill Complete`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Updated: ${updatedCount} pool(s)`);
  console.log(`Skipped: ${skippedCount} pool(s) (already had parameters)`);
  console.log(`Errors:  ${errorCount} pool(s)`);
  console.log(`\n✅ Updated deployment file: ${deploymentPath}\n`);

  if (errorCount > 0) {
    console.warn('⚠️  Some pools had errors. Review logs above.');
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
```

**Acceptance Criteria:**
- [ ] Script loads existing deployment JSON
- [ ] Script queries each pool for phase parameters
- [ ] Script updates pool objects with parameters
- [ ] Script creates backup before overwriting
- [ ] Script provides clear progress output
- [ ] Script handles errors gracefully
- [ ] Script runs via `npx hardhat run`

**Testing:**
- [ ] Run on local hardhat network (test data)
- [ ] Run on Sepolia (dry run first, then real)
- [ ] Verify backup created
- [ ] Verify deployment JSON updated correctly

**Effort:** 1 hour

---

### Task 4.4: Run Backfill Script on Sepolia
**Manual Task**

**Steps:**
1. Review current sepolia-latest.json
2. Run backfill script:
   ```bash
   npx hardhat run scripts/backfill-phase-params.js --network sepolia
   ```
3. Review updated sepolia-latest.json
4. Verify phase parameters look correct
5. Commit updated deployment artifact

**Acceptance Criteria:**
- [ ] Sepolia deployment JSON includes phase parameters
- [ ] Backup file created
- [ ] Parameters match expected values from contract
- [ ] Monitoring service can load updated config

**Testing:**
- [ ] Restart monitoring service locally
- [ ] Verify service starts without errors
- [ ] Check logs show phase detection working

**Effort:** 30 minutes

---

### Task 4.5: Update Deployment Documentation
**Files:**
- `scripts/README-MAINNET-DEPLOYMENT.md`
- `deployments/testnet-deployment-guide.md`

**Changes:**

**Add section on phase parameters:**
```markdown
## Phase Parameters

All AMM pools use two-phase pricing (flat price bootstrap, then bonding curve).
Deployment artifacts must include phase parameters for monitoring.

**Automatically Captured:**
- `flatCurveThreshold` - Reserve amount where bonding curve activates (6 decimals)
- `flatCurvePrice` - Fixed price per token during flat phase (6 decimals)

These are fetched from deployed contracts and saved to deployment JSON.

**Backfilling Existing Deployments:**
If a deployment JSON is missing phase parameters, run:
```bash
npx hardhat run scripts/backfill-phase-params.js --network <sepolia|mainnet>
```

This will query deployed contracts and update the JSON.
```

**Acceptance Criteria:**
- [ ] Documentation mentions phase parameters
- [ ] Explains automatic capture in deployment scripts
- [ ] Documents backfill process
- [ ] Links to backfill script

**Testing:**
- [ ] Manual review by team

**Effort:** 30 minutes

---

### Phase 4 Testing & Verification

**Integration Tests:**
```typescript
describe('Deployment Artifact Phase Parameters', () => {
  it('should include phase parameters after deployment', async () => {
    // Run deployment script (test mode)
    // Load deployment JSON
    // Assert: pools[0].flatCurveThreshold exists
    // Assert: pools[0].flatCurvePrice exists
  });

  it('should backfill missing phase parameters', async () => {
    // Create deployment JSON without phase params
    // Run backfill script
    // Load updated JSON
    // Assert: Phase parameters now present
  });
});
```

**Manual Verification:**
- [ ] Deploy fresh pool to Sepolia using updated script
- [ ] Verify deployment JSON includes phase parameters
- [ ] Run backfill script on existing deployment
- [ ] Verify backfill works correctly
- [ ] Restart monitoring service with updated config
- [ ] Confirm service detects phase parameters

**Phase 4 Complete When:**
- ✅ Deployment scripts capture phase parameters
- ✅ Backfill script works on existing deployments
- ✅ Sepolia deployment updated with phase parameters
- ✅ Monitoring service loads phase parameters without errors
- ✅ Documentation updated

---

## Phase 5: Phase Transition Event Monitoring

**Goal:** Track when pools transition from flat to bonding curve
**Estimated Time:** 1 day

### Task 5.1: Add PhaseTransition Event Type
**File:** `services/contract-deployer/src/monitoring/event-listener.ts`
**Location:** Add after existing event types (around line 50-100)

**Changes:**
```typescript
// Existing event types...

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

// Update EventAlert type to include phase_transition
export type EventAlertType = 'large_trade' | 'unusual_gas' | 'security_event' | 'phase_transition';
```

**Acceptance Criteria:**
- [ ] PhaseTransitionEvent interface defined
- [ ] EventAlertType includes 'phase_transition'
- [ ] TypeScript compiles

**Testing:**
- [ ] Type checking passes

**Effort:** 15 minutes

---

### Task 5.2: Add PhaseTransition Event Listener
**File:** `services/contract-deployer/src/monitoring/event-listener.ts`
**Location:** Add new method in EventListener class

**Changes:**
```typescript
/**
 * Listen for phase transition events
 */
private setupPhaseTransitionListener(poolConfig: PoolConfig): void {
  const pool = new ethers.Contract(poolConfig.ammAddress, EventListener.POOL_ABI, this.provider);

  logger.info(`Setting up PhaseTransition listener for ${poolConfig.modelId}`);

  pool.on('PhaseTransition',
    async (fromPhase: bigint, toPhase: bigint, reserveBalance: bigint, timestamp: bigint, event: any) => {
      try {
        const phaseEvent: PhaseTransitionEvent = {
          type: 'phase_transition',
          poolAddress: poolConfig.ammAddress,
          modelId: poolConfig.modelId,
          fromPhase: Number(fromPhase) as 0 | 1,
          toPhase: Number(toPhase) as 0 | 1,
          reserveBalance,
          timestamp: Number(timestamp),
          transactionHash: event.log.transactionHash,
          blockNumber: event.log.blockNumber
        };

        logger.info(`🎉 Phase transition detected: ${poolConfig.modelId}`, {
          fromPhase: phaseEvent.fromPhase === 0 ? 'FLAT_PRICE' : 'BONDING_CURVE',
          toPhase: phaseEvent.toPhase === 0 ? 'FLAT_PRICE' : 'BONDING_CURVE',
          reserveUSD: Number(ethers.formatUnits(reserveBalance, 6)),
          txHash: event.log.transactionHash
        });

        // Trigger alert (informational)
        await this.handlePhaseTransition(phaseEvent);

        // Update statistics
        this.stats.phaseTransitions = (this.stats.phaseTransitions || 0) + 1;
      } catch (error) {
        logger.error(`Error handling PhaseTransition event for ${poolConfig.modelId}:`, error);
      }
    }
  );

  logger.info(`PhaseTransition listener active for ${poolConfig.modelId}`);
}

/**
 * Handle phase transition event
 */
private async handlePhaseTransition(event: PhaseTransitionEvent): Promise<void> {
  const alert: EventAlert = {
    type: 'phase_transition',
    priority: 'medium',
    message: `Pool "${event.modelId}" transitioned from ${event.fromPhase === 0 ? 'flat price' : 'bonding curve'} to ${event.toPhase === 0 ? 'flat price' : 'bonding curve'} phase at reserve balance $${Number(ethers.formatUnits(event.reserveBalance, 6)).toLocaleString()}`,
    event,
    timestamp: Date.now()
  };

  if (this.callbacks.onAlert) {
    await this.callbacks.onAlert(alert);
  }

  // Log for audit trail
  logger.info(`Phase transition alert sent for ${event.modelId}`, {
    fromPhase: event.fromPhase,
    toPhase: event.toPhase,
    txHash: event.transactionHash
  });
}
```

**Acceptance Criteria:**
- [ ] Listener set up in setupPhaseTransitionListener()
- [ ] Event handler logs phase transition
- [ ] Alert sent via callback
- [ ] Statistics updated
- [ ] Error handling present
- [ ] TypeScript compiles

**Testing:**
- [ ] Unit test: Listener calls handlePhaseTransition when event fires
- [ ] Unit test: Alert sent with correct priority (medium)
- [ ] Integration test: Can listen to testnet pool events

**Effort:** 1 hour

---

### Task 5.3: Call setupPhaseTransitionListener() in startMonitoring()
**File:** `services/contract-deployer/src/monitoring/event-listener.ts`
**Location:** In startMonitoring() method where other listeners are set up

**Changes:**
```typescript
async startMonitoring(poolConfigs: PoolConfig[]): Promise<void> {
  logger.info(`Starting event monitoring for ${poolConfigs.length} pool(s)`);

  for (const poolConfig of poolConfigs) {
    // Existing listeners
    this.setupTradeListeners(poolConfig);
    this.setupSecurityListeners(poolConfig);
    this.setupFeeListeners(poolConfig);

    // ADD: Phase transition listener
    this.setupPhaseTransitionListener(poolConfig);
  }

  this.isMonitoring = true;
  logger.info(`Event monitoring started for ${poolConfigs.length} pool(s)`);
}
```

**Acceptance Criteria:**
- [ ] setupPhaseTransitionListener() called for each pool
- [ ] Called alongside existing listeners
- [ ] TypeScript compiles

**Testing:**
- [ ] Integration test: All listeners set up when monitoring starts

**Effort:** 15 minutes

---

### Task 5.4: Add PhaseTransition to Alert Email
**File:** `services/contract-deployer/src/monitoring/alert-manager.ts`
**Location:** In buildEventAlertDetails() method

**Changes:**
```typescript
/**
 * Build details for event alerts
 */
private buildEventAlertDetails(alert: EventAlert): string {
  const event = alert.event;

  if ('reserveAmount' in event) {
    // TradeEvent
    // ... existing trade alert formatting
  } else if ('contractAddress' in event) {
    // SecurityEvent
    // ... existing security alert formatting
  } else if ('fromPhase' in event) {
    // NEW: PhaseTransitionEvent
    const transition = event as PhaseTransitionEvent;
    const fromPhaseName = transition.fromPhase === 0 ? 'Flat Price (Bootstrap)' : 'Bonding Curve (Active)';
    const toPhaseName = transition.toPhase === 0 ? 'Flat Price (Bootstrap)' : 'Bonding Curve (Active)';

    return `
      <div class="details" style="background: #DBEAFE; border-left: 4px solid #3B82F6;">
        <h3 style="color: #1E40AF;">🎉 Phase Transition</h3>
        <p style="font-weight: bold;">
          The pool has graduated from ${fromPhaseName} to ${toPhaseName} phase.
        </p>
        <div class="detail-row">
          <span class="detail-label">Pool:</span>
          <span class="detail-value">${transition.poolAddress}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Model ID:</span>
          <span class="detail-value">${transition.modelId}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Reserve at Transition:</span>
          <span class="detail-value">$${Number(ethers.formatUnits(transition.reserveBalance, 6)).toLocaleString()}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Transaction:</span>
          <span class="detail-value"><code>${transition.transactionHash}</code></span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Timestamp:</span>
          <span class="detail-value">${new Date(transition.timestamp * 1000).toISOString()}</span>
        </div>
        <p style="margin-top: 16px;">
          ℹ️  The pool is now using bonding curve pricing. Monitoring will apply phase-appropriate alert thresholds.
        </p>
      </div>
    `;
  } else {
    // FeeEvent
    // ... existing fee alert formatting
  }
}
```

**Acceptance Criteria:**
- [ ] Phase transition alert has distinct formatting (blue theme)
- [ ] Shows from/to phase names
- [ ] Includes reserve balance at transition
- [ ] Includes transaction hash
- [ ] Informational tone (not alarming)

**Testing:**
- [ ] Unit test: buildEventAlertDetails with phase transition event
- [ ] Manual test: Send test alert, verify email HTML

**Effort:** 30 minutes

---

### Task 5.5: Add Phase Transition Statistics
**File:** `services/contract-deployer/src/monitoring/event-listener.ts`
**Location:** Update stats interface and getStats() method

**Changes:**
```typescript
// Add to stats object (class property)
private stats = {
  totalEventsProcessed: 0,
  tradeEvents: 0,
  securityEvents: 0,
  feeEvents: 0,
  phaseTransitions: 0,  // NEW
  alertsSent: 0,
  errors: 0
};

// Update getStats() to include phase transitions
getStats() {
  return {
    ...this.stats,
    isMonitoring: this.isMonitoring
  };
}
```

**Acceptance Criteria:**
- [ ] Stats include phaseTransitions counter
- [ ] Counter increments on phase transition event
- [ ] getStats() returns phase transition count

**Testing:**
- [ ] Unit test: Stats updated after phase transition

**Effort:** 15 minutes

---

### Phase 5 Testing & Verification

**Unit Tests:**
```typescript
describe('Phase Transition Monitoring', () => {
  it('should listen for PhaseTransition events', async () => {
    // Mock pool contract
    // Set up listener
    // Emit PhaseTransition event
    // Assert: handlePhaseTransition called
  });

  it('should send medium priority alert on transition', async () => {
    // Create phase transition event
    // Call handlePhaseTransition
    // Assert: Alert sent with priority 'medium'
  });

  it('should increment phase transition counter', async () => {
    // Process phase transition event
    // Assert: stats.phaseTransitions incremented
  });
});
```

**Integration Tests:**
```typescript
describe('Phase Transition Integration', () => {
  // NOTE: Hard to test actual transition without deploying pool and executing trades
  // Can simulate with mock events

  it('should format phase transition alert email', async () => {
    // Create phase transition alert
    // Generate email HTML
    // Assert: Email includes phase names, reserve balance, tx hash
  });
});
```

**Manual Verification (Testnet Only):**
- [ ] Deploy new pool on Sepolia with low threshold (~$100)
- [ ] Start monitoring service
- [ ] Execute buy that pushes pool past threshold
- [ ] Verify PhaseTransition event captured
- [ ] Verify alert email received (medium priority)
- [ ] Verify email formatting is correct

**Phase 5 Complete When:**
- ✅ All unit tests pass
- ✅ Event listener captures phase transitions
- ✅ Alerts sent with correct priority and formatting
- ✅ Statistics tracked
- ✅ Manual testnet verification confirms functionality

---

## Final Integration Testing

**After All 5 Phases Complete:**

### Full System Test
1. Deploy fresh monitoring service with all changes
2. Point to Sepolia RPC
3. Load existing deployment (with backfilled phase params)
4. Verify monitoring starts without errors
5. Monitor for 24 hours
6. Check for false positives
7. Verify all alert types work

### Test Scenarios

**Scenario 1: Flat Phase Trading (No False Alerts)**
- Pool in flat phase (reserve < threshold)
- Execute several large trades (>50% supply increase)
- Expected: No percentage-based alerts
- Expected: TRUE_SUPPLY_MISMATCH check runs but passes

**Scenario 2: Bonding Curve Phase Trading (Alerts Fire)**
- Pool in bonding curve phase (reserve > threshold)
- Execute large trade causing >15% supply increase
- Expected: supply_anomaly alert fires
- Expected: Email includes phase context

**Scenario 3: Phase Transition**
- Deploy new pool with low threshold
- Buy enough to cross threshold
- Expected: PhaseTransition event captured
- Expected: Medium priority alert email received
- Expected: State tracker updates phase immediately

**Scenario 4: Critical Alerts (Always Fire)**
- Pause a pool (testnet only)
- Expected: Paused alert fires regardless of phase

**Scenario 5: Supply Invariant Violation (Testnet Only)**
- **(TESTNET ONLY)** Manually mint tokens outside AMM
- Expected: TRUE_SUPPLY_MISMATCH alert fires (critical)
- Expected: Alert email has red warning formatting

### Acceptance Criteria for Full Feature

- ✅ All 5 phases implemented
- ✅ All unit tests pass
- ✅ All integration tests pass
- ✅ Manual test scenarios pass
- ✅ No false positive alerts in 24h monitoring
- ✅ All alert types verified
- ✅ Documentation complete
- ✅ Code reviewed and approved
- ✅ Deployment artifacts updated
- ✅ Monitoring service runs stable for 48h

---

## Deployment Checklist

**Pre-Deployment:**
- [ ] All tests passing
- [ ] Code reviewed by at least one other developer
- [ ] Documentation reviewed and complete
- [ ] Sepolia monitoring service updated and stable
- [ ] No false positives in 24h test period

**Deployment Steps:**
1. [ ] Merge feature branch to main
2. [ ] Build new Docker image with phase-aware code
3. [ ] Run backfill script on production deployment artifacts
4. [ ] Update ECS task definition (hokusai-monitor-testnet)
5. [ ] Deploy new task to ECS
6. [ ] Monitor startup logs for errors
7. [ ] Verify phase detection in logs
8. [ ] Monitor for 24h for issues

**Post-Deployment:**
- [ ] Confirm no false positive alerts
- [ ] Verify all pools show correct phase in logs
- [ ] Check suppressed alert statistics
- [ ] Tune thresholds if needed
- [ ] Document any issues encountered
- [ ] Update runbook with learnings

---

## Timeline Summary

**Week 1:**
- Days 1-2: Phase 1 (Core Phase Detection)
- Days 3-4: Phase 2 (Suppress Phase-Blind Alerts)
- Day 5: Testing and bug fixes

**Week 2:**
- Days 1-2: Phase 3 (TRUE_SUPPLY_MISMATCH Alert)
- Days 3-4: Phase 4 (Update Deployment Artifacts)
- Day 5: Integration testing

**Week 3:**
- Days 1-2: Phase 5 (Phase Transition Events)
- Day 3: Final testing and documentation
- Day 4: Code review and PR
- Day 5: Deployment to production

**Total: 3 weeks for full implementation and deployment**

---

## Success Metrics

After deployment, track these metrics to validate success:

1. **False Positive Rate**
   - Before: ~X alerts/day (mostly supply_mismatch)
   - After: Should drop to near-zero

2. **Alert Accuracy**
   - % of alerts that require action
   - Target: >90% actionable alerts

3. **Phase Detection Accuracy**
   - Verify logged phase matches expected (reserve vs threshold)
   - Target: 100% accurate

4. **RPC Call Volume**
   - Should remain flat (batched calls)
   - Target: No increase

5. **System Stability**
   - Uptime of monitoring service
   - Target: 99.9%

6. **TRUE_SUPPLY_MISMATCH Sensitivity**
   - False positive rate
   - Target: <1% of checks

---

**Tasks Complete!** Ready to begin implementation.