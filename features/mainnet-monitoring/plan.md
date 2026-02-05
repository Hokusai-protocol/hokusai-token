# Hokusai AMM Mainnet Monitoring - Implementation Plan

**Feature:** Critical monitoring infrastructure for mainnet launch
**Created:** 2026-01-14
**Updated:** 2026-01-14
**Status:** ✅ Approved - Ready for Implementation
**Target:** Mainnet deployment with Option 1 (Simple) monitoring approach

## Key Updates Based on User Feedback

✅ **Email-only alerts** → me@timogilvie.com (no webhook integration initially)
✅ **Mainnet deployment preparation** → Phase 0 added for deployment scripts
✅ **Auto-discovery of pools** → Monitor all pools, automatically detect new pools
✅ **Scalable architecture** → Support for growing pool ecosystem
✅ **AWS integration** → Use existing AWS CLI credentials for SES & CloudWatch

---

## Overview

Implement essential monitoring infrastructure to safely operate the Hokusai AMM system on mainnet. This plan focuses on **critical components (Sections 1-4 from monitoring-requirements.md)** required before launch, using AWS services where possible and staying within ~$50/month budget.

### What We're Building
A lightweight monitoring service that:
- Tracks real-time contract state (reserves, prices, supply) across **all AMM pools**
- **Automatically discovers and monitors new pools** as they're created via HokusaiAMMFactory
- Listens for critical events (Buy, Sell, FeesDeposited, Paused, etc.)
- Sends **email alerts** to me@timogilvie.com for security events and anomalies
- Provides basic health checks and metrics collection
- Extends existing [health-check.ts](../../services/contract-deployer/src/monitoring/health-check.ts) infrastructure
- **Includes mainnet deployment preparation** (contract addresses, configuration)

### Why Now
The research shows 3 AMM pools on Sepolia testnet ready for mainnet migration, with plans to deploy additional pools over time. Without monitoring, we cannot:
- Detect reserve imbalances or price manipulation across growing pool ecosystem
- Respond to emergency pause events
- Track large trades or whale activity
- Monitor fee collection and treasury balances
- Alert on unauthorized owner function calls
- Automatically discover and monitor newly created pools

---

## Current State

### What Exists Today

#### ✅ Smart Contracts (Production Ready)
- [HokusaiAMM.sol](../../contracts/HokusaiAMM.sol) - CRR-based bonding curve AMM
- [TokenManager.sol](../../contracts/TokenManager.sol) - Minting/burning authorization
- [ModelRegistry.sol](../../contracts/ModelRegistry.sol) - Model-token-pool mappings
- [HokusaiToken.sol](../../contracts/HokusaiToken.sol) - ERC20 with controller
- [HokusaiAMMFactory.sol](../../contracts/HokusaiAMMFactory.sol) - Pool deployment
- [UsageFeeRouter.sol](../../contracts/UsageFeeRouter.sol) - Fee distribution

#### ✅ Testnet Deployment (Sepolia)
- 3 pools deployed with different risk profiles:
  - Conservative (30% CRR, 0.25% fee)
  - Aggressive (10% CRR, 0.50% fee)
  - Balanced (20% CRR, 0.30% fee)
- Gas benchmarks: 111K (buy), 143K (sell)
- All contracts verified and tested

#### ✅ Existing Monitoring Foundation
- [health-check.ts](../../services/contract-deployer/src/monitoring/health-check.ts) service with:
  - Redis queue monitoring
  - Blockchain provider health checks
  - Contract reachability verification
  - Metrics collection framework
  - Alert handler system
  - Express health endpoints

### What's Missing

#### ❌ AMM-Specific Monitoring
- No event listeners for Buy/Sell/FeesDeposited
- No real-time price/reserve tracking
- No multi-pool state aggregation
- No trading volume metrics

#### ❌ Security Monitoring
- No alerts for Pause/Unpause events
- No ownership change detection
- No parameter update notifications
- No whale trade alerts (>$10K)

#### ❌ Alert Infrastructure
- No email notifications configured
- No webhook integration for alerts
- No alert prioritization (critical vs informational)

#### ❌ Mainnet Configuration
- No mainnet deployment artifacts
- No mainnet RPC configuration
- No real USDC contract integration

---

## Proposed Changes

### Architecture Decision: Extend Existing Service

Rather than creating a separate monitoring service, we'll **extend the existing contract-deployer service** to support AMM monitoring:

**Rationale:**
- Reuses proven patterns (health checks, alerts, metrics)
- Shares infrastructure (Redis, Express, TypeScript setup)
- Reduces deployment complexity (one service vs two)
- Maintains consistent monitoring patterns

**New Structure:**
```
services/contract-deployer/
├── src/
│   ├── monitoring/
│   │   ├── health-check.ts          # Existing
│   │   ├── amm-monitor.ts           # NEW - Core AMM monitoring
│   │   ├── event-listener.ts        # NEW - Event stream processor
│   │   ├── state-tracker.ts         # NEW - Pool state polling
│   │   ├── alert-manager.ts         # NEW - Alert routing & prioritization
│   │   └── metrics-collector.ts     # NEW - Time-series metrics
│   ├── config/
│   │   ├── monitoring-config.ts     # NEW - Alert thresholds & pool configs
│   │   └── mainnet-contracts.ts     # NEW - Mainnet addresses
│   └── utils/
│       ├── notifications.ts         # NEW - Email/webhook sender
│       └── format-utils.ts          # NEW - Alert message formatting
├── tests/
│   └── unit/monitoring/
│       ├── amm-monitor.test.ts      # NEW
│       ├── event-listener.test.ts   # NEW
│       └── alert-manager.test.ts    # NEW
└── monitoring/
    └── cloudwatch-dashboard.json    # Existing - extend for AMM metrics
```

### Key Components

#### 1. AMMMonitor (Core Orchestrator)
```typescript
class AMMMonitor {
  // Initialize monitoring for all pools
  async start(): Promise<void>

  // Per-pool monitoring
  async monitorPool(poolAddress: string): Promise<void>

  // Aggregate metrics across pools
  getSystemMetrics(): SystemMetrics

  // Health check integration
  getPoolHealth(poolAddress: string): ComponentHealth
}
```

#### 2. EventListener (Real-time Events)
```typescript
class EventListener {
  // Listen for Buy/Sell events
  listenBuySellEvents(poolAddress: string): void

  // Listen for security events
  listenSecurityEvents(contracts: ContractAddresses): void

  // Listen for new pool creation on HokusaiAMMFactory
  listenPoolCreated(): void  // Auto-discover new pools

  // Handle event batches
  processEventBatch(events: Event[]): Promise<void>
}
```

#### 3. StateTracker (Polling)
```typescript
class StateTracker {
  // Poll pool state every 12 seconds (1 block)
  async pollPoolState(poolAddress: string): Promise<PoolState>

  // Check for anomalies
  detectAnomalies(current: PoolState, previous: PoolState): Alert[]

  // Calculate derived metrics
  calculateMetrics(state: PoolState): DerivedMetrics
}
```

#### 4. AlertManager (Prioritization & Routing)
```typescript
class AlertManager {
  // Process alert and determine priority
  processAlert(alert: Alert): void

  // Route based on severity
  // Critical: Email + Webhook immediately
  // High: Email within 10 min
  // Medium: Batch daily
  routeAlert(alert: Alert, priority: Priority): Promise<void>

  // Prevent alert spam
  shouldSendAlert(alert: Alert): boolean // Rate limiting
}
```

---

## Implementation Phases

### Phase 0: Mainnet Deployment Preparation (Day 0 - Before Monitoring)

**Goal:** Prepare configuration and tooling for mainnet contract deployment.

**Tasks:**
1. **Create mainnet deployment script**
   - Based on existing `scripts/deploy-sepolia.ts`
   - Update to use mainnet RPC URL from .env
   - Use real USDC address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
   - Deploy contracts in order:
     1. ModelRegistry
     2. TokenManager
     3. HokusaiAMMFactory
     4. UsageFeeRouter
   - Save deployment addresses to `deployments/mainnet-latest.json`

2. **Create mainnet pool creation scripts**
   - Script to create pools via HokusaiAMMFactory
   - Initial pools: Conservative, Aggressive, Balanced (same config as testnet)
   - Record pool addresses in deployment artifact

3. **Verify deployment configuration**
   - Mainnet deployer wallet has sufficient ETH for gas
   - All deployment parameters reviewed (CRR, fees, IBR duration)
   - Treasury address configured
   - Verify USDC address is correct for mainnet

4. **Contract verification preparation**
   - Etherscan API key configured
   - Verification scripts ready (using Hardhat verify plugin)
   - Constructor arguments documented

**Success Criteria:**
- [ ] Deployment script tested on Sepolia (dry run)
- [ ] Mainnet configuration reviewed and approved
- [ ] Deployer wallet funded with sufficient ETH
- [ ] `deployments/mainnet-latest.json` template prepared

**Deliverables:**
- `scripts/deploy-mainnet.ts` - Mainnet deployment script
- `scripts/create-mainnet-pools.ts` - Pool creation script
- `deployments/mainnet-latest.json` - Deployment artifact template
- `docs/mainnet-deployment-checklist.md` - Pre-flight checklist

**Note:** This phase is a prerequisite for monitoring. Monitoring implementation (Phase 1-4) begins after mainnet contracts are deployed.

---

### Phase 1: Core Monitoring Infrastructure (Days 1-2)

**Goal:** Essential monitoring for launch - track state and events across all pools.

**Tasks:**
1. **Create monitoring configuration**
   - Load pool addresses from `deployments/mainnet-latest.json`
   - Set alert thresholds per [monitoring-requirements.md](../../deployments/monitoring-requirements.md)
   - Configure mainnet RPC URL (Alchemy with existing API key)
   - Add mainnet USDC address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`

2. **Implement Pool Discovery**
   - Listen for `PoolCreated` events from HokusaiAMMFactory
   - On new pool detected:
     - Add pool to monitoring list automatically
     - Initialize StateTracker for new pool
     - Start event listeners for new pool
     - Send notification: "New pool created: [modelId] at [address]"
   - Query factory for existing pools at startup
   - Persist pool list to avoid re-discovery on restart

3. **Implement StateTracker**
   - Poll **all monitored pools** every 12 seconds for:
     - `reserveBalance` (alert if drops >20% in 1h)
     - `spotPrice()` (alert if changes >20% in 1h)
     - `token.totalSupply()` (verify consistency with events)
     - `paused` status (critical alert if true)
   - Store last 50 states per pool for anomaly detection
   - Calculate derived metrics: reserve ratio, market cap estimate
   - Scale efficiently: parallel polling for multiple pools

4. **Implement EventListener**
   - Listen for `Buy` events → log trade, check if >$10K (whale alert)
   - Listen for `Sell` events → log trade, check if >$10K
   - Listen for `FeesDeposited` → verify fee accounting
   - Listen for `Paused/Unpaused` → **CRITICAL ALERT**
   - Listen for `OwnershipTransferred` → **CRITICAL ALERT**
   - Listen for `ParametersUpdated` → alert with old/new values

4. **Basic metrics collection**
   - Track per-pool: total buy volume, total sell volume, trade count, unique traders
   - Track system-wide: TVL (sum of all reserves across all pools), total fees collected
   - Store in memory initially (no DB required for Phase 1)
   - Support dynamic pool addition (metrics for new pools start from creation time)

**Success Criteria:**
- [ ] Monitor runs continuously without crashes
- [ ] All events detected within 1 block (~12 seconds)
- [ ] State polls complete in <2 seconds per pool (scales to 10+ pools)
- [ ] Logs show all metrics updating correctly
- [ ] **New pool creation detected and monitoring starts automatically**
- [ ] Test: Create new pool on testnet → monitoring begins within 1 block

**Out of Scope:**
- Historical data persistence (no database)
- Custom dashboard (use AWS CloudWatch)
- Advanced analytics (user behavior, arbitrage detection)

---

### Phase 2: Alert System & Notifications (Day 3)

**Goal:** Send alerts via email and webhooks for critical events.

**Tasks:**
1. **Implement AlertManager**
   - Priority levels: Critical, High, Medium, Low
   - Rate limiting: max 1 critical alert per 5 min for same event
   - Alert deduplication: don't repeat identical alerts
   - Alert formatting: human-readable messages with context

2. **Email notifications (AWS SES)**
   - Use existing configured AWS credentials
   - Verify email: me@timogilvie.com (if not already verified)
   - Templates for different alert types:
     - Critical: "🚨 HOKUSAI CRITICAL: Reserve dropped 30% in 1 hour"
     - High: "⚠️ HOKUSAI HIGH: Whale trade $25K detected"
     - Medium: "📊 HOKUSAI: Daily summary - $100K volume"
   - Batch non-critical alerts (send hourly digest)
   - Include Etherscan links in email body

3. **Email template design**
   - Subject line priority prefix: [CRITICAL], [HIGH], [MEDIUM]
   - Formatted HTML emails with:
     - Alert type and timestamp
     - Pool address and model ID
     - Specific metrics (old value → new value)
     - Direct link to Etherscan transaction
     - Link to pool contract on Etherscan
   - Plain text fallback for email clients

4. **Alert configuration**
   - Critical alerts:
     - Reserve drops >20% in 1 hour
     - `Paused` event
     - `OwnershipTransferred` event
     - Reserve goes to zero
   - High alerts:
     - Price change >20% in 1 hour
     - Large trade >$10K
     - `ParametersUpdated` event
     - Failed transaction rate >10%
   - Medium alerts:
     - Daily volume summary
     - Fee collection summary
     - IBR ending in 24 hours

**Success Criteria:**
- [ ] Critical alerts sent within 30 seconds of detection
- [ ] Email delivery confirmed to me@timogilvie.com
- [ ] No false positives during 24h test
- [ ] Alert rate limiting prevents spam

**Out of Scope:**
- SMS notifications (use email initially)
- PagerDuty integration (upgrade path)
- Phone call alerts

---

### Phase 3: Security Monitoring (Day 4)

**Goal:** Monitor owner functions and detect unauthorized access attempts.

**Tasks:**
1. **Owner function monitoring**
   - Track all calls to:
     - `HokusaiAMM.setParameters()`
     - `HokusaiAMM.setMaxTradeBps()`
     - `HokusaiAMM.withdrawTreasury()`
     - `HokusaiAMM.pause()`
     - `TokenManager.authorizeAMM()`
     - `TokenManager.setDeltaVerifier()`
   - Alert with: caller address, function name, parameters, transaction hash
   - Cross-reference with expected owner addresses

2. **Role change monitoring**
   - Listen for `RoleGranted` and `RoleRevoked` events
   - Track MINTER_ROLE grants on TokenManager
   - Track FEE_DEPOSITOR_ROLE on UsageFeeRouter
   - Alert on any unexpected role changes

3. **Unusual pattern detection**
   - Track failed transactions from same address (>5 fails = suspicious)
   - Detect repeated max-size trades (potential manipulation)
   - Flag if no trades for 24 hours (may indicate pause/bug)

**Success Criteria:**
- [ ] All owner function calls logged and alerted
- [ ] Role changes detected within 1 block
- [ ] Test ownership transfer on testnet triggers alert
- [ ] Suspicious pattern detection catches simulated attack

**Out of Scope:**
- Flash loan attack detection (future enhancement)
- MEV sandwich detection (future enhancement)
- Advanced ML-based anomaly detection

---

### Phase 4: Health Checks & Integration (Day 5)

**Goal:** Integrate AMM monitoring into existing health check system.

**Tasks:**
1. **Extend HealthCheckService**
   - Add `checkAMMHealth()` method
   - Return status per pool: healthy, degraded, unhealthy
   - Degraded if: reserve low, high volatility, long pause
   - Unhealthy if: monitoring disconnected, RPC failing

2. **Add AMM metrics to health endpoint**
   - Extend `/health/detailed` to include:
     ```json
     {
       "status": "healthy",
       "amm": {
         "pools": [
           {
             "address": "0x...",
             "status": "healthy",
             "reserveUSD": 50000,
             "spotPrice": 1.25,
             "volume24h": 25000,
             "lastTradeTime": "2026-01-14T12:00:00Z"
           }
         ],
         "systemMetrics": {
           "totalTVL": 150000,
           "totalVolume24h": 75000,
           "totalTrades24h": 150
         }
       }
     }
     ```

3. **CloudWatch integration**
   - Publish custom metrics to CloudWatch:
     - `AMM/ReserveBalance` per pool
     - `AMM/SpotPrice` per pool
     - `AMM/TradeVolume` per pool
     - `AMM/TotalTVL` system-wide
   - Update [cloudwatch-dashboard.json](../../services/contract-deployer/monitoring/cloudwatch-dashboard.json)
   - Set CloudWatch alarms for critical thresholds

4. **RPC failover**
   - Configure backup RPC URLs (Infura, QuickNode, or public)
   - Automatic failover if primary fails
   - Alert if using backup >10 minutes

**Success Criteria:**
- [ ] Health endpoint shows AMM status
- [ ] CloudWatch dashboard displays metrics
- [ ] CloudWatch alarms trigger on threshold breaches
- [ ] RPC failover tested and working
- [ ] Monitor recovers gracefully from disconnects

**Out of Scope:**
- Custom web dashboard (use CloudWatch)
- Public metrics API
- Historical charts (use CloudWatch)

---

## Testing Strategy

### Unit Tests
- `amm-monitor.test.ts` - Core monitoring logic
- `event-listener.test.ts` - Event parsing and handling
- `state-tracker.test.ts` - Anomaly detection
- `alert-manager.test.ts` - Alert routing and rate limiting

### Integration Tests
- Deploy monitor to Sepolia testnet
- Simulate trades and verify events captured
- Trigger alerts by:
  - Making large test trades
  - Calling owner functions
  - Pausing/unpausing pools
- Verify email delivery
- Confirm CloudWatch metrics appear

### Pre-Mainnet Checklist
- [ ] Monitor runs for 48 hours on testnet without errors
- [ ] All alert types tested and delivered correctly
- [ ] Health endpoint returns accurate data
- [ ] CloudWatch dashboard shows live metrics
- [ ] RPC failover tested
- [ ] Load test: handle 100+ trades in 1 minute
- [ ] Email templates reviewed and approved
- [ ] Mainnet contract addresses configured
- [ ] Monitoring starts automatically on service restart
- [ ] Documented runbook for responding to alerts

---

## Configuration

### Environment Variables (.env)

```bash
# Network Configuration
NODE_ENV=production
MAINNET_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/<KEY>
BACKUP_RPC_URL=https://mainnet.infura.io/v3/<KEY>
CHAIN_ID=1

# Existing from contract-deployer
REDIS_URL=redis://localhost:6379

# Mainnet Contract Addresses (update after deployment)
MAINNET_MODEL_REGISTRY=0x...
MAINNET_TOKEN_MANAGER=0x...
MAINNET_AMM_FACTORY=0x...
MAINNET_USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Pool Discovery
# Pools are auto-discovered via HokusaiAMMFactory PoolCreated events
# Initial pools loaded from deployments/mainnet-latest.json
# No need to manually configure individual pool addresses

# Monitoring Configuration
MONITORING_ENABLED=true
MONITORING_INTERVAL_MS=12000  # 12 seconds = 1 block
MONITORING_START_BLOCK=latest # or specific block number

# Alert Configuration
ALERT_EMAIL=me@timogilvie.com
AWS_SES_REGION=us-east-1
# AWS credentials from existing CLI configuration

# Alert Thresholds
ALERT_RESERVE_DROP_PCT=20      # Alert if reserve drops >20%
ALERT_PRICE_CHANGE_1H_PCT=20   # Alert if price changes >20% in 1h
ALERT_LARGE_TRADE_USD=10000    # Alert on trades >$10k
ALERT_FAILED_TX_RATE_PCT=10    # Alert if >10% txs fail

# AWS CloudWatch
AWS_CLOUDWATCH_NAMESPACE=Hokusai/AMM
AWS_CLOUDWATCH_ENABLED=true
```

### Mainnet Deployment Artifact

After mainnet deployment, create `deployments/mainnet-latest.json`:
```json
{
  "network": "mainnet",
  "chainId": "1",
  "timestamp": "2026-01-15T00:00:00.000Z",
  "deployer": "0x...",
  "contracts": {
    "ModelRegistry": "0x...",
    "TokenManager": "0x...",
    "HokusaiAMMFactory": "0x...",
    "UsageFeeRouter": "0x...",
    "USDC": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"
  },
  "pools": [
    {
      "modelId": "model-conservative-001",
      "tokenAddress": "0x...",
      "ammAddress": "0x...",
      "initialReserve": "50000000000",
      "crr": 300000,
      "tradeFee": 25,
      "protocolFee": 500,
      "ibrDuration": 604800
    }
  ]
}
```

---

## Success Criteria

### Automated Checks
- [ ] All unit tests pass (`npm test`)
- [ ] Integration tests pass on testnet
- [ ] TypeScript compilation succeeds with no errors
- [ ] Linting passes (no warnings)
- [ ] No console.errors in logs during normal operation

### Manual Verification
- [ ] Monitoring service starts and connects to mainnet
- [ ] All 3 pools detected and monitored
- [ ] Events appear in logs within 12 seconds of occurrence
- [ ] Email alert received for test critical event
- [ ] Health endpoint returns 200 with AMM data
- [ ] CloudWatch metrics visible in AWS console
- [ ] Alert rate limiting prevents spam (tested with 10 rapid events)
- [ ] Service recovers from simulated RPC outage

### Performance Requirements
- [ ] State polling completes in <2 seconds per pool
- [ ] Event processing lag <12 seconds (1 block)
- [ ] Memory usage <500MB for monitoring service
- [ ] CPU usage <20% during normal trading
- [ ] Alert delivery latency <30 seconds for critical alerts

### Operational Readiness
- [ ] Runbook documented for alert response
- [ ] 48-hour burn-in period on testnet completed
- [ ] Monitoring survives service restart (automatic recovery)
- [ ] Backup RPC tested and working
- [ ] Email deliverability confirmed (not spam folder)

---

## Out of Scope (Future Enhancements)

### Not Included in Initial Launch

#### 1. Advanced Analytics
- User behavior tracking (cohort analysis, retention)
- Arbitrage opportunity detection
- Predictive alerts using ML
- Historical data analysis beyond 24 hours

#### 2. Custom Dashboard
- Web UI for monitoring data
- Real-time price charts
- Trading volume visualizations
- Public transparency dashboard

#### 3. Database Persistence
- Time-series database (InfluxDB/TimescaleDB)
- Long-term historical data (>7 days)
- Query API for analytics

#### 4. Advanced Alerting
- SMS notifications (Twilio)
- Phone call alerts (PagerDuty)
- Alert escalation policies
- On-call rotation management

#### 5. Multi-Region Deployment
- Redundant monitoring in multiple AWS regions
- Geographic failover
- Load balancing

#### 6. External Integrations
- Etherscan contract monitoring
- Price oracle integration
- Social media monitoring (Twitter mentions)
- GitHub issue tracking

#### 7. Gas Optimization Monitoring
- Gas price recommendations
- Transaction cost analysis
- MEV protection metrics

### Upgrade Path (Option 2 - Comprehensive)

When ready to scale beyond Option 1:
1. Add TimeSeries DB (InfluxDB on AWS)
2. Build Grafana dashboard
3. Integrate PagerDuty for critical alerts
4. Add advanced analytics (user tracking, arbitrage detection)
5. Deploy to multiple regions for redundancy

**Estimated Timeline:** 1-2 weeks
**Estimated Cost:** $500/month

---

## Dependencies

### External Services
- **AWS SES** - Email notifications (within AWS free tier for low volume)
- **AWS CloudWatch** - Metrics and dashboards (within free tier)
- **Alchemy RPC** - Mainnet provider (existing account)
- Optional: Discord/Slack webhook (free)

### Internal Dependencies
- Mainnet deployment must complete first (get contract addresses)
- Redis already configured in contract-deployer service
- Express server already running in contract-deployer service

### Node.js Packages (Add to package.json)
```json
{
  "dependencies": {
    "aws-sdk": "^2.1500.0",      // For SES and CloudWatch
    "ethers": "^6.9.0",           // Already installed
    "nodemailer": "^6.9.0",       // Email formatting
    "discord.js": "^14.0.0"       // Optional webhook
  }
}
```

---

## Risks & Mitigations

### Risk 1: RPC Rate Limiting
**Impact:** Monitoring stops if rate limit hit
**Probability:** Medium (depends on Alchemy tier)
**Mitigation:**
- Configure backup RPC (Infura, QuickNode)
- Implement exponential backoff on errors
- Alert if switching to backup provider
- Monitor RPC call volume in CloudWatch

### Risk 2: Alert Fatigue
**Impact:** Critical alerts ignored due to spam
**Probability:** Medium (false positives during high volatility)
**Mitigation:**
- Strict rate limiting (1 critical alert per 5 min)
- Alert deduplication
- Tunable thresholds (adjust after observing mainnet behavior)
- Daily digest for non-critical alerts

### Risk 3: Monitoring Service Downtime
**Impact:** Blind to contract issues during outage
**Probability:** Low (but high impact)
**Mitigation:**
- Run monitoring service with auto-restart (PM2 or AWS ECS)
- Alert if monitoring hasn't sent heartbeat in 5 minutes
- Document manual monitoring procedures (Etherscan, direct RPC calls)
- Consider redundant monitoring in Phase 2

### Risk 4: Delayed Alert Delivery
**Impact:** Slow response to critical events
**Probability:** Low (email usually <5 seconds)
**Mitigation:**
- Use AWS SES for reliable delivery
- Test email latency during setup
- Add webhook as backup notification channel
- Monitor alert delivery latency

### Risk 5: Incorrect Mainnet Configuration
**Impact:** Monitoring wrong contracts or network
**Probability:** Low (but catastrophic)
**Mitigation:**
- Validate all contract addresses before mainnet start
- Test on testnet first with identical config
- Add startup checks: verify chainId, verify contract code matches expected
- Manual review of configuration before launch

### Risk 6: High AWS Costs
**Impact:** Budget overrun
**Probability:** Low (within free tier)
**Mitigation:**
- Monitor AWS costs daily in first week
- Set CloudWatch alarms for cost thresholds
- Review SES sending volume (should be <10 emails/day for critical alerts)
- CloudWatch metrics under 50 custom metrics (free tier)

---

## Timeline & Effort Estimate

### Total Timeline: 6 Days

| Phase | Duration | Tasks |
|-------|----------|-------|
| Phase 0: Mainnet Prep | 1 day | Deployment scripts, mainnet config, verification |
| Phase 1: Core Monitoring | 2 days | Pool discovery, StateTracker, EventListener, metrics |
| Phase 2: Alert System | 1 day | AlertManager, email (AWS SES), rate limiting |
| Phase 3: Security Monitoring | 1 day | Owner functions, role changes, patterns |
| Phase 4: Health & Integration | 1 day | Health checks, CloudWatch, RPC failover |

### Effort Distribution
- **Mainnet Preparation:** 15% (1 day) - Deployment scripts, configuration
- **Development:** 60% (3.5 days) - Writing code, tests
- **Testing:** 20% (1 day) - Testnet integration, alert verification
- **Documentation:** 5% (0.5 day) - Runbooks, configuration docs

### Pre-Launch Activities
- Deploy monitoring to testnet: 2 hours
- 48-hour burn-in period: 2 days (passive)
- **Mainnet contract deployment:** 3 hours (from Phase 0 scripts)
- Monitoring configuration for mainnet: 1 hour
- Final review & approval: 1 hour

**Total Calendar Time:** 6 days development + 2 days burn-in + 0.5 day mainnet deployment = **~8.5 days to full launch**

---

## Post-Launch Monitoring

### Week 1 Activities
- [ ] Check health endpoint 3x daily
- [ ] Review CloudWatch dashboard daily
- [ ] Tune alert thresholds based on actual volatility
- [ ] Document any false positives
- [ ] Measure average alert delivery latency
- [ ] Review AWS costs (should be near $0 in week 1)

### Week 2-4 Activities
- [ ] Analyze 30-day metrics for trends
- [ ] Identify optimization opportunities
- [ ] Plan Option 2 upgrade if needed
- [ ] Add additional pools to monitoring as deployed
- [ ] Create public dashboard (if desired)

### Monthly Review
- Review alert history - any missed events?
- Check AWS costs - still within budget?
- Evaluate need for advanced features (Option 2)
- Update runbook with lessons learned

---

## Rollback Plan

If monitoring service causes issues:

1. **Disable monitoring without affecting contracts:**
   - Set `MONITORING_ENABLED=false` in environment
   - Restart service (contracts unaffected)
   - Fall back to manual Etherscan monitoring

2. **Partial rollback (disable alerts but keep monitoring):**
   - Comment out email/webhook sending
   - Keep logging and metrics collection
   - Review logs manually

3. **Emergency manual monitoring:**
   - Watch Etherscan for each pool address
   - Set up Etherscan email alerts for critical events
   - Manually check `spotPrice()` and `reserveBalance` every hour
   - Use Tenderly for transaction monitoring

---

## Appendix: Event Signatures

For reference when implementing event listeners:

```solidity
// HokusaiAMM Events
event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 fee, uint256 spotPrice);
event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 fee, uint256 spotPrice);
event FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance, uint256 newSpotPrice);
event TreasuryWithdrawal(address indexed recipient, uint256 amount);
event ParametersUpdated(uint256 newCrr, uint256 newTradeFee, uint16 newProtocolFee);
event MaxTradeBpsUpdated(uint256 oldBps, uint256 newBps);
event Paused(address account);
event Unpaused(address account);
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

// TokenManager Events
event TokensMinted(string indexed modelId, address indexed recipient, uint256 amount);
event TokensBurned(string indexed modelId, address indexed account, uint256 amount);
event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender);
event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender);

// UsageFeeRouter Events
event FeeDeposited(string indexed modelId, address indexed poolAddress, uint256 amount, uint256 protocolFee, uint256 poolDeposit, address indexed depositor);
```

---

## Contact & Escalation

**Primary Contact:** me@timogilvie.com
**Alert Delivery:** Email (AWS SES)
**Optional:** Discord/Slack webhook for team visibility

**Alert Response Times:**
- Critical: Respond within 5 minutes
- High: Respond within 4 hours
- Medium: Review within 24 hours
- Low: Weekly review

---

**Plan Status:** ✅ Ready for Review
**Next Step:** User approval → Begin Phase 1 implementation
**Estimated Launch:** 7 days from approval (5 days dev + 2 days testnet burn-in)
