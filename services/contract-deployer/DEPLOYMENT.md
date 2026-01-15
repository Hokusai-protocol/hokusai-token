# Contract Deployer API - AWS ECS Deployment Guide

## Overview

This guide provides step-by-step instructions for deploying the Hokusai Contract Deployer API service to AWS ECS. The service will be accessible at `https://contracts.hokus.ai`.

**The service now includes two main functions:**
1. **Contract Deployment** - Original queue-based contract deployment functionality
2. **AMM Monitoring** - Real-time monitoring of Hokusai AMM pools on mainnet (Phase 1 complete)

## Architecture

### Deployment Architecture
```
┌─────────────┐     ┌─────────────┐     ┌─────────────────────────────┐
│   Route 53  │────▶│     ALB     │────▶│      ECS Tasks              │
│ contracts.  │     │   Port 443  │     │      Port 8002              │
│  hokus.ai   │     └─────────────┘     │                             │
└─────────────┘              │          │  ┌─────────────────────┐    │
                             │          │  │ Express API Server  │    │
                             │          │  │   (server.ts)       │    │
                             ▼          │  └─────────────────────┘    │
                     ┌─────────────┐    │           │                 │
                     │   Target    │    │           ├─ Contract       │
                     │   Group     │    │           │  Deployment     │
                     └─────────────┘    │           │  (Redis Queue)  │
                                        │           │                 │
                                        │           └─ AMM Monitoring │
                                        │              (Phase 1)      │
                                        └─────────────────────────────┘
                                                      │
                                        ┌─────────────┴──────────────┐
                                        ▼                            ▼
                                ┌──────────────┐           ┌──────────────┐
                                │    Redis     │           │  Ethereum    │
                                │ (ElastiCache)│           │ Mainnet RPC  │
                                └──────────────┘           │   (Alchemy)  │
                                                           └──────────────┘
```

### Service Components Architecture
```
┌────────────────────────────────────────────────────────────────┐
│                   Contract Deployer Service                     │
│                      (Node.js/Express)                          │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │              Express API Server (Port 8002)              │   │
│  │  ┌──────────────────┐    ┌──────────────────┐           │   │
│  │  │  /api/deployments│    │  /health/*       │           │   │
│  │  │  (Original API)  │    │  (Health Checks) │           │   │
│  │  └──────────────────┘    └──────────────────┘           │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         Contract Deployment (Original Function)          │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │ Queue Worker │→ │   Deployer   │→ │ Registry     │   │   │
│  │  │ (Redis-based)│  │   (ethers.js)│  │ Integration  │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │         AMM Monitoring (New - Phase 1 Complete)          │   │
│  │                                                           │   │
│  │  ┌──────────────────┐  ┌──────────────────┐             │   │
│  │  │  Pool Discovery  │  │  State Tracker   │             │   │
│  │  │  (Auto-detect    │  │  (12s polling)   │             │   │
│  │  │   new pools)     │  │                  │             │   │
│  │  └──────────────────┘  └──────────────────┘             │   │
│  │                                                           │   │
│  │  ┌──────────────────┐  ┌──────────────────┐             │   │
│  │  │  Event Listener  │  │ Metrics Collector│             │   │
│  │  │  (Buy/Sell/      │  │ (Volume, TVL,    │             │   │
│  │  │   Security)      │  │  Fees, Trades)   │             │   │
│  │  └──────────────────┘  └──────────────────┘             │   │
│  │                                                           │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │          AMMMonitor (Orchestrator)               │    │   │
│  │  │  - Coordinates all components                    │    │   │
│  │  │  - Alert aggregation                             │    │   │
│  │  │  - Provider failover (Alchemy → Backup)          │    │   │
│  │  │  - Metrics API                                   │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │                  Shared Infrastructure                   │   │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │   │
│  │  │    Logger    │  │  AWS SDK     │  │  ethers.js   │   │   │
│  │  │   (Winston)  │  │  (SES, CW)   │  │  (Provider)  │   │   │
│  │  └──────────────┘  └──────────────┘  └──────────────┘   │   │
│  └─────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────┘
```

## Prerequisites

### Required AWS Resources (Already Provisioned)
- ✅ ECR Repository: `932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts`
- ✅ ECS Cluster: `hokusai-development`
- ✅ Application Load Balancer with SSL certificate
- ✅ Target Group on port 8002
- ✅ Route 53 DNS: `contracts.hokus.ai`

### Required Tools
- AWS CLI (v2.x)
- Docker (v20.x or later)
- jq (for JSON parsing)
- Git

### AWS Credentials
Ensure AWS credentials are configured:
```bash
aws configure
# or
export AWS_PROFILE=hokusai-production
```

## Pre-Deployment Setup

### 1. Set SSM Parameters

All sensitive configuration values must be stored in AWS Systems Manager Parameter Store:

#### Contract Deployment Parameters (Original)
```bash
# Set Redis connection string
aws ssm put-parameter \
  --name "/hokusai/development/contracts/redis_url" \
  --value "redis://your-elasticache-endpoint:6379" \
  --type "SecureString" \
  --overwrite

# Set blockchain RPC endpoint
aws ssm put-parameter \
  --name "/hokusai/development/contracts/rpc_endpoint" \
  --value "https://polygon-rpc.com" \
  --type "String" \
  --overwrite

# Set contract addresses
aws ssm put-parameter \
  --name "/hokusai/development/contracts/model_registry_address" \
  --value "0x..." \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/hokusai/development/contracts/token_manager_address" \
  --value "0x..." \
  --type "String" \
  --overwrite

# Set deployer private key (SENSITIVE)
aws ssm put-parameter \
  --name "/hokusai/development/contracts/deployer_key" \
  --value "0x..." \
  --type "SecureString" \
  --overwrite

# Set API authentication keys
aws ssm put-parameter \
  --name "/hokusai/development/contracts/api_keys" \
  --value "key1,key2,key3" \
  --type "SecureString" \
  --overwrite

# Optional: Set JWT secret
aws ssm put-parameter \
  --name "/hokusai/development/contracts/jwt_secret" \
  --value "your-jwt-secret" \
  --type "SecureString" \
  --overwrite
```

#### AMM Monitoring Parameters (New - Phase 1)
```bash
# Mainnet RPC endpoints (Alchemy)
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/mainnet_rpc_url" \
  --value "https://eth-mainnet.g.alchemy.com/v2/YOUR_API_KEY" \
  --type "SecureString" \
  --overwrite

aws ssm put-parameter \
  --name "/hokusai/development/monitoring/backup_rpc_url" \
  --value "https://mainnet.infura.io/v3/YOUR_INFURA_KEY" \
  --type "SecureString" \
  --overwrite

# Alert email (AWS SES)
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alert_email" \
  --value "me@timogilvie.com" \
  --type "String" \
  --overwrite

# Monitoring toggles
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/enabled" \
  --value "true" \
  --type "String" \
  --overwrite

# Alert thresholds (optional - defaults in code)
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alert_large_trade_usd" \
  --value "10000" \
  --type "String" \
  --overwrite

aws ssm put-parameter \
  --name "/hokusai/development/monitoring/alert_reserve_drop_pct" \
  --value "20" \
  --type "String" \
  --overwrite

# CloudWatch configuration
aws ssm put-parameter \
  --name "/hokusai/development/monitoring/cloudwatch_namespace" \
  --value "Hokusai/AMM" \
  --type "String" \
  --overwrite
```

### 2. Create IAM Roles

Create the task execution role:
```bash
aws iam create-role \
  --role-name hokusai-contracts-execution-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Attach policies
aws iam attach-role-policy \
  --role-name hokusai-contracts-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Create custom policy for SSM access
aws iam put-role-policy \
  --role-name hokusai-contracts-execution-role \
  --policy-name SSMParameterAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["ssm:GetParameter", "ssm:GetParameters"],
      "Resource": "arn:aws:ssm:us-east-1:932100697590:parameter/hokusai/development/contracts/*"
    }]
  }'
```

Create the task role:
```bash
aws iam create-role \
  --role-name hokusai-contracts-task-role \
  --assume-role-policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Principal": {"Service": "ecs-tasks.amazonaws.com"},
      "Action": "sts:AssumeRole"
    }]
  }'

# Add CloudWatch and SES permissions
aws iam put-role-policy \
  --role-name hokusai-contracts-task-role \
  --policy-name MonitoringPermissions \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "cloudwatch:PutMetricData"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "ses:SendEmail",
          "ses:SendRawEmail"
        ],
        "Resource": "*",
        "Condition": {
          "StringEquals": {
            "ses:FromAddress": "alerts@hokus.ai"
          }
        }
      }
    ]
  }'
```

## How AMM Monitoring Integrates

The AMM monitoring system runs **within the same Node.js process** as the contract deployment service. This unified architecture provides:

### Benefits
- ✅ **Shared Infrastructure**: Uses existing Redis, AWS SDK, logging, and health checks
- ✅ **Single Deployment**: One Docker image, one ECS service, one set of credentials
- ✅ **Resource Efficiency**: No separate service to manage or pay for
- ✅ **Unified Monitoring**: CloudWatch metrics and logs in one place

### How It Works
1. **Startup**: When the Express server starts, it optionally initializes the AMMMonitor
2. **Configuration**: Reads `MONITORING_ENABLED` from environment variables
3. **Orchestration**: AMMMonitor runs in the background, parallel to the API server
4. **Alerts**: Triggers are sent via AWS SES (email) and logged to CloudWatch
5. **Metrics**: Exposed via REST API endpoints on the same Express server

### Deployment Artifact Integration
The monitoring system automatically loads contract addresses from:
```
/deployments/mainnet-latest.json
```

This file is created by `scripts/deploy-mainnet.js` and contains:
- All contract addresses (ModelRegistry, TokenManager, HokusaiAMMFactory, etc.)
- Initial pool configurations (Conservative, Aggressive, Balanced)
- Network and deployment metadata

**No manual configuration needed** - just deploy contracts, then enable monitoring.

### Environment Variable Control
```bash
# Master toggle
MONITORING_ENABLED=true              # Set to false to disable all monitoring

# Individual components
POOL_DISCOVERY_ENABLED=true          # Auto-discover new pools
EVENT_LISTENERS_ENABLED=true         # Listen for Buy/Sell events
STATE_POLLING_ENABLED=true           # Poll pool state every 12s
ALERTS_ENABLED=true                  # Send email alerts

# Network selection
NETWORK=mainnet                      # Load from mainnet-latest.json
```

### Monitoring Lifecycle
```
┌──────────────────────────────────────────────────────────┐
│  Express Server Starts (server.ts)                       │
└────────────────┬─────────────────────────────────────────┘
                 │
                 ├─► Initialize Health Checks (existing)
                 ├─► Initialize Queue Worker (existing)
                 │
                 └─► Initialize AMMMonitor (new)
                      │
                      ├─► Load deployment artifact
                      ├─► Connect to Alchemy RPC
                      ├─► Start Pool Discovery
                      ├─► Start State Tracker (12s polls)
                      └─► Start Event Listener (Buy/Sell)
                           │
                           └─► Alerts sent via AWS SES
                           └─► Metrics exposed on /api/monitoring/*
```

## Deployment Process

### Step 1: Build and Push Docker Image

```bash
# Navigate to service directory
cd services/contract-deployer

# Run the build and push script
./scripts/build-and-push.sh

# Or manually:
docker build -t contract-deployer .
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com
docker tag contract-deployer:latest \
  932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:latest
docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:latest
```

### Step 2: Register Task Definition

```bash
# Register the task definition
aws ecs register-task-definition \
  --cli-input-json file://ecs/task-definition.json \
  --region us-east-1
```

### Step 3: Create or Update ECS Service

For first-time deployment:
```bash
aws ecs create-service \
  --cluster hokusai-development \
  --service-name hokusai-contracts-development \
  --task-definition hokusai-contracts-task:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[subnet-xxx,subnet-yyy],
    securityGroups=[sg-xxx],
    assignPublicIp=ENABLED
  }" \
  --load-balancers "targetGroupArn=arn:aws:elasticloadbalancing:us-east-1:932100697590:targetgroup/xxx,containerName=contract-deployer,containerPort=8002" \
  --region us-east-1
```

For updates:
```bash
# Use the deployment script
./scripts/deploy.sh

# Or manually:
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --force-new-deployment \
  --region us-east-1
```

### Step 4: Monitor Deployment

```bash
# Watch service status
aws ecs wait services-stable \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1

# Check task status
aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --region us-east-1 \
  --query 'services[0].deployments'
```

### Step 5: Verify Deployment

```bash
# Test health endpoint
curl https://contracts.hokus.ai/health

# Expected response:
# {"status":"ok","timestamp":"2024-01-01T00:00:00.000Z"}

# Test readiness
curl https://contracts.hokus.ai/health/ready

# Check CloudWatch logs
aws logs tail /ecs/hokusai-contracts --follow
```

## Monitoring and Observability

### CloudWatch Dashboard

Create the monitoring dashboard:
```bash
aws cloudwatch put-dashboard \
  --dashboard-name HokusaiContractsAPI \
  --dashboard-body file://monitoring/cloudwatch-dashboard.json
```

Access the dashboard:
- URL: https://console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=HokusaiContractsAPI

### Key Metrics to Monitor
- **API Request Count**: Total requests per minute
- **Response Time**: p50, p95, p99 latencies
- **Error Rate**: 4XX and 5XX errors
- **Task Health**: Running vs desired task count
- **Resource Utilization**: CPU and memory usage

### Alarms
The following alarms are configured:
- High error rate (>1%)
- Unhealthy targets
- High response time (p99 > 2s)
- High CPU utilization (>70%)
- High memory utilization (>80%)
- Task failures

## Troubleshooting

### Common Issues

#### 1. Tasks Failing to Start
```bash
# Check task stopped reason
aws ecs describe-tasks \
  --cluster hokusai-development \
  --tasks $(aws ecs list-tasks --cluster hokusai-development --service-name hokusai-contracts-development --query 'taskArns[0]' --output text) \
  --query 'tasks[0].stoppedReason'

# Check CloudWatch logs
aws logs get-log-events \
  --log-group-name /ecs/hokusai-contracts \
  --log-stream-name contract-deployer-api/contract-deployer/latest
```

#### 2. Health Check Failures
```bash
# Test health endpoint directly
docker run --rm contract-deployer node -e "
  require('http').get('http://localhost:8002/health', (res) => {
    console.log('Status:', res.statusCode);
    process.exit(res.statusCode === 200 ? 0 : 1);
  })
"
```

#### 3. SSM Parameter Access Issues
```bash
# Verify parameters exist
aws ssm get-parameter \
  --name "/hokusai/development/contracts/redis_url" \
  --with-decryption

# Check IAM permissions
aws iam simulate-principal-policy \
  --policy-source-arn arn:aws:iam::932100697590:role/hokusai-contracts-execution-role \
  --action-names ssm:GetParameter \
  --resource-arns arn:aws:ssm:us-east-1:932100697590:parameter/hokusai/development/contracts/*
```

#### 4. Port Mismatch Issues
Ensure all components use port 8002:
- Dockerfile: `EXPOSE 8002`
- Task definition: `containerPort: 8002`
- Target group: Port 8002
- Environment variable: `PORT=8002`

## Rollback Procedure

If deployment fails:

### Automatic Rollback
The deployment script includes automatic rollback:
```bash
./scripts/deploy.sh --tag previous-version
```

### Manual Rollback
```bash
# Get previous task definition
PREVIOUS_TASK_DEF=$(aws ecs describe-services \
  --cluster hokusai-development \
  --services hokusai-contracts-development \
  --query 'services[0].deployments[1].taskDefinition' \
  --output text)

# Update service with previous version
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --task-definition $PREVIOUS_TASK_DEF \
  --force-new-deployment
```

## Security Best Practices

1. **Never commit secrets**: All sensitive values in SSM Parameter Store
2. **Use least privilege IAM roles**: Minimal permissions required
3. **Enable container insights**: For detailed monitoring
4. **Regular security updates**: Keep base images updated
5. **Network isolation**: Use security groups and VPC configuration
6. **Audit logs**: Enable CloudTrail for API calls

## Maintenance

### Updating Dependencies
```bash
# Update Node.js dependencies
npm update
npm audit fix

# Rebuild and deploy
./scripts/build-and-push.sh
./scripts/deploy.sh
```

### Scaling
```bash
# Scale service
aws ecs update-service \
  --cluster hokusai-development \
  --service hokusai-contracts-development \
  --desired-count 5

# Configure auto-scaling
aws application-autoscaling register-scalable-target \
  --service-namespace ecs \
  --resource-id service/hokusai-development/hokusai-contracts-development \
  --scalable-dimension ecs:service:DesiredCount \
  --min-capacity 2 \
  --max-capacity 10
```

## Support

For issues or questions:
- Check CloudWatch logs: `/ecs/hokusai-contracts`
- Review metrics dashboard: `HokusaiContractsAPI`
- Contact: DevOps team

## Appendix

### Environment Variables Reference
See `.env.production` for complete list of configuration options.

### API Endpoints

#### Original Contract Deployment API
- `POST /api/deployments` - Create deployment
- `GET /api/deployments/:id/status` - Check deployment status

#### Health Checks (Enhanced with AMM Monitoring)
- `GET /health` - Basic health check
- `GET /health/ready` - Readiness check
- `GET /health/detailed` - Detailed health status (includes AMM monitoring status)

#### AMM Monitoring API (New - Phase 1)
- `GET /api/monitoring/metrics` - Get current metrics for all pools
- `GET /api/monitoring/pools` - List discovered pools
- `GET /api/monitoring/pools/:poolAddress/state` - Get current state for specific pool
- `GET /api/monitoring/alerts/recent` - Get recent alerts (last 24h)

### Useful Commands
```bash
# View running tasks
aws ecs list-tasks --cluster hokusai-development --service-name hokusai-contracts-development

# SSH into container (for debugging)
aws ecs execute-command \
  --cluster hokusai-development \
  --task <task-id> \
  --container contract-deployer \
  --interactive \
  --command "/bin/sh"

# Force service update
aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --force-new-deployment
```