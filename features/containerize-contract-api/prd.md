# Product Requirements Document: Containerize and Deploy Contract API Service

## Objectives

Deploy the Contract Deployment API as a containerized service on AWS ECS infrastructure, enabling frontend applications to interact with smart contract deployment functionality via HTTPS at contracts.hokus.ai.

## User Personas

### Primary Users
- **Frontend Developers**: Need reliable API endpoints to trigger contract deployments from web applications
- **DevOps Engineers**: Require monitoring, logging, and scaling capabilities for production operations
- **Backend Developers**: Need clear deployment processes and debugging capabilities

### Secondary Users
- **Security Teams**: Require proper secret management and access controls
- **Product Managers**: Need deployment metrics and service availability reports

## Success Criteria

### Functional Requirements
- API accessible at https://contracts.hokus.ai with SSL/TLS encryption
- All existing API endpoints operational (/api/deployments, /health)
- Successful contract deployment transactions on blockchain
- Redis connection for rate limiting and job tracking
- Proper authentication via API keys stored in AWS SSM

### Non-Functional Requirements
- 99.9% uptime availability
- Response time <2 seconds for API calls (excluding blockchain operations)
- Support for 100 concurrent deployment requests
- Auto-scaling between 2-10 container instances based on load
- Zero-downtime deployments using rolling updates

### Performance Metrics
- Health check response time <500ms
- Container startup time <30 seconds
- Memory usage <1GB per container
- CPU utilization <70% under normal load

## Technical Requirements

### Container Configuration
- Multi-stage Docker build for optimized image size (<200MB)
- Non-root user execution for security
- Proper signal handling with dumb-init
- Environment-based configuration for all settings

### AWS Infrastructure Integration
- **ECR Repository**: Push images to 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts
- **ECS Service**: Deploy on hokusai-development cluster
- **Target Group**: Configure port mapping (resolve 3001 vs 8002 discrepancy)
- **Service Discovery**: Register as contracts.hokusai-development.local
- **CloudWatch**: Stream logs and metrics for monitoring

### Secret Management
- Store sensitive values in AWS SSM Parameter Store under /hokusai/development/contracts/
- Required secrets:
  - deployer_key (blockchain private key)
  - token_manager_address (smart contract address)
  - model_registry_address (smart contract address)
  - rpc_endpoint (blockchain RPC URL)
  - redis_url (ElastiCache connection string)
  - api_keys (authorized API keys list)

### Health Monitoring
- **/health**: Basic liveness check returning 200 OK
- **/health/ready**: Readiness check validating Redis and blockchain connectivity
- **/health/detailed**: Comprehensive status including memory, uptime, and component health

## Implementation Tasks

### 1. Environment Configuration
- Update service to use PORT environment variable (defaulting to 3001)
- Create .env.production template with all required variables
- Document environment variable requirements in deployment guide

### 2. AWS Integration
- Implement AWS Secrets Manager client for runtime secret retrieval
- Add CloudWatch structured logging with appropriate log levels
- Configure health check endpoints for ECS task definitions

### 3. Docker Optimization
- Verify Dockerfile builds successfully with current codebase
- Test container locally with production-like environment
- Validate health checks work within container

### 4. Deployment Scripts
- Create build-and-push.sh script for ECR deployment
- Implement deploy.sh script for ECS service updates
- Add rollback mechanism for failed deployments

### 5. ECS Task Definition
- Define task with appropriate CPU/memory limits
- Configure environment variables from SSM Parameter Store
- Set up CloudWatch log group for container logs
- Define task IAM role with necessary permissions

### 6. Load Balancer Configuration
- Update target group to use correct port (3001)
- Configure health check path and parameters
- Set up proper deregistration delay for graceful shutdown

### 7. Monitoring Setup
- Create CloudWatch dashboard with key metrics
- Configure alarms for error rates, latency, and availability
- Set up notification channels for critical alerts

### 8. Testing & Validation
- Perform local Docker testing with all components
- Execute load testing to validate scaling policies
- Test graceful shutdown and startup procedures
- Verify all API endpoints work through Load Balancer

### 9. Documentation
- Create deployment runbook with step-by-step instructions
- Document troubleshooting procedures
- Update API documentation with production endpoints
- Create architecture diagram showing all components

## Risk Mitigation

### Technical Risks
- **Port Mismatch**: Coordinate with infrastructure team to align on port 3001 or update service
- **Secret Exposure**: Use IAM roles and SSM Parameter Store, never hardcode secrets
- **Deployment Failures**: Implement blue-green deployment strategy with automatic rollback

### Operational Risks
- **Service Downtime**: Deploy multiple container instances with load balancing
- **Resource Exhaustion**: Set up auto-scaling policies and resource limits
- **Network Issues**: Configure multiple RPC endpoints for blockchain redundancy

## Dependencies

### External Dependencies
- AWS ECS cluster (hokusai-development) - **Ready**
- ECR repository - **Ready**
- Application Load Balancer with SSL - **Ready**
- Route 53 DNS (contracts.hokus.ai) - **Ready**
- Redis/ElastiCache instance - **Required**
- Blockchain RPC endpoints - **Required**

### Internal Dependencies
- Smart contracts deployed (ModelRegistry, TokenManager) - **Required**
- Private key for contract deployment - **Required**
- API authentication keys - **Required**

## Rollout Plan

### Phase 1: Local Validation
- Build and test Docker container locally
- Verify all health checks pass
- Test with mock Redis and blockchain connections

### Phase 2: Staging Deployment
- Deploy single container to ECS
- Configure minimal SSM parameters
- Test basic API functionality

### Phase 3: Production Configuration
- Set all production SSM parameters
- Deploy with 2 container instances
- Configure auto-scaling policies

### Phase 4: Traffic Migration
- Update DNS to point to new service
- Monitor metrics and logs
- Implement any necessary optimizations

## Definition of Done

- Docker image successfully built and pushed to ECR
- ECS service running with at least 2 healthy tasks
- All health check endpoints returning successful responses
- API endpoints accessible at https://contracts.hokus.ai
- Authentication working with API keys from SSM
- CloudWatch logs streaming successfully
- Monitoring dashboard showing healthy metrics
- Load testing completed with acceptable performance
- Deployment documentation reviewed and approved
- Rollback procedure tested and documented