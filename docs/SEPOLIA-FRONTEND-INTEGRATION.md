# Sepolia Frontend Integration Guide

**For hokus.ai Team**
**Date:** 2026-01-20
**Purpose:** Connect hokus.ai UI to Sepolia testnet for pre-mainnet testing

---

## Overview

The Hokusai AMM smart contracts are now deployed on **Sepolia testnet** with a real model: **Sales Lead Scoring v2** (Model ID: 21). This enables end-to-end testing of the buying flow before mainnet launch.

---

## Contract Addresses (Sepolia)

**Deployed:** January 12, 2026
**Network:** Sepolia Testnet (Chain ID: 11155111)
**Deployment File:** `deployments/sepolia-latest.json`

```javascript
{
  "network": "sepolia",
  "chainId": "11155111",

  // Core Infrastructure (DEPLOYED ✅)
  "contracts": {
    "ModelRegistry": "0x7793D34871135713940673230AbE2Bb68799d508",
    "TokenManager": "0xdD57e6C770E5A5644Ec8132FF40B4c68ab65325e",
    "HokusaiAMMFactory": "0x60500936CEb844fCcB75f2246852A65B9508eAd7",
    "MockUSDC": "0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3",
    "UsageFeeRouter": "0x2C5C22229ae63A187aafc89AF392dF53253D17d7",
    "DataContributionRegistry": "0x97c738D0aE723533f3eE97C45ec91A3abBBf491D",
    "DeltaVerifier": "0x564cE700370F9Fb0b6Fe0EdbEdAb7623eC7c131B"
  },

  // Existing Test Pools (for reference)
  "existingPools": [
    {
      "modelId": "model-conservative-001",
      "symbol": "HKS-CON",
      "tokenAddress": "0xE3423d52c42b61bc1Dd6abfbDa9bEBa827a4c806",
      "ammAddress": "0x58565F787C49F09C7Bf33990e7C5B7208580901a"
    },
    {
      "modelId": "model-aggressive-002",
      "symbol": "HKS-AGG",
      "tokenAddress": "0xc6d747bC7884e50104C6A919C86f02001a76E281",
      "ammAddress": "0xEf815E7F11eD0B88cE33Dd30FC9568f7F66abC5a"
    },
    {
      "modelId": "model-balanced-003",
      "symbol": "HKS-BAL",
      "tokenAddress": "0xeA2Ec4A52fDE565CC5a1B92A213C3CC156a6F63e",
      "ammAddress": "0x76A59583430243D595E8985cA089a00Cc18B73af"
    }
  ]
}
```

### Sales Lead Scoring v2 Pool (Model ID: 21) ✅ DEPLOYED

**Status:** ✅ Deployed and operational
**Deployed:** January 20, 2026

**Addresses:**
- **Model ID:** `"21"`
- **Symbol:** `LSCOR`
- **Token Address:** `0x645e4cB0741203E77fbb20ECb8299540544Cebf3`
- **AMM Address:** `0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E`

**Configuration:**
- **Initial Reserve:** $5,000 USDC
- **Spot Price:** $0.025
- **Total Supply:** 1,000,000 LSCOR
- **Market Cap:** $25,000
- **CRR:** 20%
- **Trade Fee:** 0.30%
- **IBR Ends:** 2026-01-22 15:24:24 UTC (47.9 hours from now)
- **Sells Enabled:** ⏳ Not yet (wait for IBR to expire)

**Quick Links:**
- 🔗 [Token on Sepolia Etherscan](https://sepolia.etherscan.io/token/0x645e4cB0741203E77fbb20ECb8299540544Cebf3)
- 🔗 [Pool on Sepolia Etherscan](https://sepolia.etherscan.io/address/0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E)
- 🔗 [Model on hokus.ai](https://hokus.ai/explore-models/21)

---

## Frontend Configuration

### 1. Network Setup

Add Sepolia network configuration:

```typescript
// config/networks.ts
export const NETWORKS = {
  sepolia: {
    chainId: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY',
    blockExplorer: 'https://sepolia.etherscan.io',
    isTestnet: true
  },
  mainnet: {
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: 'https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY',
    blockExplorer: 'https://etherscan.io',
    isTestnet: false
  }
};

// Use environment variable to switch networks
export const ACTIVE_NETWORK = process.env.NEXT_PUBLIC_NETWORK === 'mainnet'
  ? NETWORKS.mainnet
  : NETWORKS.sepolia;
```

### 2. Contract Addresses

```typescript
// config/contracts.ts
export const CONTRACT_ADDRESSES = {
  sepolia: {
    modelRegistry: "0x7793D34871135713940673230AbE2Bb68799d508",
    tokenManager: "0xdD57e6C770E5A5644Ec8132FF40B4c68ab65325e",
    ammFactory: "0x60500936CEb844fCcB75f2246852A65B9508eAd7",
    usdc: "0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3",
    usageFeeRouter: "0x2C5C22229ae63A187aafc89AF392dF53253D17d7",
    deltaVerifier: "0x564cE700370F9Fb0b6Fe0EdbEdAb7623eC7c131B"
  },
  mainnet: {
    // To be filled after mainnet deployment
  }
};

export const getContracts = () => CONTRACT_ADDRESSES[ACTIVE_NETWORK.name.toLowerCase()];
```

### 3. Model-to-AMM Mapping

```typescript
// config/models.ts
export const MODEL_POOLS = {
  sepolia: {
    // Test pools (can use these for initial integration testing)
    "model-conservative-001": {
      tokenAddress: "0xE3423d52c42b61bc1Dd6abfbDa9bEBa827a4c806",
      ammAddress: "0x58565F787C49F09C7Bf33990e7C5B7208580901a",
      symbol: "HKS-CON",
      name: "Hokusai Conservative",
      crr: 0.30,               // 30%
      tradeFee: 0.0025,        // 0.25%
      ibrEndsAt: "2026-01-13T...",  // Check actual IBR end time
      minTradeAmount: "1",
      maxTradeAmount: "10000"
    },
    "model-balanced-003": {
      tokenAddress: "0xeA2Ec4A52fDE565CC5a1B92A213C3CC156a6F63e",
      ammAddress: "0x76A59583430243D595E8985cA089a00Cc18B73af",
      symbol: "HKS-BAL",
      name: "Hokusai Balanced",
      crr: 0.20,               // 20%
      tradeFee: 0.003,         // 0.30%
      ibrEndsAt: "2026-01-13T...",
      minTradeAmount: "1",
      maxTradeAmount: "10000"
    },
    // Sales Lead Scoring v2 (DEPLOYED ✅)
    "21": {
      tokenAddress: "0x645e4cB0741203E77fbb20ECb8299540544Cebf3",
      ammAddress: "0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E",
      symbol: "LSCOR",
      name: "Sales Lead Scoring v2",
      crr: 0.20,               // 20%
      tradeFee: 0.003,         // 0.30%
      ibrEndsAt: "2026-01-22T15:24:24.000Z",
      minTradeAmount: "1",
      maxTradeAmount: "10000"
    }
  },
  mainnet: {
    // To be filled after mainnet deployment
  }
};

export const getPoolForModel = (modelId: string) => {
  return MODEL_POOLS[ACTIVE_NETWORK.name.toLowerCase()][modelId];
};
```

---

## Smart Contract ABIs

You'll need ABIs for these contracts:

```typescript
// lib/abis.ts
export { default as HokusaiAMM } from './abis/HokusaiAMM.json';
export { default as HokusaiToken } from './abis/HokusaiToken.json';
export { default as IERC20 } from './abis/IERC20.json';
export { default as ModelRegistry } from './abis/ModelRegistry.json';
```

**📁 ABI Files Location:**
`artifacts/contracts/**/*.sol/*.json` in the `hokusai-token` repo

You need:
- `HokusaiAMM.json` - For buying/selling tokens
- `HokusaiToken.json` - For token balances/approvals
- `IERC20.json` - For USDC interactions
- `ModelRegistry.json` - For model lookups (optional)

---

## Buy Flow Implementation

### Step 1: Get Pool Info

```typescript
import { ethers } from 'ethers';
import { HokusaiAMM } from '@/lib/abis';

async function getPoolInfo(modelId: string) {
  const pool = getPoolForModel(modelId);
  const provider = new ethers.BrowserProvider(window.ethereum);
  const ammContract = new ethers.Contract(pool.ammAddress, HokusaiAMM, provider);

  const [spotPrice, reserve, supply, ibrEnd] = await Promise.all([
    ammContract.spotPrice(),        // Current token price in USDC (6 decimals)
    ammContract.reserveBalance(),   // USDC reserve (6 decimals)
    ammContract.totalSupply(),      // Token supply (18 decimals)
    ammContract.ibrEndTime()        // IBR end timestamp
  ]);

  const ibrActive = Date.now() / 1000 < Number(ibrEnd);

  return {
    spotPrice: ethers.formatUnits(spotPrice, 6),  // e.g., "0.005"
    reserve: ethers.formatUnits(reserve, 6),      // e.g., "5000"
    supply: ethers.formatEther(supply),           // e.g., "1000000"
    ibrActive,                                     // true if sells disabled
    ibrEndsAt: new Date(Number(ibrEnd) * 1000)
  };
}
```

### Step 2: Calculate Buy Quote

```typescript
async function getBuyQuote(modelId: string, usdcAmount: string) {
  const pool = getPoolForModel(modelId);
  const provider = new ethers.BrowserProvider(window.ethereum);
  const ammContract = new ethers.Contract(pool.ammAddress, HokusaiAMM, provider);

  const usdcAmountWei = ethers.parseUnits(usdcAmount, 6);

  // Get quote from contract (includes price impact calculation)
  const tokensOut = await ammContract.calculateBuy(usdcAmountWei);

  return {
    usdcIn: usdcAmount,
    tokensOut: ethers.formatEther(tokensOut),
    effectivePrice: Number(usdcAmount) / Number(ethers.formatEther(tokensOut))
  };
}
```

### Step 3: Execute Buy Transaction

```typescript
async function buyTokens(modelId: string, usdcAmount: string, slippageBps: number = 50) {
  const pool = getPoolForModel(modelId);
  const contracts = getContracts();

  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  const usdcContract = new ethers.Contract(contracts.usdc, IERC20, signer);
  const ammContract = new ethers.Contract(pool.ammAddress, HokusaiAMM, signer);

  const usdcAmountWei = ethers.parseUnits(usdcAmount, 6);

  // Step 1: Approve USDC
  console.log('Approving USDC...');
  const approveTx = await usdcContract.approve(pool.ammAddress, usdcAmountWei);
  await approveTx.wait();

  // Step 2: Calculate minimum tokens (with slippage protection)
  const expectedTokens = await ammContract.calculateBuy(usdcAmountWei);
  const minTokens = expectedTokens * BigInt(10000 - slippageBps) / 10000n;

  // Step 3: Execute buy
  console.log('Buying tokens...');
  const buyTx = await ammContract.buy(usdcAmountWei, minTokens);
  const receipt = await buyTx.wait();

  // Step 4: Extract actual tokens received from event
  const buyEvent = receipt.logs
    .map(log => {
      try { return ammContract.interface.parseLog(log); }
      catch { return null; }
    })
    .find(event => event?.name === 'Buy');

  if (!buyEvent) throw new Error('Buy event not found');

  return {
    txHash: receipt.hash,
    tokensReceived: ethers.formatEther(buyEvent.args.tokensOut),
    usdcSpent: ethers.formatUnits(buyEvent.args.reserveIn, 6),
    effectivePrice: Number(ethers.formatUnits(buyEvent.args.reserveIn, 6)) /
                     Number(ethers.formatEther(buyEvent.args.tokensOut))
  };
}
```

---

## Testing USDC on Sepolia

### Option 1: Use MockUSDC Mint Function

The deployed MockUSDC has a public `mint()` function:

```typescript
async function getMockUSDC(amount: string) {
  const contracts = getContracts();
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  const mockUSDC = new ethers.Contract(contracts.usdc, [
    "function mint(address to, uint256 amount) public",
    "function balanceOf(address account) view returns (uint256)"
  ], signer);

  const amountWei = ethers.parseUnits(amount, 6);
  const tx = await mockUSDC.mint(await signer.getAddress(), amountWei);
  await tx.wait();

  console.log(`Minted ${amount} MockUSDC`);
}

// Usage: Get $1000 test USDC
await getMockUSDC("1000");
```

### Option 2: Faucet UI Component

Add a "Get Test USDC" button on Sepolia:

```typescript
function USDCFaucet() {
  const [loading, setLoading] = useState(false);
  const network = useNetwork();

  if (!network.isTestnet) return null;  // Only show on Sepolia

  const handleMint = async () => {
    setLoading(true);
    try {
      await getMockUSDC("1000");
      toast.success("Received 1000 test USDC!");
    } catch (error) {
      toast.error("Failed to mint USDC");
    } finally {
      setLoading(false);
    }
  };

  return (
    <button onClick={handleMint} disabled={loading}>
      {loading ? "Minting..." : "Get Test USDC (1000)"}
    </button>
  );
}
```

---

## UI Considerations

### 1. Network Indicator

```tsx
function NetworkBadge() {
  const { chainId } = useAccount();

  if (chainId === 11155111) {
    return (
      <div className="bg-yellow-100 text-yellow-800 px-3 py-1 rounded-full">
        ⚠️ Sepolia Testnet
      </div>
    );
  }

  return (
    <div className="bg-green-100 text-green-800 px-3 py-1 rounded-full">
      ✓ Mainnet
    </div>
  );
}
```

### 2. IBR Warning

```tsx
function IBRWarning({ modelId }: { modelId: string }) {
  const pool = getPoolForModel(modelId);
  const ibrActive = Date.now() < new Date(pool.ibrEndsAt).getTime();

  if (!ibrActive) return null;

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
      <h4 className="font-semibold text-blue-900">Initial Bonding Reserve Active</h4>
      <p className="text-sm text-blue-700 mt-1">
        Selling is disabled until {new Date(pool.ibrEndsAt).toLocaleString()}.
        You can buy tokens, but cannot sell them yet.
      </p>
    </div>
  );
}
```

### 3. Transaction Links

```tsx
function TransactionLink({ hash }: { hash: string }) {
  const explorerUrl = `${ACTIVE_NETWORK.blockExplorer}/tx/${hash}`;

  return (
    <a href={explorerUrl} target="_blank" rel="noopener noreferrer">
      View on {ACTIVE_NETWORK.isTestnet ? 'Sepolia' : ''} Etherscan ↗
    </a>
  );
}
```

---

## Environment Variables

```bash
# .env.local

# Network selection
NEXT_PUBLIC_NETWORK=sepolia  # or 'mainnet'

# RPC endpoints
NEXT_PUBLIC_SEPOLIA_RPC_URL=https://eth-sepolia.g.alchemy.com/v2/YOUR_KEY
NEXT_PUBLIC_MAINNET_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Contract addresses (auto-loaded from config based on NEXT_PUBLIC_NETWORK)
```

---

## Testing Checklist

### Pre-Testing Setup
- [ ] Deploy contracts on Sepolia (run `deploy-sepolia-sales-lead-scoring.js`)
- [ ] Copy addresses from `deployments/sepolia-latest.json` to frontend config
- [ ] Add Sepolia network to frontend network selector
- [ ] Test wallet connection on Sepolia
- [ ] Verify MockUSDC mint function works

### Buy Flow Testing
- [ ] Navigate to Model ID 21 detail page
- [ ] Verify pool info displays correctly (price, reserve, IBR status)
- [ ] Click "Get Test USDC" button, verify balance updates
- [ ] Enter buy amount ($100), verify quote calculation
- [ ] Approve USDC, verify approval transaction completes
- [ ] Execute buy, verify:
  - Transaction succeeds
  - Token balance updates
  - USDC balance decreases
  - Event logged in monitoring system
- [ ] Test with different amounts ($10, $500, $1000)
- [ ] Test slippage protection (should revert if price moves too much)

### Error Handling
- [ ] Test insufficient USDC balance
- [ ] Test insufficient ETH for gas
- [ ] Test wallet rejection
- [ ] Test network mismatch (wallet on mainnet, UI on Sepolia)

### IBR Period Testing
- [ ] Verify "Sell" button is disabled during IBR
- [ ] Verify warning message displays
- [ ] Wait for IBR to expire (~2 days on testnet)
- [ ] Verify sell becomes enabled after IBR

---

## Support & Debugging

### Common Issues

**Issue:** "Wrong network" error
**Solution:** Make sure MetaMask is on Sepolia (Chain ID: 11155111)

**Issue:** "Insufficient USDC balance"
**Solution:** Click "Get Test USDC" button or call `mint()` directly

**Issue:** "Transaction reverted"
**Solution:** Check Sepolia Etherscan for revert reason. Common causes:
- Slippage too low (increase slippage tolerance)
- IBR expired but UI hasn't refreshed
- Contract paused (check monitoring dashboard)

### Monitoring

**Monitoring Dashboard:** https://contracts.hokus.ai/health
**Sepolia Etherscan:** https://sepolia.etherscan.io

All transactions trigger alerts to `me@timogilvie.com` via AWS SES.

### Contact

For smart contract questions:
📧 me@timogilvie.com
📂 `hokusai-token` repo: [GitHub Link]

---

## Quick Start Summary

1. **Run deployment script:**
   ```bash
   npx hardhat run scripts/deploy-sepolia-sales-lead-scoring.js --network sepolia
   ```

2. **Copy addresses** from `deployments/sepolia-latest.json`

3. **Update frontend config:**
   - `config/contracts.ts` - Contract addresses
   - `config/models.ts` - Model ID 21 → AMM mapping
   - `.env.local` - `NEXT_PUBLIC_NETWORK=sepolia`

4. **Add test USDC faucet** component

5. **Test buy flow** on Model ID 21

6. **Monitor** at https://contracts.hokus.ai/health

---

**Ready to test!** 🚀
