# Hokusai AMM Monitoring System

Real-time monitoring for Hokusai AMM pools with automatic pool discovery, state tracking, event listening, and metrics collection.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              AMM Monitor                         │
│         (Main Orchestrator)                      │
└────────────┬────────────────────────────────────┘
             │
    ┌────────┴───────┬──────────┬────────────┐
    │                │          │            │
┌───▼────────┐  ┌───▼──────┐ ┌─▼────────┐ ┌▼────────────┐
│   Pool     │  │  State   │ │  Event   │ │   Metrics   │
│ Discovery  │  │ Tracker  │ │ Listener │ │  Collector  │
└────────────┘  └──────────┘ └──────────┘ └─────────────┘
```

## Components

### 1. **AMM Monitor** (`amm-monitor.ts`)
Main orchestrator that coordinates all monitoring components.

**Features:**
- Automatic startup/shutdown
- Provider failover (backup RPC)
- Alert aggregation
- Health checks
- Metrics API

### 2. **Pool Discovery** (`pool-discovery.ts`)
Automatically discovers AMM pools.

**Features:**
- Load initial pools from deployment artifact
- Listen for `PoolCreated` events from Factory
- Query factory for existing pools
- Callback system for new pools

### 3. **State Tracker** (`state-tracker.ts`)
Polls pool state every 12 seconds.

**Features:**
- Track reserve, price, supply, paused status
- Maintain 1-hour history (~300 states)
- Detect anomalies (reserve drops, price spikes)
- Alert on threshold breaches

### 4. **Event Listener** (`event-listener.ts`)
Listens for blockchain events in real-time.

**Events Monitored:**
- `Buy` / `Sell` - Trading activity
- `FeesDeposited` - Fee tracking
- `Paused` / `Unpaused` - Security events
- `OwnershipTransferred` - Critical security
- `ParametersUpdated` - Governance changes

### 5. **Metrics Collector** (`metrics-collector.ts`)
Aggregates trading metrics.

**Metrics:**
- Per-pool: volume, trades, fees, unique traders
- System-wide: TVL, 24h volume, total trades
- Rolling 24h window for recent activity

## Configuration

### Environment Variables

```bash
# Network
NETWORK=mainnet                   # or sepolia
MAINNET_RPC_URL=https://...
BACKUP_RPC_URL=https://...        # Optional

# Monitoring
MONITORING_ENABLED=true
MONITORING_INTERVAL_MS=12000      # 12 seconds = 1 block
MONITORING_START_BLOCK=latest     # or specific block number

# Pool Discovery
POOL_DISCOVERY_ENABLED=true
EVENT_LISTENERS_ENABLED=true
STATE_POLLING_ENABLED=true

# Alerts
ALERTS_ENABLED=true
ALERT_EMAIL=me@timogilvie.com
AWS_SES_REGION=us-east-1

# Alert Thresholds
ALERT_RESERVE_DROP_PCT=20         # Alert if reserve drops >20%
ALERT_PRICE_CHANGE_1H_PCT=20      # Alert if price changes >20% in 1h
ALERT_LARGE_TRADE_USD=10000       # Alert on trades >$10k
ALERT_RESERVE_MIN_USD=1000        # Alert if reserve <$1k
```

### Deployment Configuration

Monitoring automatically loads contract addresses from:
```
../../deployments/{network}-latest.json
```

## Usage

### Basic Usage

```typescript
import { AMMMonitor } from './monitoring';

// Create monitor (loads config from environment)
const monitor = new AMMMonitor();

// Register alert callback
monitor.onAlert(async (alert) => {
  console.log(`Alert: ${alert.message}`);
  // Send email/webhook
});

// Start monitoring
await monitor.start();

// Get metrics
const metrics = monitor.getMetrics();
console.log(`TVL: $${metrics.totalTVL}`);

// Stop monitoring
await monitor.stop();
```

### Run Example

```bash
cd services/contract-deployer

# Configure environment
cp .env.example .env
# Edit .env with your configuration

# Run example
npx tsx src/examples/amm-monitoring-example.ts
```

### Integration with Existing Service

```typescript
// In your existing server.ts or index.ts
import { AMMMonitor } from './monitoring';

const monitor = new AMMMonitor();

// Start monitoring on server startup
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // Start AMM monitoring
  await monitor.start();
});

// Health endpoint
app.get('/health', (req, res) => {
  const health = monitor.getHealth();
  res.json(health);
});

// Metrics endpoint
app.get('/metrics', (req, res) => {
  const metrics = monitor.getMetrics();
  res.json(metrics);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await monitor.stop();
  server.close();
});
```

## Alert Types

### Critical Alerts (Immediate Response)
- 🚨 **Paused**: Pool emergency pause activated
- 🚨 **Ownership Transferred**: Contract ownership changed
- 🚨 **Reserve Drop**: Reserve dropped >20% in 1 hour
- 🚨 **Zero Reserve**: Reserve balance is zero

### High Priority Alerts (Same Day Response)
- ⚠️ **Whale Trade**: Single trade >$10,000
- ⚠️ **Price Spike**: Price changed >20% in 1 hour
- ⚠️ **Supply Anomaly**: Supply changed >15% in 1 hour
- ⚠️ **Parameters Updated**: Pool parameters changed

### Medium Priority Alerts (Next Day)
- 📊 **Low Reserve**: Reserve below $1,000
- 📊 **High Fees**: Treasury fees >$50,000
- 📊 **New Pool**: New pool discovered

## Monitoring Best Practices

### Pre-Launch
1. Test on Sepolia testnet first
2. Verify all contract addresses
3. Test alert delivery
4. Confirm metrics accuracy
5. Run for 48 hours without issues

### During Operation
1. Monitor health endpoint regularly
2. Review metrics daily
3. Investigate all critical alerts within 5 minutes
4. Tune thresholds based on actual volatility
5. Keep backup RPC configured

### Troubleshooting

**Monitor won't start:**
- Check RPC URL is correct
- Verify contract addresses in deployment artifact
- Check network matches configured chainId

**No events detected:**
- Verify event listeners are enabled
- Check provider WebSocket connection
- Confirm pools exist and have activity

**Alerts not triggering:**
- Verify ALERTS_ENABLED=true
- Check threshold values
- Confirm email is configured

**High memory usage:**
- Reduce state history length (maxHistoryLength)
- Clear old metrics periodically
- Restart service daily

## API Reference

### AMMMonitor

```typescript
class AMMMonitor {
  // Start/Stop
  async start(): Promise<void>
  async stop(): Promise<void>

  // Status
  getHealth(): AMMMonitorHealth
  isMonitoring(): boolean

  // Data Access
  getMetrics(): SystemMetrics
  getPoolMetrics(poolAddress: string): PoolMetrics
  getPoolState(poolAddress: string): PoolState
  getPools(): PoolConfig[]

  // Configuration
  getConfig(): MonitoringConfig

  // Alerts
  onAlert(callback: (alert) => Promise<void>): void
}
```

### Health Status

```typescript
interface AMMMonitorHealth {
  status: 'healthy' | 'degraded' | 'unhealthy'
  uptime: number
  poolsMonitored: number
  componentsStatus: {
    poolDiscovery: boolean
    stateTracking: boolean
    eventListening: boolean
    metricsCollection: boolean
  }
  lastUpdateTime: number
  errors?: string[]
}
```

## Testing

```bash
# Unit tests
npm test

# Integration test on Sepolia
NETWORK=sepolia npx tsx src/examples/amm-monitoring-example.ts

# Load test (simulate high trading volume)
# TODO: Create load test script
```

## Future Enhancements (Phase 2+)

- [ ] Email notifications via AWS SES
- [ ] Discord/Slack webhook integration
- [ ] CloudWatch metrics publishing
- [ ] Historical data persistence (TimescaleDB)
- [ ] Advanced analytics (ML-based anomaly detection)
- [ ] Public dashboard
- [ ] Multi-region redundancy

## Support

- **Issues:** Create GitHub issue
- **Security:** Email me@timogilvie.com
- **Documentation:** See main README and deployment guide

---

**Version:** 1.0.0 (Phase 1)
**Last Updated:** 2026-01-14
