# 504 Gateway Timeout Fix - Contract Deployer API

## Issue Summary
After fixing the ALB routing to properly route `contracts.hokus.ai` to the Contract Deployer service, the service was returning 504 Gateway Timeout errors. The container was running but not responding to HTTP requests.

## Root Cause
The Express.js server was not binding to the correct network interface. By default, when calling `app.listen(port, callback)`, Express binds only to localhost/127.0.0.1. In a containerized environment, the server must bind to `0.0.0.0` to accept connections from outside the container.

## The Fix

### Code Change
Modified `/services/contract-deployer/src/server.ts`:

```typescript
// BEFORE - Only binds to localhost
const server = app.listen(port, () => {
  logger.info(`API listening on port ${port}`);
});

// AFTER - Binds to all interfaces
const host = '0.0.0.0'; // Bind to all network interfaces for container accessibility
const server = app.listen(port, host, () => {
  logger.info(`API listening on ${host}:${port}`);
});
```

### File Modified
- **File**: `services/contract-deployer/src/server.ts`
- **Lines**: 239-248
- **Change**: Added explicit host binding to `0.0.0.0`

## Why This Fixes the Problem

1. **Container Networking**: Docker containers have their own network namespace. When the app binds to `localhost`, it's only accessible from within the container itself.

2. **ALB Health Checks**: The Application Load Balancer sends health checks from outside the container. Without binding to `0.0.0.0`, these checks fail and the target is marked unhealthy.

3. **External Traffic**: All incoming traffic from the ALB arrives on the container's external network interface, which requires binding to `0.0.0.0` to receive.

## Deployment Steps

1. **Build the fixed code**:
   ```bash
   cd services/contract-deployer
   npm run build
   ```

2. **Build Docker image**:
   ```bash
   docker build -t hokusai-contracts:fix .
   ```

3. **Tag and push to ECR**:
   ```bash
   docker tag hokusai-contracts:fix 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:v1.2.5
   aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com
   docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:v1.2.5
   ```

4. **Update ECS service**:
   ```bash
   ./scripts/deploy.sh --tag v1.2.5
   ```

## Verification

After deployment, verify the fix:

```bash
# Test health endpoint
curl -s https://contracts.hokus.ai/health

# Expected response
{
  "status": "healthy",
  "timestamp": "2025-09-09T18:30:00.000Z",
  "uptime": 120
}

# Test with API key
curl -X POST https://contracts.hokus.ai/api/deployments \
  -H "X-API-Key: hk_live_A6RDj8Mlmex33o7G7dJtNEO9uYBOGmiT" \
  -H "Content-Type: application/json" \
  -d '{"modelId": "test", "userAddress": "0x...", "webhookUrl": "https://..."}'
```

## Additional Configuration Needed

1. **API Key Configuration**: Add the API key to the `VALID_API_KEYS` environment variable or load from SSM Parameter Store

2. **Redis Optional**: The service should work without Redis for webhook mode. Update health checks to not require Redis.

3. **CloudWatch Logging**: Enable proper log streaming for debugging

## Prevention

For future containerized Node.js services:
1. Always explicitly bind to `0.0.0.0` in container environments
2. Include this in the Dockerfile documentation
3. Add startup logs that show the actual binding address
4. Test container networking during local development

## Status
- ✅ Root cause identified
- ✅ Fix implemented in code
- ⏳ Awaiting Docker build and deployment
- ⏳ Awaiting API key configuration
- ⏳ Ready for webhook-based deployments once deployed