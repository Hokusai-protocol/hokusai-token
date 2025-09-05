# Implementation Tasks: Containerize and Deploy Contract API Service

## 1. Environment Configuration & Port Resolution
1. [x] Update service configuration for flexible port handling
   a. [ ] Modify src/server.ts to use PORT environment variable (default 3001)
   b. [ ] Update src/config/env.validation.ts to include PORT configuration
   c. [ ] Test service starts on both port 3001 and 8002
   d. [ ] Coordinate with infrastructure team on final port decision

2. [ ] Create production environment templates
   a. [ ] Create .env.production file with all required variables
   b. [ ] Document each environment variable in deployment guide
   c. [ ] Add validation for required production variables

## 2. Docker Build & Optimization
3. [ ] Verify and optimize Docker build
   a. [ ] Test current Dockerfile builds successfully
   b. [ ] Verify final image size is under 200MB
   c. [ ] Test health check endpoint within container
   d. [ ] Validate non-root user permissions work correctly

4. [ ] Local container testing
   a. [ ] Run container with docker-compose locally
   b. [ ] Test all API endpoints work in containerized environment
   c. [ ] Verify Redis connection from container
   d. [ ] Test graceful shutdown with SIGTERM signal

## 3. AWS Integration & Secrets Management  
5. [ ] Implement AWS SSM Parameter Store integration
   a. [ ] Create AWS SDK client for SSM in src/config/aws.ts
   b. [ ] Implement getSecrets() function to retrieve parameters
   c. [ ] Update environment loading to fetch from SSM
   d. [ ] Add retry logic for SSM parameter retrieval

6. [ ] Configure CloudWatch logging
   a. [ ] Update Winston logger for CloudWatch compatibility
   b. [ ] Implement structured JSON logging format
   c. [ ] Add request ID tracking across log entries
   d. [ ] Test log streaming to CloudWatch

## 4. Deployment Scripts
7. [ ] Create ECR deployment script (scripts/build-and-push.sh)
   a. [ ] Implement Docker build command
   b. [ ] Add ECR authentication via aws ecr get-login-password
   c. [ ] Tag image with version and latest
   d. [ ] Push to ECR repository
   e. [ ] Add error handling and rollback

8. [ ] Create ECS deployment script (scripts/deploy.sh)
   a. [ ] Implement ECS service update command
   b. [ ] Add health check verification
   c. [ ] Implement rollback on failure
   d. [ ] Add deployment status monitoring

## 5. ECS Configuration
9. [ ] Create ECS task definition (ecs/task-definition.json)
   a. [ ] Define container with CPU/memory limits (256 CPU, 512-1024MB memory)
   b. [ ] Configure environment variables from SSM
   c. [ ] Set up CloudWatch log configuration
   d. [ ] Define health check parameters

10. [ ] Configure IAM roles and policies
    a. [ ] Create task execution role with ECR and SSM permissions
    b. [ ] Create task role with CloudWatch and SSM read permissions
    c. [ ] Test IAM permissions with dry-run deployment

## 6. Load Balancer & Networking
11. [ ] Configure Application Load Balancer
    a. [ ] Update target group to use port 3001 (or agreed port)
    b. [ ] Configure health check path as /health/ready
    c. [ ] Set health check interval to 30 seconds
    d. [ ] Configure deregistration delay for graceful shutdown

12. [ ] Set up service discovery
    a. [ ] Verify service discovery registration
    b. [ ] Test internal DNS resolution
    c. [ ] Configure service mesh if required

## 7. Testing (Dependent on Docker & AWS Configuration)
13. [ ] Write deployment tests
    a. [ ] Create integration test for Docker build
    b. [ ] Write health check endpoint tests
    c. [ ] Implement SSM parameter retrieval tests
    d. [ ] Add CloudWatch logging verification tests

14. [ ] Perform load and stress testing
    a. [ ] Test with 100 concurrent requests
    b. [ ] Verify auto-scaling triggers at 70% CPU
    c. [ ] Test graceful degradation under load
    d. [ ] Validate rate limiting works correctly

15. [ ] End-to-end deployment testing
    a. [ ] Deploy to staging environment
    b. [ ] Test all API endpoints through load balancer
    c. [ ] Verify contract deployment functionality
    d. [ ] Test rollback procedure

## 8. Monitoring & Observability
16. [ ] Create CloudWatch dashboard
    a. [ ] Add API request count metrics
    b. [ ] Configure response time percentiles (p50, p95, p99)
    c. [ ] Display error rates by endpoint
    d. [ ] Show container resource utilization

17. [ ] Configure CloudWatch alarms
    a. [ ] Set alarm for error rate > 1%
    b. [ ] Configure unhealthy task count alarm
    c. [ ] Add high latency alarm (p99 > 2s)
    d. [ ] Set up memory utilization alarm (> 80%)

18. [ ] Set up alerting
    a. [ ] Configure SNS topic for critical alerts
    b. [ ] Set up email notifications
    c. [ ] Integrate with PagerDuty if available
    d. [ ] Test alert delivery

## 9. Documentation (Dependent on Implementation)
19. [ ] Create deployment documentation
    a. [ ] Write step-by-step deployment runbook
    b. [ ] Document rollback procedures
    c. [ ] Create troubleshooting guide
    d. [ ] Add architecture diagram

20. [ ] Update API documentation
    a. [ ] Update README with production endpoints
    b. [ ] Document authentication requirements
    c. [ ] Add rate limiting information
    d. [ ] Include example curl commands for production

## 10. Production Deployment
21. [ ] Deploy to production
    a. [ ] Set all SSM parameters in production
    b. [ ] Push Docker image to ECR
    c. [ ] Update ECS service with new task definition
    d. [ ] Verify health checks pass

22. [ ] Validate production deployment
    a. [ ] Test API endpoints at https://contracts.hokus.ai
    b. [ ] Verify CloudWatch logs are streaming
    c. [ ] Check monitoring dashboard shows healthy metrics
    d. [ ] Perform smoke tests on all critical paths

23. [ ] Post-deployment tasks
    a. [ ] Monitor service for first 24 hours
    b. [ ] Document any issues or optimizations needed
    c. [ ] Update runbook with lessons learned
    d. [ ] Schedule load test for peak traffic simulation