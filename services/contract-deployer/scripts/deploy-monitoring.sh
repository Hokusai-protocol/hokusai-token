#!/bin/bash

# Deploy Phase-Aware Monitoring Updates
# This script deploys monitoring updates WITHOUT touching contracts

set -e  # Exit on error
set -o pipefail  # Exit on pipe failure

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID:-932100697590}
CLUSTER_NAME=${CLUSTER_NAME:-hokusai-development}
SERVICE_NAME=${SERVICE_NAME:-hokusai-monitor-testnet}
ECR_REPOSITORY="hokusai-monitoring"
ECR_URL="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Logging functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_step() {
    echo -e "${BLUE}[STEP]${NC} $1"
}

# Function to check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."

    # Check if Docker is installed
    if ! command -v docker &> /dev/null; then
        log_error "Docker is not installed"
        exit 1
    fi

    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        exit 1
    fi

    # Check if npm is installed
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi

    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or invalid"
        exit 1
    fi

    # Verify we're in the right directory
    if [ ! -f "package.json" ] || [ ! -d "src" ]; then
        log_error "Must run from services/contract-deployer directory"
        exit 1
    fi

    log_info "Prerequisites check passed ✅"
}

# Function to build TypeScript
build_typescript() {
    log_step "Step 1: Building TypeScript..."

    npm run build

    if [ $? -ne 0 ]; then
        log_error "TypeScript build failed"
        exit 1
    fi

    log_info "TypeScript build successful ✅"
}

# Function to build Docker image
build_docker_image() {
    log_step "Step 2: Building Docker image for AMD64..."

    # Get version info
    VERSION=$(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
    GIT_HASH=$(git rev-parse --short HEAD 2>/dev/null || echo "no-git")

    log_info "Version: $VERSION"
    log_info "Git Hash: $GIT_HASH"

    # Build for AMD64 (required for AWS ECS Fargate)
    docker buildx build \
        --platform linux/amd64 \
        --build-arg VERSION=$VERSION \
        --build-arg BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ') \
        --build-arg VCS_REF=$GIT_HASH \
        -t hokusai-monitoring:latest \
        -t hokusai-monitoring:${VERSION} \
        -t hokusai-monitoring:${GIT_HASH} \
        --load \
        .

    if [ $? -ne 0 ]; then
        log_error "Docker build failed"
        exit 1
    fi

    log_info "Docker build successful ✅"

    # Get image size
    IMAGE_SIZE=$(docker images hokusai-monitoring:latest --format "{{.Size}}")
    log_info "Image size: $IMAGE_SIZE"
}

# Function to push to ECR
push_to_ecr() {
    log_step "Step 3: Pushing to ECR..."

    # Login to ECR
    log_info "Logging in to ECR..."
    aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com

    if [ $? -ne 0 ]; then
        log_error "ECR login failed"
        exit 1
    fi

    # Tag for ECR
    log_info "Tagging image for ECR..."
    docker tag hokusai-monitoring:latest ${ECR_URL}:latest

    # Push to ECR
    log_info "Pushing to ${ECR_URL}:latest..."
    docker push ${ECR_URL}:latest

    if [ $? -ne 0 ]; then
        log_error "Docker push failed"
        exit 1
    fi

    log_info "Push to ECR successful ✅"
}

# Function to update ECS service
update_ecs_service() {
    log_step "Step 4: Updating ECS service..."

    log_info "Cluster: ${CLUSTER_NAME}"
    log_info "Service: ${SERVICE_NAME}"

    # Get current service info
    CURRENT_TASK_COUNT=$(aws ecs describe-services \
        --cluster ${CLUSTER_NAME} \
        --services ${SERVICE_NAME} \
        --region ${AWS_REGION} \
        --query 'services[0].runningCount' \
        --output text)

    log_info "Current running tasks: ${CURRENT_TASK_COUNT}"

    # Force new deployment
    aws ecs update-service \
        --cluster ${CLUSTER_NAME} \
        --service ${SERVICE_NAME} \
        --force-new-deployment \
        --region ${AWS_REGION} \
        --output json > /dev/null

    if [ $? -ne 0 ]; then
        log_error "Failed to update ECS service"
        exit 1
    fi

    log_info "Service update initiated ✅"
}

# Function to monitor deployment
monitor_deployment() {
    log_step "Step 5: Monitoring deployment..."

    log_info "Waiting for new task to start (this may take 2-3 minutes)..."

    local max_wait=300  # 5 minutes
    local elapsed=0
    local check_interval=10

    while [ $elapsed -lt $max_wait ]; do
        # Get service status
        local service_json=$(aws ecs describe-services \
            --cluster ${CLUSTER_NAME} \
            --services ${SERVICE_NAME} \
            --region ${AWS_REGION} \
            --output json)

        local running_count=$(echo ${service_json} | jq '.services[0].runningCount')
        local desired_count=$(echo ${service_json} | jq '.services[0].desiredCount')
        local deployments=$(echo ${service_json} | jq '.services[0].deployments | length')

        log_info "Running: ${running_count}/${desired_count}, Active Deployments: ${deployments}"

        # Check if deployment is complete
        if [ "${deployments}" -eq "1" ] && [ "${running_count}" -eq "${desired_count}" ]; then
            log_info "Deployment completed successfully! ✅"
            return 0
        fi

        sleep $check_interval
        elapsed=$((elapsed + check_interval))
    done

    log_warn "Deployment monitoring timed out. Check AWS Console for status."
    return 1
}

# Function to show next steps
show_next_steps() {
    log_info "========================================"
    log_info "Monitoring Update Deployment Complete!"
    log_info "========================================"
    echo ""
    log_info "Next Steps:"
    echo ""
    echo "1. Check CloudWatch Logs:"
    echo "   aws logs tail /ecs/hokusai-monitor-testnet --follow --region us-east-1"
    echo ""
    echo "2. Verify phase detection is working:"
    echo "   - Look for log messages: 'Checking anomalies for <modelId>'"
    echo "   - Verify 'phase: FLAT_PRICE' or 'phase: BONDING_CURVE' appears"
    echo "   - Check for 'Suppressing percentage-based alerts' in flat phase"
    echo ""
    echo "3. Monitor for alerts:"
    echo "   - Watch logs for any 'true_supply_mismatch' alerts"
    echo "   - Check email for alert notifications"
    echo ""
    echo "4. Backfill deployment artifacts (optional):"
    echo "   cd ../../"
    echo "   npx hardhat run scripts/backfill-phase-params.js --network sepolia"
    echo ""
    log_info "========================================"
}

# Main deployment process
main() {
    log_info "========================================"
    log_info "Phase-Aware Monitoring Deployment"
    log_info "========================================"
    log_info "Environment: Testnet (Sepolia)"
    log_info "Service: ${SERVICE_NAME}"
    log_info "ECR: ${ECR_URL}"
    log_info "========================================"
    echo ""

    check_prerequisites
    echo ""

    build_typescript
    echo ""

    build_docker_image
    echo ""

    push_to_ecr
    echo ""

    update_ecs_service
    echo ""

    monitor_deployment
    echo ""

    show_next_steps
}

# Run main function
main "$@"
