# Infrastructure Cost Accrual Monitoring

Extension to the existing Hokusai AMM monitoring system for the Infrastructure Cost Accrual feature.

## Overview

The Infrastructure Monitor extends the existing monitoring system to track:
- Infrastructure accrual balances per model
- Payment history and runway calculations
- Infrastructure/profit split ratios
- Provider management
- Critical infrastructure conditions

## Integration with Existing Monitoring

The Infrastructure Monitor integrates seamlessly with the existing AMM monitoring:

```
┌─────────────────────────────────────────────────┐
│              AMM Monitor (Main)                  │
│         (Existing Orchestrator)                  │
└────────────┬────────────────────────────────────┘
             │
    ┌────────┴───────┬──────────┬────────────┬─────────────────┐
    │                │          │            │                 │
┌───▼────────┐  ┌───▼──────┐ ┌─▼────────┐ ┌▼────────────┐ ┌──▼───────────────┐
│   Pool     │  │  State   │ │  Event   │ │   Metrics   │ │ Infrastructure   │
│ Discovery  │  │ Tracker  │ │ Listener │ │  Collector  │ │    Monitor       │
└────────────┘  └──────────┘ └──────────┘ └─────────────┘ └──────────────────┘
                                                                  (NEW)
```

## Features

### 1. Accrual Balance Tracking
- Real-time monitoring of infrastructure accrual balances
- Historical tracking (1-hour window)
- Net accrual calculation (accrued - paid)

### 2. Runway Monitoring
- Calculate days until infrastructure accrual depleted
- Based on estimated daily burn rate
- Critical alerts at <3 days
- Warning alerts at <7 days

### 3. Payment Tracking
- Monitor all infrastructure payments
- Alert on large payments (>50% of accrued by default)
- Track cumulative payments per model
- Record invoice hashes for audit trail

### 4. Split Ratio Monitoring
- Track infrastructure/profit split per model
- Alert when governance changes split ratio
- Historical split changes

### 5. Provider Management
- Alert when no provider set
- Track provider changes
- Monitor payment recipients

## Configuration

### Environment Variables

Add to existing `.env` file:

```bash
# Infrastructure Monitoring
INFRA_MONITORING_ENABLED=true
INFRA_MONITORING_INTERVAL_MS=60000     # 1 minute (less frequent than AMM state)

# Infrastructure Alert Thresholds
ALERT_CRITICAL_RUNWAY_DAYS=3           # Critical alert if runway <3 days
ALERT_LOW_RUNWAY_DAYS=7                # Warning alert if runway <7 days
ALERT_LARGE_PAYMENT_PCT=50             # Alert if payment >50% of accrued
ALERT_ON_SPLIT_CHANGE=true             # Alert when governance changes split
ALERT_NO_PROVIDER=true                 # Alert if provider not set

# Daily Burn Rates (USD) - Set per model for runway calculation
MODEL_21_DAILY_BURN_RATE=100           # LSCOR model: $100/day estimate
# Add more as needed: MODEL_<id>_DAILY_BURN_RATE
```

### Deployment Configuration

The Infrastructure Monitor automatically loads contract addresses from:
```
../../deployments/{network}-v2-latest.json
```

New fields in deployment artifact:
```json
{
  "contracts": {
    "InfrastructureReserve": "0x...",
    "UsageFeeRouter": "0x..."  // V2 - no protocol fee
  },
  "tokens": [
    {
      "modelId": "21",
      "paramsAddress": "0x...",  // HokusaiParams address
      "infrastructureAccrualBps": 8000  // 80% default
    }
  ]
}
```

## Usage

### Basic Integration

```typescript
import { AMMMonitor } from './monitoring';
import { InfrastructureMonitor } from './monitoring/infrastructure-monitor';

// Existing AMM monitor
const ammMonitor = new AMMMonitor();

// New infrastructure monitor
const infraMonitor = new InfrastructureMonitor(
  provider,
  infraReserveAddress,
  {
    criticalRunwayDays: 3,
    lowRunwayDays: 7,
    largePaymentPercentage: 50,
    alertOnSplitChange: true,
    alertNoProvider: true
  },
  {
    onAlert: async (alert) => {
      console.log(`Infrastructure Alert: ${alert.message}`);
      // Use same alert system as AMM
      await ammMonitor.sendAlert(alert);
    },
    onStateUpdate: async (state) => {
      console.log(`Infrastructure state updated for ${state.modelId}`);
      // Log metrics, update dashboard, etc.
    }
  }
);

// Start both monitors
await ammMonitor.start();

// Start infrastructure monitoring for each model
for (const token of deployment.tokens) {
  const dailyBurnRate = process.env[`MODEL_${token.modelId}_DAILY_BURN_RATE`];
  await infraMonitor.startMonitoring(
    token.modelId,
    token.paramsAddress,
    60000, // 1 minute polling
    dailyBurnRate ? parseFloat(dailyBurnRate) : undefined
  );
}

// Get infrastructure metrics
const state = infraMonitor.getCurrentState('21');
console.log(`Model 21 runway: ${state?.runwayDays} days`);

// Stop monitoring
await infraMonitor.stopAll();
await ammMonitor.stop();
```

### API Endpoints

Add to existing monitoring server:

```typescript
// GET /infrastructure/metrics
app.get('/infrastructure/metrics', (req, res) => {
  const states = infraMonitor.getAllCurrentStates();
  const metrics = Array.from(states.entries()).map(([modelId, state]) => ({
    modelId,
    accruedUSD: state.accruedUSD,
    paidUSD: state.paidUSD,
    netAccrualUSD: state.netAccrualUSD,
    infrastructureAccrualBps: state.infrastructureAccrualBps,
    profitShareBps: state.profitShareBps,
    runwayDays: state.runwayDays,
    provider: state.provider
  }));

  res.json({
    models: metrics,
    totalAccruedUSD: metrics.reduce((sum, m) => sum + m.accruedUSD, 0),
    totalPaidUSD: metrics.reduce((sum, m) => sum + m.paidUSD, 0)
  });
});

// GET /infrastructure/:modelId
app.get('/infrastructure/:modelId', (req, res) => {
  const state = infraMonitor.getCurrentState(req.params.modelId);
  if (!state) {
    return res.status(404).json({ error: 'Model not found' });
  }

  res.json({
    modelId: state.modelId,
    accrual: {
      accrued: state.accruedUSD,
      paid: state.paidUSD,
      net: state.netAccrualUSD
    },
    split: {
      infrastructure: `${state.infrastructureAccrualBps / 100}%`,
      profit: `${state.profitShareBps / 100}%`
    },
    runway: state.runwayDays ? `${state.runwayDays} days` : 'N/A',
    provider: state.provider,
    lastUpdate: state.timestamp
  });
});

// GET /infrastructure/:modelId/history
app.get('/infrastructure/:modelId/history', (req, res) => {
  const history = infraMonitor.getStateHistory(req.params.modelId);
  res.json({
    modelId: req.params.modelId,
    dataPoints: history.length,
    history: history.map(s => ({
      timestamp: s.timestamp,
      accruedUSD: s.accruedUSD,
      paidUSD: s.paidUSD,
      runwayDays: s.runwayDays
    }))
  });
});

// GET /infrastructure/status
app.get('/infrastructure/status', (req, res) => {
  const status = infraMonitor.getStatus();
  res.json(status);
});
```

## Alert Types

### Critical Alerts (Immediate Response - <5 min)

**🚨 Critical Runway**
- **Trigger:** Runway < 3 days
- **Message:** "CRITICAL: Infrastructure runway < 3 days (2 days remaining)"
- **Action:**
  1. Increase infrastructure accrual rate immediately
  2. Reduce infrastructure spend
  3. Add emergency funds to reserve
  4. Notify treasury multisig

**🚨 Payment Failed**
- **Trigger:** Payment transaction reverts
- **Message:** "Infrastructure payment failed for Model 21"
- **Action:**
  1. Check accrued balance
  2. Verify PAYER_ROLE permissions
  3. Check gas limits
  4. Retry payment

### High Priority Alerts (Same Day Response)

**⚠️ Low Runway**
- **Trigger:** Runway < 7 days
- **Message:** "Infrastructure runway low: 5 days remaining"
- **Action:**
  1. Review cost projections
  2. Consider adjusting accrual rate
  3. Monitor daily
  4. Plan for rate adjustment if needed

**⚠️ Large Payment**
- **Trigger:** Payment > 50% of accrued balance
- **Message:** "Large infrastructure payment: $5,000 (65% of accrued balance)"
- **Action:**
  1. Verify invoice validity
  2. Review payment necessity
  3. Check provider address
  4. Log for audit

### Medium Priority Alerts (Next Day)

**📊 Split Change**
- **Trigger:** Governance changes infrastructure accrual rate
- **Message:** "Infrastructure split changed from 80% to 70% by governance"
- **Action:**
  1. Document change reason
  2. Update forecasts
  3. Notify stakeholders
  4. Monitor impact

**📊 No Provider**
- **Trigger:** Provider address not set
- **Message:** "No infrastructure provider set for Model 21"
- **Action:**
  1. Set provider address
  2. Verify provider contract/EOA
  3. Update documentation

## Enhanced Metrics Dashboard

Extend existing metrics API with infrastructure data:

```typescript
// Enhanced /metrics endpoint
app.get('/metrics', (req, res) => {
  const ammMetrics = ammMonitor.getMetrics();
  const infraStates = infraMonitor.getAllCurrentStates();

  // Calculate infrastructure metrics
  const infraMetrics = {
    totalAccruedUSD: 0,
    totalPaidUSD: 0,
    modelsWithCriticalRunway: 0,
    modelsWithLowRunway: 0,
    averageRunwayDays: 0,
    models: []
  };

  for (const [modelId, state] of infraStates) {
    infraMetrics.totalAccruedUSD += state.accruedUSD;
    infraMetrics.totalPaidUSD += state.paidUSD;

    if (state.runwayDays !== undefined) {
      if (state.runwayDays < 3) infraMetrics.modelsWithCriticalRunway++;
      if (state.runwayDays < 7) infraMetrics.modelsWithLowRunway++;
      infraMetrics.averageRunwayDays += state.runwayDays;
    }

    infraMetrics.models.push({
      modelId,
      accruedUSD: state.accruedUSD,
      runwayDays: state.runwayDays,
      split: `${state.infrastructureAccrualBps / 100}/${state.profitShareBps / 100}`
    });
  }

  if (infraMetrics.models.length > 0) {
    infraMetrics.averageRunwayDays /= infraMetrics.models.length;
  }

  res.json({
    // Existing AMM metrics
    amm: ammMetrics,

    // New infrastructure metrics
    infrastructure: infraMetrics
  });
});
```

## Monitoring Best Practices

### Pre-Launch

1. ✅ Set initial daily burn rate estimates per model
2. ✅ Configure alert thresholds (3/7 day runway)
3. ✅ Set provider addresses for all models
4. ✅ Test alert delivery for infrastructure events
5. ✅ Verify runway calculations are accurate

### During Operation

1. **Daily Review:**
   - Check runway for all models
   - Review overnight infrastructure deposits/payments
   - Verify split ratios are appropriate

2. **Weekly Review:**
   - Update daily burn rate estimates based on actual costs
   - Adjust infrastructure accrual rates if needed
   - Review payment history for anomalies

3. **Monthly Review:**
   - Analyze infrastructure vs profit trends
   - Adjust per-model splits based on cost profiles
   - Update provider addresses if needed

### Runway Management

**Target Runway:** 30+ days (1 month buffer)

**Critical Thresholds:**
- < 7 days: Warning - review and adjust
- < 3 days: Critical - immediate action required
- 0 days: Emergency - pause model or emergency funding

**Actions to Increase Runway:**
1. Increase infrastructure accrual % (governance action)
2. Reduce infrastructure spend (optimize costs)
3. Emergency deposit to InfrastructureReserve
4. Temporarily pause expensive models

## CloudWatch Integration (Optional)

Extend existing CloudWatch metrics:

```typescript
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';

async function publishInfraMetrics() {
  const cwClient = new CloudWatchClient({ region: 'us-east-1' });
  const states = infraMonitor.getAllCurrentStates();

  for (const [modelId, state] of states) {
    await cwClient.send(new PutMetricDataCommand({
      Namespace: 'Hokusai/Infrastructure',
      MetricData: [
        {
          MetricName: 'AccruedBalance',
          Value: state.accruedUSD,
          Unit: 'None',
          Dimensions: [{ Name: 'ModelId', Value: modelId }]
        },
        {
          MetricName: 'RunwayDays',
          Value: state.runwayDays || 0,
          Unit: 'Count',
          Dimensions: [{ Name: 'ModelId', Value: modelId }]
        },
        {
          MetricName: 'InfrastructureSplit',
          Value: state.infrastructureAccrualBps,
          Unit: 'None',
          Dimensions: [{ Name: 'ModelId', Value: modelId }]
        }
      ]
    }));
  }
}

// Publish every 5 minutes
setInterval(publishInfraMetrics, 5 * 60 * 1000);
```

## Troubleshooting

**Monitor not starting:**
- Verify InfrastructureReserve address in deployment artifact
- Check HokusaiParams addresses for each model
- Ensure provider connection is healthy

**No runway calculated:**
- Set `MODEL_<id>_DAILY_BURN_RATE` environment variable
- Verify dailyBurnRateUSD is passed to `startMonitoring()`
- Check that accrued balance > 0

**Alerts not triggering:**
- Verify `INFRA_MONITORING_ENABLED=true`
- Check threshold values (criticalRunwayDays, etc.)
- Confirm alert callback is configured
- Check alert manager rate limits

**Incorrect runway calculation:**
- Verify daily burn rate is in USD
- Check accrued balance is accurate
- Ensure getAccrualRunway() is returning expected value

## Testing

```bash
# Unit tests
npm test -- --grep "Infrastructure Monitor"

# Integration test on Sepolia
NETWORK=sepolia \
INFRA_MONITORING_ENABLED=true \
MODEL_21_DAILY_BURN_RATE=100 \
npx tsx src/examples/infrastructure-monitoring-example.ts

# Simulate low runway alert
# 1. Deploy with small infrastructure accrual
# 2. Set high daily burn rate
# 3. Verify alert triggers when runway < 7 days
```

## Future Enhancements (Phase 2+)

- [ ] Predictive runway forecasting (ML-based)
- [ ] Automatic accrual rate adjustment recommendations
- [ ] Cost optimization suggestions
- [ ] Provider performance tracking
- [ ] Multi-currency support (ETH, other stablecoins)
- [ ] Invoice verification automation
- [ ] Public infrastructure dashboard

## Version History

**Version 1.0.0** (2026-02-05)
- Initial infrastructure monitoring implementation
- Runway tracking and alerts
- Payment monitoring
- Split ratio tracking
- Provider management

---

**Maintained by:** Hokusai Team
**Documentation:** See main monitoring README and PRD
