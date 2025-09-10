# Fix Tasks: 504 Gateway Timeout

## Task 1: Get Target Group ARN
- [ ] Retrieve the ARN for `hokusai-contracts-tg-dev` target group
- Command: `aws elbv2 describe-target-groups --query 'TargetGroups[?TargetGroupName==\`hokusai-contracts-tg-dev\`].TargetGroupArn' --output text`

## Task 2: Update ECS Service with Target Group
- [ ] Update the ECS service to register with the target group
- Command: `aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --load-balancers targetGroupArn=<ARN>,containerName=contract-deployer,containerPort=8002`

## Task 3: Verify Target Registration
- [ ] Wait for targets to register (30-60 seconds)
- [ ] Check target health status
- Command: `aws elbv2 describe-target-health --target-group-arn <ARN>`

## Task 4: Test Health Endpoint
- [ ] Test the health endpoint via ALB
- Command: `curl -I https://contracts.hokus.ai/health`
- Expected: HTTP 200 response

## Task 5: Write Integration Test
- [ ] Create a test to verify ECS service has load balancer configuration
- [ ] Add to deployment validation scripts

## Task 6: Update Documentation
- [ ] Document the requirement for target group registration in deployment guides
- [ ] Add to infrastructure checklist

## Task 7: Add Monitoring
- [ ] Set up CloudWatch alarm for unhealthy targets
- [ ] Alert when target group has no healthy targets for >5 minutes

## Implementation Order
1. Tasks 1-3: Immediate fix (5 minutes)
2. Task 4: Validation (2 minutes)
3. Tasks 5-7: Prevention measures (30 minutes)