# Etherscan Contract Verification Guide

## Why Verify Contracts?

Verified contracts on Etherscan provide:
- ✅ **Transparency**: Users can read your source code
- ✅ **Trust**: Proves your contract does what you claim
- ✅ **Better UX**: Contract functions are labeled and readable
- ✅ **Public Name Tags**: Professional branding like "Uniswap V2: Router"
- ✅ **IDE Integration**: Code can be opened in Remix/Blockscan

## Current Status

### Sepolia Testnet Deployment (Jan 21, 2026)

**Unverified Contracts** ❌:
- ModelRegistry: `0xA76537670627a4e1b6285981039b0E653Ed0d7a6`
- TokenManager: `0x0BA3eCeD140DdD254796b0bC4235309286C38724`
- HokusaiAMMFactory: `0x8683B2Aa6fCFc51a8A40c6E859535db2Ac2e1cb7`
- UsageFeeRouter: `0x6b35eB2dF93A736Eef434570B30eE436083beAC3`
- DeltaVerifier: `0x9042492DA66cb6445ea8E4C8dFEf9b9de1bB83f5`
- LSCOR Token: `0xd6bFa8A2f85157e8a1D91E2c348c99C6Da86986c`
- LSCOR AMM Pool: `0x935b6e3487607866F47c084442C19706d1c5A738`
- MockUSDC: `0xB568cBaaBB76EC2104F830c9D2F3a806d5db4c90`
- DataContributionRegistry: `0x39a8c8C15d02F2Bb374b76B3BaaC95F8eeda82c6`

## Quick Start: Verify All Contracts

### Prerequisites

1. **Etherscan API Key** in `.env`:
```bash
ETHERSCAN_API_KEY=your_api_key_here
```

Get your API key: https://etherscan.io/myapikey

2. **Deployment file** exists at `deployments/sepolia-latest.json`

### Run Verification

```bash
# Verify all contracts automatically
npx hardhat run scripts/verify-all-contracts.js --network sepolia
```

This script will verify:
- ✅ ModelRegistry
- ✅ TokenManager
- ✅ DataContributionRegistry
- ✅ MockUSDC
- ✅ HokusaiAMMFactory
- ✅ UsageFeeRouter
- ✅ DeltaVerifier
- ✅ All HokusaiToken instances
- ✅ All HokusaiAMM pools

## Manual Verification (If Needed)

### Example: Verify LSCOR AMM Pool

```bash
npx hardhat verify --network sepolia \
  0x935b6e3487607866F47c084442C19706d1c5A738 \
  "0xB568cBaaBB76EC2104F830c9D2F3a806d5db4c90" \
  "0xd6bFa8A2f85157e8a1D91E2c348c99C6Da86986c" \
  "0x0BA3eCeD140DdD254796b0bC4235309286C38724" \
  "sales-lead-scoring-v2" \
  "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B" \
  100000 \
  30 \
  604800 \
  "25000000000" \
  "10000"
```

### Constructor Arguments Reference

#### HokusaiAMM (10 parameters)
```javascript
[
  reserveToken,        // MockUSDC address
  hokusaiToken,        // Token address
  tokenManager,        // TokenManager address
  modelId,            // String: "sales-lead-scoring-v2"
  treasury,           // Treasury/deployer address
  crr,                // uint256: 100000 (10%)
  tradeFee,           // uint256: 30 (0.30%)
  ibrDuration,        // uint256: 604800 (7 days)
  flatCurveThreshold, // uint256: "25000000000" ($25k)
  flatCurvePrice      // uint256: "10000" ($0.01)
]
```

#### HokusaiAMMFactory (4 parameters)
```javascript
[
  modelRegistry,   // ModelRegistry address
  tokenManager,    // TokenManager address
  reserveToken,    // MockUSDC address
  treasury         // Treasury address
]
```

#### UsageFeeRouter (4 parameters)
```javascript
[
  factory,         // HokusaiAMMFactory address
  reserveToken,    // MockUSDC address
  treasury,        // Treasury address
  protocolFeeBps   // uint16: 500 (5%)
]
```

#### DeltaVerifier (6 parameters)
```javascript
[
  modelRegistry,        // ModelRegistry address
  tokenManager,         // TokenManager address
  contributionRegistry, // DataContributionRegistry address
  baseRewardRate,       // uint256: 1000
  minImprovementBps,    // uint256: 100 (1%)
  maxReward            // uint256: parseEther("1000000")
]
```

## Applying for Public Name Tags

After verification, apply for **Public Name Tags** to make your contracts easily identifiable.

### Process

1. **Go to Etherscan Name Tag Application**
   - Sepolia: https://sepolia.etherscan.io/contactus?id=16
   - Mainnet: https://etherscan.io/contactus?id=16

2. **Submit Application for Each Contract**

### Recommended Name Tags

| Contract | Name Tag | Category |
|----------|----------|----------|
| HokusaiAMMFactory | `Hokusai: AMM Factory` | DEX |
| LSCOR AMM Pool | `Hokusai: LSCOR Pool` | DEX |
| TokenManager | `Hokusai: Token Manager` | Token Management |
| UsageFeeRouter | `Hokusai: Fee Router` | Finance |
| DeltaVerifier | `Hokusai: Delta Verifier` | Verification |
| ModelRegistry | `Hokusai: Model Registry` | Registry |

### Application Template

```
Contract Address: [ADDRESS]
Project Name: Hokusai Protocol
Website: [YOUR_WEBSITE]
Description: [CONTRACT_DESCRIPTION]
Requested Name Tag: [NAME_TAG]
Category: DEX / Token Management / Finance
Social Media: [TWITTER/DISCORD]
```

## Troubleshooting

### Error: "Already Verified"
✅ Good news! Your contract is already verified.

### Error: "Constructor arguments don't match"
❌ Check your constructor arguments match exactly what was used during deployment.
- Look in `deployments/sepolia-latest.json` for correct values
- Ensure string parameters are in quotes
- Verify numeric parameters match deployment

### Error: "No API Key"
❌ Add `ETHERSCAN_API_KEY` to your `.env` file

### Error: "Bytecode doesn't match"
❌ Compiler settings don't match deployment:
- Check Solidity version (should be 0.8.20)
- Check optimization (should be enabled with 200 runs)
- Check viaIR (should be true)

## Best Practices from Top DeFi Projects

### Uniswap V2
- ✅ All contracts verified
- ✅ Clear name tags ("Uniswap V2: Router 2")
- ✅ Optimization settings visible
- ✅ Source code with comments

### Aave
- ✅ Verified with exact match
- ✅ Public name tags for all core contracts
- ✅ Constructor arguments documented
- ✅ Libraries verified separately

### Compound
- ✅ Full verification on deployment
- ✅ Name tags follow consistent pattern
- ✅ Contract relationships clear

## After Verification

Once verified, your contracts will show:
- ✅ **Green checkmark** on Etherscan
- ✅ **"Contract" tab** with readable code
- ✅ **Function names** in transaction list
- ✅ **Constructor arguments** visible
- ✅ **Compiler settings** transparent

## Mainnet Deployment Checklist

Before deploying to mainnet:
- [ ] Test verification script on testnet
- [ ] Confirm all constructor arguments are correct
- [ ] Verify immediately after deployment
- [ ] Apply for name tags within 24 hours
- [ ] Document all contract addresses
- [ ] Add contracts to monitoring dashboard

## Resources

- Etherscan API: https://docs.etherscan.io/
- Hardhat Verification: https://hardhat.org/hardhat-runner/plugins/nomicfoundation-hardhat-verify
- Name Tag Application: https://info.etherscan.com/name-tag-application/

## Support

If verification fails after multiple attempts:
- Check Hardhat version compatibility
- Verify Etherscan API key permissions
- Contact Etherscan support: https://etherscan.io/contactus
