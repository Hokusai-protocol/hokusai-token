# Root Cause Hypotheses

## Hypothesis 1: TypeScript Compilation Errors Causing Runtime Failure
**Priority**: HIGH
**Proposed Root Cause**: The TypeScript compilation errors are creating invalid JavaScript that crashes at runtime
**Why This Could Cause the Behavior**: 
- Build shows multiple TS errors in deployment-processor.ts, deployment.service.ts, and queue.service.ts
- Redis client API usage errors could cause immediate crash when trying to connect
- Type mismatches might produce runtime exceptions

**How to Test**:
1. Run the compiled JavaScript locally with minimal config
2. Check if the dist/ files are actually valid despite TS errors
3. Fix TypeScript errors and rebuild

**Expected Outcome if Correct**: 
- Running the dist/server.js locally will show immediate crash
- Fixing TS errors will allow container to start

## Hypothesis 2: Redis Connection Failure
**Priority**: HIGH
**Proposed Root Cause**: Container cannot connect to Redis from ECS subnet
**Why This Could Cause the Behavior**:
- server.ts shows Redis connection is required at startup (line 35)
- If connection fails, process exits (line 190)
- No logs because crash happens before logger initialization

**How to Test**:
1. Check VPC/Security Group configuration for ECS tasks
2. Verify Redis endpoint is accessible from ECS subnet
3. Test with a simple Redis connection script
4. Add try-catch and logging before Redis connection

**Expected Outcome if Correct**:
- Security group or network configuration issue will be found
- Adding early logging will show "Failed to connect to Redis" error

## Hypothesis 3: Missing or Invalid Environment Variables
**Priority**: MEDIUM
**Proposed Root Cause**: Required environment variables are not being loaded from SSM
**Why This Could Cause the Behavior**:
- validateEnv() is called before server starts
- Missing required variables would cause immediate exit
- SSM parameters might not be accessible due to IAM permissions

**How to Test**:
1. Add console.log at the very start of server.ts
2. Log all environment variables before validation
3. Check ECS task role has SSM parameter access
4. Test with hardcoded values instead of SSM

**Expected Outcome if Correct**:
- Logs will show missing environment variables
- Task role will be missing SSM permissions

## Hypothesis 4: Node.js Module Resolution Failure
**Priority**: MEDIUM
**Proposed Root Cause**: Production dependencies are missing or incorrectly installed
**Why This Could Cause the Behavior**:
- Dockerfile uses `npm ci --only=production`
- Some required modules might be in devDependencies
- Module resolution paths might be incorrect in container

**How to Test**:
1. Check if all runtime dependencies are in "dependencies" not "devDependencies"
2. Run container with shell and try to start server manually
3. Check node_modules contents in the container

**Expected Outcome if Correct**:
- "Cannot find module" error when running manually
- Missing packages in production node_modules

## Hypothesis 5: Process Signal Handling Issue
**Priority**: LOW
**Proposed Root Cause**: Container is receiving SIGTERM immediately due to failed health check
**Why This Could Cause the Behavior**:
- Although health checks have 60s start period, other issues might trigger early termination
- Dumb-init might be forwarding signals incorrectly

**How to Test**:
1. Remove health check from task definition temporarily
2. Check if container stays running longer without health checks
3. Add signal logging to server.ts

**Expected Outcome if Correct**:
- Container will run longer without health checks
- Logs will show SIGTERM received early

## Testing Order
1. Fix TypeScript errors first (Hypothesis 1) - Most likely and easiest to verify
2. Add early logging to capture startup issues (supports all hypotheses)
3. Test Redis connectivity (Hypothesis 2)
4. Verify environment variables (Hypothesis 3)
5. Check module dependencies (Hypothesis 4)
6. Test signal handling (Hypothesis 5)