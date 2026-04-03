# Infrastructure Cost Reconciliation Service

## Overview

The Cost Reconciliation Service is an off-chain monitoring component that tracks actual infrastructure costs, compares them to on-chain estimates, and generates cost adjustment recommendations for governance approval.

## Architecture

### Components

1. **CostReconciliationService** (`monitoring/cost-reconciliation-service.ts`)
   - Core service managing cost tracking and variance analysis
   - Runs scheduled reconciliation checks (daily by default)
   - Generates adjustment recommendations when variance exceeds thresholds
   - Integrates with existing alert system

2. **Reconciliation API** (`routes/reconciliation.ts`)
   - RESTful API for cost ingestion and dashboard data
   - Endpoints for variance history, recommendations, and runway metrics
   - Manual cost submission via POST requests

3. **CSV Ingestion Script** (`scripts/ingest-costs-csv.ts`)
   - Command-line tool for batch cost ingestion
   - Reads CSV files with provider billing data
   - Supports dry-run mode for validation

### Integration Points

The service integrates with:

- **InfrastructureReserve**: Reads current accrued balances and payment history
- **InfrastructureCostOracle** (future): Will read cost estimates and submit adjustments
- **AlertManager**: Sends variance and runway alerts via email/Slack/PagerDuty

## Configuration

### Environment Variables

```bash
# Required
INFRASTRUCTURE_RESERVE_ADDRESS=0x...     # InfrastructureReserve contract address

# Optional
INFRASTRUCTURE_COST_ORACLE_ADDRESS=0x... # Cost oracle (from Issue #1)
COST_VARIANCE_WARNING_PCT=10             # Alert threshold (default: 10%)
COST_VARIANCE_CRITICAL_PCT=20            # Critical threshold (default: 20%)
RUNWAY_WARNING_DAYS=7                    # Runway warning (default: 7 days)
RUNWAY_CRITICAL_DAYS=3                   # Runway critical (default: 3 days)
RECONCILIATION_INTERVAL_MS=86400000      # Check interval (default: daily)
```

### Alert Thresholds

| Threshold | Level | Action |
|-----------|-------|--------|
| Variance > 10% | Warning | Slack notification |
| Variance > 20% | Critical | PagerDuty alert |
| Runway < 7 days | Warning | Slack notification |
| Runway < 3 days | Critical | PagerDuty alert |

## Usage

### Starting the Service

The service starts automatically with the monitoring server if `INFRASTRUCTURE_RESERVE_ADDRESS` is configured:

```bash
npm run dev:monitoring
```

### Ingesting Costs

#### Via CSV

```bash
# Preview records
npx tsx src/scripts/ingest-costs-csv.ts example-costs.csv --dry-run

# Ingest costs
npx tsx src/scripts/ingest-costs-csv.ts costs-march-2026.csv
```

CSV format:
```csv
modelId,provider,amount,periodStart,periodEnd,invoiceId
gpt-4,AWS,1234.56,2026-03-01,2026-03-31,INV-2026-03
```

#### Via API

```bash
curl -X POST http://localhost:8002/api/reconciliation/gpt-4/costs \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "AWS",
    "amount": 1234.56,
    "period": {
      "start": "2026-03-01T00:00:00Z",
      "end": "2026-03-31T23:59:59Z"
    },
    "invoiceId": "INV-2026-03"
  }'
```

## API Endpoints

### Service Status

```
GET /api/reconciliation/status
```

Returns service configuration and tracked models.

### Model Variance

```
GET /api/reconciliation/:modelId/variance?limit=10
```

Returns current variance and history for a model.

Response:
```json
{
  "success": true,
  "data": {
    "modelId": "gpt-4",
    "current": {
      "actual": 1234.56,
      "estimated": 1150.00,
      "variance": 84.56,
      "variancePercent": 7.35
    },
    "history": [...]
  }
}
```

### Cost Adjustment Recommendations

```
GET /api/reconciliation/:modelId/recommendations?limit=5
```

Returns recommended cost adjustments when variance exceeds thresholds.

Response:
```json
{
  "success": true,
  "data": {
    "modelId": "gpt-4",
    "latest": {
      "currentEstimate": 8.00,
      "recommendedEstimate": 8.50,
      "adjustmentPercent": 6.25,
      "rationale": "Actual costs 6.2% above estimate..."
    },
    "recommendations": [...]
  }
}
```

### Cost History

```
GET /api/reconciliation/:modelId/costs?limit=12
```

Returns ingested cost records for a model.

### Summary (All Models)

```
GET /api/reconciliation/summary
```

Returns variance, recommendations, and latest costs for all tracked models.

## Workflow

### Monthly Reconciliation Cycle

1. **Cost Ingestion** (Day 1-3 of month)
   - Infrastructure provider sends invoices
   - Finance team exports CSV with actual costs
   - Run CSV ingestion script
   - Costs stored in service memory and optionally recorded on-chain

2. **Variance Analysis** (Day 3-5 of month)
   - Service calculates variance between actual and estimated costs
   - If variance > 5%, generates adjustment recommendation
   - Alerts sent if variance exceeds warning thresholds (10%, 20%)

3. **Governance Proposal** (Day 5-15 of month)
   - Review recommendations in dashboard
   - Submit governance proposal for cost adjustments
   - Example: "Adjust Model X cost from $8.00 → $8.50/1000 calls (actual costs 6.2% above estimate)"

4. **Dashboard Monitoring** (Ongoing)
   - Real-time runway calculations
   - Cost trend visualization
   - Pending proposal tracking

### Daily Checks

The service runs daily reconciliation to:
- Update runway calculations
- Detect cost spikes
- Alert on critical runway (<3 days)

## Dashboard Data

The service exposes data for dashboards via API:

- **Per-model cost variance history**: Track accuracy of estimates over time
- **Current vs estimated costs**: Real-time comparison
- **Runway calculations**: Days until reserve depletion at current burn rate
- **Pending adjustment proposals**: Queue of recommended changes

## Dependencies

### Contract Methods (Future Implementation)

The service includes placeholder integration for future contract methods:

#### InfrastructureReserve (Issue #4)
```solidity
function recordActualCosts(
  string modelId,
  uint256 amount,
  bytes32 invoiceHash,
  string memo
) external;
```

#### InfrastructureCostOracle (Issue #1)
```solidity
function getCurrentEstimate(string modelId)
  view returns (uint256 costPerThousandCalls);

function getVariance(string modelId)
  view returns (int256 variance, uint256 actualCost, uint256 estimatedCost);

function suggestCostAdjustment(string modelId)
  view returns (uint256 newEstimate, int256 variance);
```

### Current Implementation

The service is fully functional for:
- ✅ Cost ingestion (off-chain storage)
- ✅ Variance calculation (placeholder estimates)
- ✅ Runway monitoring (using InfrastructureReserve.accrued)
- ✅ Alert generation
- ✅ API endpoints

Pending contract deployment:
- ⏳ On-chain cost recording
- ⏳ Oracle-based variance calculation
- ⏳ Automated estimate adjustments

## Testing

```bash
# Unit tests
npm test -- cost-reconciliation

# Integration tests
npm run test:integration

# Manual testing with example data
npx tsx src/scripts/ingest-costs-csv.ts example-costs.csv
curl http://localhost:8002/api/reconciliation/summary | jq
```

## Monitoring

### Logs

The service logs:
- Cost ingestion events
- Variance calculations
- Alert triggers
- Reconciliation cycles

### Metrics

Track via `/api/reconciliation/status`:
- Models tracked
- Last reconciliation time
- Alert counts
- Service health

## Troubleshooting

### No variance data

**Problem**: `/api/reconciliation/:modelId/variance` returns 404

**Solution**: Ingest costs first via CSV or API

### Service not starting

**Problem**: Reconciliation service disabled in logs

**Solution**: Set `INFRASTRUCTURE_RESERVE_ADDRESS` environment variable

### Alerts not firing

**Problem**: No alerts despite high variance

**Solution**: Check `COST_VARIANCE_WARNING_PCT` threshold and AlertManager configuration

## Future Enhancements

1. **Automated cost fetching**: Direct integration with AWS/GCP billing APIs
2. **On-chain governance integration**: Automatic proposal submission
3. **Machine learning**: Predictive cost modeling and anomaly detection
4. **Multi-currency support**: Handle provider billing in different currencies
5. **Cost attribution**: Break down costs by usage type (compute, storage, bandwidth)

## References

- Issue #1: InfrastructureCostOracle implementation
- Issue #4: InfrastructureReserve reconciliation methods
- `monitoring/infrastructure-monitor.ts`: Existing reserve monitoring
- `contracts/InfrastructureReserve.sol`: Reserve contract
