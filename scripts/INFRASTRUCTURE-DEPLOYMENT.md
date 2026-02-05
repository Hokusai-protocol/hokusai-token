# Infrastructure Cost Accrual System - Deployment Guide

This guide covers deploying the Infrastructure Cost Accrual System to Sepolia testnet and mainnet.

## Overview

The Infrastructure Cost Accrual System introduces a transparent, governance-controlled method for accruing infrastructure costs from API revenue and distributing residual profits to token holders.

###

 Key Changes from V1:

| Component | V1 (Old) | V2 (New - Infrastructure Accrual) |
|-----------|----------|-----------------------------------|
| **UsageFeeRouter** | Fixed 5% protocol fee | Dynamic per-model split (50-100% infrastructure) |
| **HokusaiParams** | `infraMarkupBps` (0-10%) | `infrastructureAccrualBps` (50-100%) |
| **Fee Distribution** | Protocol fee → Treasury<br>Rest → AMM | Infrastructure → Reserve<br>Profit → AMM |
| **New Contracts** | None | `InfrastructureReserve` |
| **Default Split** | 5% protocol, 95% AMM | 80% infrastructure, 20% profit |

## Architecture

```
API Revenue ($100)
       │
       ↓
  UsageFeeRouter
       │
       ├─→ 80% ($80) → InfrastructureReserve (per model accounting)
       │                      │
       │                      └─→ Manual payment to providers (treasury-controlled)
       │
       └─→ 20% ($20) → HokusaiAMM (benefits token holders via price ↑)
```

## Prerequisites

- Funded wallet (deployer) with ETH for gas
- Environment variables configured in `.env`:
  ```env
  DEPLOYER_PRIVATE_KEY=<your_private_key>
  SEPOLIA_RPC_URL=<your_rpc_url>

  # Optional - defaults to deployer if not set
  TREASURY_ADDRESS=<multisig_address_for_payments>
  BACKEND_SERVICE_ADDRESS=<backend_api_address>
  ```

## Deployment Options

### Option 1: Fresh Full Deployment (Recommended for Testnet)

Deploy all contracts from scratch including the new infrastructure system.

```bash
npx hardhat run scripts/deploy-testnet-full-v2.js --network sepolia
```

**What this deploys:**
1. ModelRegistry
2. TokenManager (with updated HokusaiParams)
3. MockUSDC (testnet only)
4. HokusaiAMMFactory
5. **InfrastructureReserve** ✨ NEW
6. **UsageFeeRouter V2** ✨ UPDATED (no protocol fee, dynamic split)
7. HokusaiToken(s)
8. HokusaiAMM pool(s)
9. DataContributionRegistry
10. DeltaVerifier

**Configured Roles:**
- `DEPOSITOR_ROLE` on InfrastructureReserve → UsageFeeRouter
- `PAYER_ROLE` on InfrastructureReserve → Treasury
- `FEE_DEPOSITOR_ROLE` on UsageFeeRouter → Backend Service

**Output:** `deployments/sepolia-v2-YYYY-MM-DD.json`

### Option 2: Add Infrastructure to Existing Deployment

If you already have contracts deployed and want to add the infrastructure system:

```bash
# Set environment variables
export FACTORY_ADDRESS=0x...
export USDC_ADDRESS=0x...
export TREASURY_ADDRESS=0x...
export BACKEND_SERVICE_ADDRESS=0x...

# Deploy infrastructure system
npx hardhat run scripts/deploy-infrastructure-system.js --network sepolia
```

**What this deploys:**
1. InfrastructureReserve
2. UsageFeeRouter V2

**Important Notes:**
- This does **NOT** update existing HokusaiParams contracts
- Existing tokens still use old `infraMarkupBps` parameter
- New tokens deployed via TokenManager will use new `infrastructureAccrualBps`
- Old UsageFeeRouter can coexist but won't use infrastructure system

**Output:** `deployments/sepolia-infrastructure-YYYY-MM-DD.json`

### Option 3: Mainnet Deployment

**CRITICAL: Before mainnet deployment:**

1. **Update Treasury Address:**
   ```env
   TREASURY_ADDRESS=0x<your_mainnet_multisig>
   ```

2. **Update Backend Service:**
   ```env
   BACKEND_SERVICE_ADDRESS=0x<your_mainnet_backend>
   ```

3. **Use Real USDC:**
   - Mainnet USDC: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
   - Update deployment script or set `USDC_ADDRESS` env var

4. **Deploy:**
   ```bash
   npx hardhat run scripts/deploy-infrastructure-system.js --network mainnet
   ```

5. **Verify Contracts on Etherscan:**
   ```bash
   npx hardhat verify --network mainnet <InfrastructureReserve> <USDC> <Factory> <Treasury>
   npx hardhat verify --network mainnet <UsageFeeRouter> <Factory> <USDC> <InfrastructureReserve>
   ```

## Post-Deployment Configuration

### 1. Set Infrastructure Providers

For each model, set the infrastructure provider address:

```javascript
const infraReserve = await ethers.getContractAt(
  "InfrastructureReserve",
  "<infraReserveAddress>"
);

await infraReserve.setProvider(
  "model-id",
  "0x<provider_address>" // AWS, Together AI, etc.
);
```

### 2. Adjust Infrastructure Accrual Rates (Optional)

The default is 80% infrastructure / 20% profit. To adjust per model:

```javascript
const params = await ethers.getContractAt(
  "HokusaiParams",
  "<paramsAddress>" // From deployment.tokens[].paramsAddress
);

// Governance role required
await params.setInfrastructureAccrualBps(7000); // 70/30 split
```

**Recommended splits by model type:**
- Lightweight models (fast inference): 60-70% infrastructure
- Standard models: 70-80% infrastructure
- Compute-heavy models (LLMs): 85-95% infrastructure

### 3. Configure Backend Service

Update your backend API configuration:

```javascript
// config/blockchain.js
module.exports = {
  contracts: {
    usageFeeRouter: "<UsageFeeRouterAddress>",
    infrastructureReserve: "<InfrastructureReserveAddress>",
    // ... other contracts
  }
};
```

### 4. Update Frontend Configuration

If your frontend tracks fee splits:

```javascript
// No more protocol fee
// Read infrastructure split from HokusaiParams per model
const params = await hokusaiParams.infrastructureAccrualBps();
const infrastructurePct = params / 100; // e.g., 8000 = 80%
const profitPct = (10000 - params) / 100; // e.g., 2000 = 20%
```

## Access Control Roles

### InfrastructureReserve

| Role | Granted To | Purpose | Critical? |
|------|------------|---------|-----------|
| `DEPOSITOR_ROLE` | UsageFeeRouter | Deposit API revenue to reserve | Yes |
| `PAYER_ROLE` | Treasury (multisig) | Pay infrastructure providers | Yes |
| `DEFAULT_ADMIN_ROLE` | Deployer | Grant/revoke roles | Yes |

### UsageFeeRouter

| Role | Granted To | Purpose | Critical? |
|------|------------|---------|-----------|
| `FEE_DEPOSITOR_ROLE` | Backend Service | Deposit API fees | Yes |
| `DEFAULT_ADMIN_ROLE` | Deployer | Grant/revoke roles | Yes |

## Testing the Deployment

### 1. Test API Fee Deposit

```javascript
const feeRouter = await ethers.getContractAt("UsageFeeRouter", "<address>");
const mockUSDC = await ethers.getContractAt("MockUSDC", "<address>");

// Mint test USDC
await mockUSDC.mint(deployer.address, ethers.parseUnits("1000", 6));

// Approve router
await mockUSDC.approve(feeRouterAddress, ethers.parseUnits("1000", 6));

// Deposit $100 API fee
await feeRouter.depositFee("model-id", ethers.parseUnits("100", 6));

// Verify split
const infraAccrued = await infraReserve.accrued("model-id");
console.log("Infrastructure:", ethers.formatUnits(infraAccrued, 6)); // Should be ~$80

const poolReserve = await pool.reserveBalance();
console.log("AMM Profit:", ethers.formatUnits(poolReserve, 6)); // Should be ~$20
```

### 2. Test Infrastructure Payment

```javascript
const infraReserve = await ethers.getContractAt("InfrastructureReserve", "<address>");

// Treasury pays provider
const invoiceHash = ethers.keccak256(ethers.toUtf8Bytes("INV-2024-001"));

await infraReserve.connect(treasury).payInfrastructureCost(
  "model-id",
  providerAddress,
  ethers.parseUnits("50", 6), // $50 payment
  invoiceHash,
  "January 2024 compute costs"
);

// Verify balances
const netAccrued = await infraReserve.accrued("model-id");
const totalPaid = await infraReserve.paid("model-id");
console.log("Net accrued:", ethers.formatUnits(netAccrued, 6)); // $80 - $50 = $30
console.log("Total paid:", ethers.formatUnits(totalPaid, 6)); // $50
```

### 3. Test Governance Adjustment

```javascript
const params = await ethers.getContractAt("HokusaiParams", "<paramsAddress>");

// Change to 70/30 split
await params.setInfrastructureAccrualBps(7000);

// Next deposit will use new split
await feeRouter.depositFee("model-id", ethers.parseUnits("100", 6));

// Verify: $70 to infrastructure, $30 to AMM
```

### 4. Monitor Accrual Health

```javascript
// Check runway (days of coverage)
const dailyBurnRate = ethers.parseUnits("50", 6); // $50/day
const runway = await infraReserve.getAccrualRunway("model-id", dailyBurnRate);
console.log("Runway:", runway.toString(), "days");

// Get comprehensive accounting
const [accrued, paid, provider] = await infraReserve.getModelAccounting("model-id");
console.log("Accrued:", ethers.formatUnits(accrued, 6));
console.log("Paid:", ethers.formatUnits(paid, 6));
console.log("Provider:", provider);
```

## Monitoring & Analytics

### Key Metrics to Track

1. **Per-Model Accrual:**
   - `InfrastructureReserve.accrued(modelId)` - Current balance
   - `InfrastructureReserve.paid(modelId)` - Cumulative payments
   - `InfrastructureReserve.getAccrualRunway(modelId, dailyBurnRate)` - Days of coverage

2. **Revenue Split:**
   - `HokusaiParams.infrastructureAccrualBps()` - Current split (per model)
   - `UsageFeeRouter.getModelStats(modelId)` - Total fees, current split

3. **AMM Impact:**
   - `HokusaiAMM.reserveBalance()` - Profit accumulated in AMM
   - `HokusaiAMM.spotPrice()` - Token price (increases as profit flows in)

### Alert Thresholds

Set up monitoring alerts for:
- **Runway < 7 days**: Low accrual balance, increase accrual rate or add funds
- **Runway < 3 days**: Critical, immediate action required
- **Large payment (>50% of accrued)**: Review and verify invoice
- **Split change**: Governance action, log and notify stakeholders

### Dune Analytics

Example queries (adapt to your deployment):

```sql
-- Total infrastructure accrued per model
SELECT
  modelId,
  SUM(infrastructureAmount) as total_infrastructure,
  SUM(profitAmount) as total_profit
FROM InfrastructureReserve_Deposits
GROUP BY modelId;

-- Payment history with invoice tracking
SELECT
  modelId,
  payee,
  amount,
  invoiceHash,
  memo,
  timestamp
FROM InfrastructureReserve_Payments
ORDER BY timestamp DESC;

-- Accrual runway over time
SELECT
  modelId,
  date,
  accrued_balance,
  daily_burn_rate,
  (accrued_balance / daily_burn_rate) as runway_days
FROM accrual_health_snapshot
WHERE date >= NOW() - INTERVAL '30 days';
```

## Troubleshooting

### Issue: "Pool does not exist"

**Cause:** Model pool hasn't been created yet

**Solution:**
```javascript
await factory.createPool(modelId, tokenAddress);
```

### Issue: "Exceeds accrued balance"

**Cause:** Trying to pay more than available in infrastructure reserve

**Solution:** Check balance and adjust payment amount:
```javascript
const accrued = await infraReserve.accrued(modelId);
console.log("Available:", ethers.formatUnits(accrued, 6));
```

### Issue: Access denied errors

**Cause:** Role not granted

**Solution:** Check and grant necessary roles:
```javascript
const hasRole = await infraReserve.hasRole(DEPOSITOR_ROLE, address);
if (!hasRole) {
  await infraReserve.grantRole(DEPOSITOR_ROLE, address);
}
```

### Issue: Old UsageFeeRouter still deployed

**Cause:** Backend pointing to old router

**Solution:** Update backend configuration to use new router address from deployment file

## Migration from V1 to V2

If you have existing deployments with the old UsageFeeRouter:

1. **Deploy new contracts** (Option 2 above)
2. **Update backend** to use new UsageFeeRouter address
3. **No changes needed** for existing tokens/pools (they continue working)
4. **New tokens** deployed after migration will use new infrastructure accrual system
5. **Old router** can be gradually phased out or left for legacy models

**Note:** Existing HokusaiParams contracts with old `infraMarkupBps` will continue working but won't participate in infrastructure accrual system. Consider redeploying tokens for full integration.

## Security Considerations

1. **Treasury Multisig:** Always use a multisig for `PAYER_ROLE` in production
2. **Backend Service:** Secure the backend service private key (has `FEE_DEPOSITOR_ROLE`)
3. **Role Management:** Regularly audit granted roles
4. **Provider Addresses:** Verify provider addresses before setting
5. **Invoice Hashes:** Always include invoice hash for payment auditability
6. **Emergency Pause:** InfrastructureReserve has pause functionality for emergencies

## Support

For issues or questions:
- GitHub Issues: https://github.com/hokusai/hokusai-token/issues
- Documentation: See `features/infrastructure-cost-accrual/PRD.md`
- Test Suite: Run `npx hardhat test test/integration/InfrastructureFlow.test.js`
