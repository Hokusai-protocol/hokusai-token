#!/bin/bash

# Hokusai AMM Monitoring - Testnet Quick Start
# This script helps you quickly deploy the monitoring system to testnet

set -e

echo "🚀 Hokusai AMM Monitoring - Testnet Deployment"
echo "=============================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check AWS CLI
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Please install it first.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ AWS CLI found${NC}"

# Check Docker
if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker not found. Please install it first.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ Docker found${NC}"

# Check Node/npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm not found. Please install Node.js first.${NC}"
    exit 1
fi
echo -e "${GREEN}✅ npm found${NC}"

# Check jq
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}⚠️  jq not found. Installing...${NC}"
    if [[ "$OSTYPE" == "darwin"* ]]; then
        brew install jq
    else
        sudo apt-get install -y jq
    fi
fi
echo -e "${GREEN}✅ jq found${NC}"

echo ""

# AWS Account verification
echo "🔐 Verifying AWS access..."
AWS_ACCOUNT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
if [ -z "$AWS_ACCOUNT" ]; then
    echo -e "${RED}❌ Cannot access AWS. Please configure AWS CLI.${NC}"
    echo "Run: aws configure"
    exit 1
fi
echo -e "${GREEN}✅ AWS Account: $AWS_ACCOUNT${NC}"

if [ "$AWS_ACCOUNT" != "932100697590" ]; then
    echo -e "${YELLOW}⚠️  Warning: Not using Hokusai AWS account${NC}"
    read -p "Continue anyway? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

echo ""

# Prompt for required information
echo "📝 Configuration Setup"
echo "======================"
echo ""

read -p "Alert email address (default: me@timogilvie.com): " ALERT_EMAIL
ALERT_EMAIL=${ALERT_EMAIL:-me@timogilvie.com}

read -p "Alert FROM email (default: alerts@hokus.ai): " ALERT_FROM
ALERT_FROM=${ALERT_FROM:-alerts@hokus.ai}

read -p "Sepolia RPC URL: " SEPOLIA_RPC
if [ -z "$SEPOLIA_RPC" ]; then
    echo -e "${RED}❌ Sepolia RPC URL is required${NC}"
    exit 1
fi

read -p "Backup RPC URL (optional): " BACKUP_RPC

echo ""
echo "Configuration Summary:"
echo "----------------------"
echo "Alert Email: $ALERT_EMAIL"
echo "Alert From: $ALERT_FROM"
echo "Sepolia RPC: ${SEPOLIA_RPC:0:50}..."
echo ""

read -p "Proceed with deployment? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 1
fi

echo ""

# Step 1: SES Setup
echo "📧 Step 1: Setting up AWS SES..."
echo "================================"

echo "Verifying sender email: $ALERT_FROM"
aws ses verify-email-identity --email-address "$ALERT_FROM" --region us-east-1 2>/dev/null || true

echo "Verifying recipient email: $ALERT_EMAIL"
aws ses verify-email-identity --email-address "$ALERT_EMAIL" --region us-east-1 2>/dev/null || true

echo -e "${YELLOW}⚠️  Check your email for verification links!${NC}"
echo ""

# Check verification status
echo "Checking verification status..."
sleep 2
VERIFICATION=$(aws ses get-identity-verification-attributes \
    --identities "$ALERT_FROM" "$ALERT_EMAIL" \
    --region us-east-1 \
    --output json)

echo "$VERIFICATION" | jq -r '.VerificationAttributes | to_entries[] | "\(.key): \(.value.VerificationStatus)"'

echo ""
read -p "Have you clicked the verification links? (y/n) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo -e "${YELLOW}Please verify emails before continuing.${NC}"
    exit 1
fi

# Test email
echo "Sending test email..."
aws ses send-email \
    --from "$ALERT_FROM" \
    --destination "ToAddresses=$ALERT_EMAIL" \
    --message "Subject={Data='Hokusai Testnet - SES Test',Charset=utf8},Body={Text={Data='SES is configured correctly for Hokusai monitoring!',Charset=utf8}}" \
    --region us-east-1

echo -e "${GREEN}✅ Test email sent. Check your inbox.${NC}"
echo ""

# Step 2: SSM Parameters
echo "🔧 Step 2: Configuring SSM Parameters..."
echo "========================================"

aws ssm put-parameter \
    --name "/hokusai/development/monitoring/network" \
    --value "sepolia" \
    --type "String" \
    --overwrite

aws ssm put-parameter \
    --name "/hokusai/development/monitoring/sepolia_rpc_url" \
    --value "$SEPOLIA_RPC" \
    --type "SecureString" \
    --overwrite

if [ ! -z "$BACKUP_RPC" ]; then
    aws ssm put-parameter \
        --name "/hokusai/development/monitoring/backup_rpc_url" \
        --value "$BACKUP_RPC" \
        --type "SecureString" \
        --overwrite
fi

aws ssm put-parameter \
    --name "/hokusai/development/monitoring/alert_email" \
    --value "$ALERT_EMAIL" \
    --type "String" \
    --overwrite

aws ssm put-parameter \
    --name "/hokusai/development/monitoring/enabled" \
    --value "true" \
    --type "String" \
    --overwrite

echo -e "${GREEN}✅ SSM parameters configured${NC}"
echo ""

# Step 3: Build Docker Image
echo "🐳 Step 3: Building Docker Image..."
echo "==================================="

cd "$(dirname "$0")/../services/contract-deployer"

echo "Installing npm dependencies..."
npm install --quiet

echo "Building TypeScript..."
npm run build

echo "Building Docker image..."
docker build -t hokusai-contracts:testnet . --quiet

echo -e "${GREEN}✅ Docker image built${NC}"
echo ""

# Step 4: Push to ECR
echo "📤 Step 4: Pushing to ECR..."
echo "============================"

echo "Logging into ECR..."
aws ecr get-login-password --region us-east-1 | \
    docker login --username AWS --password-stdin 932100697590.dkr.ecr.us-east-1.amazonaws.com

echo "Tagging image..."
docker tag hokusai-contracts:testnet \
    932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet

echo "Pushing to ECR..."
docker push 932100697590.dkr.ecr.us-east-1.amazonaws.com/hokusai/contracts:testnet

echo -e "${GREEN}✅ Image pushed to ECR${NC}"
echo ""

# Step 5: Deploy to ECS
echo "🚢 Step 5: Deploying to ECS..."
echo "=============================="

# Check if service exists
SERVICE_EXISTS=$(aws ecs describe-services \
    --cluster hokusai-development \
    --services hokusai-contracts-development \
    --region us-east-1 \
    --query 'services[0].serviceName' \
    --output text 2>/dev/null || echo "None")

if [ "$SERVICE_EXISTS" == "hokusai-contracts-development" ]; then
    echo "Updating existing service..."
    aws ecs update-service \
        --cluster hokusai-development \
        --service hokusai-contracts-development \
        --force-new-deployment \
        --region us-east-1 \
        --output json > /dev/null

    echo "Waiting for service to stabilize..."
    aws ecs wait services-stable \
        --cluster hokusai-development \
        --services hokusai-contracts-development \
        --region us-east-1
else
    echo -e "${YELLOW}⚠️  Service does not exist. Please create it manually or use ecs/task-definition-testnet.json${NC}"
    echo "Command: aws ecs create-service --cli-input-json file://ecs/task-definition-testnet.json"
    exit 1
fi

echo -e "${GREEN}✅ Service deployed${NC}"
echo ""

# Step 6: Verify Deployment
echo "✅ Step 6: Verifying Deployment..."
echo "=================================="

echo "Waiting 30 seconds for service to start..."
sleep 30

# Get task ARN
TASK_ARN=$(aws ecs list-tasks \
    --cluster hokusai-development \
    --service-name hokusai-contracts-development \
    --region us-east-1 \
    --query 'taskArns[0]' \
    --output text)

if [ "$TASK_ARN" == "None" ] || [ -z "$TASK_ARN" ]; then
    echo -e "${RED}❌ No tasks running${NC}"
    exit 1
fi

echo "Task ARN: $TASK_ARN"

# Check task status
TASK_STATUS=$(aws ecs describe-tasks \
    --cluster hokusai-development \
    --tasks "$TASK_ARN" \
    --region us-east-1 \
    --query 'tasks[0].lastStatus' \
    --output text)

echo "Task Status: $TASK_STATUS"

if [ "$TASK_STATUS" != "RUNNING" ]; then
    echo -e "${YELLOW}⚠️  Task is not running yet. Current status: $TASK_STATUS${NC}"
fi

# Try to hit health endpoint
echo ""
echo "Checking health endpoint..."
SERVICE_URL="https://contracts.hokus.ai"

HEALTH_STATUS=$(curl -s "$SERVICE_URL/health" | jq -r .status 2>/dev/null || echo "unavailable")
if [ "$HEALTH_STATUS" == "ok" ]; then
    echo -e "${GREEN}✅ Health check passed${NC}"

    # Check monitoring health
    echo "Checking monitoring status..."
    MONITORING_STATUS=$(curl -s "$SERVICE_URL/api/monitoring/health" | jq -r .data.status 2>/dev/null || echo "unavailable")

    if [ "$MONITORING_STATUS" == "healthy" ]; then
        echo -e "${GREEN}✅ Monitoring is healthy${NC}"

        # Get pool count
        POOL_COUNT=$(curl -s "$SERVICE_URL/api/monitoring/pools" | jq -r .data.count 2>/dev/null || echo "0")
        echo "Pools monitored: $POOL_COUNT"
    else
        echo -e "${YELLOW}⚠️  Monitoring status: $MONITORING_STATUS${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Health endpoint unavailable. Service may still be starting.${NC}"
fi

echo ""

# Summary
echo "🎉 Deployment Complete!"
echo "======================="
echo ""
echo "Next Steps:"
echo "1. Check your email for test alert"
echo "2. Monitor CloudWatch logs:"
echo "   aws logs tail /ecs/hokusai-contracts --follow"
echo "3. Test monitoring endpoints:"
echo "   curl $SERVICE_URL/api/monitoring/summary | jq"
echo "4. Execute test trades on Sepolia"
echo "5. Monitor for 48 hours before mainnet"
echo ""
echo "Useful Commands:"
echo "• Status: curl $SERVICE_URL/api/monitoring/health | jq"
echo "• Metrics: curl $SERVICE_URL/api/monitoring/metrics | jq"
echo "• Alerts: curl $SERVICE_URL/api/monitoring/alerts/recent | jq"
echo "• Logs: aws logs tail /ecs/hokusai-contracts --follow"
echo ""
echo -e "${GREEN}✅ Testnet deployment successful!${NC}"
