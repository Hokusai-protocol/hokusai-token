#!/bin/bash

# Hokusai AMM Monitoring - Live Dashboard
# Real-time monitoring dashboard for testnet deployment

SERVICE_URL="${SERVICE_URL:-https://contracts.hokus.ai}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Emojis
CHECK="✅"
WARN="⚠️ "
ERROR="❌"
INFO="ℹ️ "

print_header() {
    echo -e "${CYAN}╔════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║        🌊 Hokusai AMM Monitoring Dashboard 🌊             ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════════════════════════╝${NC}"
}

print_section() {
    echo -e "\n${BLUE}━━━ $1 ━━━${NC}"
}

format_number() {
    printf "%'d" "$1" 2>/dev/null || echo "$1"
}

format_currency() {
    printf "$%'.2f" "$1" 2>/dev/null || echo "$$1"
}

get_status_color() {
    case $1 in
        "healthy"|"ok"|"RUNNING"|"true")
            echo "$GREEN"
            ;;
        "degraded"|"warning")
            echo "$YELLOW"
            ;;
        "unhealthy"|"error"|"false"|"STOPPED")
            echo "$RED"
            ;;
        *)
            echo "$NC"
            ;;
    esac
}

while true; do
    clear
    print_header

    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${MAGENTA}Last Update: $TIMESTAMP${NC}"

    # Service Health
    print_section "Service Health"
    HEALTH=$(curl -s "$SERVICE_URL/health" 2>/dev/null)
    if [ $? -eq 0 ]; then
        HEALTH_STATUS=$(echo "$HEALTH" | jq -r '.status // "unknown"')
        COLOR=$(get_status_color "$HEALTH_STATUS")
        echo -e "Service Status: ${COLOR}$HEALTH_STATUS${NC}"
    else
        echo -e "Service Status: ${RED}unreachable${NC}"
    fi

    # ECS Task Status
    TASK_STATUS=$(aws ecs describe-services \
        --cluster hokusai-development \
        --services hokusai-contracts-development \
        --region us-east-1 \
        --query 'services[0].deployments[0]' 2>/dev/null | jq -r '{status:.status, desired:.desiredCount, running:.runningCount, pending:.pendingCount}')

    if [ $? -eq 0 ]; then
        DESIRED=$(echo "$TASK_STATUS" | jq -r '.desired')
        RUNNING=$(echo "$TASK_STATUS" | jq -r '.running')
        PENDING=$(echo "$TASK_STATUS" | jq -r '.pending')
        DEPLOY_STATUS=$(echo "$TASK_STATUS" | jq -r '.status')

        echo -e "ECS Tasks: ${GREEN}$RUNNING${NC}/$DESIRED running, $PENDING pending"
        echo -e "Deployment: $(get_status_color "$DEPLOY_STATUS")$DEPLOY_STATUS${NC}"
    fi

    # Monitoring Health
    print_section "Monitoring System"
    MON_HEALTH=$(curl -s "$SERVICE_URL/api/monitoring/health" 2>/dev/null)
    if [ $? -eq 0 ]; then
        MON_STATUS=$(echo "$MON_HEALTH" | jq -r '.data.status // "unknown"')
        UPTIME=$(echo "$MON_HEALTH" | jq -r '.data.uptime // 0')
        POOLS=$(echo "$MON_HEALTH" | jq -r '.data.poolsMonitored // 0')

        # Convert uptime to human readable
        UPTIME_SEC=$((UPTIME / 1000))
        UPTIME_MIN=$((UPTIME_SEC / 60))
        UPTIME_HOUR=$((UPTIME_MIN / 60))

        COLOR=$(get_status_color "$MON_STATUS")
        echo -e "Status: ${COLOR}$MON_STATUS${NC}"
        echo -e "Uptime: ${UPTIME_HOUR}h ${UPTIME_MIN}m"
        echo -e "Pools Monitored: ${GREEN}$POOLS${NC}"

        # Component health
        POOL_DISC=$(echo "$MON_HEALTH" | jq -r '.data.components.poolDiscovery')
        STATE_TRACK=$(echo "$MON_HEALTH" | jq -r '.data.components.stateTracking')
        EVENT_LIST=$(echo "$MON_HEALTH" | jq -r '.data.components.eventListening')
        METRICS=$(echo "$MON_HEALTH" | jq -r '.data.components.metricsCollection')

        echo -e "\nComponents:"
        echo -e "  Pool Discovery:    $(get_status_color "$POOL_DISC")$([ "$POOL_DISC" == "true" ] && echo "$CHECK" || echo "$ERROR")${NC}"
        echo -e "  State Tracking:    $(get_status_color "$STATE_TRACK")$([ "$STATE_TRACK" == "true" ] && echo "$CHECK" || echo "$ERROR")${NC}"
        echo -e "  Event Listening:   $(get_status_color "$EVENT_LIST")$([ "$EVENT_LIST" == "true" ] && echo "$CHECK" || echo "$ERROR")${NC}"
        echo -e "  Metrics Collection:$(get_status_color "$METRICS")$([ "$METRICS" == "true" ] && echo "$CHECK" || echo "$ERROR")${NC}"
    else
        echo -e "Status: ${RED}unavailable${NC}"
    fi

    # System Metrics
    print_section "System Metrics"
    METRICS=$(curl -s "$SERVICE_URL/api/monitoring/metrics" 2>/dev/null)
    if [ $? -eq 0 ]; then
        TVL=$(echo "$METRICS" | jq -r '.data.systemMetrics.totalTVL // 0')
        VOLUME_24H=$(echo "$METRICS" | jq -r '.data.systemMetrics.totalVolume24h // 0')
        TRADES_24H=$(echo "$METRICS" | jq -r '.data.systemMetrics.totalTrades24h // 0')
        TRADERS_24H=$(echo "$METRICS" | jq -r '.data.systemMetrics.totalUniqueTraders24h // 0')

        echo -e "Total TVL:         ${GREEN}$(format_currency "$TVL")${NC}"
        echo -e "24h Volume:        ${GREEN}$(format_currency "$VOLUME_24H")${NC}"
        echo -e "24h Trades:        ${CYAN}$(format_number "$TRADES_24H")${NC}"
        echo -e "24h Unique Traders:${CYAN}$(format_number "$TRADERS_24H")${NC}"
    else
        echo -e "${RED}Metrics unavailable${NC}"
    fi

    # Pools
    print_section "Monitored Pools"
    POOLS=$(curl -s "$SERVICE_URL/api/monitoring/pools" 2>/dev/null)
    if [ $? -eq 0 ]; then
        POOL_COUNT=$(echo "$POOLS" | jq -r '.data.count // 0')
        if [ "$POOL_COUNT" -gt 0 ]; then
            echo "$POOLS" | jq -r '.data.pools[] | "  • \(.name // .modelId) (\(.ammAddress[0:10])...)"' | head -5
            if [ "$POOL_COUNT" -gt 5 ]; then
                echo -e "  ${CYAN}... and $((POOL_COUNT - 5)) more${NC}"
            fi
        else
            echo -e "  ${YELLOW}No pools discovered yet${NC}"
        fi
    fi

    # Recent Alerts
    print_section "Recent Alerts (Last 24h)"
    ALERTS=$(curl -s "$SERVICE_URL/api/monitoring/alerts/recent" 2>/dev/null)
    if [ $? -eq 0 ]; then
        ALERT_COUNT=$(echo "$ALERTS" | jq -r '.data.count // 0')
        if [ "$ALERT_COUNT" -gt 0 ]; then
            echo "$ALERTS" | jq -r '.data.alerts[] | "  \(if .priority == "critical" then "🚨" elif .priority == "high" then "⚠️ " else "📊" end) [\(.priority)] \(.type): \(.message[0:50])..."' | head -5
            if [ "$ALERT_COUNT" -gt 5 ]; then
                echo -e "  ${CYAN}... and $((ALERT_COUNT - 5)) more${NC}"
            fi
        else
            echo -e "  ${GREEN}No alerts in last 24h${NC}"
        fi
    fi

    # Alert Statistics
    print_section "Alert System Stats"
    ALERT_STATS=$(curl -s "$SERVICE_URL/api/monitoring/alerts/stats" 2>/dev/null)
    if [ $? -eq 0 ]; then
        SENT=$(echo "$ALERT_STATS" | jq -r '.data.totalAlertsSent // 0')
        DROPPED=$(echo "$ALERT_STATS" | jq -r '.data.totalAlertsDropped // 0')
        DEDUPED=$(echo "$ALERT_STATS" | jq -r '.data.totalAlertsDeduplicated // 0')

        echo -e "Alerts Sent:       ${GREEN}$(format_number "$SENT")${NC}"
        if [ "$DROPPED" -gt 0 ]; then
            echo -e "Alerts Dropped:    ${YELLOW}$(format_number "$DROPPED")${NC} (rate limited)"
        else
            echo -e "Alerts Dropped:    ${GREEN}$DROPPED${NC}"
        fi
        if [ "$DEDUPED" -gt 0 ]; then
            echo -e "Deduplicated:      ${CYAN}$(format_number "$DEDUPED")${NC}"
        else
            echo -e "Deduplicated:      ${GREEN}$DEDUPED${NC}"
        fi

        # Alert breakdown
        CRITICAL=$(echo "$ALERT_STATS" | jq -r '.data.alertsByPriority.critical // 0')
        HIGH=$(echo "$ALERT_STATS" | jq -r '.data.alertsByPriority.high // 0')
        MEDIUM=$(echo "$ALERT_STATS" | jq -r '.data.alertsByPriority.medium // 0')

        if [ "$SENT" -gt 0 ]; then
            echo -e "\nBreakdown:"
            echo -e "  🚨 Critical: ${RED}$CRITICAL${NC}"
            echo -e "  ⚠️  High:     ${YELLOW}$HIGH${NC}"
            echo -e "  📊 Medium:   ${CYAN}$MEDIUM${NC}"
        fi
    fi

    # Recent Events
    print_section "Recent Events"
    EVENTS=$(curl -s "$SERVICE_URL/api/monitoring/events/recent?limit=5" 2>/dev/null)
    if [ $? -eq 0 ]; then
        EVENT_COUNT=$(echo "$EVENTS" | jq -r '.data.count // 0')
        if [ "$EVENT_COUNT" -gt 0 ]; then
            echo "$EVENTS" | jq -r '.data.events[] | "  \(if .type == "buy" then "🟢" else "🔴" end) \(.type | ascii_upcase): $\(.reserveAmountUSD | tostring) by \(.trader[0:10])..."' 2>/dev/null | head -3
        else
            echo -e "  ${YELLOW}No events yet${NC}"
        fi
    fi

    # Footer
    echo -e "\n${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${MAGENTA}Next update in 30 seconds... (Ctrl+C to exit)${NC}"

    # Commands
    echo -e "\n${BLUE}Quick Commands:${NC}"
    echo -e "  • Logs: ${YELLOW}aws logs tail /ecs/hokusai-contracts --follow${NC}"
    echo -e "  • Full Summary: ${YELLOW}curl $SERVICE_URL/api/monitoring/summary | jq${NC}"

    sleep 30
done
