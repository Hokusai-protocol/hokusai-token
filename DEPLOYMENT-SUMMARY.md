# 🎉 Sepolia Deployment Complete

**Date:** January 20, 2026
**Status:** ✅ FULLY DEPLOYED - Ready for frontend integration

---

## ✅ What's Deployed

### Core Infrastructure (Sepolia Testnet)

All smart contracts are live and operational:

| Contract | Address |
|----------|---------|
| ModelRegistry | `0x7793D34871135713940673230AbE2Bb68799d508` |
| TokenManager | `0xdD57e6C770E5A5644Ec8132FF40B4c68ab65325e` |
| HokusaiAMMFactory | `0x60500936CEb844fCcB75f2246852A65B9508eAd7` |
| MockUSDC | `0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3` |
| UsageFeeRouter | `0x2C5C22229ae63A187aafc89AF392dF53253D17d7` |
| DataContributionRegistry | `0x97c738D0aE723533f3eE97C45ec91A3abBBf491D` |
| DeltaVerifier | `0x564cE700370F9Fb0b6Fe0EdbEdAb7623eC7c131B` |

### Sales Lead Scoring v2 Pool (Model ID: 21) ✅

**The star of the show - ready for hokus.ai integration!**

| Property | Value |
|----------|-------|
| Model ID | `"21"` |
| Token Symbol | `LSCOR` |
| Token Address | `0x645e4cB0741203E77fbb20ECb8299540544Cebf3` |
| AMM Pool Address | `0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E` |
| Initial Reserve | $5,000 USDC |
| Spot Price | $0.025 |
| Total Supply | 1,000,000 LSCOR |
| Market Cap | $25,000 |
| CRR | 20% |
| Trade Fee | 0.30% |
| IBR Ends | 2026-01-22 15:24:24 UTC (~48 hours) |
| Sells Enabled | ⏳ Not yet (after IBR expires) |

**Quick Links:**
- 🔗 [Token on Sepolia Etherscan](https://sepolia.etherscan.io/token/0x645e4cB0741203E77fbb20ECb8299540544Cebf3)
- 🔗 [Pool on Sepolia Etherscan](https://sepolia.etherscan.io/address/0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E)
- 🔗 [Model on hokus.ai](https://hokus.ai/explore-models/21)

---

## 📋 For hokus.ai Team

### Integration Document

**Everything you need is in:** [`docs/SEPOLIA-FRONTEND-INTEGRATION.md`](docs/SEPOLIA-FRONTEND-INTEGRATION.md)

This includes:
- ✅ Real contract addresses (no placeholders!)
- ✅ Complete TypeScript code examples
- ✅ Buy flow implementation
- ✅ USDC faucet instructions
- ✅ Network configuration
- ✅ Testing checklist

### Quick Start

1. **Update your config** with these addresses:
   ```typescript
   const SEPOLIA_CONTRACTS = {
     modelRegistry: "0x7793D34871135713940673230AbE2Bb68799d508",
     usdc: "0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3",
     // ... see full list in integration doc
   };

   const MODEL_21_POOL = {
     modelId: "21",
     tokenAddress: "0x645e4cB0741203E77fbb20ECb8299540544Cebf3",
     ammAddress: "0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E",
     symbol: "LSCOR"
   };
   ```

2. **Get test USDC:**
   ```typescript
   // Call mint() on MockUSDC contract
   const mockUSDC = new Contract(
     "0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3",
     ["function mint(address to, uint256 amount)"],
     signer
   );
   await mockUSDC.mint(userAddress, parseUnits("1000", 6));
   ```

3. **Test a buy:**
   - Navigate to Model ID 21 on hokus.ai
   - Connect wallet to Sepolia
   - Get test USDC
   - Try buying $100 worth of LSCOR tokens

### Testing Checklist

- [ ] Wallet connects to Sepolia network
- [ ] Contract addresses load correctly
- [ ] USDC faucet works (mint test tokens)
- [ ] Pool info displays (price, reserve, market cap)
- [ ] IBR warning shows (sells disabled for ~48 hours)
- [ ] Buy quote calculation accurate
- [ ] USDC approval transaction succeeds
- [ ] Buy transaction executes successfully
- [ ] Token balance updates in UI
- [ ] Transaction appears on Sepolia Etherscan
- [ ] Monitoring system detects transaction (if applicable)

---

## 📊 Pool Economics

**How the AMM works (for testing):**

```
Initial State:
- Reserve: $5,000 USDC
- Supply: 1,000,000 LSCOR
- Price: $0.025/token
- CRR: 20% (means price is volatile!)

Example Buy ($100 USDC):
- Expected tokens: ~3,846 LSCOR
- New price: ~$0.0253 (slight increase)
- Price impact: ~1.2%
- Fee: $0.30 (0.30% of $100)

Example Buy ($1,000 USDC):
- Expected tokens: ~34,783 LSCOR
- New price: ~$0.0287 (14.8% increase!)
- Price impact: ~14.8%
- Fee: $3.00
```

**IBR (Initial Bonding Reserve) Period:**
- Duration: 2 days (testnet accelerated)
- Sells disabled until: 2026-01-22 15:24:24 UTC
- Purpose: Prevents immediate dumps, builds initial liquidity
- What works: Buying tokens ✅
- What doesn't: Selling tokens ⏳ (wait ~48 hours)

---

## 🧪 Testing Scenarios

### Scenario 1: Small Buy
```
Amount: $10 USDC
Expected: ~400 LSCOR
Price impact: ~0.04%
Purpose: Test basic buy flow
```

### Scenario 2: Medium Buy
```
Amount: $100 USDC
Expected: ~3,846 LSCOR
Price impact: ~1.2%
Purpose: Test realistic purchase size
```

### Scenario 3: Large Buy
```
Amount: $1,000 USDC
Expected: ~34,783 LSCOR
Price impact: ~14.8%
Purpose: Test price impact warnings
```

### Scenario 4: Slippage Protection
```
1. Get quote for $100
2. Wait 30 seconds (simulate delay)
3. Another user buys $500
4. Try to execute original quote
5. Should revert if slippage > tolerance
Purpose: Test slippage protection works
```

---

## 🚨 Important Notes

### IBR Period (Active Now)

**Sells are DISABLED** until IBR expires in ~48 hours. Your UI should:
- Show a clear warning/banner
- Display IBR end time countdown
- Disable/hide the "Sell" button
- Explain why selling is disabled

### After IBR Expires (Jan 22, ~3pm UTC)

**Additional testing needed:**
- [ ] Verify "Sell" button becomes enabled
- [ ] Test small sell transaction
- [ ] Verify sell price impact calculations
- [ ] Test buy → sell → buy flow

### Gas Costs (Sepolia)

Typical gas costs for testing:
- USDC approval: ~46,000 gas
- Buy transaction: ~150,000 gas
- Sell transaction: ~120,000 gas

Sepolia ETH is free from faucets!

---

## 📁 Files Updated

All deployment info is saved in:

1. **`deployments/sepolia-latest.json`**
   - Complete deployment record
   - All contract addresses
   - Pool configurations

2. **`docs/SEPOLIA-FRONTEND-INTEGRATION.md`**
   - Frontend integration guide
   - Code examples
   - Testing instructions

3. **`DEPLOYMENT-SUMMARY.md`** (this file)
   - High-level overview
   - Quick reference

---

## 🆘 Support

**Contract Developer:** me@timogilvie.com
**Monitoring:** https://contracts.hokus.ai/health
**Sepolia Explorer:** https://sepolia.etherscan.io

**Common Issues:**

| Issue | Solution |
|-------|----------|
| "Insufficient USDC balance" | Call `mint()` on MockUSDC contract |
| "Wrong network" | Switch MetaMask to Sepolia (Chain ID: 11155111) |
| "Transaction reverted" | Check Etherscan for revert reason, likely slippage or IBR |
| "Cannot sell tokens" | IBR is active, wait until 2026-01-22 15:24:24 UTC |

---

## ✅ Success Criteria

Deployment is successful when:

- [x] All infrastructure contracts deployed
- [x] Sales Lead Scoring v2 pool created
- [x] Initial liquidity deposited ($5K USDC)
- [x] Pool state verified (price, supply, reserve)
- [x] Deployment records updated
- [x] Integration doc updated with real addresses
- [ ] Frontend team can buy tokens through UI
- [ ] Transactions appear on Sepolia Etherscan
- [ ] Monitoring system detects pool activity

---

**🎉 Ready to integrate! Share `docs/SEPOLIA-FRONTEND-INTEGRATION.md` with your frontend team.**
