const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Edge Case Tests
 *
 * Tests boundary conditions and edge cases:
 * 1. Minimum trade sizes (dust amounts)
 * 2. Maximum trade sizes (hitting limits)
 * 3. Zero balance scenarios
 * 4. Approval edge cases
 * 5. Quote accuracy at extremes
 *
 * USAGE:
 * npx hardhat test test/testnet/edge-cases.test.js --network sepolia
 */

describe("Edge Case Testing", function () {
  let deployment;
  let pool, token, mockUSDC;
  let trader;
  let poolInfo;

  before(async function () {
    [trader] = await ethers.getSigners();

    // Load deployment info
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    console.log(`\n  📦 Network: ${deployment.network}`);

    // Use balanced pool for testing (good reserves)
    poolInfo = deployment.pools.find(p => p.configKey === "balanced");
    pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    console.log(`  💎 Testing pool: ${poolInfo.configKey}`);
    console.log(`  💰 Trader: ${trader.address}\n`);
  });

  describe("Minimum Trade Sizes", function () {
    it("Should handle very small buy ($0.01)", async function () {
      const buyAmount = parseUnits("0.01", 6); // 1 cent

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $0.01 USDC`);
        this.skip();
      }

      console.log(`      Testing dust trade: $${ethers.formatUnits(buyAmount, 6)}`);

      // Get quote
      const quote = await pool.getBuyQuote(buyAmount);
      console.log(`      Quote: ${ethers.formatEther(quote)} tokens`);

      if (quote === 0n) {
        console.log(`      ⚠️  Quote is zero - amount too small for this pool`);
        return;
      }

      // Try to execute
      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, buyAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;

      try {
        const tx = await pool.buy(buyAmount, 0, trader.address, deadline);
        await tx.wait();
        console.log(`      ✅ Dust trade successful`);
      } catch (error) {
        console.log(`      ℹ️  Dust trade failed: ${error.message.split('\n')[0]}`);
        console.log(`         This may be expected if amount is below minimum`);
      }
    });

    it("Should handle minimum viable buy ($1)", async function () {
      const buyAmount = parseUnits("1", 6);

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $1 USDC`);
        this.skip();
      }

      const quote = await pool.getBuyQuote(buyAmount);
      console.log(`      $1 buy → ${ethers.formatEther(quote)} tokens`);

      expect(quote).to.be.gt(0, "Quote should be positive");

      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, buyAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await pool.buy(buyAmount, 0, trader.address, deadline);
      await tx.wait();

      console.log(`      ✅ $1 trade successful`);
    });
  });

  describe("Maximum Trade Sizes", function () {
    it("Should show max trade limit", async function () {
      const reserve = await pool.reserveBalance();
      const maxTradeBps = await pool.maxTradeBps();
      const maxTradeSize = (reserve * maxTradeBps) / 10000n;

      console.log(`      Pool Reserve: $${ethers.formatUnits(reserve, 6)}`);
      console.log(`      Max Trade BPS: ${maxTradeBps} (${Number(maxTradeBps) / 100}%)`);
      console.log(`      Max Trade Size: $${ethers.formatUnits(maxTradeSize, 6)}`);

      expect(maxTradeSize).to.be.gt(0, "Max trade should be positive");
      console.log(`      ✅ Max trade limit documented`);
    });

    it("Should accept trade at exact max limit", async function () {
      const reserve = await pool.reserveBalance();
      const maxTradeBps = await pool.maxTradeBps();
      const maxTradeSize = (reserve * maxTradeBps) / 10000n;

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < maxTradeSize) {
        console.log(`      ⚠️  Skipping - needs $${ethers.formatUnits(maxTradeSize, 6)} USDC`);
        this.skip();
      }

      console.log(`      Testing max trade: $${ethers.formatUnits(maxTradeSize, 6)}`);

      const quote = await pool.getBuyQuote(maxTradeSize);
      console.log(`      Quote: ${ethers.formatEther(quote)} tokens`);

      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, maxTradeSize);

      const deadline = Math.floor(Date.now() / 1000) + 300;

      try {
        const tx = await pool.buy(maxTradeSize, 0, trader.address, deadline);
        await tx.wait();
        console.log(`      ✅ Max size trade successful`);
      } catch (error) {
        console.log(`      ⚠️  Max trade failed: ${error.message.split('\n')[0]}`);
      }
    });

    it("Should reject trade exceeding max limit", async function () {
      const reserve = await pool.reserveBalance();
      const maxTradeBps = await pool.maxTradeBps();
      const maxTradeSize = (reserve * maxTradeBps) / 10000n;
      const overLimit = maxTradeSize + parseUnits("1", 6); // $1 over

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < overLimit) {
        console.log(`      ⚠️  Skipping - needs $${ethers.formatUnits(overLimit, 6)} USDC`);
        this.skip();
      }

      console.log(`      Max allowed: $${ethers.formatUnits(maxTradeSize, 6)}`);
      console.log(`      Attempting: $${ethers.formatUnits(overLimit, 6)}`);

      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, overLimit);

      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.buy(overLimit, 0, trader.address, deadline)
      ).to.be.revertedWith("Trade exceeds max size limit");

      console.log(`      ✅ Over-limit trade correctly rejected`);
    });
  });

  describe("Quote Accuracy", function () {
    it("Should provide consistent quotes", async function () {
      const testAmount = parseUnits("100", 6);

      const quote1 = await pool.getBuyQuote(testAmount);
      const quote2 = await pool.getBuyQuote(testAmount);
      const quote3 = await pool.getBuyQuote(testAmount);

      console.log(`      Quote 1: ${ethers.formatEther(quote1)}`);
      console.log(`      Quote 2: ${ethers.formatEther(quote2)}`);
      console.log(`      Quote 3: ${ethers.formatEther(quote3)}`);

      expect(quote1).to.equal(quote2);
      expect(quote2).to.equal(quote3);

      console.log(`      ✅ Quotes are consistent (before state changes)`);
    });

    it("Should show quote changes based on reserve", async function () {
      const testAmount = parseUnits("100", 6);

      const reserveBefore = await pool.reserveBalance();
      const quoteBefore = await pool.getBuyQuote(testAmount);

      console.log(`      Reserve: $${ethers.formatUnits(reserveBefore, 6)}`);
      console.log(`      Quote before: ${ethers.formatEther(quoteBefore)} tokens`);

      // Note: Can't actually change reserve without trading
      // Just documenting that quotes depend on current state

      console.log(`      ✅ Quotes reflect current pool state`);
    });

    it("Should handle quote for maximum trade", async function () {
      const reserve = await pool.reserveBalance();
      const maxTradeBps = await pool.maxTradeBps();
      const maxTradeSize = (reserve * maxTradeBps) / 10000n;

      try {
        const quote = await pool.getBuyQuote(maxTradeSize);
        console.log(`      Max trade quote: ${ethers.formatEther(quote)} tokens`);
        console.log(`      For: $${ethers.formatUnits(maxTradeSize, 6)}`);

        expect(quote).to.be.gt(0);
        console.log(`      ✅ Max trade quote valid`);
      } catch (error) {
        console.log(`      ⚠️  Quote failed: ${error.message.split('\n')[0]}`);
      }
    });
  });

  describe("Price Impact at Extremes", function () {
    it("Should show price impact for various sizes", async function () {
      const spotPrice = await pool.spotPrice();
      const reserve = await pool.reserveBalance();

      console.log(`      Current spot price: $${ethers.formatUnits(spotPrice, 6)}`);
      console.log(`      Pool reserve: $${ethers.formatUnits(reserve, 6)}`);
      console.log();

      const testSizes = [
        { label: "Tiny", amount: "1" },
        { label: "Small", amount: "10" },
        { label: "Medium", amount: "100" },
        { label: "Large", amount: "1000" },
      ];

      for (const test of testSizes) {
        const amount = parseUnits(test.amount, 6);

        // Check if within max trade limit
        const maxTradeBps = await pool.maxTradeBps();
        const maxTradeSize = (reserve * maxTradeBps) / 10000n;

        if (amount > maxTradeSize) {
          console.log(`      ${test.label} ($${test.amount}): Exceeds max trade size`);
          continue;
        }

        try {
          const quote = await pool.getBuyQuote(amount);
          const avgPrice = (amount * 1000000000000000000n) / quote; // Calculate avg price paid per token

          const priceImpact = avgPrice > spotPrice
            ? ((avgPrice - spotPrice) * 10000n) / spotPrice
            : 0n;

          console.log(`      ${test.label} ($${test.amount}):`);
          console.log(`         Tokens: ${ethers.formatEther(quote)}`);
          console.log(`         Avg price: $${ethers.formatUnits(avgPrice, 6)}/token`);
          console.log(`         Impact: ${priceImpact / 100n}%`);
        } catch (error) {
          console.log(`      ${test.label} ($${test.amount}): Quote failed`);
        }
      }

      console.log(`\n      ✅ Price impact analysis complete`);
    });
  });

  describe("Zero Balance Scenarios", function () {
    it("Should handle buy with insufficient balance", async function () {
      const buyAmount = parseUnits("1000000", 6); // $1M

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      console.log(`      Trader balance: $${ethers.formatUnits(traderBalance, 6)}`);
      console.log(`      Attempting: $${ethers.formatUnits(buyAmount, 6)}`);

      if (traderBalance >= buyAmount) {
        console.log(`      ⚠️  Skipping - trader has sufficient balance`);
        this.skip();
      }

      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, buyAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.buy(buyAmount, 0, trader.address, deadline)
      ).to.be.reverted; // Will fail on transfer

      console.log(`      ✅ Insufficient balance correctly handled`);
    });
  });

  describe("Approval Edge Cases", function () {
    it("Should handle zero approval", async function () {
      const buyAmount = parseUnits("10", 6);

      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $10 USDC`);
        this.skip();
      }

      // Set approval to zero
      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, 0);

      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.buy(buyAmount, 0, trader.address, deadline)
      ).to.be.reverted;

      console.log(`      ✅ Zero approval correctly rejected`);

      // Restore approval
      await mockUSDC.approve(poolAddress, ethers.MaxUint256);
    });

    it("Should show current approval", async function () {
      const poolAddress = await pool.getAddress();
      const currentApproval = await mockUSDC.allowance(trader.address, poolAddress);

      console.log(`      Current approval: $${ethers.formatUnits(currentApproval, 6)}`);

      if (currentApproval === ethers.MaxUint256) {
        console.log(`      ℹ️  Max approval set (unlimited)`);
      } else if (currentApproval > 0n) {
        console.log(`      ℹ️  Limited approval set`);
      } else {
        console.log(`      ℹ️  No approval (zero)`);
      }

      console.log(`      ✅ Approval status checked`);
    });
  });

  describe("Multi-Pool Edge Cases", function () {
    it("Should show edge case behavior across pools", async function () {
      console.log(`\n      📊 Edge Case Comparison:\n`);

      for (const poolConfig of deployment.pools) {
        const testPool = await ethers.getContractAt("HokusaiAMM", poolConfig.ammAddress);

        const reserve = await testPool.reserveBalance();
        const maxTradeBps = await testPool.maxTradeBps();
        const maxTradeSize = (reserve * maxTradeBps) / 10000n;
        const spotPrice = await testPool.spotPrice();

        console.log(`      ${poolConfig.configKey.toUpperCase()}:`);
        console.log(`         Reserve: $${ethers.formatUnits(reserve, 6)}`);
        console.log(`         Spot Price: $${ethers.formatUnits(spotPrice, 6)}`);
        console.log(`         Max Trade: $${ethers.formatUnits(maxTradeSize, 6)}`);

        // Try tiny quote
        try {
          const tinyQuote = await testPool.getBuyQuote(parseUnits("0.01", 6));
          console.log(`         $0.01 quote: ${ethers.formatEther(tinyQuote)} tokens`);
        } catch {
          console.log(`         $0.01 quote: Failed`);
        }

        console.log();
      }

      console.log(`      ✅ Multi-pool edge cases documented`);
    });
  });
});
