# Testnet Deployment Checklist

Quick reference checklist for deploying AMM monitoring to Sepolia testnet.

## Pre-Deployment (15 minutes)

### AWS Setup
- [ ] AWS CLI configured: `aws sts get-caller-identity`
- [ ] Access to Hokusai account (932100697590)
- [ ] Docker running: `docker ps`
- [ ] Node.js installed: `node --version` (v18+)

### Email Setup (AWS SES)
```bash
# Verify sender email
aws ses verify-email-identity --email-address alerts@hokus.ai --region us-east-1

# Verify recipient email
aws ses verify-email-identity --email-address me@timogilvie.com --region us-east-1

# Check inbox for verification emails and click links

# Test email
aws ses send-email \
  --from alerts@hokus.ai \
  --destination "ToAddresses=me@timogilvie.com" \
  --message "Subject={Data='Test',Charset=utf8},Body={Text={Data='Test',Charset=utf8}}" \
  --region us-east-1
```

**✅ Checkpoint**: Received test email successfully

## Quick Start (5 minutes)

### Option 1: Use Quick Start Script (Recommended)

```bash
cd deployments
./testnet-quickstart.sh
```

The script will:
1. ✅ Verify prerequisites
2. ✅ Setup AWS SES
3. ✅ Configure SSM parameters
4. ✅ Build Docker image
5. ✅ Push to ECR
6. ✅ Deploy to ECS
7. ✅ Verify deployment

### Option 2: Manual Deployment

If you prefer manual control, follow these steps:

#### 1. Configure SSM Parameters

```bash
# Store RPC URL
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/sepolia_rpc_url" \
  --value "https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY" \
  --type "SecureString" \
  --overwrite

# Store alert email
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alert_email" \
  --value "me@timogilvie.com" \
  --type "String" \
  --overwrite

# Enable monitoring
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/enabled" \
  --value "true" \
  --type "String" \
  --overwrite
```

#### 2. Build and Push Docker Image

```bash
cd services/contract-deployer

# Install and build
npm install
npm run build

# Build Docker image
docker build -t hokusai-contracts:testnet .

# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com

# Tag and push
docker tag hokusai-contracts:testnet \
  932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet

docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet
```

#### 3. Deploy to ECS

```bash
# Force new deployment
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --force-new-deployment \
  --region us-east-1

# Wait for stable
aws ecs wait services-stable \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1
```

**✅ Checkpoint**: ECS service shows "Running" status

## Verification (5 minutes)

### 1. Check Service Health

```bash
SERVICE_URL="https://contracts.hokus.ai"

# Basic health
curl $SERVICE_URL/health

# Monitoring health
curl $SERVICE_URL/api/monitoring/health | jq
```

Expected:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "isHealthy": true,
    "poolsMonitored": 0,
    "components": {
      "poolDiscovery": true,
      "stateTracking": true,
      "eventListening": true,
      "metricsCollection": true
    }
  }
}
```

### 2. Check CloudWatch Logs

```bash
# Tail logs
aws logs tail /ecs/hokusai-contracts --follow --format short

# Look for monitoring initialization
aws logs tail /ecs/hokusai-contracts --filter-pattern "AMM Monitor"
```

Expected log output:
```
[STARTUP] Initializing AMM monitoring...
🚀 Starting AMM Monitor...
========================
Network:          sepolia
State Polling:    ENABLED (12000ms)
Event Listeners:  ENABLED
Pool Discovery:   ENABLED
Alerts:           ENABLED
Alert Email:      me@timogilvie.com
========================
AMM Monitor started successfully
```

### 3. Verify Components

```bash
# List pools (should auto-discover if any exist)
curl $SERVICE_URL/api/monitoring/pools | jq

# Check metrics
curl $SERVICE_URL/api/monitoring/metrics | jq

# View summary
curl $SERVICE_URL/api/monitoring/summary | jq
```

**✅ Checkpoint**: All API endpoints responding

## Deploy Test Contracts (30 minutes)

### 1. Get Testnet Resources

- Sepolia ETH: https://sepoliafaucet.com/
- Sepolia USDC: Swap on Uniswap Sepolia

### 2. Deploy Contracts

```bash
# Set environment
export NETWORK=sepolia
export SEPOLIA_RPC_URL="your-rpc-url"
export DEPLOYER_PRIVATE_KEY="your-key"

# Deploy (if deploy-sepolia.js exists)
npx hardhat run scripts/deploy-sepolia.js --network sepolia

# Or use mainnet script with testnet config
# (modify USDC address and reduce initial reserves)
```

### 3. Create Test Pools

```bash
# Via Hardhat console
npx hardhat console --network sepolia

# Create small test pool
const factory = await ethers.getContractAt("HokusaiAMMFactory", "FACTORY_ADDRESS");
await factory.createPool(
  "test-model-001",
  "TOKEN_ADDRESS",
  300000,  // 30% CRR
  25,      // 0.25% fee
  604800   // 7 day IBR
);
```

### 4. Verify Pools Discovered

```bash
# Wait 30 seconds, then check
curl $SERVICE_URL/api/monitoring/pools | jq

# Should show your new pool
```

**✅ Checkpoint**: Pools discovered and being monitored

## Test Alerts (15 minutes)

### Method 1: Execute Large Trade (Whale Alert)

```bash
npx hardhat console --network sepolia

# Get contracts
const pool = await ethers.getContractAt("HokusaiAMM", "POOL_ADDRESS");
const usdc = await ethers.getContractAt("IERC20", "USDC_ADDRESS");

# Approve and buy (trigger >$10K alert)
await usdc.approve(pool.address, ethers.parseUnits("15000", 6));
await pool.buy(ethers.parseUnits("15000", 6), 0);
```

### Method 2: Pause Pool (Security Alert)

```bash
# Pause pool to trigger security event
const pool = await ethers.getContractAt("HokusaiAMM", "POOL_ADDRESS");
await pool.pause();
```

### Verify Alert Received

1. Check email inbox (me@timogilvie.com)
2. Check alert stats:
   ```bash
   curl $SERVICE_URL/api/monitoring/alerts/stats | jq
   curl $SERVICE_URL/api/monitoring/alerts/recent | jq
   ```

**✅ Checkpoint**: Alert email received with correct details

## Live Monitoring (Ongoing)

### Option 1: Use Dashboard Script

```bash
cd deployments
./monitor-testnet.sh
```

This provides a live updating dashboard showing:
- Service health
- Pool metrics
- Recent alerts
- System stats

### Option 2: Manual Monitoring Commands

```bash
# Quick status
alias hk-status='curl -s https://contracts.hokus.ai/api/monitoring/summary | jq'

# Watch logs
alias hk-logs='aws logs tail /ecs/hokusai-contracts --follow'

# Check health
alias hk-health='curl -s https://contracts.hokus.ai/api/monitoring/health | jq .data.status'

# Use them
hk-status
hk-health
hk-logs
```

## 48-Hour Burn-In Test

### Day 1: Initial Testing

**Morning:**
- [ ] Deploy monitoring ✅
- [ ] Deploy contracts ✅
- [ ] Create 2-3 test pools ✅
- [ ] Verify all components working ✅
- [ ] Execute 3-5 test trades
- [ ] Trigger 1-2 test alerts

**Afternoon:**
- [ ] Monitor for 4 hours continuously
- [ ] Check memory usage stable
- [ ] Verify no error logs
- [ ] Confirm metrics accumulating

**Evening:**
- [ ] Execute batch of test trades (10-15)
- [ ] Monitor overnight
- [ ] Set up CloudWatch alarms if needed

### Day 2: Continuous Operation

**Morning:**
- [ ] Check overnight logs
- [ ] Review metrics from last 24h
- [ ] Verify 24h rolling windows working
- [ ] Check alert statistics

**Afternoon:**
- [ ] Execute stress test (rapid trades)
- [ ] Test rate limiting (>10 alerts/hour)
- [ ] Verify deduplication working
- [ ] Test RPC failover (if possible)

**Evening:**
- [ ] Final health check
- [ ] Export 48h metrics
- [ ] Document any issues found
- [ ] Prepare mainnet configuration

### Validation Checklist

After 48 hours, verify:

**Stability:**
- [ ] Service uptime: 100%
- [ ] No crashes or restarts
- [ ] Memory usage stable (<150MB)
- [ ] CPU usage <10% average
- [ ] No error spikes in logs

**Functionality:**
- [ ] State polling continuous (every 12s)
- [ ] Events captured in real-time
- [ ] Metrics accurate over 24h windows
- [ ] Pool discovery working
- [ ] Alerts delivered successfully

**Performance:**
- [ ] API response times <500ms
- [ ] RPC calls within limits
- [ ] No blocked requests
- [ ] Database queries efficient

**Alerts:**
- [ ] Email delivery 100%
- [ ] Rate limiting effective
- [ ] No false positives
- [ ] Priority levels appropriate
- [ ] Email format readable

## Troubleshooting

### Service Won't Start

```bash
# Check logs
aws logs tail /ecs/hokusai-contracts --format short | grep ERROR

# Check task status
aws ecs describe-tasks \
  --cluster hokusai-development \
  --tasks $(aws ecs list-tasks --cluster hokusai-development --service-name hokusai-contracts-development --query 'taskArns[0]' --output text) \
  --query 'tasks[0].{status:lastStatus,reason:stoppedReason,containers:containers[0].reason}'
```

### Monitoring Not Initializing

```bash
# Verify SSM parameters
aws ssm get-parameters-by-path \
  --path "/hokusai/development/monitoring" \
  --with-decryption

# Check environment variable
aws ecs describe-task-definition \
  --task-definition hokusai-contracts-task \
  --query 'taskDefinition.containerDefinitions[0].environment'
```

### No Pools Discovered

```bash
# Check logs for PoolCreated events
aws logs tail /ecs/hokusai-contracts --filter-pattern "PoolCreated"

# Verify factory address in deployment artifact
# Should be in deployments/sepolia-latest.json

# Check if pools exist on-chain
npx hardhat console --network sepolia
const factory = await ethers.getContractAt("HokusaiAMMFactory", "ADDRESS");
await factory.getPoolCount();
```

### Alerts Not Received

```bash
# Check SES verification
aws ses get-identity-verification-attributes \
  --identities alerts@hokus.ai me@timogilvie.com \
  --region us-east-1

# Check alert stats
curl $SERVICE_URL/api/monitoring/alerts/stats | jq

# Check if alerts are being generated
curl $SERVICE_URL/api/monitoring/alerts/recent | jq

# Look for SES errors in logs
aws logs tail /ecs/hokusai-contracts --filter-pattern "SES"
```

## Success Criteria

Before proceeding to mainnet, ensure:

✅ **All systems operational for 48 consecutive hours**
✅ **At least 10 alerts successfully sent and received**
✅ **At least 50 transactions monitored**
✅ **No memory leaks or performance degradation**
✅ **All components showing healthy status**
✅ **Rate limiting and deduplication working correctly**
✅ **Documentation complete and accurate**

## Next Steps

Once testnet validation is complete:

1. Document results in `testnet-validation-report.md`
2. Update mainnet configuration based on learnings
3. Review `deployments/testnet-deployment-guide.md` for full mainnet prep
4. Schedule mainnet deployment window
5. Prepare rollback plan
6. Brief team on monitoring capabilities

---

**Questions?** See full guide: `deployments/testnet-deployment-guide.md`
