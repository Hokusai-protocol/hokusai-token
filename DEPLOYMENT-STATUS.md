# Sepolia Deployment Status

**Date:** January 20, 2026
**Status:** Infrastructure deployed ✅ | Model pool pending ⏳

## Current Status

### Infrastructure (DEPLOYED ✅)

All core contracts are deployed on Sepolia and operational:

- **ModelRegistry:** `0x7793D34871135713940673230AbE2Bb68799d508`
- **TokenManager:** `0xdD57e6C770E5A5644Ec8132FF40B4c68ab65325e`
- **HokusaiAMMFactory:** `0x60500936CEb844fCcB75f2246852A65B9508eAd7`
- **MockUSDC:** `0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3`
- **UsageFeeRouter:** `0x2C5C22229ae63A187aafc89AF392dF53253D17d7`
- **DataContributionRegistry:** `0x97c738D0aE723533f3eE97C45ec91A3abBBf491D`
- **DeltaVerifier:** `0x564cE700370F9Fb0b6Fe0EdbEdAb7623eC7c131B`

### Test Pools (DEPLOYED ✅)

Three test pools are available for frontend integration testing:

1. **HKS-CON** (Conservative)
   - Token: `0xE3423d52c42b61bc1Dd6abfbDa9bEBa827a4c806`
   - AMM: `0x58565F787C49F09C7Bf33990e7C5B7208580901a`
   - Model ID: `model-conservative-001`

2. **HKS-AGG** (Aggressive)
   - Token: `0xc6d747bC7884e50104C6A919C86f02001a76E281`
   - AMM: `0xEf815E7F11eD0B88cE33Dd30FC9568f7F66abC5a`
   - Model ID: `model-aggressive-002`

3. **HKS-BAL** (Balanced)
   - Token: `0xeA2Ec4A52fDE565CC5a1B92A213C3CC156a6F63e`
   - AMM: `0x76A59583430243D595E8985cA089a00Cc18B73af`
   - Model ID: `model-balanced-003`

### Sales Lead Scoring v2 Pool (PENDING ⏳)

**Model ID:** 21
**Status:** Deployment blocked by Alchemy RPC rate limiting

**Script Ready:** `scripts/deploy-sepolia-sales-lead-scoring.js`

**Planned Configuration:**
- Symbol: LSCOR
- Initial Reserve: $5,000 USDC
- CRR: 20%
- Trade Fee: 0.30%
- IBR: 2 days

## Next Steps

### Immediate (Today)

1. **Wait for RPC rate limit to clear** (typically 1-2 hours)
2. **Run deployment script:**
   ```bash
   npx hardhat run scripts/deploy-sepolia-sales-lead-scoring.js --network sepolia
   ```
3. **Update frontend integration doc** with deployed addresses
4. **Share updated doc** with hokus.ai team

### Frontend Integration (Can Start Now)

The hokus.ai team can begin integration work immediately using the existing test pools:

- **Integration Guide:** `docs/SEPOLIA-FRONTEND-INTEGRATION.md`
- **Test with:** Model ID `model-balanced-003` (similar params to planned Model 21 pool)
- **Mock USDC:** Available via `mint()` function at `0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3`

### Testing Checklist

- [ ] Frontend connects to Sepolia network
- [ ] Contract addresses loaded correctly
- [ ] USDC faucet works (mint test tokens)
- [ ] Buy quote calculation accurate
- [ ] Buy transaction executes successfully
- [ ] Token balance updates in UI
- [ ] IBR status displays correctly
- [ ] Monitoring system detects transactions

### Once Model 21 Pool Deployed

- [ ] Update `docs/SEPOLIA-FRONTEND-INTEGRATION.md` with real addresses
- [ ] Update `deployments/sepolia-latest.json`
- [ ] Test buy flow on Model 21 pool
- [ ] Verify hokus.ai UI shows correct pool data
- [ ] Document any issues or learnings
- [ ] Update mainnet deployment checklist based on findings

## Support

**Contract Developer:** me@timogilvie.com
**Monitoring Dashboard:** https://contracts.hokus.ai/health
**Sepolia Etherscan:** https://sepolia.etherscan.io

## Rate Limit Issue Details

**Error:** `Too Many Requests error received from eth-sepolia.g.alchemy.com`
**Cause:** Alchemy free tier rate limiting
**Solution:** Wait 1-2 hours or use alternative RPC endpoint
**Prevention:** Added 2-second delays between transactions in deployment script
