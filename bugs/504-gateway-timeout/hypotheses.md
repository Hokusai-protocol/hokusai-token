# Bug Hypotheses: 504 Gateway Timeout

## Hypothesis 1: Application Not Starting Due to Missing Contract Addresses [HIGH PRIORITY]
**Root Cause**: The application requires valid contract addresses to start, but SSM contains placeholder values (0x0000...)
**Why This Causes 504**: Application crashes during startup when trying to validate contracts, never establishing health check endpoint
**Test Method**: 
1. Check ECS task logs for contract validation errors
2. Test with mock contract addresses locally
**Expected Outcome**: Logs show "Required contracts not deployed" or similar error

## Hypothesis 2: Health Check Endpoint Not Responding on Port 8002 [HIGH PRIORITY]
**Root Cause**: Application is not binding to port 8002 or health check route is not registered
**Why This Causes 504**: ALB health checks fail, marking all targets unhealthy
**Test Method**:
1. Check target group health status in AWS console
2. SSH into container and curl localhost:8002/health
3. Review server.ts startup sequence
**Expected Outcome**: Target group shows unhealthy targets with failing health checks

## Hypothesis 3: Application Startup Timeout [MEDIUM PRIORITY]
**Root Cause**: Application takes too long to start (blockchain connection, Redis timeout, SSM loading)
**Why This Causes 504**: ECS kills container before it becomes healthy
**Test Method**:
1. Check ECS task stopped reason
2. Analyze startup logs timing
3. Review health check grace period settings
**Expected Outcome**: Tasks show multiple restart attempts

## Hypothesis 4: server.ts vs index.ts Confusion [MEDIUM PRIORITY]
**Root Cause**: Wrong entry point being used - index.ts starts queue listener, server.ts starts API
**Why This Causes 504**: Queue listener doesn't expose HTTP endpoints
**Test Method**:
1. Check Dockerfile CMD instruction
2. Verify package.json start script
3. Check which file is being executed
**Expected Outcome**: Logs show queue listener starting instead of HTTP server

## Hypothesis 5: SSM Parameter Loading Failure [LOW PRIORITY]
**Root Cause**: IAM permissions or SSM parameter paths incorrect
**Why This Causes 504**: Application can't load config and fails to start
**Test Method**:
1. Check for SSM access errors in logs
2. Verify IAM role has SSM permissions
3. Test SSM parameter retrieval manually
**Expected Outcome**: "Access Denied" or parameter not found errors

## Hypothesis 6: Network Configuration Issue [LOW PRIORITY]
**Root Cause**: Security group or network ACL blocking traffic
**Why This Causes 504**: Traffic can't reach container
**Test Method**:
1. Check security group rules for port 8002
2. Verify subnet routing
3. Test from within VPC
**Expected Outcome**: Connection refused or timeout at network level

## Testing Order
1. Check ECS logs for startup errors (H1, H4)
2. Verify target group health (H2)
3. Check entry point configuration (H4)
4. Test with valid contract addresses (H1)
5. Review startup timing (H3)
6. Verify SSM access (H5)
7. Check network configuration (H6)