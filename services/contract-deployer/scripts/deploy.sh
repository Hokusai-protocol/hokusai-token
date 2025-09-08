#!/bin/bash

# ECS Deployment Script for Contract Deployer API
# This script updates the ECS service with a new task definition

set -e  # Exit on error
set -o pipefail  # Exit on pipe failure

# Configuration
AWS_REGION=${AWS_REGION:-us-east-1}
AWS_ACCOUNT_ID=${AWS_ACCOUNT_ID:-932100697590}
CLUSTER_NAME=${CLUSTER_NAME:-hokusai-development}
SERVICE_NAME=${SERVICE_NAME:-hokusai-contracts-development}
TASK_FAMILY=${TASK_FAMILY:-hokusai-contracts-task}
ECR_REPOSITORY="hokusai/contracts"
ECR_URL="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

# Deployment options
MAX_WAIT_TIME=${MAX_WAIT_TIME:-600}  # Maximum time to wait for deployment (seconds)
ROLLBACK_ON_FAILURE=${ROLLBACK_ON_FAILURE:-true}
IMAGE_TAG=${IMAGE_TAG:-latest}

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

log_debug() {
    echo -e "${BLUE}[DEBUG]${NC} $1"
}

# Function to check prerequisites
check_prerequisites() {
    log_info "Checking prerequisites..."
    
    # Check if AWS CLI is installed
    if ! command -v aws &> /dev/null; then
        log_error "AWS CLI is not installed"
        exit 1
    fi
    
    # Check if jq is installed (for JSON parsing)
    if ! command -v jq &> /dev/null; then
        log_error "jq is not installed. Please install it: brew install jq (macOS) or apt-get install jq (Linux)"
        exit 1
    fi
    
    # Check AWS credentials
    if ! aws sts get-caller-identity &> /dev/null; then
        log_error "AWS credentials not configured or invalid"
        exit 1
    fi
    
    # Verify cluster exists
    if ! aws ecs describe-clusters --clusters ${CLUSTER_NAME} --region ${AWS_REGION} &> /dev/null; then
        log_error "ECS cluster '${CLUSTER_NAME}' not found in region ${AWS_REGION}"
        exit 1
    fi
    
    # Verify service exists
    if ! aws ecs describe-services --cluster ${CLUSTER_NAME} --services ${SERVICE_NAME} --region ${AWS_REGION} &> /dev/null; then
        log_error "ECS service '${SERVICE_NAME}' not found in cluster ${CLUSTER_NAME}"
        exit 1
    fi
    
    log_info "Prerequisites check passed"
}

# Function to get current task definition
get_current_task_definition() {
    aws ecs describe-services \
        --cluster ${CLUSTER_NAME} \
        --services ${SERVICE_NAME} \
        --region ${AWS_REGION} \
        --query 'services[0].taskDefinition' \
        --output text
}

# Function to create new task definition revision
create_new_task_definition() {
    local current_task_def=$1
    local new_image="${ECR_URL}:${IMAGE_TAG}"
    
    log_info "Creating new task definition with image: ${new_image}"
    
    # Get current task definition
    local task_def_json=$(aws ecs describe-task-definition \
        --task-definition ${current_task_def} \
        --region ${AWS_REGION} \
        --query 'taskDefinition')
    
    # Update the image in the task definition
    local new_task_def=$(echo ${task_def_json} | jq \
        --arg IMAGE "${new_image}" \
        '.containerDefinitions[0].image = $IMAGE | 
         del(.taskDefinitionArn) | 
         del(.revision) | 
         del(.status) | 
         del(.requiresAttributes) | 
         del(.compatibilities) | 
         del(.registeredAt) | 
         del(.registeredBy)')
    
    # Register new task definition
    local new_task_arn=$(aws ecs register-task-definition \
        --cli-input-json "${new_task_def}" \
        --region ${AWS_REGION} \
        --query 'taskDefinition.taskDefinitionArn' \
        --output text)
    
    if [ -z "${new_task_arn}" ]; then
        log_error "Failed to register new task definition"
        exit 1
    fi
    
    echo ${new_task_arn}
}

# Function to update ECS service
update_ecs_service() {
    local new_task_def=$1
    
    log_info "Updating ECS service with new task definition: ${new_task_def}"
    
    aws ecs update-service \
        --cluster ${CLUSTER_NAME} \
        --service ${SERVICE_NAME} \
        --task-definition ${new_task_def} \
        --force-new-deployment \
        --region ${AWS_REGION} \
        --output json > /dev/null
    
    if [ $? -ne 0 ]; then
        log_error "Failed to update ECS service"
        exit 1
    fi
    
    log_info "Service update initiated"
}

# Function to wait for deployment to complete
wait_for_deployment() {
    local start_time=$(date +%s)
    local timeout=${MAX_WAIT_TIME}
    
    log_info "Waiting for deployment to complete (timeout: ${timeout}s)..."
    
    while true; do
        # Get service status
        local service_json=$(aws ecs describe-services \
            --cluster ${CLUSTER_NAME} \
            --services ${SERVICE_NAME} \
            --region ${AWS_REGION} \
            --output json)
        
        local running_count=$(echo ${service_json} | jq '.services[0].runningCount')
        local desired_count=$(echo ${service_json} | jq '.services[0].desiredCount')
        local pending_count=$(echo ${service_json} | jq '.services[0].pendingCount')
        
        # Check deployments
        local deployments=$(echo ${service_json} | jq '.services[0].deployments | length')
        
        log_debug "Running: ${running_count}/${desired_count}, Pending: ${pending_count}, Active Deployments: ${deployments}"
        
        # Check if deployment is complete (only 1 deployment and all tasks running)
        if [ "${deployments}" -eq "1" ] && [ "${running_count}" -eq "${desired_count}" ] && [ "${pending_count}" -eq "0" ]; then
            log_info "Deployment completed successfully!"
            return 0
        fi
        
        # Check timeout
        local current_time=$(date +%s)
        local elapsed=$((current_time - start_time))
        
        if [ ${elapsed} -ge ${timeout} ]; then
            log_error "Deployment timed out after ${timeout} seconds"
            return 1
        fi
        
        # Wait before checking again
        sleep 10
    done
}

# Function to rollback deployment
rollback_deployment() {
    local previous_task_def=$1
    
    log_warn "Rolling back to previous task definition: ${previous_task_def}"
    
    aws ecs update-service \
        --cluster ${CLUSTER_NAME} \
        --service ${SERVICE_NAME} \
        --task-definition ${previous_task_def} \
        --force-new-deployment \
        --region ${AWS_REGION} \
        --output json > /dev/null
    
    if [ $? -eq 0 ]; then
        log_info "Rollback initiated successfully"
    else
        log_error "Rollback failed!"
    fi
}

# Function to verify deployment health
verify_deployment_health() {
    log_info "Verifying deployment health..."
    
    # Get target group health (if configured)
    # This assumes the service is behind an ALB
    local target_group_arn=$(aws ecs describe-services \
        --cluster ${CLUSTER_NAME} \
        --services ${SERVICE_NAME} \
        --region ${AWS_REGION} \
        --query 'services[0].loadBalancers[0].targetGroupArn' \
        --output text 2>/dev/null)
    
    if [ ! -z "${target_group_arn}" ] && [ "${target_group_arn}" != "None" ]; then
        log_info "Checking target group health..."
        
        local healthy_targets=$(aws elbv2 describe-target-health \
            --target-group-arn ${target_group_arn} \
            --region ${AWS_REGION} \
            --query 'TargetHealthDescriptions[?TargetHealth.State==`healthy`] | length(@)' \
            --output text)
        
        if [ "${healthy_targets}" -gt "0" ]; then
            log_info "Target group has ${healthy_targets} healthy targets"
        else
            log_warn "No healthy targets in target group yet"
        fi
    fi
    
    # Test health endpoint
    local health_url="https://contracts.hokus.ai/health"
    log_info "Testing health endpoint: ${health_url}"
    
    if curl -f -s -o /dev/null -w "%{http_code}" ${health_url} | grep -q "200"; then
        log_info "Health check passed!"
        return 0
    else
        log_warn "Health check failed or service not yet accessible"
        return 1
    fi
}

# Main deployment process
main() {
    log_info "========================================"
    log_info "Starting ECS Deployment"
    log_info "========================================"
    log_info "Cluster: ${CLUSTER_NAME}"
    log_info "Service: ${SERVICE_NAME}"
    log_info "Image Tag: ${IMAGE_TAG}"
    log_info "Region: ${AWS_REGION}"
    log_info "========================================"
    
    # Check prerequisites
    check_prerequisites
    
    # Get current task definition (for rollback if needed)
    log_info "Getting current task definition..."
    CURRENT_TASK_DEF=$(get_current_task_definition)
    log_info "Current task definition: ${CURRENT_TASK_DEF}"
    
    # Create new task definition with updated image
    log_info "Creating new task definition..."
    NEW_TASK_DEF=$(create_new_task_definition ${CURRENT_TASK_DEF})
    log_info "New task definition created: ${NEW_TASK_DEF}"
    
    # Update ECS service
    update_ecs_service ${NEW_TASK_DEF}
    
    # Wait for deployment to complete
    if wait_for_deployment; then
        # Verify deployment health
        if verify_deployment_health; then
            log_info "========================================"
            log_info "Deployment Successful!"
            log_info "========================================"
            log_info "Service: ${SERVICE_NAME}"
            log_info "Task Definition: ${NEW_TASK_DEF}"
            log_info "Image: ${ECR_URL}:${IMAGE_TAG}"
            log_info "========================================"
            exit 0
        else
            log_warn "Health check failed, but deployment completed"
            
            if [ "${ROLLBACK_ON_FAILURE}" = "true" ]; then
                rollback_deployment ${CURRENT_TASK_DEF}
                exit 1
            fi
        fi
    else
        log_error "Deployment failed or timed out"
        
        if [ "${ROLLBACK_ON_FAILURE}" = "true" ]; then
            rollback_deployment ${CURRENT_TASK_DEF}
        fi
        
        exit 1
    fi
}

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --tag)
            IMAGE_TAG="$2"
            shift 2
            ;;
        --cluster)
            CLUSTER_NAME="$2"
            shift 2
            ;;
        --service)
            SERVICE_NAME="$2"
            shift 2
            ;;
        --no-rollback)
            ROLLBACK_ON_FAILURE=false
            shift
            ;;
        --timeout)
            MAX_WAIT_TIME="$2"
            shift 2
            ;;
        --help)
            echo "Usage: $0 [options]"
            echo "Options:"
            echo "  --tag <tag>         Docker image tag to deploy (default: latest)"
            echo "  --cluster <name>    ECS cluster name"
            echo "  --service <name>    ECS service name"
            echo "  --no-rollback       Disable automatic rollback on failure"
            echo "  --timeout <seconds> Maximum wait time for deployment (default: 600)"
            echo "  --help              Show this help message"
            exit 0
            ;;
        *)
            log_error "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Run main function
main "$@"