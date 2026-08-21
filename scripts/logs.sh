#!/usr/bin/env bash
# =============================================================================
# vpnVPN Log Viewer
# =============================================================================
# Fetches logs from a VPN server instance using AWS SSM.
#
# Usage:
#   ./scripts/logs.sh [staging|production] [region]
#
# Example:
#   ./scripts/logs.sh staging us-east-1
# =============================================================================

set -euo pipefail

ENVIRONMENT="${1:-staging}"
REGION="${2:-us-east-1}"

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check dependencies
if ! command -v aws &> /dev/null; then
    log_error "AWS CLI is required but not installed."
    exit 1
fi

if ! command -v jq &> /dev/null; then
    log_error "jq is required but not installed."
    exit 1
fi

log_info "Fetching logs for ${ENVIRONMENT} in ${REGION}..."

# Find the ASG for the region/environment
# We look for ASGs with tags Project=vpnvpn and Stack=region-<region>-<env>
STACK_NAME="region-${REGION}-${ENVIRONMENT}"
ASG_NAME=$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --query "AutoScalingGroups[?contains(Tags[?Key=='Stack'].Value, '${STACK_NAME}')].AutoScalingGroupName" \
    --output text)

if [[ -z "$ASG_NAME" ]]; then
    log_error "No Auto Scaling Group found for stack: ${STACK_NAME}"
    exit 1
fi

log_info "Found ASG: ${ASG_NAME}"

# Get the first instance in the ASG
INSTANCE_ID=$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --auto-scaling-group-names "${ASG_NAME}" \
    --query "AutoScalingGroups[0].Instances[?LifecycleState=='InService'].InstanceId | [0]" \
    --output text)

if [[ -z "$INSTANCE_ID" || "$INSTANCE_ID" == "None" ]]; then
    log_error "No active instances found in ASG."
    exit 1
fi

log_info "Targeting Instance: ${INSTANCE_ID}"

# Fetch logs via SSM
# We try two methods:
# 1. If the admin server is up and reachable via localhost (it should be), we curl /logs
# 2. If that fails, we get docker logs

log_info "Fetching logs via SSM..."

CMD_OUTPUT=$(aws ssm send-command \
    --region "${REGION}" \
    --instance-ids "${INSTANCE_ID}" \
    --document-name "AWS-RunShellScript" \
    --parameters 'commands=["curl -s http://localhost:8080/logs || docker logs vpn-server"]' \
    --output json)

CMD_ID=$(echo "$CMD_OUTPUT" | jq -r '.Command.CommandId')

if [[ -z "$CMD_ID" ]]; then
    log_error "Failed to send SSM command."
    exit 1
fi

# Wait for command to finish
log_info "Waiting for command ${CMD_ID} to complete..."
aws ssm wait command-executed --command-id "${CMD_ID}" --instance-id "${INSTANCE_ID}" --region "${REGION}"

# Get output
OUTPUT=$(aws ssm get-command-invocation \
    --command-id "${CMD_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --region "${REGION}" \
    --output json)

STATUS=$(echo "$OUTPUT" | jq -r '.Status')

if [[ "$STATUS" == "Success" ]]; then
    echo ""
    echo -e "${GREEN}=== LOGS START ===${NC}"
    echo "$OUTPUT" | jq -r '.StandardOutputContent'
    echo -e "${GREEN}=== LOGS END ===${NC}"
else
    log_error "Command failed with status: ${STATUS}"
    echo "$OUTPUT" | jq -r '.StandardErrorContent'
fi
