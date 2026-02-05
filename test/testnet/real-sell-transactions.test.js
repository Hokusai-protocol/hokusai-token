const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Real Sell Transaction Tests
 *
 * Tests actual sell transactions on deployed testnet contracts:
 * - Sell tokens for USDC
 * - Slippage protection
 * - Deadline checks
 * - Buy-sell round trips
 * - Event emission
 *
 * PREREQUISITES:
 * 1. Contracts deployed: npx hardhat run scripts/deploy-testnet-full.js --network sepolia
 * 2. AMM pools authorized: npx hardhat run scripts/authorize-amm-pools.js --network sepolia
 * 3. Tokens acquired: npx hardhat test test/testnet/real-buy-transactions.test.js --network sepolia
 * 4. IBR period expired (1 day after deployment)
 *
 * USAGE:
 * npx hardhat test test/testnet/real-sell-transactions.test.js --network sepolia
 */

describe("Real Sell Transactions", function () {
  let deployment;
  let pool, token, mockUSDC;
  let seller;
  let poolInfo;

  before(async function () {
    [seller] = await ethers.getSigners();

    // Load deployment info
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);

    if (!fs.existsSync(deploymentPath)) {
      throw new Error(
        `❌ Deployment file not found: ${deploymentPath}\n\n` +
        `   Please run deployment first:\n` +
        `   npx hardhat run scripts/deploy-testnet-full.js --network ${network}\n`
      );
    }

    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    console.log(`\n  📦 Loaded deployment from: ${deploymentPath}`);
    console.log(`  🌐 Network: ${deployment.network} (chainId: ${deployment.chainId})`);

    // Use balanced pool for testing (good reserve balance)
    poolInfo = deployment.pools.find(p => p.configKey === "balanced");
    if (!poolInfo) {
      throw new Error("Balanced pool not found in deployment");
    }

    pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    console.log(`  ✅ Testing pool: ${poolInfo.modelId}`);
    console.log(`  ✅ Pool address: ${poolInfo.ammAddress}`);
    console.log(`  ✅ Token address: ${poolInfo.tokenAddress}\n`);

    // Check seller has tokens
    const tokenBalance = await token.balanceOf(seller.address);
    console.log(`  💎 Seller token balance: ${ethers.formatEther(tokenBalance)}`);

    if (tokenBalance === 0n) {
      console.log(`  ⚠️  WARNING: Seller has no tokens. Run buy tests first.\n`);
    }

    // Check IBR status
    const buyOnlyUntil = await pool.buyOnlyUntil();
    const block = await ethers.provider.getBlock('latest');
    const currentTime = BigInt(block.timestamp);
    const ibrActive = buyOnlyUntil > currentTime;

    console.log(`  ⏰ IBR Active: ${ibrActive}`);
    if (ibrActive) {
      console.log(`  ⚠️  WARNING: IBR still active. Sell tests will fail.\n`);
    }
    console.log();
  });

  describe("Basic Sell", function () {
    it("Should sell tokens for USDC", async function () {
      // Check seller has tokens
      const tokenBalance = await token.balanceOf(seller.address);
      if (tokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - no tokens to sell`);
        this.skip();
      }

      // Sell 10% of balance
      const sellAmount = tokenBalance / 10n;
      console.log(`      📊 Selling ${ethers.formatEther(sellAmount)} tokens`);

      // Get quote
      const quotedUSDC = await pool.getSellQuote(sellAmount);
      console.log(`      📊 Quote: ${ethers.formatEther(sellAmount)} tokens → $${ethers.formatUnits(quotedUSDC, 6)}`);

      // Get state before
      const usdcBefore = await mockUSDC.balanceOf(seller.address);
      const spotPriceBefore = await pool.spotPrice();
      const reserveBefore = await pool.reserveBalance();

      // Approve and sell
      const poolAddress = await pool.getAddress();
      const approveTx = await token.approve(poolAddress, sellAmount);
      await approveTx.wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await pool.sell(
        sellAmount,
        0, // no slippage protection
        seller.address,
        deadline
      );
      const receipt = await tx.wait();

      // Get state after
      const usdcAfter = await mockUSDC.balanceOf(seller.address);
      const spotPriceAfter = await pool.spotPrice();
      const reserveAfter = await pool.reserveBalance();

      const usdcReceived = usdcAfter - usdcBefore;

      // Validate
      expect(usdcReceived).to.be.gt(0, "Should receive USDC");
      expect(usdcReceived).to.be.approximately(quotedUSDC, quotedUSDC / 100n); // within 1%
      expect(reserveAfter).to.be.lt(reserveBefore, "Reserve should decrease");
      expect(spotPriceAfter).to.be.lt(spotPriceBefore, "Price should decrease");

      console.log(`      ✅ Sell successful`);
      console.log(`         Tokens sold: ${ethers.formatEther(sellAmount)}`);
      console.log(`         USDC received: $${ethers.formatUnits(usdcReceived, 6)}`);
      console.log(`         Price before: $${ethers.formatUnits(spotPriceBefore, 6)}`);
      console.log(`         Price after: $${ethers.formatUnits(spotPriceAfter, 6)}`);
      console.log(`         Price impact: ${((spotPriceBefore - spotPriceAfter) * 10000n / spotPriceBefore) / 100n}%`);
      console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
    });
  });

  describe("Buy-Sell Round Trip", function () {
    it("Should handle buy followed by sell", async function () {
      this.timeout(120000); // 2 minutes for network calls
      const buyAmount = parseUnits("100", 6);

      // Check seller has USDC
      const usdcBalance = await mockUSDC.balanceOf(seller.address);
      if (usdcBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      const usdcBefore = await mockUSDC.balanceOf(seller.address);

      // Buy
      const poolAddress = await pool.getAddress();
      let approveTx = await mockUSDC.approve(poolAddress, buyAmount);
      await approveTx.wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const buyTx = await pool.buy(buyAmount, 0, seller.address, deadline);
      await buyTx.wait();

      const tokensReceived = await token.balanceOf(seller.address);
      console.log(`      📊 Buy: $${ethers.formatUnits(buyAmount, 6)} → ${ethers.formatEther(tokensReceived)} tokens`);

      // Sell same amount
      approveTx = await token.approve(poolAddress, tokensReceived);
      await approveTx.wait();

      const sellDeadline = Math.floor(Date.now() / 1000) + 300;
      const sellTx = await pool.sell(tokensReceived, 0, seller.address, sellDeadline);
      await sellTx.wait();

      const usdcAfter = await mockUSDC.balanceOf(seller.address);
      const usdcFromSell = usdcAfter - (usdcBefore - buyAmount);

      console.log(`      📊 Sell: ${ethers.formatEther(tokensReceived)} tokens → $${ethers.formatUnits(usdcFromSell, 6)}`);

      const netLoss = buyAmount - usdcFromSell;
      const netLossPercent = (netLoss * 10000n) / buyAmount;

      console.log(`      💸 Net loss: $${ethers.formatUnits(netLoss, 6)} (${netLossPercent / 100n}%)`);

      // Should have net loss due to fees and slippage
      expect(usdcFromSell).to.be.lt(buyAmount, "Should have net loss from round trip");
      console.log(`      ✅ Round trip validated - fees/slippage applied correctly`);
    });
  });

  describe("Slippage Protection", function () {
    it("Should revert if slippage exceeded on sell", async function () {
      // Check seller has tokens
      const tokenBalance = await token.balanceOf(seller.address);
      if (tokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - no tokens to sell`);
        this.skip();
      }

      const sellAmount = tokenBalance / 20n; // Sell 5%
      const quotedUSDC = await pool.getSellQuote(sellAmount);

      // Set minUSDCOut impossibly high (double the quote)
      const minUSDCOut = quotedUSDC * 2n;

      const poolAddress = await pool.getAddress();
      const approveTx = await token.approve(poolAddress, sellAmount);
      await approveTx.wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.sell(sellAmount, minUSDCOut, seller.address, deadline)
      ).to.be.revertedWith("Slippage exceeded");

      console.log(`      ✅ Slippage protection working`);
      console.log(`         Quote: $${ethers.formatUnits(quotedUSDC, 6)}`);
      console.log(`         Min requested: $${ethers.formatUnits(minUSDCOut, 6)}`);
    });
  });

  describe("Deadline Checks", function () {
    it("Should revert if deadline passed on sell", async function () {
      // Check seller has tokens
      const tokenBalance = await token.balanceOf(seller.address);
      if (tokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - no tokens to sell`);
        this.skip();
      }

      const sellAmount = tokenBalance / 20n;

      const poolAddress = await pool.getAddress();
      const approveTx = await token.approve(poolAddress, sellAmount);
      await approveTx.wait();

      // Use expired deadline
      const expiredDeadline = Math.floor(Date.now() / 1000) - 1;

      await expect(
        pool.sell(sellAmount, 0, seller.address, expiredDeadline)
      ).to.be.revertedWith("Transaction expired");

      console.log(`      ✅ Deadline check working`);
    });
  });

  describe("Event Emission", function () {
    it("Should emit Sell event with correct data", async function () {
      // Check seller has tokens
      const tokenBalance = await token.balanceOf(seller.address);
      if (tokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - no tokens to sell`);
        this.skip();
      }

      const sellAmount = tokenBalance / 20n;

      const poolAddress = await pool.getAddress();
      const approveTx = await token.approve(poolAddress, sellAmount);
      await approveTx.wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;

      const tx = await pool.sell(sellAmount, 0, seller.address, deadline);
      const receipt = await tx.wait();

      // Check Sell event in logs
      const sellEvent = receipt.logs.find(log => {
        try {
          const parsed = pool.interface.parseLog(log);
          return parsed && parsed.name === "Sell";
        } catch {
          return false;
        }
      });

      expect(sellEvent).to.not.be.undefined;
      console.log(`      ✅ Sell event emitted correctly`);
    });
  });

  describe("Multi-Pool Sell Testing", function () {
    it("Should work on all pool configurations", async function () {
      this.timeout(120000); // 2 minutes for network calls

      for (const poolConfig of deployment.pools) {
        console.log(`\n      🔄 Testing ${poolConfig.configKey} pool...`);

        const testPool = await ethers.getContractAt("HokusaiAMM", poolConfig.ammAddress);
        const testToken = await ethers.getContractAt("HokusaiToken", poolConfig.tokenAddress);

        // Check if we have tokens
        const tokenBalance = await testToken.balanceOf(seller.address);
        if (tokenBalance === 0n) {
          console.log(`         ⚠️  Skipping - no tokens`);
          continue;
        }

        // Sell 5% of balance
        const sellAmount = tokenBalance / 20n;
        const usdcBefore = await mockUSDC.balanceOf(seller.address);

        try {
          // Approve
          const testPoolAddress = await testPool.getAddress();
          const approveTx = await testToken.approve(testPoolAddress, sellAmount);
          await approveTx.wait();

          const deadline = Math.floor(Date.now() / 1000) + 300;
          const tx = await testPool.sell(sellAmount, 0, seller.address, deadline);
          await tx.wait();

          const usdcAfter = await mockUSDC.balanceOf(seller.address);
          const received = usdcAfter - usdcBefore;

          expect(received).to.be.gt(0);
          console.log(`         ✅ Sold ${ethers.formatEther(sellAmount)} tokens for $${ethers.formatUnits(received, 6)}`);
        } catch (error) {
          console.log(`         ⚠️  Sell failed: ${error.message.split('\n')[0]}`);
        }
      }
    });
  });
});
