# Infrastructure Cost Accrual System

**Version:** 2.0.0
**Status:** Production Ready
**Feature Branch:** `fix/permanent-bonding-curve-graduation`

## Overview

The Infrastructure Cost Accrual System introduces transparent, governance-controlled infrastructure cost management for Hokusai's AI model tokenization platform. It replaces the fixed protocol fee model with a dynamic infrastructure/profit split that ensures:

- **Infrastructure providers get paid first** from API revenue
- **Token holders receive genuine profit** (residual after costs)
- **Per-model governance control** over cost allocation
- **Transparent on-chain accounting** for all costs and payments

### Key Principle

> Infrastructure is an **obligation** (must be paid first), profit is **residual** (what remains).

## Architecture

```
API Revenue ($100)
       │
       ↓
  UsageFeeRouter V2
       │
       ├─→ 80% ($80) → InfrastructureReserve
       │                    ├─ Accrues per-model
       │                    ├─ Manual payments to providers
       │                    └─ Invoice tracking
       │
       └─→ 20% ($20) → HokusaiAMM
                           └─ Increases token price
                              (benefits holders)
```

## What's New

### New Contracts

1. **InfrastructureReserve** ([contracts/InfrastructureReserve.sol](contracts/InfrastructureReserve.sol))
   - Tracks infrastructure accrual per model
   - Manages payments to infrastructure providers
   - Provides runway calculations
   - Emergency controls and pause functionality

2. **UsageFeeRouter V2** ([contracts/UsageFeeRouter.sol](contracts/UsageFeeRouter.sol))
   - **Breaking Change:** No more fixed protocol fee
   - Dynamic infrastructure split (50-100% per model)
   - Reads split from HokusaiParams
   - Routes funds to InfrastructureReserve + AMM

### Updated Contracts

3. **HokusaiParams** ([contracts/HokusaiParams.sol](contracts/HokusaiParams.sol))
   - **Breaking Change:** `infraMarkupBps` removed
   - New: `infrastructureAccrualBps` (5000-10000 bps = 50-100%)
   - New: `getProfitShareBps()` - calculated residual
   - Governance-controlled per model

4. **TokenManager** ([contracts/TokenManager.sol](contracts/TokenManager.sol))
   - Updated to use `infrastructureAccrualBps` (default: 8000 = 80%)
   - Automatically creates HokusaiParams with new semantics

## Quick Start

### 1. Deploy Infrastructure System

```bash
# For fresh testnet deployment (recommended)
npx hardhat run scripts/deploy-testnet-full-v2.js --network sepolia

# To add to existing deployment
export FACTORY_ADDRESS=0x...
export USDC_ADDRESS=0x...
export TREASURY_ADDRESS=0x...
npx hardhat run scripts/deploy-infrastructure-system.js --network sepolia
```

### 2. Test API Fee Deposit

```javascript
const feeRouter = await ethers.getContractAt("UsageFeeRouter", routerAddress);

// Deposit $100 API fee
await usdc.approve(routerAddress, ethers.parseUnits("100", 6));
await feeRouter.depositFee("model-id", ethers.parseUnits("100", 6));

// Verify split (80/20 default)
const infraAccrued = await infraReserve.accrued("model-id");
// infraAccrued = $80

const poolReserve = await pool.reserveBalance();
// poolReserve increased by $20
```

### 3. Pay Infrastructure Costs

```javascript
const infraReserve = await ethers.getContractAt("InfrastructureReserve", reserveAddress);

// Treasury pays provider
const invoiceHash = ethers.keccak256(ethers.toUtf8Bytes("INV-2024-001"));
await infraReserve.connect(treasury).payInfrastructureCost(
  "model-id",
  providerAddress,
  ethers.parseUnits("50", 6),
  invoiceHash,
  "December 2024 infrastructure costs"
);
```

### 4. Monitor Accrual Health

```javascript
// Check runway
const dailyBurnRate = ethers.parseUnits("100", 6); // $100/day
const runway = await infraReserve.getAccrualRunway("model-id", dailyBurnRate);
console.log(`Runway: ${runway} days`);

// Get full accounting
const [accrued, paid, provider] = await infraReserve.getModelAccounting("model-id");
console.log(`Accrued: $${ethers.formatUnits(accrued, 6)}`);
console.log(`Paid: $${ethers.formatUnits(paid, 6)}`);
```

## Testing

### Unit Tests

```bash
# All tests (177 tests)
npm test

# Specific test suites
npx hardhat test test/HokusaiParams.test.js          # 38 tests
npx hardhat test test/InfrastructureReserve.test.js  # 65 tests
npx hardhat test test/UsageFeeRouter.test.js         # 51 tests
npx hardhat test test/integration/InfrastructureFlow.test.js  # 23 tests
```

**Test Coverage:** 100% passing (177/177 tests)

### Integration Tests

The integration test suite ([test/integration/InfrastructureFlow.test.js](test/integration/InfrastructureFlow.test.js)) covers:

- End-to-end revenue flow (80/20 split)
- Infrastructure payment lifecycle
- Governance split adjustments (80/20 → 70/30)
- Multiple models with different splits
- Accrual runway monitoring
- AMM price impact from profit
- **Realistic 3-month scenario** ($150k revenue, $118k paid, $2k buffer)

## Deployment

### Testnet (Sepolia)

```bash
# Set environment variables
export TREASURY_ADDRESS=0x...              # Multisig for payments
export BACKEND_SERVICE_ADDRESS=0x...       # API service for deposits

# Deploy full system
npx hardhat run scripts/deploy-testnet-full-v2.js --network sepolia

# Verify contracts
npx hardhat verify --network sepolia <InfrastructureReserve> <USDC> <Factory> <Treasury>
npx hardhat verify --network sepolia <UsageFeeRouter> <Factory> <USDC> <InfraReserve>
```

### Mainnet

**See:** [scripts/INFRASTRUCTURE-DEPLOYMENT.md](scripts/INFRASTRUCTURE-DEPLOYMENT.md) for detailed mainnet deployment guide.

**Critical Pre-Deployment Checklist:**
- [ ] Treasury address is a **multisig** (not EOA)
- [ ] Backend service private key is **secured**
- [ ] Use real USDC address: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- [ ] Set initial provider addresses for all models
- [ ] Configure monitoring and alerts
- [ ] Test on Sepolia first

## Monitoring

### Real-Time Monitoring

The system includes comprehensive monitoring via the Infrastructure Monitor:

```bash
# Start monitoring server
cd services/contract-deployer
npm run monitoring

# Available endpoints
GET /infrastructure/metrics          # All models summary
GET /infrastructure/:modelId         # Single model details
GET /infrastructure/:modelId/history # Historical data
GET /infrastructure/status           # Monitor health
```

**See:** [services/contract-deployer/src/monitoring/INFRASTRUCTURE-MONITORING.md](services/contract-deployer/src/monitoring/INFRASTRUCTURE-MONITORING.md)

### Alert Thresholds

| Alert Type | Threshold | Priority | Response Time |
|------------|-----------|----------|---------------|
| Critical Runway | <3 days | 🚨 Critical | <5 minutes |
| Low Runway | <7 days | ⚠️ High | Same day |
| Large Payment | >50% of accrued | ⚠️ High | Same day |
| Split Change | Governance update | 📊 Medium | Next day |
| No Provider | Provider = 0x0 | 📊 Medium | Next day |

### Metrics Dashboard

Key metrics tracked:
- Infrastructure accrued/paid per model
- Runway days (accrued / daily burn rate)
- Infrastructure/profit split ratios
- Payment history with invoice tracking
- Provider addresses

## Governance

### Adjusting Infrastructure Split

Each model has independent governance control over its infrastructure accrual rate:

```javascript
const params = await ethers.getContractAt("HokusaiParams", paramsAddress);

// Requires GOV_ROLE
await params.setInfrastructureAccrualBps(7000); // 70/30 split

// Event emitted
// InfrastructureAccrualBpsSet(oldBps: 8000, newBps: 7000, updatedBy: governor)
```

**Recommended Splits by Model Type:**
- Lightweight models (fast inference): 60-70%
- Standard models: 70-80%
- Compute-heavy models (LLMs): 85-95%
- Critical/experimental: 100% (zero profit until stable)

### Setting Providers

```javascript
// Set infrastructure provider for a model
await infraReserve.setProvider("model-id", providerAddress);

// Typically: AWS account, Together AI, Anthropic, etc.
```

## Migration from V1

If you have existing deployments with the old UsageFeeRouter (fixed protocol fee):

1. **Deploy new infrastructure system** (Option 2 in deployment guide)
2. **Update backend** to use new UsageFeeRouter address
3. **New tokens** deployed after migration will use new system
4. **Old tokens** continue working but don't participate in infrastructure accrual
5. **Optional:** Redeploy old tokens for full integration

**No Breaking Changes for:**
- HokusaiAMM pools (fully compatible)
- HokusaiToken contracts (no changes)
- Model Registry (no changes)

**Breaking Changes:**
- UsageFeeRouter constructor (new parameters)
- HokusaiParams interface (new functions)
- TokenManager defaults (new infrastructure accrual parameter)

## Gas Costs

| Operation | Gas Used | Cost @ 20 Gwei |
|-----------|----------|----------------|
| Deploy InfrastructureReserve | ~2.16M | $0.04 |
| Deploy UsageFeeRouter | ~2.02M | $0.04 |
| Single fee deposit | ~183-303k | $0.004-0.006 |
| Batch deposit (2 models) | ~435k | $0.009 |
| Infrastructure payment | ~67-118k | $0.001-0.002 |

## Security

### Access Control

**InfrastructureReserve:**
- `DEPOSITOR_ROLE`: UsageFeeRouter (deposits infrastructure accrual)
- `PAYER_ROLE`: Treasury multisig (pays infrastructure providers)
- `DEFAULT_ADMIN_ROLE`: Deployer (role management)

**UsageFeeRouter:**
- `FEE_DEPOSITOR_ROLE`: Backend API service (deposits API fees)
- `DEFAULT_ADMIN_ROLE`: Deployer (role management)

**HokusaiParams:**
- `GOV_ROLE`: Governance (adjusts infrastructure accrual rate)
- `DEFAULT_ADMIN_ROLE`: Deployer (role management)

### Emergency Controls

**InfrastructureReserve:**
- `pause()` / `unpause()` - Halt deposits/payments during emergencies
- `emergencyWithdraw()` - Withdraw funds to treasury (admin only)

### Audit Status

- ✅ Comprehensive test suite (177 tests, 100% passing)
- ✅ CEI pattern followed (no reentrancy vulnerabilities)
- ✅ Access control enforced on all critical functions
- ✅ Input validation on all external functions
- ⏳ Third-party audit: Scheduled (Q1 2026)

## Documentation

### Core Documents

- **[PRD](features/infrastructure-cost-accrual/PRD.md)** - Product requirements and architecture
- **[TASKS](features/infrastructure-cost-accrual/TASKS.md)** - Implementation task breakdown
- **[Deployment Guide](scripts/INFRASTRUCTURE-DEPLOYMENT.md)** - Comprehensive deployment instructions
- **[Monitoring Guide](services/contract-deployer/src/monitoring/INFRASTRUCTURE-MONITORING.md)** - Monitoring setup and alerts

### Contract Documentation

- [InfrastructureReserve](contracts/InfrastructureReserve.sol) - Infrastructure accrual management
- [UsageFeeRouter](contracts/UsageFeeRouter.sol) - API fee routing with dynamic splits
- [HokusaiParams](contracts/HokusaiParams.sol) - Per-model governance parameters
- [IInfrastructureReserve](contracts/interfaces/IInfrastructureReserve.sol) - Interface definition
- [IHokusaiParams](contracts/interfaces/IHokusaiParams.sol) - Interface definition

### Examples

See `features/infrastructure-cost-accrual/` directory for:
- Flow diagrams
- Example calculations
- Governance scenarios
- Payment workflows

## FAQ

### Q: What happens to existing tokens/pools?

**A:** They continue working normally. Existing HokusaiParams contracts with old `infraMarkupBps` parameter remain functional. New tokens deployed after the upgrade will use the new infrastructure accrual system.

### Q: Can I adjust the 80/20 split?

**A:** Yes! Each model has independent governance control via `HokusaiParams.setInfrastructureAccrualBps()`. Valid range: 50-100% infrastructure (i.e., 50/50 to 100/0 splits).

### Q: What happens if infrastructure costs exceed accrued balance?

**A:** Payments are capped at the accrued balance. The transaction will revert if you attempt to pay more than available. Monitor runway closely to prevent this.

### Q: How is runway calculated?

**A:** `runway_days = accrued_balance / daily_burn_rate`. Set daily burn rate estimates per model for accurate runway calculations.

### Q: Who can pay infrastructure providers?

**A:** Only addresses with `PAYER_ROLE` (typically treasury multisig). All payments require invoice hash for audit trail.

### Q: Can I change the provider address?

**A:** Yes, addresses with `DEFAULT_ADMIN_ROLE` can call `infraReserve.setProvider(modelId, newProvider)`.

### Q: What if I need emergency access to funds?

**A:** Treasury can call `emergencyWithdraw()` to recover funds during emergencies. This requires `DEFAULT_ADMIN_ROLE` and should only be used in critical situations.

## Support

- **GitHub Issues:** https://github.com/hokusai/hokusai-token/issues
- **Documentation:** See `features/infrastructure-cost-accrual/` directory
- **Tests:** Run `npm test` for comprehensive test suite
- **Security:** Email security@hokusai.ai for security concerns

## License

MIT License - See [LICENSE](LICENSE) file

---

**Built with ❤️ by the Hokusai Team**

**Last Updated:** 2026-02-05
**Version:** 2.0.0 (Infrastructure Cost Accrual)
