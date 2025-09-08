#!/bin/bash

# ECR Deployment Script for Contract Deployer API
# This script builds the Docker image and pushes it to AWS ECR

set -e  # Exit on error
set -o pipefail  # Exit on pipe failure

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID:-932100697590}
ECR_REPOSITORY="hokusai/contracts"
ECR_URL="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"
IMAGE_NAME="contract-deployer"
ENV=${ENV:-development}

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
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
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or invalid"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Function to get Git commit hash for tagging
get_git_hash() {
    if command -v git &> /dev/null && git rev-parse --git-dir > /dev/null 2>&1; then
        echo $(git rev-parse --short HEAD)
    else
        echo "no-git"
    fi
}

# Function to get version from package.json
get_version() {
    if [ -f "package.json" ]; then
        echo $(node -p "require('./package.json').version" 2>/dev/null || echo "0.0.0")
    else
        echo "0.0.0"
    fi
}

# Main deployment process
main() {
    log_info "Starting ECR deployment for Contract Deployer API"
    log_info "Environment: $ENV"
    log_info "ECR Repository: $ECR_URL"
    
    # Check prerequisites
    check_prerequisites
    
    # Get version and git hash for tagging
    VERSION=$(get_version)
    GIT_HASH=$(get_git_hash)
    TIMESTAMP=$(date +%Y%m%d-%H%M%S)
    
    log_info "Version: $VERSION"
    log_info "Git Hash: $GIT_HASH"
    
    # Build Docker image
    log_info "Building Docker image..."
    docker build \
        --build-arg VERSION=$VERSION \
        --build-arg BUILD_DATE=$(date -u +'%Y-%m-%dT%H:%M:%SZ') \
        --build-arg VCS_REF=$GIT_HASH \
        -t ${IMAGE_NAME}:latest \
        -t ${IMAGE_NAME}:${VERSION} \
        -t ${IMAGE_NAME}:${GIT_HASH} \
        -t ${IMAGE_NAME}:${ENV}-${TIMESTAMP} \
        .
    
    if [ $? -ne 0 ]; then
        log_error "Docker build failed"
        exit 1
    fi
    
    log_info "Docker build successful"
    
    # Get Docker image size
    IMAGE_SIZE=$(docker images ${IMAGE_NAME}:latest --format "{{.Size}}")
    log_info "Image size: $IMAGE_SIZE"
    
    # Verify image size is under 200MB (optional check)
    IMAGE_SIZE_MB=$(docker images ${IMAGE_NAME}:latest --format "{{.Size}}" | sed 's/MB//' | sed 's/GB/*1024/' | bc 2>/dev/null || echo "0")
    if [ ! -z "$IMAGE_SIZE_MB" ] && [ "$IMAGE_SIZE_MB" != "0" ]; then
        if (( $(echo "$IMAGE_SIZE_MB > 200" | bc -l) )); then
            log_warn "Image size exceeds 200MB target: ${IMAGE_SIZE}"
        fi
    fi
    
    # Login to ECR
    log_info "Logging in to ECR..."
    aws ecr get-login-password --region ${AWS_REGION} | docker login --username AWS --password-stdin ${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com
    
    if [ $? -ne 0 ]; then
        log_error "ECR login failed"
        exit 1
    fi
    
    # Tag images for ECR
    log_info "Tagging images for ECR..."
    docker tag ${IMAGE_NAME}:latest ${ECR_URL}:latest
    docker tag ${IMAGE_NAME}:${VERSION} ${ECR_URL}:${VERSION}
    docker tag ${IMAGE_NAME}:${GIT_HASH} ${ECR_URL}:${GIT_HASH}
    docker tag ${IMAGE_NAME}:${ENV}-${TIMESTAMP} ${ECR_URL}:${ENV}-${TIMESTAMP}
    
    # Push images to ECR
    log_info "Pushing images to ECR..."
    
    # Push with retry logic
    push_with_retry() {
        local tag=$1
        local max_attempts=3
        local attempt=1
        
        while [ $attempt -le $max_attempts ]; do
            log_info "Pushing ${ECR_URL}:${tag} (attempt $attempt/$max_attempts)..."
            
            if docker push ${ECR_URL}:${tag}; then
                log_info "Successfully pushed ${ECR_URL}:${tag}"
                return 0
            else
                log_warn "Push failed for ${ECR_URL}:${tag}"
                attempt=$((attempt + 1))
                
                if [ $attempt -le $max_attempts ]; then
                    log_info "Retrying in 5 seconds..."
                    sleep 5
                fi
            fi
        done
        
        log_error "Failed to push ${ECR_URL}:${tag} after $max_attempts attempts"
        return 1
    }
    
    # Push all tags
    push_with_retry "latest" || exit 1
    push_with_retry "${VERSION}" || exit 1
    push_with_retry "${GIT_HASH}" || exit 1
    push_with_retry "${ENV}-${TIMESTAMP}" || exit 1
    
    # Clean up local images (optional)
    if [ "${CLEANUP:-true}" = "true" ]; then
        log_info "Cleaning up local images..."
        docker rmi ${IMAGE_NAME}:latest ${IMAGE_NAME}:${VERSION} ${IMAGE_NAME}:${GIT_HASH} ${IMAGE_NAME}:${ENV}-${TIMESTAMP} 2>/dev/null || true
        docker rmi ${ECR_URL}:latest ${ECR_URL}:${VERSION} ${ECR_URL}:${GIT_HASH} ${ECR_URL}:${ENV}-${TIMESTAMP} 2>/dev/null || true
    fi
    
    # Output deployment summary
    log_info "========================================"
    log_info "ECR Deployment Successful!"
    log_info "========================================"
    log_info "Repository: ${ECR_URL}"
    log_info "Tags pushed:"
    log_info "  - latest"
    log_info "  - ${VERSION}"
    log_info "  - ${GIT_HASH}"
    log_info "  - ${ENV}-${TIMESTAMP}"
    log_info "========================================"
    
    # Output next steps
    log_info "Next steps:"
    log_info "  1. Update ECS task definition with new image"
    log_info "  2. Run: ./scripts/deploy.sh"
    log_info "  3. Monitor CloudWatch logs for deployment"
}

# Run main function
main "$@"