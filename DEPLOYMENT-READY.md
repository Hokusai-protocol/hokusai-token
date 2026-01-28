# Alchemy Optimizations - Ready to Deploy

**Date**: 2026-01-22
**Status**: ✅ READY
**Docker Image**: `hokusai-monitoring:optimized`

---

## What's Been Optimized

### 1. WebSocket Provider ✅
- **File**: `services/contract-deployer/src/monitoring/amm-monitor.ts`
- **Change**: Auto-converts HTTPS → WSS URLs, uses WebSocket instead of HTTP polling
- **Impact**: Eliminates ~10,000 event polling calls/day

### 2. Static Data Caching ✅
- **File**: `services/contract-deployer/src/monitoring/state-tracker.ts`
- **Change**: Caches immutable data (token address, USDC address)
- **Impact**: Reduces from 7 → 5 RPC calls per poll

### 3. Single Pool Monitoring ✅
- **File**: `services/contract-deployer/deployments/sepolia-latest.json`
- **Change**: Only tracks LSCOR pool (removed 3 old test pools)
- **Impact**: Reduces monitoring load by 67%

---

## Expected Results

| Metric | Before | After | Savings |
|--------|--------|-------|---------|
| **Pools** | 3 | 1 | -67% |
| **RPC Calls/Day** | ~25,000 | ~3,700 | **-85%** |
| **Cost** | High usage | Well within free tier | Significant headroom |

---

## Quick Deploy (AWS ECS)

### If monitoring service is NOT currently deployed:
**No action needed** - optimizations will be active on first deployment.

### If monitoring service IS currently deployed:

```bash
# 1. Tag and push image to ECR
aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com
docker tag hokusai-monitoring:optimized 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring:latest
docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai-monitoring:latest

# 2. Update ECS service
aws ecs update-service --cluster hokusai-production --service contract-deployer-monitoring --force-new-deployment

# 3. Monitor deployment
aws logs tail /ecs/hokusai-monitoring --follow
```

**Look for in logs**:
- ✅ `"Using WebSocket provider for event listening"` or `"Converted to WebSocket provider"`
- ✅ `"Cached token address for sales-lead-scoring-v2"`
- ✅ `"Starting state tracking for sales-lead-scoring-v2"` (only 1 pool)

---

## Alternative: Deploy Without AWS

If you don't have AWS ECS or want to test locally:

```bash
# Run locally with Docker
docker run --rm \
  -e SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY \
  -e NETWORK=sepolia \
  -e MONITORING_ENABLED=true \
  -e STATE_POLLING_ENABLED=true \
  -e EVENT_LISTENERS_ENABLED=true \
  -e MONITORING_INTERVAL_MS=120000 \
  -p 8002:8002 \
  hokusai-monitoring:optimized
```

---

## Verification Checklist

After deployment, verify:

- [ ] Service started successfully (check logs)
- [ ] WebSocket connection established (look for log message)
- [ ] Only 1 pool being monitored (LSCOR/sales-lead-scoring-v2)
- [ ] Caching active (look for "Cached token address" messages)
- [ ] No errors in logs for 5 minutes
- [ ] Alchemy dashboard shows decreasing request count (check after 1 hour)

---

## Files Changed

**Code**:
- `services/contract-deployer/src/monitoring/amm-monitor.ts` - WebSocket provider
- `services/contract-deployer/src/monitoring/state-tracker.ts` - Caching

**Config**:
- `deployments/sepolia-latest.json` - 1 pool (LSCOR)
- `services/contract-deployer/deployments/sepolia-latest.json` - 1 pool (LSCOR)

**Docker**:
- `services/contract-deployer/Dockerfile` - No changes (uses code above)

---

## Rollback Plan

If issues arise:

```bash
# Revert to previous ECS task definition
aws ecs update-service \
  --cluster hokusai-production \
  --service contract-deployer-monitoring \
  --task-definition contract-deployer-monitoring:PREVIOUS_VERSION
```

---

## Documentation

- **[DEPLOY-ALCHEMY-OPTIMIZATIONS.md](DEPLOY-ALCHEMY-OPTIMIZATIONS.md)** - Full deployment guide
- **[ALCHEMY-OPTIMIZATIONS-APPLIED.md](ALCHEMY-OPTIMIZATIONS-APPLIED.md)** - Technical details
- **[ALCHEMY-USAGE-SUMMARY.md](ALCHEMY-USAGE-SUMMARY.md)** - Original analysis

---

**Status**: ✅ Ready to deploy
**Risk**: 🟢 Low (automatic rollback available)
**Downtime**: ~1-2 minutes (rolling update)
