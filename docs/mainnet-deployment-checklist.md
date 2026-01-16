# Mainnet Deployment Checklist

Comprehensive checklist for deploying Hokusai AMM contracts to Ethereum mainnet.

**Date:** ___________
**Deployer:** ___________
**Network:** Ethereum Mainnet (Chain ID: 1)

---

## Pre-Deployment Preparation

### Environment Setup
- [ ] Hardhat configuration updated for mainnet
- [ ] `.env` file configured with mainnet RPC URL
- [ ] Mainnet RPC provider tested (Alchemy/Infura)
- [ ] Deployer private key secured (hardware wallet preferred)
- [ ] Backup RPC provider configured

### Wallet Preparation
- [ ] Deployer wallet address verified: `___________`
- [ ] ETH balance sufficient (minimum 0.5 ETH): `_____` ETH
- [ ] USDC balance sufficient for initial reserves: `$_____` USDC
- [ ] Test transaction sent to verify wallet access
- [ ] Backup wallet configured (for emergency)

### Gas Price Strategy
- [ ] Current gas price checked: `_____` Gwei
- [ ] Gas price acceptable (<100 Gwei preferred)
- [ ] Gas price trends reviewed (use https://etherscan.io/gastracker)
- [ ] Time window selected (lower gas typically: weekends, non-US hours)
- [ ] Max gas price limit configured: `_____` Gwei

### Code Review & Testing
- [ ] Latest contracts compiled: `npx hardhat compile`
- [ ] All tests passing: `npm test`
- [ ] Gas benchmarks reviewed
- [ ] Security audit completed (if applicable)
- [ ] Testnet deployment successful (Sepolia)
- [ ] Testnet functionality verified (buy/sell transactions)

### Contract Verification Preparation
- [ ] Etherscan API key configured in `.env`
- [ ] Verification plugin installed: `@nomiclabs/hardhat-etherscan`
- [ ] Constructor arguments documented
- [ ] Flattened contracts generated (if needed)

### Treasury & Admin Configuration
- [ ] Treasury address decided: `___________`
- [ ] Multi-sig setup (if using): `___________`
- [ ] Admin roles documented
- [ ] Ownership transfer plan documented

---

## Phase 1: Infrastructure Deployment

**Script:** `node scripts/deploy-mainnet.js`

### Pre-Flight Check
- [ ] Network confirmed as mainnet (Chain ID: 1)
- [ ] Deployer balance verified
- [ ] Gas price acceptable
- [ ] 10-second confirmation pause reviewed

### Contracts to Deploy
- [ ] 1. ModelRegistry
  - Address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

- [ ] 2. TokenManager (+ HokusaiParams)
  - TokenManager address: `___________`
  - HokusaiParams address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

- [ ] 3. DataContributionRegistry
  - Address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

- [ ] 4. HokusaiAMMFactory
  - Address: `___________`
  - USDC address verified: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  - Treasury address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

- [ ] 5. UsageFeeRouter
  - Address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

- [ ] 6. DeltaVerifier
  - Address: `___________`
  - Gas used: `___________`
  - Tx hash: `___________`

### Configuration Verification
- [ ] ModelRegistry.tokenManager = TokenManager address
- [ ] TokenManager.deltaVerifier = DeltaVerifier address
- [ ] Factory.modelRegistry = ModelRegistry address
- [ ] Factory.tokenManager = TokenManager address
- [ ] Factory.reserveToken = USDC address (0xA0b...B48)
- [ ] Factory.treasury = Treasury address
- [ ] Factory defaults set (CRR: 20%, Fee: 0.30%, IBR: 7 days)

### Deployment Artifact
- [ ] `deployments/mainnet-latest.json` created
- [ ] All contract addresses recorded
- [ ] Deployment timestamp recorded
- [ ] Deployer address recorded
- [ ] Configuration parameters saved

### Post-Deployment Verification
- [ ] All contracts deployed successfully
- [ ] All verification checks passed
- [ ] Total gas cost calculated: `_____` ETH
- [ ] No errors in deployment output

---

## Phase 2: Contract Verification on Etherscan

**Purpose:** Publish source code for transparency and trust

### Verify Core Contracts
- [ ] ModelRegistry verified
  - Link: https://etherscan.io/address/___________#code

- [ ] TokenManager verified
  - Link: https://etherscan.io/address/___________#code

- [ ] HokusaiParams verified
  - Link: https://etherscan.io/address/___________#code

- [ ] DataContributionRegistry verified
  - Link: https://etherscan.io/address/___________#code

- [ ] HokusaiAMMFactory verified
  - Link: https://etherscan.io/address/___________#code

- [ ] UsageFeeRouter verified
  - Link: https://etherscan.io/address/___________#code

- [ ] DeltaVerifier verified
  - Link: https://etherscan.io/address/___________#code

### Verification Commands
```bash
# Example verification command:
npx hardhat verify --network mainnet <CONTRACT_ADDRESS> <CONSTRUCTOR_ARGS>

# ModelRegistry (no constructor args)
npx hardhat verify --network mainnet 0x...

# TokenManager (takes ModelRegistry address)
npx hardhat verify --network mainnet 0x... "0x<REGISTRY_ADDRESS>"

# Factory (takes multiple args)
npx hardhat verify --network mainnet 0x... "0x<REGISTRY>" "0x<MANAGER>" "0x<USDC>" "0x<TREASURY>"
```

---

## Phase 3: Pool Creation (CRITICAL)

**Script:** `node scripts/create-mainnet-pools.js`

### Pre-Pool Creation Check
- [ ] Infrastructure deployment completed
- [ ] All contracts verified on Etherscan
- [ ] Monitoring service ready (Phase 4 complete)
- [ ] USDC balance sufficient for all pools: $_____ available
- [ ] Pool configurations reviewed and approved

### Pool Configuration Review

**Conservative Pool:**
- [ ] Model ID: `model-conservative-001`
- [ ] Token: Hokusai Conservative (HKS-CON)
- [ ] Initial Reserve: $10,000 USDC
- [ ] CRR: 30%
- [ ] Trade Fee: 0.25%
- [ ] IBR Duration: 7 days

**Aggressive Pool:**
- [ ] Model ID: `model-aggressive-002`
- [ ] Token: Hokusai Aggressive (HKS-AGG)
- [ ] Initial Reserve: $50,000 USDC
- [ ] CRR: 10%
- [ ] Trade Fee: 0.50%
- [ ] IBR Duration: 7 days

**Balanced Pool:**
- [ ] Model ID: `model-balanced-003`
- [ ] Token: Hokusai Balanced (HKS-BAL)
- [ ] Initial Reserve: $25,000 USDC
- [ ] CRR: 20%
- [ ] Trade Fee: 0.30%
- [ ] IBR Duration: 7 days

### Pool Creation Execution
- [ ] 15-second confirmation pause reviewed
- [ ] Total USDC needed: $85,000
- [ ] USDC approved for pools

**Conservative Pool:**
- [ ] Token deployed: `___________`
- [ ] Model registered
- [ ] Pool created: `___________`
- [ ] Initial liquidity added
- [ ] Reserve balance verified: $10,000
- [ ] Spot price checked: $___________

**Aggressive Pool:**
- [ ] Token deployed: `___________`
- [ ] Model registered
- [ ] Pool created: `___________`
- [ ] Initial liquidity added
- [ ] Reserve balance verified: $50,000
- [ ] Spot price checked: $___________

**Balanced Pool:**
- [ ] Token deployed: `___________`
- [ ] Model registered
- [ ] Pool created: `___________`
- [ ] Initial liquidity added
- [ ] Reserve balance verified: $25,000
- [ ] Spot price checked: $___________

### Pool Verification
- [ ] All pools created successfully
- [ ] `mainnet-latest.json` updated with pool addresses
- [ ] IBR end times recorded
- [ ] All pools visible on Etherscan

---

## Phase 4: Monitoring Setup (BEFORE announcing pools!)

**Location:** `services/contract-deployer/src/monitoring/`

### Monitoring Configuration
- [ ] `deployments/mainnet-latest.json` loaded
- [ ] All contract addresses configured
- [ ] Mainnet RPC URL configured
- [ ] Backup RPC URL configured
- [ ] AWS credentials verified
- [ ] Email address verified (me@timogilvie.com)

### AWS SES Setup
- [ ] AWS SES configured in us-east-1
- [ ] Email address verified: me@timogilvie.com
- [ ] Test email sent successfully
- [ ] Email templates reviewed
- [ ] Alert rate limiting configured

### CloudWatch Setup
- [ ] CloudWatch namespace created: `Hokusai/AMM`
- [ ] Custom metrics configured
- [ ] CloudWatch dashboard created
- [ ] Alarms configured for:
  - [ ] Reserve drops >20%
  - [ ] Price changes >20% in 1h
  - [ ] Large trades >$10K
  - [ ] Pause events
- [ ] CloudWatch dashboard link: `___________`

### Monitoring Service Deployment
- [ ] Monitoring code tested on testnet
- [ ] Service deployed to production environment
- [ ] Health endpoint accessible: `___________`
- [ ] Pool discovery working (auto-detects new pools)
- [ ] Event listeners active for all pools
- [ ] State polling working (12-second interval)

### Alert Testing
- [ ] Test critical alert sent and received
- [ ] Test high priority alert sent and received
- [ ] Alert formatting verified
- [ ] Etherscan links in emails working
- [ ] Alert rate limiting tested

---

## Phase 5: Post-Deployment Testing

### Functionality Testing
- [ ] Small buy transaction on Conservative pool (<$100)
  - Tx hash: `___________`
  - Tokens received: `___________`
  - Fee collected: `___________`
  - Spot price after: `___________`

- [ ] Small buy transaction on Aggressive pool (<$100)
  - Tx hash: `___________`
  - Tokens received: `___________`
  - Fee collected: `___________`
  - Spot price after: `___________`

- [ ] Small buy transaction on Balanced pool (<$100)
  - Tx hash: `___________`
  - Tokens received: `___________`
  - Fee collected: `___________`
  - Spot price after: `___________`

### Monitoring Verification
- [ ] Buy events detected by monitoring
- [ ] Pool state updates logged
- [ ] Metrics visible in CloudWatch
- [ ] Health endpoint showing all pools
- [ ] No errors in monitoring logs

### IBR Verification
- [ ] Sell transactions disabled (should revert during IBR)
- [ ] IBR end times calculated correctly
- [ ] Countdown alerts configured (24h before IBR end)

---

## Phase 6: Documentation & Communication

### Technical Documentation
- [ ] All contract addresses documented in team wiki/docs
- [ ] API documentation updated (if applicable)
- [ ] Monitoring dashboard URLs shared with team
- [ ] Emergency procedures documented
- [ ] Owner function documentation updated

### Team Communication
- [ ] Deployment announcement sent to team
- [ ] Contract addresses shared
- [ ] Monitoring dashboard access granted
- [ ] On-call rotation established
- [ ] Incident response procedures reviewed

### External Communication (if applicable)
- [ ] Announcement drafted
- [ ] Community channels updated
- [ ] Website/docs updated with contract addresses
- [ ] Social media announcement prepared (but not posted yet)

---

## Phase 7: Security & Access Control

### Access Control Review
- [ ] All owner addresses documented
- [ ] Multi-sig configuration verified (if using)
- [ ] Role assignments documented:
  - [ ] DEFAULT_ADMIN_ROLE holders
  - [ ] MINTER_ROLE holders
  - [ ] FEE_DEPOSITOR_ROLE holders
  - [ ] RECORDER_ROLE holders
  - [ ] VERIFIER_ROLE holders

### Security Hardening
- [ ] Deployer private key secured (removed from server)
- [ ] Hardware wallet configured for future operations
- [ ] Emergency pause procedures documented
- [ ] Emergency contacts established
- [ ] Incident response plan reviewed

---

## Phase 8: Monitoring Period (First 7 Days)

### Daily Checks (IBR Period)
- [ ] Day 1: Check pool state, verify monitoring, test transactions
- [ ] Day 2: Review metrics, check for anomalies
- [ ] Day 3: Mid-week check, gas usage review
- [ ] Day 4: Check CloudWatch alarms, verify email alerts
- [ ] Day 5: Review trading volume, price movements
- [ ] Day 6: IBR ending soon - prepare for sell enablement
- [ ] Day 7: IBR ends - verify sells enabled, test sell transaction

### Metrics to Monitor
- [ ] Total trading volume per pool
- [ ] Number of unique traders
- [ ] Average trade size
- [ ] Reserve balances trending correctly
- [ ] Fee collection amounts match expectations
- [ ] No unusual patterns (MEV, sandwiching, etc.)
- [ ] Gas usage within expected ranges

### Issue Tracking
- [ ] No critical alerts triggered
- [ ] No false positive alerts
- [ ] Alert rate limiting working correctly
- [ ] Monitoring uptime >99%
- [ ] No missed events

---

## Post-IBR Actions (After 7 Days)

- [ ] Verify sells are enabled on all pools
- [ ] Test sell transaction on each pool
- [ ] Review IBR period metrics
- [ ] Adjust alert thresholds if needed
- [ ] Publish retrospective (internal)
- [ ] Announce pools publicly (if not done earlier)
- [ ] Monitor for increased trading activity

---

## Emergency Procedures

### If Monitoring Detects Issue
1. **Critical Alert (Pause, Ownership Transfer, Zero Reserve)**
   - [ ] Respond within 5 minutes
   - [ ] Verify issue via Etherscan
   - [ ] Determine if emergency pause needed
   - [ ] Notify team immediately
   - [ ] Document incident

2. **High Priority Alert (Large Trade, Price Spike, Reserve Drop)**
   - [ ] Respond within 4 hours
   - [ ] Investigate transaction(s)
   - [ ] Verify pool state
   - [ ] Assess if action needed
   - [ ] Document findings

3. **Monitor Down**
   - [ ] Check service health endpoint
   - [ ] Review server logs
   - [ ] Restart service if needed
   - [ ] Fall back to manual Etherscan monitoring
   - [ ] Fix root cause

### Emergency Pause Procedure
```solidity
// Only if absolutely necessary (exploit, critical bug)
// Call pause() on affected pool(s)

HokusaiAMM pool = HokusaiAMM(poolAddress);
pool.pause();  // Only owner can call
```

### Contact Information
- **Primary Contact:** me@timogilvie.com
- **Backup Contact:** ___________
- **Emergency Hotline:** ___________

---

## Sign-Off

**Infrastructure Deployment Complete:**
- Name: ___________
- Signature: ___________
- Date: ___________

**Pool Creation Complete:**
- Name: ___________
- Signature: ___________
- Date: ___________

**Monitoring Operational:**
- Name: ___________
- Signature: ___________
- Date: ___________

**Ready for Production:**
- Name: ___________
- Signature: ___________
- Date: ___________

---

**Notes:**
(Use this space for any deployment-specific notes, issues encountered, or deviations from the checklist)

___________________________________________________________________________
___________________________________________________________________________
___________________________________________________________________________
___________________________________________________________________________
