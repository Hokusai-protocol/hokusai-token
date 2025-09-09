# Root Cause Analysis

## Confirmed Root Cause
**SSM Parameter Path Mismatch**

The container is failing because it's trying to load SSM parameters from the wrong path.

### Technical Explanation
1. **Environment Configuration**:
   - NODE_ENV is set to "production" in the ECS task definition
   - The code uses NODE_ENV to determine the SSM parameter path
   - Path construction: `/hokusai/${environment}/contracts/`
   - With NODE_ENV=production, it looks for: `/hokusai/production/contracts/`

2. **Actual Parameter Location**:
   - Parameters are stored at: `/hokusai/development/contracts/`
   - These were created during the initial setup

3. **Failure Mode**:
   - SSM client hangs when trying to test connection to non-existent parameters
   - No timeout is set on the SSM client operations
   - Container exits after ~30 seconds (likely due to ECS task timeout)
   - No error logs because the process hangs before any error handling

### Evidence
From CloudWatch logs:
```
[STARTUP] NODE_ENV: production
[STARTUP] Loading from SSM with path prefix: /hokusai/production/contracts/
[STARTUP] Testing SSM connection...
```
Then the process stops - no further logs.

### Why It Wasn't Caught Earlier
1. **Environment Mismatch**: Development environment doesn't use SSM (NODE_ENV != production)
2. **No Local Testing**: The production SSM loading path was never tested locally
3. **Silent Failure**: SSM client hangs instead of timing out with an error
4. **Insufficient Logging**: No timeout or error handling in SSM connection test

### Impact Assessment
- **Service Availability**: Complete service outage in ECS
- **Data Loss**: None - service never started
- **Security**: No security impact
- **User Experience**: Contract deployment service unavailable

### Related Code Sections
- `/src/config/aws-ssm.ts:294-306` - SSM path construction
- `/src/config/env.validation.ts:191-194` - SSM loading trigger
- `/ecs/task-definition.json:29-30` - NODE_ENV set to "production"

## Solution Options

### Option 1: Use DEPLOY_ENV (Recommended)
Set DEPLOY_ENV=development in the task definition to override the production path

### Option 2: Create Production Parameters
Copy all parameters from /hokusai/development/contracts/ to /hokusai/production/contracts/

### Option 3: Change NODE_ENV
Set NODE_ENV=development (not recommended - affects other behaviors)

### Option 4: Fix Parameter Path
Update the code to use a fixed path regardless of NODE_ENV