# Bug Investigation: ECS Tasks Failing to Stay Running

## Bug Summary
ECS tasks for the contract-deployer service are failing to stay running in the hokusai-development cluster. Tasks start successfully but stop within ~30 seconds, before the health check start period (60 seconds) expires.

## Impact Analysis
- **Severity**: Critical
- **Service**: Contract Deployer API
- **Environment**: Development (ECS/Fargate)
- **User Impact**: Contract deployment service is completely unavailable
- **Business Impact**: Cannot deploy new model tokens or manage existing deployments

## Affected Components
1. **ECS Service**: hokusai-contracts-development
2. **Task Definition**: hokusai-contracts-task (revision 4)
3. **Docker Image**: 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:v1.0.1
4. **Dependencies**:
   - Redis (ElastiCache)
   - RPC endpoints (blockchain connectivity)
   - SSM Parameter Store (secrets)

## Reproduction Steps
1. Deploy task definition revision 4 to ECS service
2. Observe task starts (PROVISIONING → RUNNING)
3. Task stops within 30 seconds (RUNNING → STOPPED)
4. Stop reason: "Essential container in task exited"

## Initial Observations

### What Works
- Docker image builds successfully with correct platform (linux/amd64)
- Image contains required contracts directory (/app/contracts/HokusaiToken.json)
- Task definition is registered successfully
- ECS service accepts the deployment
- Tasks initially reach RUNNING state

### What Fails
- Container exits before writing any logs to CloudWatch
- No error messages captured in CloudWatch Logs
- Health checks never get a chance to run (60-second start period)
- Service continuously attempts to restart tasks

### Evidence Collected
1. **CloudWatch Logs**: No logs from recent tasks (tasks exit before logging)
2. **ECS Task Status**: 
   - lastStatus: "STOPPED"
   - stoppedReason: "Essential container in task exited"
   - healthStatus: "UNKNOWN"
3. **TypeScript Build Errors**: 
   - Multiple compilation errors in deployment-processor.ts and deployment.service.ts
   - Errors related to Redis client API usage
   - Type mismatches in deployment status handling
4. **Local Testing**: Container hangs when run locally (may be due to missing environment)

## Investigation Timeline
- Initial deployment attempted with "latest" tag
- Fixed architecture mismatch (ARM → x86_64)
- Added missing contracts directory to Docker image
- Increased health check timeout (5s → 10s)
- Created versioned image tag (v1.0.1) to avoid caching issues
- Tasks still failing despite fixes

## Next Steps
1. Generate and test hypotheses for root cause
2. Fix TypeScript compilation errors
3. Test Redis connectivity from ECS subnet
4. Verify all required environment variables are present
5. Add comprehensive logging to capture startup failures