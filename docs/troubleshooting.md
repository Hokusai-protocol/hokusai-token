# Troubleshooting Guide

Common errors, solutions, and debugging strategies for the Hokusai Token system.

## Table of Contents

- [Trading Errors](#trading-errors)
- [Deployment Errors](#deployment-errors)
- [Fee Collection Errors](#fee-collection-errors)
- [Authorization Errors](#authorization-errors)
- [Gas and Network Issues](#gas-and-network-issues)
- [Debugging Tools](#debugging-tools)

## Trading Errors

### "Slippage exceeded"

**Error Message**:
```
Error: execution reverted: Slippage exceeded
```

**Cause**: The actual tokens/USDC received would be less than your specified `minOut` value due to price movement.

**Solutions**:

1. **Increase slippage tolerance**:
```typescript
// Instead of 0.5% slippage
const minOut = expectedOut * 995n / 1000n;

// Try 1% slippage
const minOut = expectedOut * 99n / 100n;
```

2. **Wait for better conditions**: Large trades during high volatility may require waiting for market stabilization.

3. **Split large trades**: Break one large trade into smaller chunks to reduce price impact.

```typescript
// Instead of one $10,000 trade:
await pool.buy(parseUSDC("10000"), minOut, user, deadline);

// Split into 5 × $2,000 trades:
for (let i = 0; i < 5; i++) {
  await pool.buy(parseUSDC("2000"), minOutSmall, user, deadline);
  await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s between trades
}
```

### "Transaction expired"

**Error Message**:
```
Error: execution reverted: Transaction expired
```

**Cause**: The transaction `deadline` parameter has passed.

**Solution**: Set deadline further in the future (typically 5-20 minutes):

```typescript
// ❌ Wrong: 1 minute deadline (may be too short)
const deadline = Math.floor(Date.now() / 1000) + 60;

// ✅ Correct: 10 minute deadline
const deadline = Math.floor(Date.now() / 1000) + 600;

await pool.buy(usdcAmount, minOut, userAddress, deadline);
```

### "Sells not enabled during IBR"

**Error Message**:
```
Error: execution reverted: Sells not enabled yet
```

**Cause**: The Initial Bonding Round (IBR) period is still active. Only buying is allowed.

**Solution**:

1. **Check IBR end time**:
```typescript
const [sellsEnabled, ibrEndTime, isPaused] = await pool.getTradeInfo();

if (!sellsEnabled) {
  const now = Date.now() / 1000;
  const timeLeft = Number(ibrEndTime) - now;
  const days = Math.floor(timeLeft / 86400);
  const hours = Math.floor((timeLeft % 86400) / 3600);

  console.log(`Sells will be enabled in ${days} days and ${hours} hours`);
  console.log(`Exact time: ${new Date(Number(ibrEndTime) * 1000)}`);
}
```

2. **Wait for IBR to end** or **only use buy operations** during this period.

3. **Disable sell button in UI**:
```typescript
<button disabled={!tradeInfo.sellsEnabled}>
  {tradeInfo.sellsEnabled ? "Sell" : `Sells available in ${timeRemaining}`}
</button>
```

### "Trade size exceeds maximum"

**Error Message**:
```
Error: execution reverted: Trade too large
```

**Cause**: The trade exceeds `maxTradeBps` (default 20% of reserve).

**Solution**:

1. **Check max trade size**:
```typescript
const state = await pool.getPoolState();
const maxTradeBps = await pool.maxTradeBps(); // e.g., 2000 = 20%

const maxUSDC = state.reserve * maxTradeBps / 10000n;
console.log(`Max buy: $${ethers.formatUnits(maxUSDC, 6)} USDC`);
```

2. **Split trade** or **wait for reserve to grow** (via fee deposits).

### "Trading paused"

**Error Message**:
```
Error: execution reverted: Pausable: paused
```

**Cause**: The pool owner has paused trading (emergency measure).

**Solution**:

1. **Check pause status**:
```typescript
const [, , isPaused] = await pool.getTradeInfo();

if (isPaused) {
  console.log("Trading is currently paused. Check announcements for updates.");
}
```

2. **Wait for announcement** from the protocol team about when trading will resume.

## Deployment Errors

### "Model already registered"

**Error Message**:
```
Error: execution reverted: Model already registered
```

**Cause**: The model ID is already registered in ModelRegistry.

**Solution**:

1. **Check if model exists**:
```typescript
const isRegistered = await modelRegistry.isRegisteredString(modelId);

if (isRegistered) {
  const tokenAddress = await modelRegistry.getTokenByString(modelId);
  console.log(`Model already has token: ${tokenAddress}`);
}
```

2. **Use a different model ID** or **update the existing registration** (owner only).

### "CRR out of bounds"

**Error Message**:
```
Error: execution reverted: CRR out of bounds
```

**Cause**: CRR must be between 50,000 (5%) and 500,000 (50%) ppm.

**Solution**:

```typescript
// ❌ Wrong
const crr = 1000; // Too low (0.1%)

// ✅ Correct
const crr = 100000; // 10%

// Validation helper
function validateCRR(crr: number): boolean {
  return crr >= 50000 && crr <= 500000;
}
```

### "Trade fee too high"

**Error Message**:
```
Error: execution reverted: Trade fee too high
```

**Cause**: Trade fee exceeds 1,000 bps (10%).

**Solution**:

```typescript
// ❌ Wrong
const tradeFee = 1500; // 15%

// ✅ Correct
const tradeFee = 25; // 0.25%

// Validation
const MAX_TRADE_FEE = 1000; // 10%
if (tradeFee > MAX_TRADE_FEE) {
  throw new Error(`Trade fee ${tradeFee} exceeds maximum ${MAX_TRADE_FEE}`);
}
```

## Fee Collection Errors

### "Pool does not exist"

**Error Message**:
```
Error: execution reverted: Pool does not exist
```

**Cause**: No AMM pool exists for the specified model ID.

**Solution**:

1. **Verify pool exists**:
```typescript
const hasPool = await factory.hasPool(modelId);

if (!hasPool) {
  console.log(`No pool for model ${modelId}. Create pool first.`);
}
```

2. **Create the pool** before depositing fees.

### "Insufficient allowance"

**Error Message**:
```
Error: execution reverted: ERC20: insufficient allowance
```

**Cause**: USDC allowance not granted to the FeeRouter contract.

**Solution**:

```typescript
// 1. Check current allowance
const currentAllowance = await usdc.allowance(
  backendAddress,
  feeRouterAddress
);

console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 6)}`);

// 2. Approve sufficient amount
const depositAmount = parseUSDC("100");

if (currentAllowance < depositAmount) {
  const approveTx = await usdc.approve(feeRouterAddress, depositAmount);
  await approveTx.wait();
  console.log("Approval granted");
}

// 3. Now deposit
await feeRouter.depositFee(modelId, depositAmount);
```

**Pro Tip**: Approve a large amount once to save gas on future deposits:

```typescript
// Approve $1M USDC once
const MAX_UINT256 = ethers.MaxUint256;
await usdc.approve(feeRouterAddress, MAX_UINT256);
```

### "Transfer failed"

**Error Message**:
```
Error: execution reverted: Transfer failed
```

**Cause**: Insufficient USDC balance.

**Solution**:

```typescript
// Check balance before depositing
const balance = await usdc.balanceOf(backendAddress);
const depositAmount = parseUSDC("100");

if (balance < depositAmount) {
  throw new Error(
    `Insufficient balance. Have: ${ethers.formatUnits(balance, 6)}, Need: ${ethers.formatUnits(depositAmount, 6)}`
  );
}

await feeRouter.depositFee(modelId, depositAmount);
```

## Authorization Errors

### "AccessControl: account is missing role"

**Error Message**:
```
Error: execution reverted: AccessControl: account 0x... is missing role 0x...
```

**Cause**: Your address doesn't have the required role.

**Solution**:

1. **Identify required role**:

| Operation | Role | Contract |
|-----------|------|----------|
| Mint/Burn tokens | `MINTER_ROLE` | TokenManager |
| Deposit fees | `FEE_DEPOSITOR_ROLE` | UsageFeeRouter |
| Record contributions | `RECORDER_ROLE` | DataContributionRegistry |
| Verify contributions | `VERIFIER_ROLE` | DataContributionRegistry |
| Update params | `GOV_ROLE` | HokusaiParams |

2. **Check if you have the role**:

```typescript
const FEE_DEPOSITOR_ROLE = ethers.keccak256(
  ethers.toUtf8Bytes("FEE_DEPOSITOR_ROLE")
);

const hasRole = await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, backendAddress);

if (!hasRole) {
  console.log("Missing FEE_DEPOSITOR_ROLE");
  console.log("Contact admin to grant role:");
  console.log(`  await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, "${backendAddress}")`);
}
```

3. **Request role from admin**:

```typescript
// Admin grants role
const FEE_DEPOSITOR_ROLE = ethers.keccak256(
  ethers.toUtf8Bytes("FEE_DEPOSITOR_ROLE")
);

const tx = await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, backendAddress);
await tx.wait();

console.log("Role granted successfully");
```

### "Ownable: caller is not the owner"

**Error Message**:
```
Error: execution reverted: Ownable: caller is not the owner
```

**Cause**: Trying to call an owner-only function without being the owner.

**Solution**:

1. **Check owner**:
```typescript
const owner = await pool.owner();
const caller = await signer.getAddress();

if (owner !== caller) {
  console.log(`Only owner can call this function. Owner: ${owner}, You: ${caller}`);
}
```

2. **Use the correct signer** or **request action from the owner**.

## Gas and Network Issues

### Transaction Underpriced

**Error Message**:
```
Error: transaction underpriced
```

**Cause**: Gas price too low for current network conditions.

**Solution**:

```typescript
// Fetch current gas price
const feeData = await provider.getFeeData();

console.log(`Current gas price: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei`);

// Set higher gas price
const tx = await pool.buy(amount, minOut, user, deadline, {
  maxFeePerGas: feeData.maxFeePerGas * 12n / 10n, // 20% higher
  maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 12n / 10n,
});
```

### Out of Gas

**Error Message**:
```
Error: out of gas
```

**Cause**: Gas limit too low for the operation.

**Solution**:

```typescript
// Estimate gas first
const gasEstimate = await pool.buy.estimateGas(
  amount,
  minOut,
  user,
  deadline
);

console.log(`Estimated gas: ${gasEstimate.toString()}`);

// Add 20% buffer
const gasLimit = gasEstimate * 12n / 10n;

const tx = await pool.buy(amount, minOut, user, deadline, {
  gasLimit,
});
```

### Nonce Too Low

**Error Message**:
```
Error: nonce too low
```

**Cause**: Transaction nonce conflict (transaction already mined with this nonce).

**Solution**:

```typescript
// Get latest nonce
const nonce = await provider.getTransactionCount(signerAddress, "latest");

// Explicitly set nonce
const tx = await pool.buy(amount, minOut, user, deadline, {
  nonce,
});
```

## Debugging Tools

### Transaction Trace Analysis

For failed transactions, examine the trace:

```typescript
// Get transaction receipt
const receipt = await provider.getTransactionReceipt(txHash);

if (receipt.status === 0) {
  console.log("Transaction failed");

  // Get revert reason (if available)
  try {
    const tx = await provider.getTransaction(txHash);
    const result = await provider.call(tx, tx.blockNumber);
  } catch (error: any) {
    console.log("Revert reason:", error.reason);
    console.log("Error data:", error.data);
  }
}
```

### Event Log Analysis

Check events to understand what happened:

```typescript
// Parse transaction logs
const receipt = await tx.wait();

for (const log of receipt.logs) {
  try {
    const parsed = pool.interface.parseLog(log);
    console.log(`Event: ${parsed.name}`);
    console.log(`Args:`, parsed.args);
  } catch (e) {
    // Log from different contract
  }
}
```

### Contract State Inspection

Debug by checking current state:

```typescript
// Check all pool state
const [reserve, supply, price, crr, tradeFee, protocolFee] =
  await pool.getPoolState();

console.log("Pool State:");
console.log(`  Reserve: $${ethers.formatUnits(reserve, 6)}`);
console.log(`  Supply: ${ethers.formatEther(supply)} tokens`);
console.log(`  Price: $${ethers.formatUnits(price, 6)}`);
console.log(`  CRR: ${Number(crr) / 10000}%`);
console.log(`  Trade Fee: ${Number(tradeFee) / 100}%`);
console.log(`  Protocol Fee: ${Number(protocolFee) / 100}%`);

// Check trade info
const [sellsEnabled, ibrEndTime, isPaused] = await pool.getTradeInfo();

console.log("Trade Info:");
console.log(`  Sells Enabled: ${sellsEnabled}`);
console.log(`  IBR End: ${new Date(Number(ibrEndTime) * 1000)}`);
console.log(`  Paused: ${isPaused}`);

// Check roles
const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));
const hasRole = await tokenManager.hasRole(MINTER_ROLE, poolAddress);
console.log(`Pool has MINTER_ROLE: ${hasRole}`);
```

### RPC Error Handling

Handle common RPC provider issues:

```typescript
async function retryRpcCall<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      if (error.code === "NETWORK_ERROR" || error.code === "TIMEOUT") {
        console.log(`RPC error, retry ${i + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)));
      } else {
        throw error;
      }
    }
  }
  throw new Error("Max retries exceeded");
}

// Usage
const state = await retryRpcCall(() => pool.getPoolState());
```

## Gas Optimization Tips

1. **Use batch operations**: `batchDepositFees()` instead of multiple `depositFee()` calls
2. **Call view functions before transactions**: Validate with `calculateBuyImpact()` before calling `buy()`
3. **Set appropriate gas limits**: Don't over-estimate to avoid wasted gas on reverts
4. **Monitor gas prices**: Delay non-urgent transactions during high gas periods
5. **Use multicall for reads**: Fetch multiple pool states in one RPC call

## Common Patterns

### Safe Trade Execution

```typescript
async function safeTrade(
  pool: Contract,
  type: "buy" | "sell",
  amount: bigint,
  slippageBps: number = 100 // 1%
): Promise<string> {
  // 1. Check if trading is allowed
  const [sellsEnabled, , isPaused] = await pool.getTradeInfo();

  if (isPaused) {
    throw new Error("Trading is paused");
  }

  if (type === "sell" && !sellsEnabled) {
    throw new Error("Sells not enabled yet (IBR period)");
  }

  // 2. Calculate expected output and apply slippage
  const preview = type === "buy"
    ? await pool.calculateBuyImpact(amount)
    : await pool.calculateSellImpact(amount);

  const expectedOut = preview[0]; // tokensOut or reserveOut
  const minOut = expectedOut * BigInt(10000 - slippageBps) / 10000n;

  // 3. Set deadline
  const deadline = Math.floor(Date.now() / 1000) + 600; // 10 minutes

  // 4. Execute trade
  const tx = type === "buy"
    ? await pool.buy(amount, minOut, userAddress, deadline)
    : await pool.sell(amount, minOut, userAddress, deadline);

  const receipt = await tx.wait();

  return receipt.hash;
}
```

## Need More Help?

- **Smart Contract Integration**: See [docs/integration/smart-contracts.md](integration/smart-contracts.md)
- **Backend Integration**: See [docs/integration/backend-services.md](integration/backend-services.md)
- **Frontend Integration**: See [docs/integration/frontend-development.md](integration/frontend-development.md)
- **GitHub Issues**: Report bugs at https://github.com/hokusai/hokusai-token/issues
- **Discord**: Join the community for support
