# Frontend Integration Guide

This guide is for web developers building trading UIs, dashboards, and analytics interfaces for the Hokusai Token system.

## Table of Contents

- [View Functions Reference](#view-functions-reference)
- [Decimal Handling](#decimal-handling)
- [Real-time UI Patterns](#real-time-ui-patterns)
- [Performance Optimization](#performance-optimization)
- [Code Examples](#code-examples)

## View Functions Reference

The HokusaiAMM contract provides gas-efficient view functions designed specifically for frontend integration.

### getPoolState()

Fetches all pool metrics in a single RPC call.

**Function Signature**:
```solidity
function getPoolState() external view returns (
    uint256 reserve,           // USDC reserve balance (6 decimals)
    uint256 supply,            // Token supply (18 decimals)
    uint256 price,             // Spot price in USDC per token (6 decimals)
    uint256 reserveRatio,      // CRR in ppm (parts per million)
    uint256 tradeFeeRate,      // Trade fee in bps (basis points)
    uint16 protocolFeeRate     // Protocol fee in bps
)
```

**TypeScript Example**:
```typescript
interface PoolState {
  reserve: bigint;        // USDC (6 decimals)
  supply: bigint;         // Tokens (18 decimals)
  price: bigint;          // USDC per token (6 decimals)
  reserveRatio: bigint;   // ppm (1000000 = 100%)
  tradeFeeRate: bigint;   // bps (100 = 1%)
  protocolFeeRate: bigint; // bps (100 = 1%)
}

async function fetchPoolState(poolAddress: string): Promise<PoolState> {
  const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);
  const [reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate] =
    await pool.getPoolState();

  return {
    reserve,
    supply,
    price,
    reserveRatio,
    tradeFeeRate,
    protocolFeeRate,
  };
}

// Display in UI
const state = await fetchPoolState(poolAddress);
console.log(`Reserve: $${ethers.formatUnits(state.reserve, 6)} USDC`);
console.log(`Supply: ${ethers.formatEther(state.supply)} tokens`);
console.log(`Price: $${ethers.formatUnits(state.price, 6)} per token`);
console.log(`CRR: ${Number(state.reserveRatio) / 10000}%`);
console.log(`Trade Fee: ${Number(state.tradeFeeRate) / 100}%`);
```

**Gas Cost**: ~8,000 gas

### getTradeInfo()

Returns trading status and IBR information.

**Function Signature**:
```solidity
function getTradeInfo() external view returns (
    bool sellsEnabled,    // Whether sells are currently allowed
    uint256 ibrEndTime,   // Timestamp when IBR ends (sells enabled)
    bool isPaused         // Whether trading is paused
)
```

**TypeScript Example**:
```typescript
interface TradeInfo {
  sellsEnabled: boolean;
  ibrEndTime: bigint;    // Unix timestamp
  isPaused: boolean;
}

async function fetchTradeInfo(poolAddress: string): Promise<TradeInfo> {
  const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);
  const [sellsEnabled, ibrEndTime, isPaused] = await pool.getTradeInfo();

  return { sellsEnabled, ibrEndTime, isPaused };
}

// Determine button state
const info = await fetchTradeInfo(poolAddress);

if (info.isPaused) {
  console.log("Trading paused");
} else if (!info.sellsEnabled) {
  const timeLeft = Number(info.ibrEndTime) - Date.now() / 1000;
  const days = Math.floor(timeLeft / 86400);
  const hours = Math.floor((timeLeft % 86400) / 3600);
  console.log(`Sells available in ${days}d ${hours}h`);
} else {
  console.log("Trading enabled");
}
```

**Gas Cost**: ~5,000 gas

### calculateBuyImpact()

Previews the impact of a buy trade.

**Function Signature**:
```solidity
function calculateBuyImpact(uint256 reserveIn) external view returns (
    uint256 tokensOut,      // Tokens to be received (18 decimals)
    uint256 priceImpact,    // Price impact in bps (100 = 1%)
    uint256 newSpotPrice    // New spot price after trade (6 decimals)
)
```

**TypeScript Example**:
```typescript
async function previewBuy(
  poolAddress: string,
  usdcAmount: bigint
): Promise<{
  tokensOut: bigint;
  priceImpact: bigint;
  newSpotPrice: bigint;
}> {
  const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);
  const [tokensOut, priceImpact, newSpotPrice] = await pool.calculateBuyImpact(
    usdcAmount
  );

  return { tokensOut, priceImpact, newSpotPrice };
}

// Preview $100 buy
const preview = await previewBuy(poolAddress, 100_000000n);
console.log(`You will receive: ${ethers.formatEther(preview.tokensOut)} tokens`);
console.log(`Price impact: ${Number(preview.priceImpact) / 100}%`);
console.log(`New price: $${ethers.formatUnits(preview.newSpotPrice, 6)}`);
```

**Gas Cost**: ~15,000 gas

### calculateSellImpact()

Previews the impact of a sell trade.

**Function Signature**:
```solidity
function calculateSellImpact(uint256 tokensIn) external view returns (
    uint256 reserveOut,     // USDC to be received (6 decimals)
    uint256 priceImpact,    // Price impact in bps (100 = 1%)
    uint256 newSpotPrice    // New spot price after trade (6 decimals)
)
```

**TypeScript Example**:
```typescript
async function previewSell(
  poolAddress: string,
  tokenAmount: bigint
): Promise<{
  reserveOut: bigint;
  priceImpact: bigint;
  newSpotPrice: bigint;
}> {
  const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);
  const [reserveOut, priceImpact, newSpotPrice] = await pool.calculateSellImpact(
    tokenAmount
  );

  return { reserveOut, priceImpact, newSpotPrice };
}

// Preview selling 1000 tokens
const preview = await previewSell(poolAddress, ethers.parseEther("1000"));
console.log(`You will receive: $${ethers.formatUnits(preview.reserveOut, 6)} USDC`);
console.log(`Price impact: ${Number(preview.priceImpact) / 100}%`);
```

**Gas Cost**: ~15,000 gas

## Decimal Handling

Different tokens use different decimal places. Always handle conversions correctly.

### Decimal Reference

| Token | Decimals | Format | Example |
|-------|----------|--------|---------|
| USDC | 6 | `formatUnits(value, 6)` | `100_000000` = $100 |
| HokusaiToken | 18 | `formatEther(value)` | `1000000000000000000` = 1 token |
| Price | 6 | `formatUnits(value, 6)` | `5_500000` = $5.50 |
| Price Impact | Basis points | `value / 100` | `150` = 1.5% |
| CRR | Parts per million | `value / 10000` | `100000` = 10% |

### Conversion Utilities

```typescript
// Format for display
function formatUSDC(amount: bigint): string {
  return `$${ethers.formatUnits(amount, 6)}`;
}

function formatTokens(amount: bigint): string {
  return ethers.formatEther(amount);
}

function formatPercentage(bps: bigint): string {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function formatCRR(ppm: bigint): string {
  return `${(Number(ppm) / 10000).toFixed(1)}%`;
}

// Parse from user input
function parseUSDC(input: string): bigint {
  return ethers.parseUnits(input, 6);
}

function parseTokens(input: string): bigint {
  return ethers.parseEther(input);
}

// Example usage
const reserve = 50000_000000n; // $50,000
console.log(formatUSDC(reserve)); // "$50000.0"

const tokens = ethers.parseEther("1234.56");
console.log(formatTokens(tokens)); // "1234.56"

const impact = 234n; // 2.34%
console.log(formatPercentage(impact)); // "2.34%"
```

## Real-time UI Patterns

### Price Impact Preview

Show price impact as users type amounts:

```typescript
import { useState, useEffect } from "react";
import { ethers } from "ethers";

function PriceImpactPreview({ poolAddress }: { poolAddress: string }) {
  const [usdcInput, setUsdcInput] = useState("");
  const [preview, setPreview] = useState<{
    tokensOut: string;
    priceImpact: number;
    newPrice: string;
  } | null>(null);

  useEffect(() => {
    if (!usdcInput || isNaN(Number(usdcInput))) {
      setPreview(null);
      return;
    }

    const fetchPreview = async () => {
      try {
        const amount = ethers.parseUnits(usdcInput, 6);
        const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);

        const [tokensOut, priceImpact, newSpotPrice] =
          await pool.calculateBuyImpact(amount);

        setPreview({
          tokensOut: ethers.formatEther(tokensOut),
          priceImpact: Number(priceImpact) / 100,
          newPrice: ethers.formatUnits(newSpotPrice, 6),
        });
      } catch (error) {
        console.error("Preview failed:", error);
        setPreview(null);
      }
    };

    // Debounce preview updates
    const timer = setTimeout(fetchPreview, 300);
    return () => clearTimeout(timer);
  }, [usdcInput, poolAddress]);

  // Color coding based on price impact
  const getImpactColor = (impact: number) => {
    if (impact < 1) return "text-green-600";
    if (impact < 5) return "text-yellow-600";
    return "text-red-600";
  };

  return (
    <div>
      <input
        type="number"
        value={usdcInput}
        onChange={(e) => setUsdcInput(e.target.value)}
        placeholder="USDC amount"
        className="border p-2 rounded"
      />

      {preview && (
        <div className="mt-4 p-4 bg-gray-50 rounded">
          <p>You will receive: <strong>{preview.tokensOut} tokens</strong></p>
          <p className={getImpactColor(preview.priceImpact)}>
            Price Impact: <strong>{preview.priceImpact.toFixed(2)}%</strong>
          </p>
          <p>New Price: <strong>${preview.newPrice}</strong></p>
        </div>
      )}
    </div>
  );
}
```

### Trading Button State

Enable/disable buttons based on IBR and pause status:

```typescript
function TradingButtons({ poolAddress }: { poolAddress: string }) {
  const [tradeInfo, setTradeInfo] = useState<TradeInfo | null>(null);

  useEffect(() => {
    const fetchInfo = async () => {
      const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);
      const [sellsEnabled, ibrEndTime, isPaused] = await pool.getTradeInfo();
      setTradeInfo({ sellsEnabled, ibrEndTime, isPaused });
    };

    fetchInfo();
    const interval = setInterval(fetchInfo, 10000); // Update every 10s
    return () => clearInterval(interval);
  }, [poolAddress]);

  if (!tradeInfo) return <div>Loading...</div>;

  const buyDisabled = tradeInfo.isPaused;
  const sellDisabled = tradeInfo.isPaused || !tradeInfo.sellsEnabled;

  const getButtonMessage = () => {
    if (tradeInfo.isPaused) return "Trading Paused";
    if (!tradeInfo.sellsEnabled) {
      const timeLeft = Number(tradeInfo.ibrEndTime) - Date.now() / 1000;
      const days = Math.floor(timeLeft / 86400);
      const hours = Math.floor((timeLeft % 86400) / 3600);
      return `Sells available in ${days}d ${hours}h`;
    }
    return null;
  };

  return (
    <div className="flex gap-4">
      <button
        disabled={buyDisabled}
        className={`px-6 py-2 rounded ${
          buyDisabled ? "bg-gray-300" : "bg-green-600 text-white"
        }`}
      >
        Buy
      </button>

      <button
        disabled={sellDisabled}
        className={`px-6 py-2 rounded ${
          sellDisabled ? "bg-gray-300" : "bg-red-600 text-white"
        }`}
      >
        Sell
      </button>

      {getButtonMessage() && (
        <p className="text-sm text-gray-600">{getButtonMessage()}</p>
      )}
    </div>
  );
}
```

### Slippage Tolerance

Calculate `minOut` values with user-configured slippage:

```typescript
function calculateMinOut(
  expectedOut: bigint,
  slippageBps: number // e.g., 50 = 0.5%
): bigint {
  const slippageMultiplier = BigInt(10000 - slippageBps);
  return (expectedOut * slippageMultiplier) / 10000n;
}

// Example: User wants 1% slippage tolerance
const expectedTokens = 1000_000000000000000000n; // 1000 tokens
const minTokens = calculateMinOut(expectedTokens, 100); // 1% = 100 bps

console.log(`Expected: ${ethers.formatEther(expectedTokens)}`);
console.log(`Min acceptable: ${ethers.formatEther(minTokens)}`);
// Expected: 1000.0
// Min acceptable: 990.0

// Use in trade
await pool.buy(usdcAmount, minTokens, userAddress, deadline);
```

### Slippage Selector Component

```typescript
function SlippageSelector({
  slippage,
  setSlippage,
}: {
  slippage: number;
  setSlippage: (bps: number) => void;
}) {
  const presets = [
    { label: "0.1%", value: 10 },
    { label: "0.5%", value: 50 },
    { label: "1%", value: 100 },
    { label: "3%", value: 300 },
  ];

  return (
    <div className="flex gap-2">
      <label>Slippage:</label>
      {presets.map((preset) => (
        <button
          key={preset.value}
          onClick={() => setSlippage(preset.value)}
          className={`px-3 py-1 rounded ${
            slippage === preset.value
              ? "bg-blue-600 text-white"
              : "bg-gray-200"
          }`}
        >
          {preset.label}
        </button>
      ))}
      <input
        type="number"
        value={slippage / 100}
        onChange={(e) => setSlippage(Number(e.target.value) * 100)}
        step="0.1"
        className="w-20 border p-1 rounded"
      />
      <span>%</span>
    </div>
  );
}
```

## Performance Optimization

### Multicall Batching

Fetch data from multiple pools efficiently:

```typescript
import { Contract } from "ethers";

// Using ethers.js Contract.multicall (v6+)
async function batchFetchPoolStates(
  poolAddresses: string[]
): Promise<PoolState[]> {
  const pool = new Contract(poolAddresses[0], AMM_ABI, provider);

  // Create multicall for all pools
  const calls = poolAddresses.map((address) => {
    const poolContract = new Contract(address, AMM_ABI, provider);
    return poolContract.getPoolState();
  });

  // Execute all calls in parallel
  const results = await Promise.all(calls);

  return results.map(([reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate]) => ({
    reserve,
    supply,
    price,
    reserveRatio,
    tradeFeeRate,
    protocolFeeRate,
  }));
}

// Fetch states for 10 pools in one batch
const poolStates = await batchFetchPoolStates(poolAddresses);
```

Using viem for more efficient multicall:

```typescript
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
});

async function viemMulticall(poolAddresses: string[]) {
  const contracts = poolAddresses.map((address) => ({
    address: address as `0x${string}`,
    abi: AMM_ABI,
    functionName: "getPoolState",
  }));

  const results = await client.multicall({ contracts });

  return results.map((result) => {
    if (result.status === "success") {
      const [reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate] =
        result.result as any;
      return { reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate };
    }
    return null;
  });
}
```

### Event Subscription

Listen for real-time updates:

```typescript
function usePoolEvents(poolAddress: string) {
  const [lastTrade, setLastTrade] = useState<{
    type: "buy" | "sell";
    amount: string;
    price: string;
  } | null>(null);

  useEffect(() => {
    const pool = new ethers.Contract(poolAddress, AMM_ABI, provider);

    // Listen for buy events
    const buyFilter = pool.filters.Buy();
    pool.on(buyFilter, (buyer, reserveIn, tokensOut, fee, spotPrice) => {
      setLastTrade({
        type: "buy",
        amount: ethers.formatEther(tokensOut),
        price: ethers.formatUnits(spotPrice, 6),
      });
    });

    // Listen for sell events
    const sellFilter = pool.filters.Sell();
    pool.on(sellFilter, (seller, tokensIn, reserveOut, fee, spotPrice) => {
      setLastTrade({
        type: "sell",
        amount: ethers.formatEther(tokensIn),
        price: ethers.formatUnits(spotPrice, 6),
      });
    });

    return () => {
      pool.removeAllListeners();
    };
  }, [poolAddress]);

  return lastTrade;
}

// Usage in component
function RecentTrades({ poolAddress }: { poolAddress: string }) {
  const lastTrade = usePoolEvents(poolAddress);

  if (!lastTrade) return <div>Waiting for trades...</div>;

  return (
    <div className={lastTrade.type === "buy" ? "text-green-600" : "text-red-600"}>
      Last {lastTrade.type}: {lastTrade.amount} tokens @ ${lastTrade.price}
    </div>
  );
}
```

### Caching Strategy

Cache static data to reduce RPC calls:

```typescript
class PoolDataCache {
  private cache = new Map<string, { data: any; timestamp: number }>();
  private ttl: number;

  constructor(ttlSeconds: number = 60) {
    this.ttl = ttlSeconds * 1000;
  }

  async get<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);

    if (cached && Date.now() - cached.timestamp < this.ttl) {
      return cached.data as T;
    }

    const data = await fetcher();
    this.cache.set(key, { data, timestamp: Date.now() });
    return data;
  }

  invalidate(key: string) {
    this.cache.delete(key);
  }
}

// Usage
const cache = new PoolDataCache(60); // 60 second TTL

async function getPoolState(poolAddress: string): Promise<PoolState> {
  return cache.get(`pool-state-${poolAddress}`, async () => {
    const pool = new Contract(poolAddress, AMM_ABI, provider);
    return await pool.getPoolState();
  });
}

// Invalidate cache when trade occurs
pool.on("Buy", () => {
  cache.invalidate(`pool-state-${poolAddress}`);
});
```

## Code Examples

### Complete Trading Interface

See [docs/examples/react/TradingInterface.tsx](../examples/react/TradingInterface.tsx) for a production-ready trading component with:
- Real-time price impact preview
- Slippage tolerance selector
- IBR countdown timer
- Transaction status tracking
- Error handling

### Pool Analytics Dashboard

See [docs/examples/react/PoolAnalytics.tsx](../examples/react/PoolAnalytics.tsx) for a comprehensive dashboard showing:
- Pool metrics (reserve, supply, price, CRR)
- Recent trade history
- Price impact chart
- Trading volume statistics

### Price Impact Visualization

```typescript
function PriceImpactChart({ poolAddress }: { poolAddress: string }) {
  const [impactData, setImpactData] = useState<
    Array<{ amount: number; impact: number }>
  >([]);

  useEffect(() => {
    const calculateImpacts = async () => {
      const pool = new Contract(poolAddress, AMM_ABI, provider);
      const amounts = [100, 500, 1000, 5000, 10000]; // USDC amounts

      const data = await Promise.all(
        amounts.map(async (amount) => {
          const usdcAmount = ethers.parseUnits(amount.toString(), 6);
          const [, priceImpact] = await pool.calculateBuyImpact(usdcAmount);
          return {
            amount,
            impact: Number(priceImpact) / 100,
          };
        })
      );

      setImpactData(data);
    };

    calculateImpacts();
  }, [poolAddress]);

  return (
    <div>
      <h3>Price Impact by Trade Size</h3>
      {impactData.map(({ amount, impact }) => (
        <div key={amount} className="flex justify-between">
          <span>${amount}</span>
          <span className={impact < 1 ? "text-green-600" : "text-yellow-600"}>
            {impact.toFixed(2)}%
          </span>
        </div>
      ))}
    </div>
  );
}
```

## TypeScript Type Definitions

```typescript
// Contract ABIs
export const AMM_ABI = [
  "function getPoolState() view returns (uint256, uint256, uint256, uint256, uint256, uint16)",
  "function getTradeInfo() view returns (bool, uint256, bool)",
  "function calculateBuyImpact(uint256) view returns (uint256, uint256, uint256)",
  "function calculateSellImpact(uint256) view returns (uint256, uint256, uint256)",
  "function buy(uint256, uint256, address, uint256) returns (uint256)",
  "function sell(uint256, uint256, address, uint256) returns (uint256)",
  "event Buy(address indexed, uint256, uint256, uint256, uint256)",
  "event Sell(address indexed, uint256, uint256, uint256, uint256)",
];

// Type definitions
export interface PoolState {
  reserve: bigint;
  supply: bigint;
  price: bigint;
  reserveRatio: bigint;
  tradeFeeRate: bigint;
  protocolFeeRate: bigint;
}

export interface TradeInfo {
  sellsEnabled: boolean;
  ibrEndTime: bigint;
  isPaused: boolean;
}

export interface TradePreview {
  tokensOut: bigint;
  priceImpact: bigint;
  newSpotPrice: bigint;
}
```

## Next Steps

- [Troubleshooting Guide](../troubleshooting.md) - Common errors and solutions
- [API Reference: HokusaiAMM](../api-reference/contracts/HokusaiAMM.md) - Full contract documentation
- [Smart Contract Integration](./smart-contracts.md) - For protocol-level integration
- [Backend Integration](./backend-services.md) - Server-side patterns
