# Production Deployment: RPC Optimization

## Overview

This guide covers deploying the RPC-optimized monitoring system to production ECS.

## Changes Summary

**Files Modified:**
- `src/monitoring/state-tracker.ts` - Event-driven updates (98% RPC reduction)
- `src/config/monitoring-config.ts` - Updated defaults (12s → 5min fallback)

**Files Added:**
- `src/monitoring/multicall-helper.ts` - Batching helper for future use
- `RPC-OPTIMIZATION.md` - Full optimization documentation

## Pre-Deployment Checklist

- [ ] Code changes reviewed and tested locally
- [ ] TypeScript compiles without errors (`npm run build`)
- [ ] No breaking changes to monitoring API
- [ ] Rollback plan identified (existing ECS task definition)

## Deployment Steps

### Step 1: Build TypeScript

```bash
cd services/contract-deployer

# Clean and rebuild
rm -rf dist/
npm run build

# Verify build succeeded
ls -la dist/monitoring/
```

Expected output should include:
- `dist/monitoring/state-tracker.js`
- `dist/monitoring/multicall-helper.js`
- `dist/config/monitoring-config.js`

### Step 2: Build and Push Docker Image

```bash
# From services/contract-deployer directory

# Build and push to ECR
./scripts/build-and-push.sh

# This will:
# 1. Build Docker image with optimized code
# 2. Tag with version, git hash, and timestamp
# 3. Push to ECR: 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts
```

Expected tags pushed:
- `latest`
- `1.0.0` (version from package.json)
- `<git-hash>` (current commit)
- `development-<timestamp>`

### Step 3: Deploy to ECS

```bash
# Deploy latest image to development cluster
./scripts/deploy.sh

# Or deploy specific tag
./scripts/deploy.sh --tag <git-hash>

# This will:
# 1. Create new ECS task definition with new image
# 2. Update ECS service with rolling deployment
# 3. Wait for deployment to complete (max 10 minutes)
# 4. Verify health check
# 5. Auto-rollback if deployment fails
```

### Step 4: Monitor Deployment

Watch ECS service deployment:

```bash
# Check service status
aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1

# Watch CloudWatch logs
aws logs tail /ecs/hokusai-contracts-development \
  --follow \
  --region us-east-1
```

Look for log messages indicating event-driven mode:
```
Starting state tracking for <model> (<address>), mode: event-driven + periodic fallback
State tracking started for <model> (event-driven + 300000ms fallback)
```

### Step 5: Verify Optimization

**Check RPC call reduction:**

1. Monitor Alchemy dashboard for 15-30 minutes
2. Compare RPC call rate before/after:
   - **Before**: ~600 calls/hour per pool
   - **After**: ~12 calls/hour per pool

**Check monitoring still works:**

```bash
# Test monitoring API
curl https://contracts.hokus.ai/monitoring/status

# Should show:
# - Pools being tracked
# - Recent state updates
# - Event counts
```

**Verify events are firing:**

```bash
# Check CloudWatch logs for event-driven updates
aws logs filter-log-events \
  --log-group-name /ecs/hokusai-contracts-development \
  --filter-pattern "event-driven" \
  --region us-east-1 \
  --start-time $(date -u -d '5 minutes ago' +%s)000
```

## Rollback Procedure

If issues arise, rollback is automatic but can be manual:

### Automatic Rollback
The deployment script auto-rolls back if:
- Health checks fail
- Deployment times out (10 min)
- ECS tasks fail to start

### Manual Rollback

```bash
# List recent task definitions
aws ecs list-task-definitions \
  --family-prefix hokusai-contracts-task \
  --sort DESC \
  --max-items 5 \
  --region us-east-1

# Rollback to previous version
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --task-definition hokusai-contracts-task:<previous-revision> \
  --force-new-deployment \
  --region us-east-1
```

### Emergency: Disable Event-Driven Mode

If the new event-driven mode causes issues, you can disable it via environment variable without redeploying:

1. Update ECS task definition environment:
   ```json
   {
     "name": "STATE_POLLING_ENABLED",
     "value": "true"
   },
   {
     "name": "MONITORING_INTERVAL_MS",
     "value": "60000"
   }
   ```

2. Force new deployment:
   ```bash
   aws ecs update-service \
     --cluster hokusai-development \
     --service hokusai-contracts-development \
     --force-new-deployment \
     --region us-east-1
   ```

This reverts to polling mode at 60s intervals (still better than 12s).

## Post-Deployment Verification

### RPC Usage (15-30 min after deployment)

Check Alchemy dashboard metrics:
- [ ] `eth_getFilterChanges` calls dropped to ~0
- [ ] `eth_blockNumber` calls dropped significantly
- [ ] `eth_call` frequency reduced by ~95%
- [ ] Overall RPC usage down ~98%

### Monitoring Functionality

- [ ] Pool discovery still working
- [ ] Trade alerts still firing
- [ ] State updates still happening
- [ ] CloudWatch metrics still being published
- [ ] Email alerts still working (if enabled)

### Performance

- [ ] Service memory usage stable
- [ ] CPU usage reduced (less polling overhead)
- [ ] Response times unchanged
- [ ] No error spikes in logs

## Expected Metrics

### Before Optimization
```
RPC Calls: ~600/hour/pool
- eth_call: ~300/hour
- eth_getFilterChanges: ~200/hour
- eth_blockNumber: ~100/hour
```

### After Optimization
```
RPC Calls: ~12/hour/pool
- eth_call: ~12/hour (fallback polling only)
- eth_getFilterChanges: 0 (WebSocket events)
- eth_blockNumber: 0 (event-driven)
```

### Cost Impact (Alchemy)
- **Before**: ~432K calls/month/pool
- **After**: ~8.6K calls/month/pool
- **Savings**: 98% reduction

## Troubleshooting

### Issue: Events not firing

**Symptom**: No state updates happening, logs show only fallback polls every 5 min

**Cause**: WebSocket connection issues

**Fix**:
```bash
# Check if provider supports WebSocket
curl https://eth-sepolia.g.alchemy.com/v2/<API_KEY> \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"net_version","params":[],"id":1}'

# Restart service to reconnect WebSocket
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --force-new-deployment \
  --region us-east-1
```

### Issue: RPC usage still high

**Symptom**: Alchemy dashboard shows calls still at old levels

**Cause**: Old tasks still running, or cache not cleared

**Fix**:
```bash
# Force stop all old tasks
aws ecs list-tasks \
  --cluster hokusai-development \
  --service-name hokusai-contracts-development \
  --region us-east-1 \
  --query 'taskArns[]' \
  --output text | xargs -I {} aws ecs stop-task --cluster hokusai-development --task {} --region us-east-1

# Service will auto-start new tasks
```

### Issue: Memory leak

**Symptom**: Memory usage growing over time

**Cause**: Event listeners not cleaned up on pool removal

**Fix**: Already handled in code, but to clear manually:
```bash
# Restart service
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --force-new-deployment \
  --region us-east-1
```

## Support

If issues persist:

1. Check CloudWatch logs: `/ecs/hokusai-contracts-development`
2. Check ECS service events: AWS Console → ECS → hokusai-contracts-development
3. Check Alchemy dashboard for RPC patterns
4. Roll back to previous version
5. Contact DevOps team

## Related Documentation

- [RPC-OPTIMIZATION.md](../../RPC-OPTIMIZATION.md) - Full optimization details
- [README.md](README.md) - Service overview
- [DEPLOYMENT.md](DEPLOYMENT.md) - General deployment guide
