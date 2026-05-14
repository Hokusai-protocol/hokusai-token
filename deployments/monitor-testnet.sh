#!/usr/bin/env bash

set -euo pipefail

SERVICE_URL="${SERVICE_URL:-https://contracts.hokus.ai}"
AWS_CLUSTER="${AWS_CLUSTER:-hokusai-development}"
AWS_SERVICE="${AWS_SERVICE:-hokusai-contracts-development}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-30}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: $1 is required" >&2
    exit 1
  fi
}

json_get() {
  jq -r "$1 // \"unknown\"" 2>/dev/null || echo "unknown"
}

require_command curl
require_command jq

while true; do
  clear
  echo "Hokusai Sepolia Monitoring Dashboard"
  echo "===================================="
  echo "Updated: $(date '+%Y-%m-%d %H:%M:%S')"
  echo "Service URL: $SERVICE_URL"
  echo

  echo "Service Health"
  echo "--------------"
  HEALTH="$(curl -fsS "$SERVICE_URL/health" 2>/dev/null || true)"
  if [[ -n "$HEALTH" ]]; then
    echo "$HEALTH" | jq .
  else
    echo "health endpoint unreachable"
  fi
  echo

  echo "Monitoring Health"
  echo "-----------------"
  MON_HEALTH="$(curl -fsS "$SERVICE_URL/api/monitoring/health" 2>/dev/null || true)"
  if [[ -n "$MON_HEALTH" ]]; then
    STATUS="$(echo "$MON_HEALTH" | json_get '.data.status')"
    POOLS="$(echo "$MON_HEALTH" | json_get '.data.poolsMonitored')"
    echo "status: $STATUS"
    echo "pools monitored: $POOLS"
    echo "$MON_HEALTH" | jq '.data.components // {}'
  else
    echo "monitoring health endpoint unreachable"
  fi
  echo

  echo "Pools"
  echo "-----"
  POOLS_JSON="$(curl -fsS "$SERVICE_URL/api/monitoring/pools" 2>/dev/null || true)"
  if [[ -n "$POOLS_JSON" ]]; then
    echo "$POOLS_JSON" | jq -r '
      if (.data.pools // []) | length == 0 then
        "no pools reported"
      else
        (.data.pools // [])[] | "- \(.modelId // .name // "unknown"): \(.ammAddress // .poolAddress // "unknown")"
      end
    '
  else
    echo "pools endpoint unreachable"
  fi
  echo

  echo "Recent Alerts"
  echo "-------------"
  ALERTS_JSON="$(curl -fsS "$SERVICE_URL/api/monitoring/alerts/recent" 2>/dev/null || true)"
  if [[ -n "$ALERTS_JSON" ]]; then
    echo "$ALERTS_JSON" | jq -r '
      if (.data.alerts // []) | length == 0 then
        "no recent alerts reported"
      else
        (.data.alerts // [])[0:5][] | "- [\(.priority // "unknown")] \(.type // "unknown"): \(.message // "")"
      end
    '
  else
    echo "alerts endpoint unreachable"
  fi
  echo

  if command -v aws >/dev/null 2>&1; then
    echo "ECS Service"
    echo "-----------"
    aws ecs describe-services \
      --cluster "$AWS_CLUSTER" \
      --services "$AWS_SERVICE" \
      --region "$AWS_REGION" \
      --query 'services[0].{status:status,desired:desiredCount,running:runningCount,pending:pendingCount,taskDefinition:taskDefinition}' \
      --output table 2>/dev/null || echo "ECS service status unavailable"
    echo
  fi

  echo "Next update in ${INTERVAL_SECONDS}s. Press Ctrl+C to exit."
  sleep "$INTERVAL_SECONDS"
done
