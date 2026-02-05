# Hokusai AMM Monitoring Requirements

Based on testnet validation and mainnet deployment preparation.

---

## 🎯 **CRITICAL - Must Have for Launch**

### 1. Contract State Monitoring

**Reserve Balance Tracking**
```
Monitor: Each pool's reserveBalance
Alert if:
  - Drops below 20% of initial
  - Increases by >50% in 1 hour (whale alert)
  - Goes to zero (critical emergency)
Check frequency: Every block
```

**Token Supply Tracking**
```
Monitor: Each token's totalSupply
Alert if:
  - Deviates from expected based on trades
  - Changes without corresponding Buy/Sell event
Check frequency: Every block
```

**Price Monitoring**
```
Monitor: spotPrice() for each pool
Alert if:
  - Changes by >20% in 1 hour
  - Changes by >50% in 24 hours
  - Goes below $0.001 or above $1000
Check frequency: Every minute
```

**Reserve/Supply Ratio**
```
Monitor: reserveBalance / tokenSupply
Alert if:
  - Ratio drifts from expected bonding curve
  - Sudden divergence (indicates bug or exploit)
Check frequency: Every block
```

### 2. Transaction Monitoring

**Buy/Sell Events**
```solidity
event Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 feeAmount, uint256 newPrice)
event Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 feeAmount, uint256 newPrice)
```

Monitor:
- Total buy volume per hour/day
- Total sell volume per hour/day
- Largest trades (>$10K)
- Failed transactions (reverts)

Alert if:
- Buy/sell volume imbalance >80% for 4 hours
- Single trade >$100K
- Failed transaction rate >10%
- No trades for 24 hours (may indicate pause/bug)

**Fee Collection**
```solidity
Monitor: Treasury USDC balance
Alert if:
  - Doesn't increase after trades
  - Increases by less than expected fees
Check frequency: After each trade
```

**Gas Usage Anomalies**
```
Monitor: Gas used per transaction
Alert if:
  - Exceeds 200K gas (normal is 110-145K)
  - Pattern of high gas suggests attack
Baseline: Buy ~111K, Sell ~143K
```

### 3. Security Monitoring

**Ownership Changes**
```solidity
event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)
```
Alert: IMMEDIATELY on any ownership transfer
Action: Verify this was intentional

**Pause Events**
```solidity
event Paused(address account)
event Unpaused(address account)
```
Alert: IMMEDIATELY on pause/unpause
Action: Check if emergency or unauthorized

**Authorization Changes**
```
Monitor: MINTER_ROLE grants/revokes on TokenManager
Alert: Any role change
Action: Verify authorization is correct
```

**Unusual Patterns**
```
Monitor:
  - Multiple failed transactions from same address
  - Repeated max-size trades
  - Sandwich attack patterns (buy-trade-sell)
  - Flash loan interactions

Alert if: Potential MEV or exploit attempt detected
```

### 4. Health Checks

**RPC Endpoint Health**
```
Monitor:
  - Alchemy/Infura response time
  - Failed RPC requests
  - Rate limit hits

Alert if:
  - Response time >3 seconds
  - Failure rate >5%
  - Hitting rate limits

Have backup: Infura, QuickNode, own node
```

**Contract Reachability**
```
Check every 5 minutes:
  - Can read spotPrice()
  - Can read reserveBalance()
  - Can get latest block

Alert if: Any call fails 3 times in a row
```

---

## 🟡 **IMPORTANT - Should Have Soon**

### 5. Economic Metrics

**Daily Trading Volume**
```
Track:
  - Total USDC volume (in + out)
  - Number of unique traders
  - Number of transactions
  - Average trade size

Dashboard: Show 7-day trends
```

**Price Impact Analysis**
```
Track for each pool:
  - Average price impact per trade size
  - Slippage frequency (minOut not met)
  - Quote accuracy (actual vs quoted)

Alert if: Impact significantly higher than expected
```

**Fee Revenue**
```
Track:
  - Daily protocol fees collected
  - Split by pool
  - Comparison to other AMMs

Dashboard: Show cumulative and daily
```

**Liquidity Metrics**
```
Track:
  - Reserve depth per pool
  - Max trade size available
  - Time to deplete at current volume

Alert if: Reserve would deplete in <7 days
```

### 6. User Behavior Tracking

**Wallet Analytics**
```
Track:
  - New vs returning traders
  - Whale activity (>$10K trades)
  - Bot vs human patterns
  - Geographic distribution (if possible)
```

**Trade Patterns**
```
Identify:
  - Common trade sizes
  - Hold times (buy to sell duration)
  - Multi-pool traders
  - Arbitrage activity
```

**Error Analysis**
```
Track failed transactions:
  - "Slippage exceeded" frequency
  - "Transaction expired" frequency
  - Approval issues
  - Insufficient balance

Use for UX improvements
```

### 7. Parameter Monitoring

**Governance Changes**
```solidity
// HokusaiParams events
event TokensPerDeltaOneSet(uint256 oldValue, uint256 newValue, address updater)
event InfraMarkupBpsSet(uint16 oldBps, uint16 newBps, address updater)
```

Alert: IMMEDIATELY on any parameter change
Action: Verify change was intentional and within limits

**Pool Configuration**
```
Monitor:
  - tradeFee
  - protocolFeeBps
  - maxTradeBps
  - IBR duration

Alert if: Values outside safe ranges
```

---

## 🟢 **NICE TO HAVE - Post-Launch**

### 8. Advanced Analytics

**Historical Data**
```
Store and analyze:
  - All trades (time series)
  - Price history per pool
  - Volume patterns
  - User cohort analysis
```

**Benchmarking**
```
Compare against:
  - Uniswap V2/V3
  - Curve
  - Your own projections
```

**Predictive Alerts**
```
ML-based anomaly detection:
  - Unusual trading patterns
  - Potential exploits before they happen
  - Volume/price predictions
```

### 9. External Integrations

**Etherscan Monitoring**
```
Track:
  - Contract verification status
  - Source code matches deployment
  - Transaction success rate on block explorer
```

**Price Feed Integration**
```
If using oracles:
  - Oracle price vs AMM price divergence
  - Oracle failure detection
  - Stale price detection
```

**Social Monitoring**
```
Monitor:
  - Twitter mentions
  - Discord/Telegram activity
  - GitHub issues
  - Blog posts about your protocol
```

---

## 📊 **IMPLEMENTATION OPTIONS**

### Option 1: Simple (Week 1 minimum)
```
Tools:
  - Tenderly alerts for critical events
  - Etherscan watchlist for addresses
  - Simple script checking balances every 5 min
  - Discord webhooks for alerts

Cost: ~$50/month
Setup time: 1 day
```

### Option 2: Comprehensive (Recommended)
```
Tools:
  - Tenderly Pro for advanced monitoring
  - Grafana dashboard with Ethereum data
  - Custom event indexer (The Graph or Dune)
  - PagerDuty for critical alerts
  - Datadog for system health

Cost: ~$500/month
Setup time: 1 week
```

### Option 3: Enterprise (Future)
```
Tools:
  - Full monitoring stack (Prometheus + Grafana)
  - Custom indexer on own infrastructure
  - ML-based anomaly detection
  - 24/7 monitoring service
  - Redundant alerting channels

Cost: ~$5K/month
Setup time: 1 month
```

---

## 🚨 **ALERT CHANNELS**

### Critical (Immediate Response Required)
```
Triggers:
  - Pause event
  - Ownership transfer
  - Reserve drops to zero
  - Exploit detected

Channels:
  - PagerDuty (phone call)
  - SMS to all team members
  - Discord @everyone
  - Email (high priority)

Response time: <5 minutes
```

### High Priority (Same Day Response)
```
Triggers:
  - Large trade (>$100K)
  - Price movement >20% in 1 hour
  - Failed transaction spike
  - RPC failures

Channels:
  - Discord notification
  - Email
  - Slack alert

Response time: <4 hours
```

### Medium Priority (Next Day)
```
Triggers:
  - Daily volume trends
  - Parameter changes
  - New users/whales

Channels:
  - Daily summary email
  - Dashboard review

Response time: <24 hours
```

### Low Priority (Weekly Review)
```
Triggers:
  - Long-term trends
  - Optimization opportunities
  - User feedback

Channels:
  - Weekly report
  - Team meeting discussion

Response time: Next sprint
```

---

## 📝 **MONITORING CHECKLIST**

### Pre-Launch (Week 1)
- [ ] Set up Tenderly alerts
- [ ] Create Discord webhook for critical events
- [ ] Simple script for balance/price checking
- [ ] Document response procedures
- [ ] Test alert system on testnet

### Month 1
- [ ] Deploy comprehensive monitoring (Option 2)
- [ ] Historical data collection started
- [ ] Dashboard with key metrics
- [ ] On-call rotation established
- [ ] Post-mortem process for incidents

### Month 3
- [ ] Optimize alerts (reduce false positives)
- [ ] Advanced analytics dashboards
- [ ] Automated responses for common issues
- [ ] Public dashboard for transparency

---

## 🔧 **SAMPLE IMPLEMENTATION**

### Tenderly Alert Examples

**Reserve Drop Alert**
```javascript
// Tenderly Alert Configuration
Event: reserveBalance < initialReserve * 0.2
Action: Webhook to Discord
Message: "⚠️ CRITICAL: Reserve dropped to {reserveBalance} USDC"
```

**Large Trade Alert**
```javascript
// Tenderly Alert
Event: Buy.reserveIn > 10000 * 1e6  // $10K
Action: Webhook to Discord
Message: "🐋 Large trade: {buyer} bought {tokensOut} tokens for ${reserveIn}"
```

### Simple Monitoring Script
```javascript
// scripts/monitor.js
const CHECK_INTERVAL = 60000; // 1 minute

setInterval(async () => {
  const reserve = await pool.reserveBalance();
  const price = await pool.spotPrice();
  const supply = await token.totalSupply();

  // Log to database
  await logMetrics({ reserve, price, supply });

  // Check alerts
  if (reserve < RESERVE_THRESHOLD) {
    await sendAlert("Low reserve warning");
  }
}, CHECK_INTERVAL);
```

---

## 📚 **RESOURCES**

- **Tenderly**: https://tenderly.co (monitoring + alerts)
- **The Graph**: https://thegraph.com (event indexing)
- **Dune Analytics**: https://dune.com (public dashboards)
- **Grafana**: https://grafana.com (internal dashboards)
- **PagerDuty**: https://pagerduty.com (incident response)

---

**Last Updated:** 2026-01-14
**Status:** Draft for mainnet launch preparation
