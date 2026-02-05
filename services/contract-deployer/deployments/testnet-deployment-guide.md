# Testnet Deployment Guide - AMM Monitoring System

This guide walks through deploying the Hokusai AMM monitoring system to Sepolia testnet for validation before mainnet deployment.

## Overview

**Goal**: Deploy and validate monitoring system on testnet for 48 hours before mainnet launch

**Timeline**:
- Day 0: Setup and deployment
- Day 1-2: 48-hour burn-in test
- Day 3: Review results, prepare for mainnet

## Prerequisites

### 1. Local Development Setup

```bash
# Pull latest merged code
git checkout main
git pull origin main

# Install dependencies
cd services/contract-deployer
npm install

# Verify TypeScript compilation
npm run build
```

### 2. AWS Account Access

Ensure you have:
- AWS CLI configured with credentials
- Access to Hokusai AWS account (932100697590)
- Permissions for: ECS, ECR, SES, SSM, CloudWatch, IAM

```bash
# Verify AWS access
aws sts get-caller-identity
aws configure list
```

### 3. Testnet Resources

- ✅ Sepolia RPC URL (Alchemy)
- ✅ Testnet ETH for gas (at least 1 ETH)
- ✅ Testnet USDC (for pool reserves)
- ✅ Deployer wallet with private key

## Phase 1: AWS SES Email Setup

### Step 1.1: Verify Sender Email

```bash
# Verify the "from" email address
aws ses verify-email-identity \
  --email-address alerts@hokus.ai \
  --region us-east-1

# Alternative: Use your personal email for testing
aws ses verify-email-identity \
  --email-address me@timogilvie.com \
  --region us-east-1
```

**Check verification status:**
```bash
aws ses get-identity-verification-attributes \
  --identities alerts@hokus.ai me@timogilvie.com \
  --region us-east-1
```

You'll receive a verification email. Click the link to verify.

### Step 1.2: Verify Recipient Email (SES Sandbox)

If your AWS SES is in sandbox mode:

```bash
# Verify recipient email
aws ses verify-email-identity \
  --email-address me@timogilvie.com \
  --region us-east-1
```

**Note**: In production, request to move out of SES sandbox:
```bash
# Check current status
aws ses get-account-sending-enabled --region us-east-1

# To move out of sandbox: AWS Console > SES > Account Dashboard > Request Production Access
```

### Step 1.3: Test Email Sending

```bash
# Send test email
aws ses send-email \
  --from alerts@hokus.ai \
  --destination "ToAddresses=me@timogilvie.com" \
  --message "Subject={Data='Test Alert',Charset=utf8},Body={Text={Data='This is a test alert from Hokusai monitoring',Charset=utf8}}" \
  --region us-east-1
```

✅ **Checkpoint**: Confirm test email received

## Phase 2: Deploy Contracts to Sepolia

### Step 2.1: Prepare Deployment Configuration

Create testnet deployment script based on mainnet version:

```bash
# Copy and modify for testnet
cp scripts/deploy-mainnet.js scripts/deploy-sepolia.js
```

Update `deploy-sepolia.js`:
```javascript
// Change USDC address to Sepolia USDC
const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238"; // Sepolia USDC

// Reduce initial reserves for testing
const POOL_CONFIGS = {
  conservative: {
    initialReserve: ethers.parseUnits("100", 6), // $100 USDC
    // ... rest of config
  }
};
```

### Step 2.2: Get Testnet ETH and USDC

```bash
# Get Sepolia ETH from faucet
# https://sepoliafaucet.com/
# https://www.alchemy.com/faucets/ethereum-sepolia

# Get Sepolia USDC from faucet or swap
# Use Uniswap on Sepolia to swap ETH -> USDC
```

### Step 2.3: Deploy Contracts

```bash
# Set environment
export NETWORK=sepolia
export SEPOLIA_RPC_URL="https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY"
export DEPLOYER_PRIVATE_KEY="your-testnet-private-key"

# Run deployment
cd /Users/timothyogilvie/Dropbox/Hokusai/hokusai-token
npx hardhat run scripts/deploy-sepolia.js --network sepolia
```

**Expected output:**
```
✅ ModelRegistry deployed: 0x1234...
✅ TokenManager deployed: 0x5678...
✅ DataContributionRegistry deployed: 0x9abc...
✅ HokusaiAMMFactory deployed: 0xdef0...
✅ UsageFeeRouter deployed: 0x1111...
✅ DeltaVerifier deployed: 0x2222...

📝 Deployment saved to: deployments/sepolia-latest.json
```

### Step 2.4: Create Test Pools

```bash
# Create 2-3 small test pools
node scripts/create-sepolia-pools.js

# Or manually via Hardhat console
npx hardhat console --network sepolia
```

Example pool creation:
```javascript
const factory = await ethers.getContractAt("HokusaiAMMFactory", "0xdef0...");
await factory.createPool(
  "test-model-001",
  "0xTokenAddress",
  300000, // 30% CRR
  25,     // 0.25% fee
  7 * 24 * 60 * 60 // 7 day IBR
);
```

✅ **Checkpoint**: Verify `deployments/sepolia-latest.json` exists with all contract addresses and pools

## Phase 3: Configure SSM Parameters

### Step 3.1: Store Testnet Configuration

```bash
# Network configuration
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/network" \
  --value "sepolia" \
  --type "String" \
  --overwrite

# Sepolia RPC URL
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/sepolia_rpc_url" \
  --value "https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY" \
  --type "SecureString" \
  --overwrite

# Backup RPC
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/backup_rpc_url" \
  --value "https://sepolia.infura.io/v3/YOUR_INFURA_KEY" \
  --type "SecureString" \
  --overwrite

# Alert configuration
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alert_email" \
  --value "me@timogilvie.com" \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/hokusai/development/monitoring/enabled" \
  --value "true" \
  --type "String" \
  --overwrite
```

### Step 3.2: Verify Parameters

```bash
# List all monitoring parameters
aws ssm get-parameters-by-path \
  --path "/hokusai/development/monitoring" \
  --with-decryption \
  --region us-east-1
```

## Phase 4: Build and Push Docker Image

### Step 4.1: Build Docker Image

```bash
cd services/contract-deployer

# Build image
docker build -t hokusai-contracts:testnet .

# Verify build
docker images | grep hokusai-contracts
```

### Step 4.2: Push to ECR

```bash
# Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com

# Tag image
docker tag hokusai-contracts:testnet \
  932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet

# Push to ECR
docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet
```

✅ **Checkpoint**: Verify image in ECR console

## Phase 5: Update ECS Task Definition

### Step 5.1: Create Testnet Task Definition

Create `ecs/task-definition-testnet.json`:

```json
{
  "family": "hokusai-contracts-task",
  "taskRoleArn": "arn:aws:iam::932100697590:role/hokusai-contracts-task-role",
  "executionRoleArn": "arn:aws:iam::932100697590:role/hokusai-contracts-execution-role",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "contract-deployer",
      "image": "932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet",
      "essential": true,
      "portMappings": [
        {
          "containerPort": 8002,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "development"},
        {"name": "PORT", "value": "8002"},
        {"name": "NETWORK", "value": "sepolia"},
        {"name": "MONITORING_ENABLED", "value": "true"},
        {"name": "POOL_DISCOVERY_ENABLED", "value": "true"},
        {"name": "EVENT_LISTENERS_ENABLED", "value": "true"},
        {"name": "STATE_POLLING_ENABLED", "value": "true"},
        {"name": "ALERTS_ENABLED", "value": "true"},
        {"name": "MONITORING_INTERVAL_MS", "value": "12000"},
        {"name": "ALERT_EMAIL_FROM", "value": "alerts@hokus.ai"},
        {"name": "AWS_SES_REGION", "value": "us-east-1"},
        {"name": "MAX_ALERTS_PER_HOUR", "value": "20"},
        {"name": "MAX_ALERTS_PER_DAY", "value": "100"},
        {"name": "ALERT_DEDUP_WINDOW_MS", "value": "300000"}
      ],
      "secrets": [
        {"name": "SEPOLIA_RPC_URL", "valueFrom": "/hokusai/development/monitoring/sepolia_rpc_url"},
        {"name": "BACKUP_RPC_URL", "valueFrom": "/hokusai/development/monitoring/backup_rpc_url"},
        {"name": "ALERT_EMAIL", "valueFrom": "/hokusai/development/monitoring/alert_email"},
        {"name": "REDIS_HOST", "valueFrom": "/hokusai/development/contracts/redis_host"},
        {"name": "REDIS_PORT", "valueFrom": "/hokusai/development/contracts/redis_port"}
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/hokusai-contracts",
          "awslogs-region": "us-east-1",
          "awslogs-stream-prefix": "testnet"
        }
      },
      "healthCheck": {
        "command": ["CMD-SHELL", "curl -f http://localhost:8002/health || exit 1"],
        "interval": 30,
        "timeout": 5,
        "retries": 3,
        "startPeriod": 60
      }
    }
  ]
}
```

### Step 5.2: Register Task Definition

```bash
aws ecs register-task-definition \
  --cli-input-json file://ecs/task-definition-testnet.json \
  --region us-east-1
```

## Phase 6: Deploy to ECS

### Step 6.1: Update ECS Service

```bash
# Update service to use new task definition
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --task-definition hokusai-contracts-task \
  --force-new-deployment \
  --region us-east-1
```

### Step 6.2: Monitor Deployment

```bash
# Watch service deployment
aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1 \
  --query 'services[0].deployments'

# Wait for stable
aws ecs wait services-stable \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1
```

### Step 6.3: Check CloudWatch Logs

```bash
# Tail logs
aws logs tail /ecs/hokusai-contracts \
  --follow \
  --format short \
  --filter-pattern "STARTUP"

# Look for monitoring initialization
aws logs tail /ecs/hokusai-contracts \
  --follow \
  --filter-pattern "AMM Monitor"
```

Expected log output:
```
[STARTUP] AMM Monitor initialized
[STARTUP] Initializing AMM monitoring...
🚀 Starting AMM Monitor...
========================
Network:          sepolia
Pools Monitored:  2
State Polling:    ENABLED (12000ms)
Event Listeners:  ENABLED
Pool Discovery:   ENABLED
Alerts:           ENABLED
Alert Email:      me@timogilvie.com
========================
```

✅ **Checkpoint**: Service running and monitoring initialized

## Phase 7: Verify Monitoring Components

### Step 7.1: Test Health Endpoint

```bash
# Get service URL
SERVICE_URL="https://contracts.hokus.ai"  # Or ECS task public IP

# Check health
curl $SERVICE_URL/health
# Expected: {"status":"ok","timestamp":"..."}

# Check monitoring health
curl $SERVICE_URL/api/monitoring/health | jq
```

Expected response:
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "isHealthy": true,
    "uptime": 60000,
    "poolsMonitored": 2,
    "components": {
      "poolDiscovery": true,
      "stateTracking": true,
      "eventListening": true,
      "metricsCollection": true
    }
  }
}
```

### Step 7.2: Verify Pool Discovery

```bash
# List discovered pools
curl $SERVICE_URL/api/monitoring/pools | jq

# Check specific pool state
POOL_ADDRESS="0x..."
curl $SERVICE_URL/api/monitoring/pools/$POOL_ADDRESS/state | jq
```

### Step 7.3: Check Metrics

```bash
# Get system metrics
curl $SERVICE_URL/api/monitoring/metrics | jq

# Get summary
curl $SERVICE_URL/api/monitoring/summary | jq
```

### Step 7.4: Monitor Logs for State Polling

```bash
# Watch state tracker logs
aws logs tail /ecs/hokusai-contracts \
  --follow \
  --filter-pattern "📊"

# Should see updates every 12 seconds
```

✅ **Checkpoint**: All components reporting healthy

## Phase 8: Test Alert System

### Step 8.1: Trigger Test Alerts

**Option A: Manual Alert Trigger (if you added test endpoint)**

```bash
# Trigger test alert via API
curl -X POST $SERVICE_URL/api/monitoring/test-alert \
  -H "Content-Type: application/json" \
  -d '{"type":"reserve_drop","priority":"high"}'
```

**Option B: Simulate Real Conditions**

Execute a large trade on testnet to trigger whale alert:

```bash
# Connect to pool contract
npx hardhat console --network sepolia

# Execute large buy (>$10K equivalent in testnet)
const pool = await ethers.getContractAt("HokusaiAMM", "0x...");
const usdc = await ethers.getContractAt("IERC20", "0x...");

// Approve large amount
await usdc.approve(pool.address, ethers.parseUnits("15000", 6));

// Execute buy
await pool.buy(ethers.parseUnits("15000", 6), 0);
```

**Option C: Pause Pool (Security Event)**

```bash
# Pause pool to trigger security alert
const pool = await ethers.getContractAt("HokusaiAMM", "0x...");
await pool.pause();
```

### Step 8.2: Verify Email Received

Check your inbox (me@timogilvie.com) for alert email:

Expected email:
```
Subject: ⚠️ HIGH: Hokusai AMM Alert - WHALE TRADE

🐋 Large BUY: $15,000.00
Pool: test-pool-001 (0x...)
Trader: 0x...
Tokens: 123,456.78
Fee: $37.50
Price: $0.001234
```

### Step 8.3: Verify Rate Limiting

```bash
# Trigger multiple alerts rapidly
for i in {1..15}; do
  # Trigger alert
  echo "Triggering alert $i"
  # ... (use one of the methods above)
  sleep 2
done

# Check alert stats
curl $SERVICE_URL/api/monitoring/alerts/stats | jq
```

Expected stats showing rate limiting:
```json
{
  "totalAlertsSent": 10,
  "totalAlertsDropped": 5,
  "totalAlertsDeduplicated": 3
}
```

✅ **Checkpoint**: Alerts working, rate limiting functional

## Phase 9: 48-Hour Burn-In Test

### Step 9.1: Execute Test Trades

Create script to execute periodic test trades:

```bash
# Create test-trades.sh
cat > test-trades.sh << 'EOF'
#!/bin/bash
for i in {1..50}; do
  echo "Trade $i at $(date)"
  npx hardhat run scripts/execute-test-trade.js --network sepolia
  sleep 1800  # Wait 30 minutes
done
EOF

chmod +x test-trades.sh
./test-trades.sh &
```

### Step 9.2: Monitor During Burn-In

Create monitoring dashboard script:

```bash
# monitor-testnet.sh
while true; do
  clear
  echo "=== Hokusai Testnet Monitoring ==="
  echo "Time: $(date)"
  echo ""

  echo "Health:"
  curl -s $SERVICE_URL/api/monitoring/health | jq -r '.data.status'
  echo ""

  echo "Pools Monitored:"
  curl -s $SERVICE_URL/api/monitoring/pools | jq -r '.data.count'
  echo ""

  echo "Recent Alerts (24h):"
  curl -s $SERVICE_URL/api/monitoring/alerts/recent | jq -r '.data.count'
  echo ""

  echo "Metrics:"
  curl -s $SERVICE_URL/api/monitoring/metrics | jq '.data.systemMetrics | {tvl: .totalTVL, volume24h: .totalVolume24h, trades24h: .totalTrades24h}'
  echo ""

  echo "Alert Stats:"
  curl -s $SERVICE_URL/api/monitoring/alerts/stats | jq '{sent: .data.totalAlertsSent, dropped: .data.totalAlertsDropped, deduped: .data.totalAlertsDeduplicated}'

  sleep 300  # Update every 5 minutes
done
```

### Step 9.3: Validation Checklist

Monitor and verify over 48 hours:

**Functionality Checks:**
- [ ] State polling continues every 12s without interruption
- [ ] Pool discovery detects any new pools created
- [ ] Buy/Sell events are captured in real-time
- [ ] Metrics accumulate correctly over 24h windows
- [ ] Alert emails are delivered successfully
- [ ] Rate limiting prevents alert storms
- [ ] Deduplication works (no duplicate alerts within 5 min)
- [ ] Provider failover works (test by throttling Alchemy)
- [ ] Service restarts gracefully (test with ECS task stop)
- [ ] Memory usage stable (<150MB)

**Performance Checks:**
- [ ] CPU usage <10% average
- [ ] RPC calls within Alchemy limits
- [ ] No memory leaks over 48 hours
- [ ] Response times <500ms for API endpoints
- [ ] Log volume manageable (<100MB/day)

**Alert Checks:**
- [ ] Reserve drop alerts trigger correctly
- [ ] Price change alerts trigger correctly
- [ ] Whale trade alerts trigger correctly
- [ ] Security event alerts trigger correctly
- [ ] Email format is readable and informative
- [ ] Alert priority levels are appropriate

### Step 9.4: Collect Metrics

```bash
# Export 48-hour metrics
curl $SERVICE_URL/api/monitoring/summary > testnet-results-48h.json

# Get CloudWatch metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ECS \
  --metric-name CPUUtilization \
  --dimensions Name=ServiceName,Value=hokusai-contracts-development \
  --start-time $(date -u -d '48 hours ago' +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 3600 \
  --statistics Average,Maximum \
  --region us-east-1

# Get alert history
curl $SERVICE_URL/api/monitoring/alerts/recent > testnet-alerts-48h.json
```

## Phase 10: Prepare for Mainnet

### Step 10.1: Review Test Results

Create summary report:

```markdown
# Testnet Validation Results

## Duration
- Start: [DATE]
- End: [DATE]
- Total: 48 hours

## Pools Monitored
- Pool 1: [Address] - [X] trades, $[Y] volume
- Pool 2: [Address] - [X] trades, $[Y] volume

## System Performance
- Uptime: 100%
- Average CPU: [X]%
- Average Memory: [X]MB
- API Response Time: [X]ms

## Alerts
- Total Sent: [X]
- Critical: [X]
- High: [X]
- Medium: [X]
- False Positives: [X]

## Issues Found
- [List any issues]

## Recommendations
- [Any adjustments needed]

## Mainnet Readiness: ✅ READY / ❌ NOT READY
```

### Step 10.2: Update Configuration for Mainnet

Create mainnet environment file:

```bash
# .env.mainnet
NETWORK=mainnet
MONITORING_ENABLED=true
POOL_DISCOVERY_ENABLED=true
EVENT_LISTENERS_ENABLED=true
STATE_POLLING_ENABLED=true
ALERTS_ENABLED=true
MONITORING_INTERVAL_MS=12000

# More conservative rate limits for mainnet
MAX_ALERTS_PER_HOUR=5
MAX_ALERTS_PER_DAY=20
ALERT_DEDUP_WINDOW_MS=600000  # 10 minutes

# Lower alert thresholds for mainnet
ALERT_RESERVE_DROP_PCT=15
ALERT_PRICE_CHANGE_1H_PCT=15
ALERT_LARGE_TRADE_USD=25000
```

### Step 10.3: Mainnet Pre-Flight Checklist

Before deploying to mainnet:

**AWS Setup:**
- [ ] SES moved out of sandbox (production access)
- [ ] Verified sender domain (not just email)
- [ ] CloudWatch alarms configured
- [ ] SSM parameters for mainnet created
- [ ] IAM roles have necessary permissions
- [ ] Backup RPC endpoint configured

**Monitoring Configuration:**
- [ ] Alert thresholds reviewed and adjusted
- [ ] Rate limits set appropriately
- [ ] Email recipient list finalized
- [ ] Backup notification channels ready (Slack/Discord)

**Infrastructure:**
- [ ] ECS service scaled appropriately (2+ tasks)
- [ ] Auto-scaling configured
- [ ] Health checks tuned
- [ ] Log retention set to 30 days
- [ ] Backup and disaster recovery plan

**Contracts:**
- [ ] All contracts deployed to mainnet
- [ ] Pools created with real liquidity
- [ ] Ownership verified
- [ ] Contract addresses in mainnet-latest.json

**Documentation:**
- [ ] Runbook created for common issues
- [ ] Escalation procedures documented
- [ ] Contact information updated

## Emergency Procedures

### If Monitoring Fails

```bash
# Quick disable
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --task-definition hokusai-contracts-task-no-monitoring \
  --force-new-deployment
```

### If Alert Storm Occurs

```bash
# Temporarily increase rate limits via SSM
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/max_alerts_per_hour" \
  --value "50" \
  --overwrite

# Or disable alerts entirely
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alerts_enabled" \
  --value "false" \
  --overwrite

# Restart service to pick up changes
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --force-new-deployment
```

### If RPC Fails

The system should automatically failover to backup RPC. Verify:

```bash
# Check logs for failover
aws logs tail /ecs/hokusai-contracts \
  --filter-pattern "failover"

# Manually update RPC if needed
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/sepolia_rpc_url" \
  --value "NEW_RPC_URL" \
  --overwrite
```

## Useful Commands

```bash
# Quick status check
alias hokusai-status='curl -s https://contracts.hokus.ai/api/monitoring/summary | jq'

# Tail logs
alias hokusai-logs='aws logs tail /ecs/hokusai-contracts --follow --format short'

# Restart service
alias hokusai-restart='aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --force-new-deployment'

# Check health
alias hokusai-health='curl -s https://contracts.hokus.ai/api/monitoring/health | jq .data.status'
```

## Next Steps

After successful testnet validation:

1. **Deploy to Mainnet** - Follow mainnet deployment checklist
2. **Monitor Closely** - First 72 hours critical
3. **Iterate** - Adjust thresholds based on real data
4. **Phase 3 & 4** - Implement remaining monitoring features

## Support

For issues during deployment:
- CloudWatch Logs: `/ecs/hokusai-contracts`
- Monitoring API: `https://contracts.hokus.ai/api/monitoring/health`
- AWS ECS Console: `hokusai-development` cluster
