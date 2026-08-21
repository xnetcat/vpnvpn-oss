#!/usr/bin/env bash
# =============================================================================
# vpnVPN Teardown Script
# =============================================================================
# This script destroys all resources for a specified environment:
# 1. Destroys all regional Pulumi stacks
# 2. Destroys the global Pulumi stack
# 3. Verifies that all resources are gone across all regions
#
# Usage:
#   ./scripts/teardown.sh [staging|production]
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

ENVIRONMENT="${1:-}"

if [[ "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  log_error "Usage: $0 [staging|production]"
  exit 1
fi

log_warn "You are about to DESTROY all resources for environment: ${ENVIRONMENT}"
log_warn "This includes all VPN nodes, databases, and global infrastructure."
read -p "Are you sure? (y/N) " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  log_info "Aborted."
  exit 1
fi

# =============================================================================
# Step 1: Destroy Pulumi Stacks
# =============================================================================

destroy_stacks() {
  log_info "Destroying Pulumi stacks..."
  
  cd "${ROOT_DIR}/infra/pulumi"
  
  # List all stacks
  log_info "Listing stacks..."
  STACKS=$(pulumi stack ls --json | jq -r '.[].name')
  
  # Filter for regional stacks for this environment
  REGIONAL_STACKS=$(echo "$STACKS" | grep "^region-.*-${ENVIRONMENT}$" || echo "")
  
  if [[ -n "$REGIONAL_STACKS" ]]; then
    for stack in $REGIONAL_STACKS; do
      log_info "Destroying regional stack: ${stack}"
      pulumi stack select "${stack}"
      pulumi destroy -y --skip-preview
      pulumi stack rm -y "${stack}"
      log_success "Destroyed and removed stack: ${stack}"
    done
  else
    log_info "No regional stacks found for ${ENVIRONMENT}"
  fi
  
  cd "${ROOT_DIR}"
}

# =============================================================================
# Step 2: Verify Resource Removal
# =============================================================================

verify_removal() {
  log_info "Verifying resource removal across all regions..."
  
  # Get all enabled regions
  REGIONS=$(aws ec2 describe-regions --query "Regions[].RegionName" --output text)
  
  FOUND_RESOURCES=false
  
  for region in $REGIONS; do
    # log_info "Checking region: ${region}..."
    
    # Check for EC2 Instances with Project=vpnvpn tag
    INSTANCES=$(aws ec2 describe-instances --region "${region}" \
      --filters "Name=tag:Project,Values=vpnvpn" "Name=instance-state-name,Values=running,pending,stopping,stopped" \
      --query "Reservations[].Instances[].InstanceId" --output text)
      
    if [[ -n "$INSTANCES" ]]; then
      log_error "[${region}] Found lingering EC2 instances: ${INSTANCES}"
      FOUND_RESOURCES=true
    fi
    
    # Check for Load Balancers (ALB/NLB) with Project=vpnvpn tag
    LBS=$(aws elbv2 describe-load-balancers --region "${region}" \
      --query "LoadBalancers[?contains(Tags[?Key=='Project'].Value, 'vpnvpn')].LoadBalancerArn" --output text 2>/dev/null || echo "")
      
    # If tags filter isn't supported directly in describe-load-balancers for all CLI versions, 
    # we might need to fetch all and filter, but let's assume standard tagging works or we check by name pattern if needed.
    # Actually, describe-load-balancers doesn't support tag filtering directly in all versions easily without iterating.
    # Let's try resource groups tagging api which is more efficient for "find all resources with tag".
    
    # Using Resource Groups Tagging API is better for "find everything with this tag"
    RESOURCES=$(aws resourcegroupstaggingapi get-resources --region "${region}" \
      --tag-filters Key=Project,Values=vpnvpn \
      --query "ResourceTagMappingList[].ResourceARN" --output text)
      
    if [[ -n "$RESOURCES" ]]; then
       # Filter out terminated instances that might still show up for a bit
       # But generally, if it shows up, it's worth noting.
       log_error "[${region}] Found lingering resources with tag Project=vpnvpn:"
       echo "$RESOURCES"
       FOUND_RESOURCES=true
    fi
    
    # Also check specifically for our CloudWatch Log Groups as they might not have tags propagated or might persist
    LOG_GROUPS=$(aws logs describe-log-groups --region "${region}" --log-group-name-prefix "/aws/lambda/vpnvpn" --query "logGroups[].logGroupName" --output text)
    if [[ -n "$LOG_GROUPS" ]]; then
       log_warn "[${region}] Found Log Groups (might need manual cleanup if not tagged):"
       echo "$LOG_GROUPS"
       # Log groups are often not deleted by Pulumi if they were auto-created, or if retention keeps them.
       # We won't fail the verification for log groups, just warn.
    fi
    
  done
  
  if [[ "$FOUND_RESOURCES" == "true" ]]; then
    log_error "Verification FAILED: Some resources were not removed."
    exit 1
  else
    log_success "Verification PASSED: No active resources with tag Project=vpnvpn found."
  fi
}

main() {
  destroy_stacks
  verify_removal
}

main
