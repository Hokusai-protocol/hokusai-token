# Sepolia Contract Update Guide

## 🚀 New Contracts Deployed (2025-09-24)

The Hokusai token system has been upgraded with governance-controlled parameters. Here are the new addresses to use:

### Primary Contracts

| Contract | Old Address | New Address |
|----------|------------|-------------|
| **HokusaiToken** | `0xf107e000b6cf35de3a7d36667fb899cc59b6a28f` | **`0x39c60AaC840AAd357edfdED3772e4134B2e04d8C`** ✨ |
| **HokusaiParams** | N/A (new) | **`0xBbED47149FDA720e22e3029Bf9A197985711D823`** |
| **ModelRegistry** | N/A | `0xc8b2f6B1C569A7d16D0eD17fE9318547679E1Df0` |
| **TokenManager** | N/A | `0xEb81526f1D2c4226cEea08821553f6c8a9c1B431` |
| **DeltaVerifier** | N/A | `0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd` |

## 📝 What Changed in This Repo

✅ **Already Updated:**
- `.env.sepolia` - Updated with new contract addresses
- `.env.sepolia.deployed` - Created with deployment details
- `deployment-sepolia.json` - Contains deployment metadata

## 🔄 What Needs Updating Externally

### Frontend Applications
Update any frontend that interacts with the token:
- Replace old token address with `0x39c60AaC840AAd357edfdED3772e4134B2e04d8C`
- Add TokenManager address: `0xEb81526f1D2c4226cEea08821553f6c8a9c1B431`
- Add ModelRegistry address: `0xc8b2f6B1C569A7d16D0eD17fE9318547679E1Df0`

### Backend Services
If you have backend services (APIs, indexers, etc.):
- Update token contract address
- Add new contract ABIs if needed
- Update any monitoring or alerting

### Documentation
Update any external documentation that references:
- Token contract addresses
- Deployment guides
- Integration examples

## 🎯 Key Benefits of New System

1. **Governance Control**: Parameters can be adjusted without redeployment
2. **Dynamic Minting Rate**: `tokensPerDeltaOne` is adjustable (currently: 1000)
3. **Infrastructure Markup**: Can set fees (currently: 5%)
4. **License Management**: Updateable license references

## 🔗 Etherscan Links

- [New Token](https://sepolia.etherscan.io/address/0x39c60AaC840AAd357edfdED3772e4134B2e04d8C)
- [Params Module](https://sepolia.etherscan.io/address/0xBbED47149FDA720e22e3029Bf9A197985711D823)
- [TokenManager](https://sepolia.etherscan.io/address/0xEb81526f1D2c4226cEea08821553f6c8a9c1B431)
- [ModelRegistry](https://sepolia.etherscan.io/address/0xc8b2f6B1C569A7d16D0eD17fE9318547679E1Df0)
- [DeltaVerifier](https://sepolia.etherscan.io/address/0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd)

## 🛠️ Testing Commands

```bash
# Verify the new system is working
npx hardhat run scripts/verify-params.js --network sepolia

# Update parameters (requires GOV_ROLE)
npx hardhat run scripts/update-params.js --network sepolia
```

## ⚠️ Important Notes

- The old token (`0xf107e000...`) still exists but should no longer be used
- Only the new token has the params module for governance control
- Make sure all integrations are updated to use the new token address