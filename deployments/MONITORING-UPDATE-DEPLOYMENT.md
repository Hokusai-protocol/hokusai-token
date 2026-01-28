# Phase-Aware Monitoring Update Deployment Guide

**Feature:** HOK-673 - Phase-Aware Alert System
**Status:** Ready for Deployment
**Target:** Testnet (Sepolia) Monitoring Service

---

## Overview

This deployment updates the **monitoring service only** - no smart contract changes are required. The monitoring service will detect phase information from existing deployed contracts at runtime.

### What's Changed

1. **Phase Detection**: Monitoring now reads `getCurrentPhase()`, `FLAT_CURVE_THRESHOLD()`, and `FLAT_CURVE_PRICE()` from AMM pools
2. **Alert Suppression**: Percentage-based alerts (reserve_drop, price_spike, supply_anomaly) are suppressed during FLAT_PRICE phase
3. **Supply Invariant Check**: New `true_supply_mismatch` alert detects unauthorized minting/burning in BONDING_CURVE phase
4. **Enhanced Email Alerts**: Phase context included in all alerts; red warning box for supply invariant violations

### What's NOT Changed

- ❌ No contract deployments
- ❌ No contract modifications
- ❌ No on-chain state changes
- ✅ Only monitoring service code update

---

## Prerequisites

1. **Docker** installed with buildx support
2. **AWS CLI** configured with valid credentials
3. **npm** installed (for TypeScript build)
4. **jq** installed (for JSON parsing)

```bash
# Verify prerequisites
docker --version
aws sts get-caller-identity
npm --version
jq --version
```

---

## Deployment Steps

### Option A: Automated Deployment (Recommended)

```bash
cd services/contract-deployer
./scripts/deploy-monitoring.sh
```

This script will:
1. Build TypeScript (compile src/ to dist/)
2. Build AMD64 Docker image
3. Push to ECR (932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring)
4. Update ECS service (hokusai-monitor-testnet)
5. Monitor deployment progress

### Option B: Manual Deployment

```bash
cd services/contract-deployer

# Step 1: Build TypeScript
npm run build

# Step 2: Build Docker image (AMD64 for AWS Fargate)
docker buildx build --platform linux/amd64 -t hokusai-monitoring:latest --load .

# Step 3: Tag for ECR
docker tag hokusai-monitoring:latest 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring:latest

# Step 4: Login to ECR
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com

# Step 5: Push to ECR
docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring:latest

# Step 6: Update ECS service
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-monitor-testnet \
  --force-new-deployment \
  --region us-east-1

# Step 7: Monitor deployment
aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-monitor-testnet \
  --region us-east-1 \
  --query 'services[0].{runningCount:runningCount,desiredCount:desiredCount,deployments:deployments}'
```

---

## Verification

### 1. Check Service Health

```bash
# Watch CloudWatch logs
aws logs tail /ecs/hokusai-monitor-testnet --follow --region us-east-1
```

**Look for:**
- ✅ `Monitoring server started on port 8002`
- ✅ `State tracking started for <modelId>`
- ✅ `Checking anomalies for <modelId>` with phase information

### 2. Verify Phase Detection

Expected log output:
```
Checking anomalies for model-conservative-001 {
  phase: 'FLAT_PRICE',
  reserveUSD: 5000,
  threshold: 25000
}
```

or

```
Checking anomalies for model-aggressive-002 {
  phase: 'BONDING_CURVE',
  reserveUSD: 30000,
  threshold: 25000
}
```

### 3. Verify Alert Suppression (Flat Phase)

Expected log output during FLAT_PRICE phase:
```
Suppressing percentage-based alerts for model-conservative-001 (flat phase)
```

### 4. Check Suppression Statistics

The monitoring service tracks how many alerts were suppressed:
```bash
# Query monitoring API
curl http://localhost:8002/api/monitoring/stats
```

Expected response includes:
```json
{
  "suppressedAlerts": {
    "total": 45,
    "byType": {
      "reserve_drop": 12,
      "price_spike": 8,
      "supply_anomaly": 15,
      "low_reserve": 10
    }
  }
}
```

### 5. Test Alert Emails

If any alerts fire, check email (tim@hokus.ai → me@timogilvie.com) for:
- ✅ Phase information in email body
- ✅ "Flat Price (Bootstrap)" or "Bonding Curve (Active)" label
- ✅ Phase threshold displayed
- ✅ Red warning box for `true_supply_mismatch` alerts (if any)

---

## Rollback Plan

If the deployment fails or causes issues:

```bash
# Force redeployment of previous task definition
aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-monitor-testnet \
  --region us-east-1 \
  --query 'services[0].taskDefinition' \
  --output text

# Note the previous task definition revision, then:
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-monitor-testnet \
  --task-definition hokusai-contracts-task:<PREVIOUS_REVISION> \
  --force-new-deployment \
  --region us-east-1
```

---

## Optional: Backfill Deployment Artifacts

To update `sepolia-latest.json` with phase parameters from deployed contracts:

```bash
cd /Users/timothyogilvie/Dropbox/Hokusai/hokusai-token
npx hardhat run scripts/backfill-phase-params.js --network sepolia
```

This will:
1. Read existing `deployments/sepolia-latest.json`
2. Query each pool for `FLAT_CURVE_THRESHOLD` and `FLAT_CURVE_PRICE`
3. Add phase parameters to pool objects
4. Save updated JSON (creates backup first)

**Note:** This is optional. The monitoring service fetches phase parameters directly from contracts at runtime, so the deployment JSON update is purely for documentation/auditing purposes.

---

## Monitoring Behavior Changes

### Before Update
- ❌ No phase awareness
- ❌ False positives during bootstrap (large supply changes trigger alerts)
- ❌ No supply invariant validation

### After Update
- ✅ Phase-aware alerting
- ✅ Suppresses percentage-based alerts during FLAT_PRICE phase
- ✅ Continues critical alerts (paused, high_fees) in all phases
- ✅ Detects supply invariant violations (unauthorized minting/burning)
- ✅ Enhanced email formatting with phase context

---

## Expected Behavior by Phase

### FLAT_PRICE Phase (pricingPhase = 0)
**Characteristics:**
- Reserve < threshold (e.g., < $25,000)
- Fixed price (e.g., $0.01)
- Large supply changes are normal and healthy

**Alerts ACTIVE:**
- ✅ `paused` - Pool is paused
- ✅ `high_fees` - Treasury fees exceed threshold

**Alerts SUPPRESSED:**
- 🔇 `reserve_drop` - Large reserve changes expected
- 🔇 `price_spike` - Price is fixed
- 🔇 `supply_anomaly` - Large supply changes are normal
- 🔇 `low_reserve` - Reserve grows during bootstrap
- 🔇 `true_supply_mismatch` - Complex validation, skipped

### BONDING_CURVE Phase (pricingPhase = 1)
**Characteristics:**
- Reserve ≥ threshold (e.g., ≥ $25,000)
- Exponential bonding curve pricing
- Supply/reserve ratio should match CRR

**Alerts ACTIVE:**
- ✅ `paused` - Pool is paused
- ✅ `high_fees` - Treasury fees exceed threshold
- ✅ `reserve_drop` - 10% drop in 1 hour
- ✅ `price_spike` - 5% spike in 5 minutes
- ✅ `supply_anomaly` - Unusual supply changes
- ✅ `low_reserve` - Reserve below minimum
- ✅ **`true_supply_mismatch`** - Reserve ratio deviates >5% from CRR

---

## Success Criteria

- ✅ Service deploys successfully
- ✅ No errors in CloudWatch logs
- ✅ Phase detection logs appear
- ✅ Alert suppression logs appear (if in flat phase)
- ✅ No false positive alerts during bootstrap
- ✅ Service remains stable for 48 hours

---

## Support

**Issues or Questions:**
- Check CloudWatch Logs: `/ecs/hokusai-monitor-testnet`
- Review [testnet-monitoring-status.md](testnet-monitoring-status.md)
- See implementation: [features/phase-aware-alerts/](../features/phase-aware-alerts/)

**Key Files:**
- Monitoring logic: `services/contract-deployer/src/monitoring/state-tracker.ts`
- Alert formatting: `services/contract-deployer/src/monitoring/alert-manager.ts`
- Phase detection: `services/contract-deployer/src/monitoring/state-tracker.ts:276-302`
