# Mainnet Deployment Guide

Step-by-step guide for deploying Hokusai AMM to Ethereum mainnet.

## Overview

The deployment process is split into two phases for safety:
1. **Phase 1:** Deploy core infrastructure contracts
2. **Phase 2:** Create tokens and AMM pools

This separation allows review and monitoring setup between infrastructure deployment and pool creation.

---

## Prerequisites

### 1. Environment Setup

Create `.env` file with mainnet configuration:
```bash
# Network
MAINNET_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/YOUR_API_KEY
BACKUP_RPC_URL=https://mainnet.infura.io/v3/YOUR_INFURA_KEY

# Deployer wallet
DEPLOYER_PRIVATE_KEY=0x...

# Etherscan verification
ETHERSCAN_API_KEY=YOUR_ETHERSCAN_KEY

# Gas configuration
MAX_GAS_PRICE_GWEI=100
GAS_MULTIPLIER=1.2
```

### 2. Wallet Preparation

- **ETH Balance:** Minimum 0.5 ETH (for gas)
- **USDC Balance:** $85,000 USDC (for initial pool reserves)
  - Conservative: $10,000
  - Aggressive: $50,000
  - Balanced: $25,000

### 3. Hardhat Configuration

Verify `hardhat.config.js` includes mainnet network:
```javascript
networks: {
  mainnet: {
    url: process.env.MAINNET_RPC_URL || "",
    accounts: process.env.DEPLOYER_PRIVATE_KEY ? [process.env.DEPLOYER_PRIVATE_KEY] : [],
    chainId: 1
  }
}
```

---

## Deployment Process

### Step 1: Compile Contracts

```bash
npx hardhat compile
```

Verify:
- No compilation errors
- All artifacts generated in `artifacts/contracts/`

### Step 2: Run Tests

```bash
npm test
```

Verify:
- All tests pass
- Gas usage within expected ranges

### Step 3: Test on Sepolia (Dry Run)

```bash
# Deploy to Sepolia first as a dry run
npx hardhat run scripts/deploy-testnet-full.js --network sepolia
```

Verify:
- Deployment completes successfully
- All contracts verified on Sepolia Etherscan
- Test transactions work (buy/sell)

### Step 4: Deploy Infrastructure to Mainnet

```bash
# CRITICAL: Review checklist first!
node scripts/deploy-mainnet.js
```

**What This Does:**
1. Deploys ModelRegistry
2. Deploys TokenManager (+ HokusaiParams)
3. Deploys DataContributionRegistry
4. Deploys HokusaiAMMFactory
5. Deploys UsageFeeRouter
6. Deploys DeltaVerifier
7. Configures access control
8. Saves deployment to `deployments/mainnet-latest.json`

**Safety Features:**
- 10-second confirmation pause
- Network validation (must be mainnet)
- Balance checks (ETH and USDC)
- Gas price warning (if >100 Gwei)
- Configuration verification

**Expected Output:**
```
🎉 MAINNET DEPLOYMENT SUCCESSFUL!
📋 Deployed Contracts:
   ModelRegistry:             0x...
   TokenManager:              0x...
   HokusaiAMMFactory:         0x...
   ...
```

### Step 5: Verify Contracts on Etherscan

```bash
# Verify each contract
npx hardhat verify --network mainnet <ADDRESS> <CONSTRUCTOR_ARGS>

# Example for ModelRegistry (no args)
npx hardhat verify --network mainnet 0x...

# Example for TokenManager
npx hardhat verify --network mainnet 0x... "0x<REGISTRY_ADDRESS>"
```

Or use the verification script (if created):
```bash
node scripts/verify-mainnet-contracts.js
```

### Step 6: Set Up Monitoring (BEFORE Creating Pools!)

```bash
cd services/contract-deployer

# Configure monitoring with mainnet addresses
cp ../../deployments/mainnet-latest.json config/mainnet-contracts.json

# Update .env with monitoring configuration
MONITORING_ENABLED=true
ALERT_EMAIL=me@timogilvie.com
AWS_SES_REGION=us-east-1

# Start monitoring service
npm start
```

Verify:
- Health endpoint accessible
- CloudWatch metrics appearing
- Test alert received via email

### Step 7: Create Pools on Mainnet

```bash
# CRITICAL: Monitoring must be running first!
node scripts/create-mainnet-pools.js
```

**What This Does:**
1. Loads deployment from `mainnet-latest.json`
2. Creates 3 tokens (Conservative, Aggressive, Balanced)
3. Registers models in ModelRegistry
4. Creates 3 AMM pools via Factory
5. Adds initial USDC liquidity to each pool
6. Updates `mainnet-latest.json` with pool addresses

**Safety Features:**
- 15-second confirmation pause
- USDC balance verification
- Network validation
- Per-pool state verification

**Expected Output:**
```
🎉 POOL CREATION SUCCESSFUL!
🪙 Tokens Created:
   Hokusai Conservative (HKS-CON): 0x...
   Hokusai Aggressive (HKS-AGG): 0x...
   Hokusai Balanced (HKS-BAL): 0x...

🏊 Pools Created:
   Conservative Pool: 0x...
   Aggressive Pool: 0x...
   Balanced Pool: 0x...
```

### Step 8: Post-Deployment Testing

```bash
# Test buy transaction on each pool (small amount)
npx hardhat run scripts/test-buy-mainnet.js --network mainnet
```

Verify:
- Buy transactions succeed
- Tokens minted correctly
- Fees collected
- Spot price updates
- Monitoring detects events

### Step 9: Verify Monitoring

Check monitoring dashboard:
- [ ] All 3 pools detected
- [ ] Events appearing in logs
- [ ] State polling working (12-second interval)
- [ ] CloudWatch metrics updating
- [ ] No errors in monitoring logs

---

## Configuration Files

### deployments/mainnet-latest.json

Generated by deployment scripts. Contains:
- All contract addresses
- Pool addresses
- Configuration parameters
- Deployment timestamp

Used by monitoring service to discover contracts.

### docs/mainnet-deployment-checklist.md

Comprehensive checklist for deployment. Print and fill out during deployment.

---

## Emergency Procedures

### If Deployment Fails

1. **Review Error Message**
   - Check gas price (might be too low/high)
   - Verify wallet has sufficient balance
   - Check RPC provider is responding

2. **Resume Deployment**
   - Some scripts support resuming from last successful step
   - Check `deployments/` for partial deployment artifacts
   - May need to deploy remaining contracts manually

3. **Rollback**
   - Cannot "rollback" deployed contracts
   - Can pause pools using owner functions
   - Can deploy new versions if needed

### If Monitoring Fails to Start

1. **Fall Back to Manual Monitoring**
   - Watch pools on Etherscan
   - Set up Etherscan email alerts
   - Use Tenderly for transaction monitoring

2. **Debug Monitoring Service**
   - Check logs: `docker logs <container-id>`
   - Verify RPC connection
   - Test health endpoint: `curl http://localhost:3000/health`

### Emergency Pause

If critical issue detected:
```javascript
// Connect to pool contract
const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);

// Pause trading (only owner can call)
await pool.pause();

// Resume later (only owner)
await pool.unpause();
```

---

## Monitoring Auto-Discovery

The monitoring service automatically discovers new pools via `PoolCreated` events:

1. **Factory Event Listener**
   ```typescript
   factory.on('PoolCreated', (event) => {
     addPoolToMonitoring(event.poolAddress);
     startStateTracking(event.poolAddress);
     startEventListeners(event.poolAddress);
   });
   ```

2. **Initial Pool Discovery**
   - On startup, monitoring queries factory for existing pools
   - Loads pool addresses from `mainnet-latest.json`
   - Begins monitoring all discovered pools

3. **Future Pools**
   - New pools created via factory are automatically discovered
   - No manual configuration needed
   - Monitoring begins within 1 block (~12 seconds)

---

## Gas Optimization Tips

1. **Deploy During Low Gas Periods**
   - Weekends (Saturday/Sunday)
   - Early morning UTC (2-6 AM)
   - Non-US hours

2. **Monitor Gas Prices**
   - https://etherscan.io/gastracker
   - https://www.gasprice.io/
   - Set max gas price limit in script

3. **Batch Operations**
   - Deploy all contracts in one session
   - Create all pools in one transaction (if possible)

---

## Troubleshooting

### "Insufficient Funds" Error
- Check ETH balance for gas
- Check USDC balance for pool reserves
- Verify wallet address is correct

### "Wrong Network" Error
- Verify `--network mainnet` flag
- Check RPC URL in `.env`
- Confirm chainId = 1

### "Contract Verification Failed"
- Etherscan API key might be rate-limited
- Wait 30 seconds and retry
- Verify constructor arguments match deployment

### "Pool Creation Failed"
- Check USDC approval
- Verify token was deployed successfully
- Check model is registered in ModelRegistry

---

## Support

- **Technical Issues:** Create GitHub issue
- **Security Concerns:** Email me@timogilvie.com
- **Emergency:** Use emergency contact list in checklist

---

## Additional Resources

- **Hokusai AMM Docs:** [Contract documentation]
- **Monitoring Requirements:** `deployments/monitoring-requirements.md`
- **Implementation Plan:** `features/mainnet-monitoring/plan.md`
- **Etherscan:** https://etherscan.io/
- **Gas Tracker:** https://etherscan.io/gastracker

---

**Last Updated:** 2026-01-14
**Version:** 1.0.0
