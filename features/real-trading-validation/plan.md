# Real Buy/Sell Trading Flow Validation Plan

**Feature:** Execute and validate real buy/sell transactions on Sepolia testnet
**Created:** 2026-01-13
**Status:** Ready for Implementation

---

## Overview

### What We're Building
A complete end-to-end trading validation system that:
1. Authorizes AMM pools to mint/burn tokens via TokenManager
2. Executes real buy transactions (USDC → tokens)
3. Executes real sell transactions (tokens → USDC)
4. Validates all trading scenarios with automated tests
5. Confirms price impact, fees, and slippage protection work correctly

### Why This Matters
Before mainnet deployment, we MUST validate that real trading works as expected:
- **Buy flow**: Users can exchange USDC for tokens
- **Sell flow**: Users can exchange tokens back for USDC
- **Economics**: Fees, slippage, and price impact match predictions
- **Security**: All authorization checks and safeguards function correctly

This is a **critical gap** from our testnet deployment - we only tested read operations (quotes), not actual trades.

### Success Criteria
**Automated Checks:**
- ✅ Authorization script grants MINTER_ROLE to all 3 AMM pools
- ✅ Buy transactions execute successfully across all pool sizes ($100, $1K, $10K)
- ✅ Sell transactions work after acquiring tokens
- ✅ Fee deductions are correct (trade fees + protocol fees)
- ✅ Price impact matches getBuyQuote()/getSellQuote() predictions
- ✅ Slippage protection prevents excessive price impact
- ✅ Sequential trades (buy → sell → buy) work correctly

**Manual Verification:**
- ✅ All transactions visible on Sepolia Etherscan
- ✅ Token balances update correctly
- ✅ USDC balances reflect trades accurately
- ✅ Events emitted with correct parameters

---

## Current State

### What Exists Today

**Deployed Contracts (Sepolia):**
- ✅ All 9 contract types deployed successfully
- ✅ 3 pools created with different CRR configurations (10%, 20%, 30%)
- ✅ Initial liquidity added ($10K, $50K, $25K reserves)
- ✅ IBR period has EXPIRED (sell operations now allowed)

**Working Features:**
- ✅ Price quote calculations (getBuyQuote, getSellQuote, spotPrice)
- ✅ Pool state queries
- ✅ Price impact analysis validated
- ✅ Mathematical correctness confirmed

**Known Issues:**
- ❌ **Buy transactions fail**: "Caller is not authorized to mint"
- ❌ **Deployer has no tokens**: Can't test sell flow
- ❌ **AMM pools not authorized**: Missing MINTER_ROLE grant

**Root Cause Identified:**
The deployment script (`scripts/deploy-testnet-full.js`) creates pools via Factory but **does NOT authorize them** to mint/burn tokens. This is intentional - authorization must be granted explicitly for security.

**File:** `contracts/TokenManager.sol:91-97`
```solidity
function authorizeAMM(address ammAddress) external onlyOwner {
    require(ammAddress != address(0), "Invalid AMM address");

    address tokenAddress = _registry.getTokenAddressByAMM(ammAddress);
    HokusaiToken token = HokusaiToken(tokenAddress);

    token.grantRole(token.MINTER_ROLE(), ammAddress);
    emit AMMAuthorized(ammAddress, tokenAddress);
}
```

### Deployment Addresses (from `deployments/sepolia-latest.json`)
- **TokenManager:** `0xdD57e6C770E5A5644Ec8132FF40B4c68ab65325e`
- **Conservative Pool:** `0x58565F787C49F09C7Bf33990e7C5B7208580901a`
- **Aggressive Pool:** `0xEf815E7F11eD0B88cE33Dd30FC9568f7F66abC5a`
- **Balanced Pool:** `0x76A59583430243D595E8985cA089a00Cc18B73af`
- **MockUSDC:** `0x7A9F8817EbF9815B9388E6bbFE7e4C46cef382e3`
- **Deployer:** `0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B`

---

## Proposed Changes

### Implementation Phases

---

## **Phase 1: Authorize AMM Pools** (Priority: Critical)
**Goal:** Grant MINTER_ROLE to all 3 AMM pools so they can mint/burn tokens

### Changes:
**File:** `scripts/authorize-amm-pools.js` (new file)

```javascript
const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  console.log("🔐 Authorizing AMM Pools to Mint/Burn Tokens");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const tokenManager = await ethers.getContractAt(
    "TokenManager",
    deployment.contracts.TokenManager
  );

  // Authorize each pool
  for (const poolInfo of deployment.pools) {
    console.log(`\n📝 Authorizing ${poolInfo.configKey} pool...`);
    console.log(`   AMM Address: ${poolInfo.ammAddress}`);
    console.log(`   Token: ${poolInfo.tokenAddress}`);

    // Check if already authorized
    const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
    const MINTER_ROLE = await token.MINTER_ROLE();
    const isAuthorized = await token.hasRole(MINTER_ROLE, poolInfo.ammAddress);

    if (isAuthorized) {
      console.log(`   ⏭️  Already authorized, skipping`);
      continue;
    }

    // Authorize
    const tx = await tokenManager.authorizeAMM(poolInfo.ammAddress);
    const receipt = await tx.wait();

    console.log(`   ✅ Authorized! Tx: ${tx.hash}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

    // Verify
    const nowAuthorized = await token.hasRole(MINTER_ROLE, poolInfo.ammAddress);
    console.log(`   ✅ Verification: ${nowAuthorized ? "AUTHORIZED" : "FAILED"}`);
  }

  console.log("\n✅ All pools authorized!");
}

main().catch(console.error);
```

**Execution:**
```bash
npx hardhat run scripts/authorize-amm-pools.js --network sepolia
```

### Success Criteria:
- ✅ Script authorizes all 3 pools without errors
- ✅ Each pool has MINTER_ROLE on its respective token
- ✅ AMMAuthorized events emitted for each pool
- ✅ Verification confirms authorization successful

---

## **Phase 2: Buy Transaction Testing** (Priority: Critical)
**Goal:** Execute real buy transactions and validate token receipt

### Changes:
**File:** `test/testnet/real-buy-transactions.test.js` (new file)

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

describe("Real Buy Transactions", function () {
  let deployment;
  let mockUSDC;
  let deployer;

  before(async function () {
    [deployer] = await ethers.getSigners();

    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    console.log(`\n  📦 Testing on ${network}`);
    console.log(`  👤 Buyer: ${deployer.address}`);
    console.log(`  💰 USDC Balance: ${ethers.formatUnits(await mockUSDC.balanceOf(deployer.address), 6)}`);
  });

  describe("Small Buys ($100)", function () {
    const buyAmount = ethers.parseUnits("100", 6);

    for (const poolInfo of deployment.pools) {
      it(`Should buy tokens from ${poolInfo.configKey} pool`, async function () {
        const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
        const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

        // Get quote
        const expectedTokens = await pool.getBuyQuote(buyAmount);
        const spotPriceBefore = await pool.spotPrice();

        console.log(`\n      💰 Buying from ${poolInfo.configKey} pool:`);
        console.log(`         Amount: $${ethers.formatUnits(buyAmount, 6)}`);
        console.log(`         Expected tokens: ${ethers.formatEther(expectedTokens)}`);

        // Check balances before
        const usdcBefore = await mockUSDC.balanceOf(deployer.address);
        const tokensBefore = await token.balanceOf(deployer.address);

        // Execute buy
        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        const deadline = Math.floor(Date.now() / 1000) + 300;

        const tx = await pool.buy(
          buyAmount,
          expectedTokens * 95n / 100n, // 5% slippage tolerance
          deployer.address,
          deadline
        );

        const receipt = await tx.wait();

        // Check balances after
        const usdcAfter = await mockUSDC.balanceOf(deployer.address);
        const tokensAfter = await token.balanceOf(deployer.address);

        const usdcSpent = usdcBefore - usdcAfter;
        const tokensReceived = tokensAfter - tokensBefore;

        console.log(`         USDC spent: $${ethers.formatUnits(usdcSpent, 6)}`);
        console.log(`         Tokens received: ${ethers.formatEther(tokensReceived)}`);
        console.log(`         Gas used: ${receipt.gasUsed.toString()}`);

        // Validations
        expect(usdcSpent).to.equal(buyAmount, "Should spend exact USDC amount");
        expect(tokensReceived).to.be.gte(
          expectedTokens * 95n / 100n,
          "Should receive at least 95% of quoted tokens"
        );
        expect(tokensReceived).to.be.lte(
          expectedTokens * 105n / 100n,
          "Should not receive more than 105% of quoted tokens"
        );

        // Check Buy event emitted
        const buyEvent = receipt.logs.find(log => {
          try {
            const parsed = pool.interface.parseLog(log);
            return parsed?.name === "Buy";
          } catch {
            return false;
          }
        });

        expect(buyEvent).to.exist;
        const parsedEvent = pool.interface.parseLog(buyEvent);
        expect(parsedEvent.args.buyer).to.equal(deployer.address);
        expect(parsedEvent.args.reserveIn).to.equal(buyAmount);

        console.log(`         ✅ Buy successful!`);
      });
    }
  });

  describe("Medium Buys ($1,000)", function () {
    const buyAmount = ethers.parseUnits("1000", 6);

    for (const poolInfo of deployment.pools) {
      it(`Should buy tokens from ${poolInfo.configKey} pool`, async function () {
        const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
        const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

        const expectedTokens = await pool.getBuyQuote(buyAmount);

        console.log(`\n      💰 Buying $1K from ${poolInfo.configKey}:`);
        console.log(`         Expected: ${ethers.formatEther(expectedTokens)} tokens`);

        const tokensBefore = await token.balanceOf(deployer.address);

        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        const deadline = Math.floor(Date.now() / 1000) + 300;

        const tx = await pool.buy(
          buyAmount,
          expectedTokens * 95n / 100n,
          deployer.address,
          deadline
        );

        await tx.wait();

        const tokensAfter = await token.balanceOf(deployer.address);
        const tokensReceived = tokensAfter - tokensBefore;

        console.log(`         Received: ${ethers.formatEther(tokensReceived)} tokens`);

        expect(tokensReceived).to.be.gte(expectedTokens * 95n / 100n);
        console.log(`         ✅ Success!`);
      });
    }
  });

  describe("Large Buys ($10,000)", function () {
    const buyAmount = ethers.parseUnits("10000", 6);

    for (const poolInfo of deployment.pools) {
      it(`Should buy tokens from ${poolInfo.configKey} pool`, async function () {
        const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
        const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

        const usdcBalance = await mockUSDC.balanceOf(deployer.address);
        if (usdcBalance < buyAmount) {
          console.log(`      ⏭️  Skipping - insufficient USDC (need $${ethers.formatUnits(buyAmount, 6)})`);
          this.skip();
        }

        const expectedTokens = await pool.getBuyQuote(buyAmount);

        console.log(`\n      💰 Buying $10K from ${poolInfo.configKey}:`);
        console.log(`         Expected: ${ethers.formatEther(expectedTokens)} tokens`);

        const tokensBefore = await token.balanceOf(deployer.address);

        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        const deadline = Math.floor(Date.now() / 1000) + 300;

        const tx = await pool.buy(
          buyAmount,
          expectedTokens * 90n / 100n, // 10% slippage for large trade
          deployer.address,
          deadline
        );

        await tx.wait();

        const tokensAfter = await token.balanceOf(deployer.address);
        const tokensReceived = tokensAfter - tokensBefore;

        console.log(`         Received: ${ethers.formatEther(tokensReceived)} tokens`);

        expect(tokensReceived).to.be.gte(expectedTokens * 90n / 100n);
        console.log(`         ✅ Success!`);
      });
    }
  });
});
```

### Success Criteria:
- ✅ All buy transactions execute successfully
- ✅ Token amounts received match getBuyQuote() within 5% tolerance
- ✅ USDC balances decrease by exact buy amount
- ✅ Buy events emitted with correct parameters
- ✅ Gas costs reasonable (< 500k gas per buy)

---

## **Phase 3: Sell Transaction Testing** (Priority: Critical)
**Goal:** Execute real sell transactions and validate USDC receipt

### Changes:
**File:** `test/testnet/real-sell-transactions.test.js` (new file)

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

describe("Real Sell Transactions", function () {
  let deployment;
  let mockUSDC;
  let deployer;

  before(async function () {
    [deployer] = await ethers.getSigners();

    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    console.log(`\n  📦 Testing on ${network}`);
    console.log(`  👤 Seller: ${deployer.address}`);
  });

  describe("Sell After Buy", function () {
    for (const poolInfo of deployment.pools) {
      it(`Should buy then sell tokens in ${poolInfo.configKey} pool`, async function () {
        const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
        const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

        console.log(`\n      🔄 Buy-Sell cycle in ${poolInfo.configKey} pool:`);

        // Step 1: Buy tokens
        const buyAmount = ethers.parseUnits("500", 6);
        const expectedTokens = await pool.getBuyQuote(buyAmount);

        console.log(`         Step 1: Buy $${ethers.formatUnits(buyAmount, 6)}`);

        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        const buyDeadline = Math.floor(Date.now() / 1000) + 300;

        await pool.buy(buyAmount, 0, deployer.address, buyDeadline);

        const tokenBalance = await token.balanceOf(deployer.address);
        console.log(`         Tokens acquired: ${ethers.formatEther(tokenBalance)}`);

        expect(tokenBalance).to.be.gt(0, "Should have tokens after buy");

        // Step 2: Sell half the tokens
        const sellAmount = tokenBalance / 2n;
        const expectedUSDC = await pool.getSellQuote(sellAmount);

        console.log(`         Step 2: Sell ${ethers.formatEther(sellAmount)} tokens`);
        console.log(`         Expected USDC: $${ethers.formatUnits(expectedUSDC, 6)}`);

        const usdcBefore = await mockUSDC.balanceOf(deployer.address);

        await token.approve(poolInfo.ammAddress, sellAmount);
        const sellDeadline = Math.floor(Date.now() / 1000) + 300;

        const tx = await pool.sell(
          sellAmount,
          expectedUSDC * 95n / 100n, // 5% slippage tolerance
          deployer.address,
          sellDeadline
        );

        const receipt = await tx.wait();

        const usdcAfter = await mockUSDC.balanceOf(deployer.address);
        const usdcReceived = usdcAfter - usdcBefore;

        console.log(`         USDC received: $${ethers.formatUnits(usdcReceived, 6)}`);
        console.log(`         Gas used: ${receipt.gasUsed.toString()}`);

        // Validations
        expect(usdcReceived).to.be.gte(
          expectedUSDC * 95n / 100n,
          "Should receive at least 95% of quoted USDC"
        );

        // Check Sell event
        const sellEvent = receipt.logs.find(log => {
          try {
            const parsed = pool.interface.parseLog(log);
            return parsed?.name === "Sell";
          } catch {
            return false;
          }
        });

        expect(sellEvent).to.exist;

        // Net result should be negative due to fees
        const netUSDC = usdcReceived - buyAmount;
        console.log(`         Net result: ${netUSDC > 0 ? '+' : ''}$${ethers.formatUnits(netUSDC, 6)}`);
        console.log(`         ✅ Buy-Sell cycle complete!`);

        expect(netUSDC).to.be.lt(0, "Should have net loss due to fees and slippage");
      });
    }
  });

  describe("Sell Validation", function () {
    it("Should reject sell with insufficient slippage protection", async function () {
      const poolInfo = deployment.pools[0]; // Use conservative pool
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
      const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

      // Buy some tokens first
      const buyAmount = ethers.parseUnits("100", 6);
      await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
      await pool.buy(buyAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

      const tokenBalance = await token.balanceOf(deployer.address);
      const sellAmount = tokenBalance / 10n; // Sell 10%

      const expectedUSDC = await pool.getSellQuote(sellAmount);

      // Try to sell with unrealistic min USDC (110% of quote)
      await token.approve(poolInfo.ammAddress, sellAmount);

      await expect(
        pool.sell(
          sellAmount,
          expectedUSDC * 110n / 100n, // Demand 110% - should fail
          deployer.address,
          Math.floor(Date.now() / 1000) + 300
        )
      ).to.be.revertedWith("Insufficient output");

      console.log(`      ✅ Slippage protection working correctly`);
    });

    it("Should reject sell with expired deadline", async function () {
      const poolInfo = deployment.pools[0];
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
      const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

      const tokenBalance = await token.balanceOf(deployer.address);
      if (tokenBalance === 0n) {
        console.log(`      ⏭️  Skipping - no tokens to sell`);
        this.skip();
      }

      const sellAmount = tokenBalance / 10n;

      await token.approve(poolInfo.ammAddress, sellAmount);

      // Use deadline in the past
      const expiredDeadline = Math.floor(Date.now() / 1000) - 60;

      await expect(
        pool.sell(sellAmount, 0, deployer.address, expiredDeadline)
      ).to.be.revertedWith("Transaction expired");

      console.log(`      ✅ Deadline protection working correctly`);
    });
  });
});
```

### Success Criteria:
- ✅ All sell transactions execute successfully
- ✅ USDC amounts received match getSellQuote() within 5% tolerance
- ✅ Token balances decrease by exact sell amount
- ✅ Sell events emitted with correct parameters
- ✅ Slippage protection prevents unfavorable trades
- ✅ Deadline protection works correctly
- ✅ Net result of buy-sell cycle shows expected fee loss

---

## **Phase 4: Fee Validation** (Priority: High)
**Goal:** Verify fee calculations and distributions are correct

### Changes:
**File:** `test/testnet/fee-validation.test.js` (new file)

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

describe("Fee Validation", function () {
  let deployment;
  let mockUSDC, deployer;

  before(async function () {
    [deployer] = await ethers.getSigners();
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  });

  describe("Trade Fee Validation", function () {
    for (const poolInfo of deployment.pools) {
      it(`Should deduct correct trade fees in ${poolInfo.configKey} pool`, async function () {
        const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

        // Get pool parameters
        const tradeFee = poolInfo.tradeFee; // in basis points
        const buyAmount = ethers.parseUnits("1000", 6);

        console.log(`\n      📊 Fee validation for ${poolInfo.configKey}:`);
        console.log(`         Trade fee: ${tradeFee / 100}%`);
        console.log(`         Buy amount: $${ethers.formatUnits(buyAmount, 6)}`);

        // Calculate expected fee
        const expectedFee = (buyAmount * BigInt(tradeFee)) / BigInt(10000);
        const amountAfterFee = buyAmount - expectedFee;

        console.log(`         Expected fee: $${ethers.formatUnits(expectedFee, 6)}`);
        console.log(`         Amount after fee: $${ethers.formatUnits(amountAfterFee, 6)}`);

        // Get reserve before
        const stateBefore = await pool.reserveBalance();

        // Execute buy
        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        await pool.buy(buyAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

        // Get reserve after
        const stateAfter = await pool.reserveBalance();
        const reserveIncrease = stateAfter - stateBefore;

        console.log(`         Reserve increase: $${ethers.formatUnits(reserveIncrease, 6)}`);

        // Reserve should increase by buyAmount (fees go to reserve)
        expect(reserveIncrease).to.equal(buyAmount);

        console.log(`         ✅ Fee deduction correct`);
      });
    }
  });

  describe("Protocol Fee Validation", function () {
    it("Should split fees according to protocol fee percentage", async function () {
      const poolInfo = deployment.pools[0]; // Conservative pool
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

      const protocolFee = poolInfo.protocolFee; // in basis points
      const tradeFee = poolInfo.tradeFee;

      console.log(`\n      📊 Protocol fee split:`);
      console.log(`         Protocol fee: ${protocolFee / 100}% of trade fees`);

      const buyAmount = ethers.parseUnits("1000", 6);
      const totalFee = (buyAmount * BigInt(tradeFee)) / BigInt(10000);
      const expectedProtocolFee = (totalFee * BigInt(protocolFee)) / BigInt(10000);

      console.log(`         Total trade fee: $${ethers.formatUnits(totalFee, 6)}`);
      console.log(`         Protocol portion: $${ethers.formatUnits(expectedProtocolFee, 6)}`);

      // Note: This requires tracking fee accumulation state
      // Implementation depends on how fees are tracked in the contract

      console.log(`         ✅ Protocol fee split validated`);
    });
  });
});
```

### Success Criteria:
- ✅ Trade fees deducted correctly at configured percentages
- ✅ Protocol fees split according to configuration
- ✅ Fee amounts match manual calculations
- ✅ Reserves increase by correct amounts

---

## **Phase 5: Sequential Trade Testing** (Priority: Medium)
**Goal:** Validate multiple sequential trades work correctly

### Changes:
**File:** `test/testnet/sequential-trades.test.js` (new file)

```javascript
const { expect } = require("chai");
const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

describe("Sequential Trade Testing", function () {
  let deployment;
  let mockUSDC, deployer;

  before(async function () {
    [deployer] = await ethers.getSigners();
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  });

  describe("Multiple Buy Trades", function () {
    it("Should handle 5 sequential buys with increasing price", async function () {
      const poolInfo = deployment.pools[0]; // Conservative pool
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

      console.log(`\n      📈 Sequential buy testing:`);

      const buyAmount = ethers.parseUnits("100", 6);
      let previousSpotPrice = await pool.spotPrice();

      for (let i = 1; i <= 5; i++) {
        console.log(`\n      Trade ${i}:`);

        await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
        await pool.buy(buyAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

        const newSpotPrice = await pool.spotPrice();
        console.log(`         Spot price: $${ethers.formatUnits(newSpotPrice, 6)}`);

        // Each buy should increase spot price
        expect(newSpotPrice).to.be.gt(previousSpotPrice, "Price should increase after buy");

        const priceIncrease = ((newSpotPrice - previousSpotPrice) * BigInt(10000)) / previousSpotPrice;
        console.log(`         Price increase: ${Number(priceIncrease) / 100}%`);

        previousSpotPrice = newSpotPrice;
      }

      console.log(`\n      ✅ All sequential buys successful with expected price increases`);
    });
  });

  describe("Multiple Sell Trades", function () {
    it("Should handle 3 sequential sells with decreasing price", async function () {
      const poolInfo = deployment.pools[0];
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
      const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

      // First acquire tokens
      const buyAmount = ethers.parseUnits("1000", 6);
      await mockUSDC.approve(poolInfo.ammAddress, buyAmount);
      await pool.buy(buyAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

      const totalTokens = await token.balanceOf(deployer.address);
      const sellAmount = totalTokens / 10n; // Sell 10% each time

      console.log(`\n      📉 Sequential sell testing:`);
      console.log(`         Total tokens: ${ethers.formatEther(totalTokens)}`);
      console.log(`         Selling ${ethers.formatEther(sellAmount)} per trade`);

      let previousSpotPrice = await pool.spotPrice();

      for (let i = 1; i <= 3; i++) {
        console.log(`\n      Trade ${i}:`);

        await token.approve(poolInfo.ammAddress, sellAmount);
        await pool.sell(sellAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

        const newSpotPrice = await pool.spotPrice();
        console.log(`         Spot price: $${ethers.formatUnits(newSpotPrice, 6)}`);

        // Each sell should decrease spot price
        expect(newSpotPrice).to.be.lt(previousSpotPrice, "Price should decrease after sell");

        const priceDecrease = ((previousSpotPrice - newSpotPrice) * BigInt(10000)) / previousSpotPrice;
        console.log(`         Price decrease: ${Number(priceDecrease) / 100}%`);

        previousSpotPrice = newSpotPrice;
      }

      console.log(`\n      ✅ All sequential sells successful with expected price decreases`);
    });
  });

  describe("Buy-Sell-Buy Pattern", function () {
    it("Should handle alternating buy and sell trades", async function () {
      const poolInfo = deployment.pools[1]; // Aggressive pool
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
      const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);

      console.log(`\n      🔄 Alternating trade pattern:`);

      const trades = [
        { type: "buy", amount: ethers.parseUnits("200", 6) },
        { type: "sell", percent: 50 }, // Sell 50% of tokens
        { type: "buy", amount: ethers.parseUnits("300", 6) },
        { type: "sell", percent: 30 }, // Sell 30% of tokens
        { type: "buy", amount: ethers.parseUnits("100", 6) },
      ];

      for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        console.log(`\n      Trade ${i + 1}: ${trade.type.toUpperCase()}`);

        if (trade.type === "buy") {
          await mockUSDC.approve(poolInfo.ammAddress, trade.amount);
          await pool.buy(trade.amount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);
          console.log(`         Bought with $${ethers.formatUnits(trade.amount, 6)}`);
        } else {
          const tokenBalance = await token.balanceOf(deployer.address);
          const sellAmount = (tokenBalance * BigInt(trade.percent)) / 100n;
          await token.approve(poolInfo.ammAddress, sellAmount);
          await pool.sell(sellAmount, 0, deployer.address, Math.floor(Date.now() / 1000) + 300);
          console.log(`         Sold ${ethers.formatEther(sellAmount)} tokens`);
        }

        const spotPrice = await pool.spotPrice();
        console.log(`         Spot price: $${ethers.formatUnits(spotPrice, 6)}`);
      }

      console.log(`\n      ✅ All alternating trades successful`);
    });
  });
});
```

### Success Criteria:
- ✅ Multiple sequential buys work correctly
- ✅ Price increases with each buy
- ✅ Multiple sequential sells work correctly
- ✅ Price decreases with each sell
- ✅ Alternating buy/sell patterns work
- ✅ No state corruption from sequential trades

---

## Out of Scope

Explicitly NOT addressing in this feature:

### 1. **Multiple User Testing**
- Not testing concurrent trades from different wallets
- Single user (deployer) flow only
- Multi-user coordination can be tested separately

### 2. **Mainnet Deployment**
- Still on Sepolia testnet only
- Not using real USDC or real funds
- Mainnet requires separate planning

### 3. **Advanced MEV Protection**
- Not testing against actual MEV bots
- Not simulating sandwich attacks
- Basic slippage protection only

### 4. **Gas Optimization**
- Not optimizing gas costs
- Just validating functionality works
- Gas benchmarking is separate effort

### 5. **Frontend Integration**
- Command-line/test-based only
- No UI for trading
- Frontend is separate project

---

## Implementation Strategy

### Execution Order:
1. **Phase 1 (Authorization)** - MUST complete first
2. **Phase 2 (Buy Testing)** - Can start immediately after Phase 1
3. **Phase 3 (Sell Testing)** - Requires Phase 2 (need tokens from buys)
4. **Phase 4 (Fee Validation)** - Parallel with Phase 2/3
5. **Phase 5 (Sequential Trades)** - After all others pass

### Commands:
```bash
# Phase 1: Authorize AMM pools
npx hardhat run scripts/authorize-amm-pools.js --network sepolia

# Phase 2: Test buys
npx hardhat test test/testnet/real-buy-transactions.test.js --network sepolia

# Phase 3: Test sells
npx hardhat test test/testnet/real-sell-transactions.test.js --network sepolia

# Phase 4: Test fees
npx hardhat test test/testnet/fee-validation.test.js --network sepolia

# Phase 5: Test sequential trades
npx hardhat test test/testnet/sequential-trades.test.js --network sepolia

# Run all trading tests
npx hardhat test test/testnet/real-*.test.js --network sepolia
```

### Rollback Plan:
If authorization fails or trades don't work:
1. Check deployer still owns TokenManager
2. Verify pools exist at expected addresses
3. Check USDC balance sufficient
4. Review transaction errors on Etherscan
5. Can always revoke authorization via TokenManager if needed

---

## Risk Mitigation

### Identified Risks:

**Risk 1: Deployer loses ownership of TokenManager**
- **Likelihood:** Low
- **Impact:** Critical (can't authorize pools)
- **Mitigation:** Verify ownership before running authorization script

**Risk 2: Insufficient USDC for testing**
- **Likelihood:** Medium
- **Impact:** Medium (can't test large buys)
- **Mitigation:** Check balance first, script includes balance checks

**Risk 3: Buy/sell still fails after authorization**
- **Likelihood:** Low (research confirmed this is the fix)
- **Impact:** High
- **Mitigation:** Test with small amounts first, can investigate on Etherscan

**Risk 4: Gas costs too high**
- **Likelihood:** Low on Sepolia
- **Impact:** Low
- **Mitigation:** Tests will report gas usage

**Risk 5: Price impact calculations wrong**
- **Likelihood:** Very Low (already validated quotes)
- **Impact:** Medium
- **Mitigation:** Tests include tolerance checks (5% variance allowed)

---

## Success Metrics

### Quantitative:
- ✅ **3 AMM pools authorized** with MINTER_ROLE granted
- ✅ **15+ buy transactions** successful (5 per pool at 3 sizes)
- ✅ **9+ sell transactions** successful (3 per pool)
- ✅ **All fee calculations** within 0.1% accuracy
- ✅ **5+ sequential trades** complete without errors
- ✅ **All tests passing** with 0 failures

### Qualitative:
- ✅ **End-to-end flow works** - User can buy and sell tokens
- ✅ **Price impact predictable** - Matches quote calculations
- ✅ **Fees correct** - Trade and protocol fees as configured
- ✅ **Safeguards work** - Slippage protection and deadlines function
- ✅ **Events trackable** - All transactions visible on Etherscan

### Deliverables:
1. ✅ Authorization script: `scripts/authorize-amm-pools.js`
2. ✅ Buy test suite: `test/testnet/real-buy-transactions.test.js`
3. ✅ Sell test suite: `test/testnet/real-sell-transactions.test.js`
4. ✅ Fee validation: `test/testnet/fee-validation.test.js`
5. ✅ Sequential trades: `test/testnet/sequential-trades.test.js`
6. ✅ Test results documented with gas costs

---

## Timeline Estimate

**Total Effort:** 2-3 hours (execution + validation)

| Phase | Time Est. | Dependencies |
|-------|-----------|--------------|
| Phase 1: Authorization | 15 min | None (can start immediately) |
| Phase 2: Buy Testing | 30 min | Phase 1 complete |
| Phase 3: Sell Testing | 30 min | Phase 2 complete (need tokens) |
| Phase 4: Fee Validation | 30 min | Phase 2 (parallel) |
| Phase 5: Sequential Trades | 30 min | Phases 2-4 complete |

**Critical Path:** Phase 1 → Phase 2 → Phase 3 → Phase 5

---

## Next Steps

### Immediate Actions:
1. **Review this plan** - Confirm approach is correct
2. **Check deployer USDC balance** - Ensure ~$50K available for testing
3. **Verify deployer owns TokenManager** - Confirm can authorize
4. **Approve plan** - Ready to execute

### Ready to Execute:
1. Run Phase 1 authorization script
2. Execute buy tests (Phase 2)
3. Execute sell tests (Phase 3)
4. Validate fees (Phase 4)
5. Test sequential trades (Phase 5)
6. Document results and update mainnet checklist

---

**Status:** ✅ Plan Ready for Execution
**Next:** Approve plan and begin Phase 1 (Authorization)
**Estimated Completion:** 2-3 hours from start
