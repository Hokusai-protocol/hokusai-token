# Mainnet Readiness Checklist

Based on Sepolia testnet deployment and validation (Jan 2026)

---

## ✅ **COMPLETED - Testnet Validation**

### Smart Contract Functionality
- [x] All 9 contracts deploy successfully
- [x] 3 pools created with different CRR configurations (10%, 20%, 30%)
- [x] Price impact scales correctly with CRR (lower CRR = higher volatility) **VALIDATED**
- [x] Buy quotes calculate correctly across all pool sizes
- [x] IBR period mechanism works (24-hour test completed)
- [x] Pool independence verified (trades don't affect other pools)
- [x] State consistency validated (reserve/supply accounting correct)
- [x] Mathematical functions work (power, ln, exp calculations)
- [x] Security audit completed (HOK-653) and all fixes deployed

### Gas Costs
- [x] All operations complete successfully on testnet
- [x] No transactions exceed block gas limit

---

## 🔴 **CRITICAL - Must Complete Before Mainnet**

### 1. Security & Auditing
- [ ] **Third-party security audit** (professional audit firm)
  - [ ] All contracts audited
  - [ ] Audit report reviewed and all issues resolved
  - [ ] Re-audit if any contract changes made
- [ ] **Bug bounty program** set up (Immunefi, Code4rena)
- [ ] **Formal verification** of critical math functions (optional but recommended)

### 2. Governance & Access Control
- [ ] **Multisig wallet** deployed (Gnosis Safe recommended)
  - [ ] Minimum 3-of-5 or 4-of-7 signers
  - [ ] Signers from different entities/geographies
  - [ ] Test multisig operations on testnet first
- [ ] **Timelock controller** for parameter changes
  - [ ] Minimum 24-48 hour delay for critical changes
  - [ ] Emergency pause can bypass timelock
- [ ] **Transfer ownership** from EOA to multisig
  - [ ] Factory ownership
  - [ ] Pool ownership
  - [ ] TokenManager ownership
- [ ] **Role-based access control** documented
  - [ ] Who has what roles
  - [ ] Process for granting/revoking roles

### 3. Testing Not Done on Testnet
- [ ] **Actual buy transactions** with real USDC
  - [ ] Small buy ($100)
  - [ ] Medium buy ($1,000)
  - [ ] Large buy ($10,000+)
  - [ ] Verify tokens received and price impact matches quotes
- [ ] **Actual sell transactions** after IBR expires
  - [ ] Test with real token holders
  - [ ] Verify USDC received and slippage protection works
- [ ] **Fee distribution** end-to-end
  - [ ] Protocol fees route to treasury correctly
  - [ ] UsageFeeRouter distributes fees properly
- [ ] **Emergency pause/unpause** with multisig
  - [ ] Test on testnet with multisig first
  - [ ] Document emergency response procedures
- [ ] **Parameter updates** via governance
  - [ ] CRR changes
  - [ ] Fee changes
  - [ ] IBR duration changes

### 4. Economic Parameters
- [ ] **Initial liquidity sizing**
  - [ ] Determine optimal reserve amounts
  - [ ] Calculate initial token supply
  - [ ] Model expected price ranges
- [ ] **Fee structure finalized**
  - [ ] Trade fees optimized for competitiveness
  - [ ] Protocol fee split determined
  - [ ] Compare to similar AMMs (Uniswap, Balancer)
- [ ] **CRR values validated**
  - [ ] Economic modeling for each CRR tier
  - [ ] Volatility analysis
  - [ ] Risk assessment
- [ ] **IBR duration** decided (7 days for mainnet?)
  - [ ] Testnet used 1 day - too short for mainnet
  - [ ] Consider market conditions and liquidity needs

### 5. Integration Testing
- [ ] **Real USDC integration**
  - [ ] Test with actual Circle USDC contract
  - [ ] Verify approval/transfer patterns
  - [ ] Test edge cases (transfer hooks, etc.)
- [ ] **Oracle integration** (if using external data)
  - [ ] Test oracle failures
  - [ ] Implement fallback mechanisms
- [ ] **Frontend testing** with real contracts
  - [ ] MetaMask integration
  - [ ] WalletConnect support
  - [ ] Transaction signing flows
  - [ ] Error handling

### 6. Monitoring & Operations
- [ ] **Block explorer verification**
  - [ ] All contracts verified on Etherscan
  - [ ] Source code uploaded
  - [ ] Constructor arguments documented
- [ ] **Monitoring infrastructure**
  - [ ] Contract state monitoring (reserves, supply)
  - [ ] Event monitoring (buys, sells, pauses)
  - [ ] Gas price alerts
  - [ ] Anomaly detection
- [ ] **Alerting system**
  - [ ] Large trades (> $100k)
  - [ ] Emergency pause triggered
  - [ ] Unusual price movements
  - [ ] Failed transactions spike
- [ ] **Backup RPC providers**
  - [ ] Multiple providers (Alchemy, Infura, QuickNode)
  - [ ] Automatic failover
  - [ ] Rate limit handling

---

## 🟡 **IMPORTANT - Should Complete Before Mainnet**

### 7. Load & Stress Testing
- [ ] **Concurrent user simulation**
  - [ ] 10+ users trading simultaneously
  - [ ] Test transaction ordering/nonce management
  - [ ] Verify state remains consistent
- [ ] **High gas price scenarios**
  - [ ] Test with 200+ gwei gas
  - [ ] Verify transactions still profitable for users
- [ ] **Network congestion testing**
  - [ ] Simulate full blocks
  - [ ] Test transaction replacement (speed up)
- [ ] **MEV attack simulations**
  - [ ] Front-running attempts
  - [ ] Sandwich attacks
  - [ ] Verify protections work (slippage, deadlines)

### 8. Documentation
- [ ] **User documentation**
  - [ ] How to buy/sell tokens
  - [ ] Fee structure explained
  - [ ] IBR period explained
  - [ ] Risk disclosures
- [ ] **Developer documentation**
  - [ ] Contract interfaces documented
  - [ ] Integration guide
  - [ ] Event schemas
  - [ ] Error codes and handling
- [ ] **Operations runbook**
  - [ ] Deployment procedure
  - [ ] Emergency response procedures
  - [ ] Parameter update process
  - [ ] Incident response plan
- [ ] **Legal documentation**
  - [ ] Terms of service
  - [ ] Privacy policy
  - [ ] Regulatory compliance (if applicable)

### 9. Gas Optimization
- [ ] **Gas benchmarking** on mainnet gas prices
  - [ ] Calculate costs at 50, 100, 200 gwei
  - [ ] Ensure operations economical for users
- [ ] **Optimize gas-heavy operations**
  - [ ] Review buy/sell gas usage
  - [ ] Consider batch operations if applicable
  - [ ] Optimize storage patterns

### 10. Disaster Recovery
- [ ] **Backup and recovery plan**
  - [ ] Contract upgrade strategy (if using proxies)
  - [ ] Emergency withdrawal mechanisms
  - [ ] Lost key recovery (multisig)
- [ ] **Circuit breakers**
  - [ ] Maximum price deviation limits
  - [ ] Volume limits (if applicable)
  - [ ] Automatic pause thresholds

---

## 🟢 **NICE TO HAVE - Post-Launch**

### 11. Advanced Features
- [ ] **Flash loan protection testing**
  - [ ] Simulate flash loan attacks
  - [ ] Verify fees make attacks unprofitable
- [ ] **Cross-chain deployment**
  - [ ] L2 deployments (Arbitrum, Optimism)
  - [ ] Bridge mechanisms
  - [ ] Multi-chain liquidity
- [ ] **Advanced monitoring**
  - [ ] Grafana dashboards
  - [ ] Real-time analytics
  - [ ] Historical data analysis
- [ ] **Governance UI**
  - [ ] Parameter voting interface
  - [ ] Proposal creation/execution
  - [ ] Multisig dashboard

### 12. Community & Marketing
- [ ] **Liquidity incentives** planned
  - [ ] Initial liquidity mining
  - [ ] Rewards structure
- [ ] **Community education**
  - [ ] Explainer videos
  - [ ] AMAs and Q&A sessions
  - [ ] Risk awareness campaigns
- [ ] **Partnerships**
  - [ ] Integration with aggregators (1inch, Matcha)
  - [ ] Listing on analytics sites (DeFi Llama, Dune)

---

## 🚨 **Known Issues from Testnet**

### Issues to Address:
1. **Pool ownership** - Factory owns pools, not deployer
   - ✅ Expected behavior for factory pattern
   - 🔧 Need governance process to manage pool parameters

2. **No buy authorization** - Deployer can't buy tokens on testnet
   - ✅ This is because TokenManager controls minting
   - 🔧 On mainnet, ensure proper authorization setup

3. **Event verification** - Alchemy free tier limits
   - ✅ Works with chunked queries
   - 🔧 Upgrade to paid tier for mainnet or use Etherscan API

4. **Sell testing** - Couldn't fully test on testnet
   - ⚠️ Deployer had no tokens (initial supply went to pools)
   - 🔧 Need actual trading flow testing before mainnet

---

## 📋 **Pre-Deployment Checklist**

When ready to deploy to mainnet:

- [ ] All critical items above completed
- [ ] Deployment script tested on testnet
- [ ] Sufficient ETH in deployer wallet (estimate 2-5 ETH for gas)
- [ ] Real USDC contract address confirmed (mainnet)
- [ ] Initial liquidity amounts decided and available
- [ ] Multisig wallet created and tested
- [ ] Emergency contacts established
- [ ] Post-deployment verification plan ready
- [ ] Announcement/communications prepared
- [ ] Support channels ready (Discord, Telegram, etc.)

---

## 🎯 **Recommended Deployment Sequence**

1. **Deploy to mainnet** (with small initial liquidity)
2. **Verify all contracts** on Etherscan immediately
3. **Transfer ownership** to multisig (within 24 hours)
4. **Test small trades** with team wallets first
5. **Monitor closely** for first 48 hours
6. **Gradually increase** liquidity as confidence grows
7. **Enable governance** once stable
8. **Public announcement** once fully tested

---

## 📊 **Success Metrics for Mainnet Launch**

### Week 1:
- [ ] No critical bugs or security issues
- [ ] All test trades execute correctly
- [ ] Emergency pause works if needed
- [ ] Gas costs acceptable (< 500k gas per trade)

### Month 1:
- [ ] $X in total volume (define target)
- [ ] Y unique users
- [ ] Z successful trades
- [ ] No security incidents
- [ ] All monitoring systems operational

---

**Last Updated:** 2026-01-13
**Testnet Deployment:** ✅ Complete
**Mainnet Ready:** 🔴 Not Yet (see critical items above)
