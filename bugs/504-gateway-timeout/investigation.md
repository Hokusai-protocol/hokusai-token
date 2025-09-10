# Bug Investigation: 504 Gateway Timeout - contracts.hokus.ai

## Bug Summary
The Contract Deployer API service at contracts.hokus.ai is returning 504 Gateway Timeout errors from the AWS Application Load Balancer, despite the ECS service showing as running with healthy tasks.

## Impact Analysis
- **Severity**: High - Service is completely inaccessible via public endpoint
- **Affected Users**: All users trying to access the Contract Deployer API
- **Business Impact**: Cannot deploy new model tokens, blocking core functionality
- **Duration**: Ongoing since initial deployment

## Affected Components/Services
1. **Contract Deployer API** (services/contract-deployer)
2. **AWS ECS Service** (hokusai-contracts-development)
3. **Application Load Balancer** (ALB)
4. **Target Group Health Checks**
5. **SSM Parameter Store** (configuration values)

## Reproduction Steps
1. Deploy Contract Deployer service to ECS (completed)
2. Access https://contracts.hokus.ai/health
3. Observe 504 Gateway Timeout response

**Verified**: Yes, consistently reproducible

## Initial Observations

### From Deployment Logs
1. Service container starts successfully
2. Winston logger error occurs but was fixed in v1.3.2
3. Container now runs on correct architecture (AMD64)
4. ECS shows task as RUNNING

### From AWS Console
- ECS Service: 1/1 tasks running
- Task Status: RUNNING
- Health Status: UNKNOWN
- Target Group: Likely showing unhealthy targets

### From Configuration
- SSM Parameters contain placeholder values:
  - MODEL_REGISTRY_ADDRESS: 0x0000000000000000000000000000000000000000
  - TOKEN_MANAGER_ADDRESS: 0x0000000000000000000000000000000000000000
  - RPC_URL: Valid Sepolia endpoint
  - DEPLOYER_PRIVATE_KEY: Present

### Potential Issues Identified
1. Health check endpoint may be failing internally
2. Service may not be listening on the correct port (8002)
3. Blockchain connection issues with placeholder addresses
4. Application startup failures not visible in limited logs
5. Target group health check configuration mismatch

## Next Steps
1. Check ECS task logs for startup errors
2. Verify target group health check status
3. Test service connectivity directly (bypassing ALB)
4. Analyze application startup sequence
5. Validate health check endpoint implementation