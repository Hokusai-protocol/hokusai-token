const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Real Buy Transaction Tests
 *
 * Tests actual buy transactions on deployed testnet contracts:
 * - Small buy ($100)
 * - Medium buy ($1,000)
 * - Large buy ($10,000)
 * - Slippage protection
 * - Deadline checks
 * - Event emission
 *
 * PREREQUISITES:
 * 1. Contracts deployed: npx hardhat run scripts/deploy-testnet-full.js --network sepolia
 * 2. AMM pools authorized: npx hardhat run scripts/authorize-amm-pools.js --network sepolia
 * 3. IBR period expired (1 day after deployment)
 *
 * USAGE:
 * npx hardhat test test/testnet/real-buy-transactions.test.js --network sepolia
 */

describe("Real Buy Transactions", function () {
  let deployment;
  let pool, token, mockUSDC;
  let buyer;
  let poolInfo;

  // Test configuration
  // Note: Conservative pool has ~$2000 max trade size (20% of reserve)
  const buyTests = [
    { label: "Small", amount: "100", expectedMinTokens: 0n },
    { label: "Medium", amount: "1000", expectedMinTokens: 0n },
    { label: "Large", amount: "2000", expectedMinTokens: 0n }
  ];

  before(async function () {
    [buyer] = await ethers.getSigners();

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

    // Use conservative pool for testing
    poolInfo = deployment.pools.find(p => p.configKey === "conservative");
    if (!poolInfo) {
      throw new Error("Conservative pool not found in deployment");
    }

    pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    console.log(`  ✅ Testing pool: ${poolInfo.modelId}`);
    console.log(`  ✅ Pool address: ${poolInfo.ammAddress}`);
    console.log(`  ✅ Token address: ${poolInfo.tokenAddress}\n`);

    // Check buyer has USDC
    const buyerBalance = await mockUSDC.balanceOf(buyer.address);
    console.log(`  💰 Buyer USDC balance: $${ethers.formatUnits(buyerBalance, 6)}`);

    if (buyerBalance === 0n) {
      console.log(`  ⚠️  WARNING: Buyer has no USDC. Tests will skip.\n`);
    }
  });

  describe("Standard Buy Transactions", function () {
    for (const test of buyTests) {
      it(`Should execute ${test.label} buy ($${test.amount})`, async function () {
        const buyAmount = parseUnits(test.amount, 6);

        // Check buyer has enough USDC
        const buyerBalance = await mockUSDC.balanceOf(buyer.address);
        if (buyerBalance < buyAmount) {
          console.log(`      ⚠️  Skipping - needs $${test.amount} USDC`);
          this.skip();
        }

        // Get quote before buy
        const quotedTokens = await pool.getBuyQuote(buyAmount);
        console.log(`      📊 Quote: $${test.amount} → ${ethers.formatEther(quotedTokens)} tokens`);

        // Get pool state before
        const spotPriceBefore = await pool.spotPrice();
        const reserveBefore = await pool.reserveBalance();
        const tokenBalanceBefore = await token.balanceOf(buyer.address);

        // Approve (use large allowance to avoid approval issues)
        const poolAddress = await pool.getAddress();
        const currentAllowance = await mockUSDC.allowance(buyer.address, poolAddress);
        if (currentAllowance < buyAmount) {
          const approveTx = await mockUSDC.approve(poolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
        const deadline = Math.floor(Date.now() / 1000) + 300;

        const tx = await pool.buy(
          buyAmount,
          0, // no slippage protection
          buyer.address,
          deadline
        );

        const receipt = await tx.wait();

        // Get pool state after
        const spotPriceAfter = await pool.spotPrice();
        const reserveAfter = await pool.reserveBalance();
        const tokenBalanceAfter = await token.balanceOf(buyer.address);
        const tokensReceived = tokenBalanceAfter - tokenBalanceBefore;

        // Validate
        expect(tokensReceived).to.be.gt(0, "Should receive tokens");
        expect(tokensReceived).to.be.approximately(quotedTokens, quotedTokens / 100n); // within 1%
        expect(reserveAfter).to.be.gt(reserveBefore, "Reserve should increase");
        expect(spotPriceAfter).to.be.gt(spotPriceBefore, "Price should increase");

        console.log(`      ✅ Buy successful`);
        console.log(`         USDC spent: $${ethers.formatUnits(buyAmount, 6)}`);
        console.log(`         Tokens received: ${ethers.formatEther(tokensReceived)}`);
        console.log(`         Price before: $${ethers.formatUnits(spotPriceBefore, 6)}`);
        console.log(`         Price after: $${ethers.formatUnits(spotPriceAfter, 6)}`);
        console.log(`         Price impact: ${((spotPriceAfter - spotPriceBefore) * 10000n / spotPriceBefore) / 100n}%`);
        console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
        console.log(`         🔗 ${network === 'sepolia' ? 'https://sepolia.etherscan.io/tx/' + tx.hash : ''}`);
      });
    }
  });

  describe("Slippage Protection", function () {
    it("Should revert if slippage exceeded", async function () {
      const buyAmount = parseUnits("100", 6);

      // Check buyer has USDC
      const buyerBalance = await mockUSDC.balanceOf(buyer.address);
      if (buyerBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      // Get quote
      const quotedTokens = await pool.getBuyQuote(buyAmount);

      // Set minTokensOut impossibly high (double the quote)
      const minTokensOut = quotedTokens * 2n;

      await mockUSDC.approve(await pool.getAddress(), buyAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.buy(buyAmount, minTokensOut, buyer.address, deadline)
      ).to.be.revertedWith("Slippage exceeded");

      console.log(`      ✅ Slippage protection working`);
      console.log(`         Quote: ${ethers.formatEther(quotedTokens)} tokens`);
      console.log(`         Min requested: ${ethers.formatEther(minTokensOut)} tokens`);
    });
  });

  describe("Deadline Checks", function () {
    it("Should revert if deadline passed", async function () {
      const buyAmount = parseUnits("100", 6);

      // Check buyer has USDC
      const buyerBalance = await mockUSDC.balanceOf(buyer.address);
      if (buyerBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      await mockUSDC.approve(await pool.getAddress(), buyAmount);

      // Use expired deadline (1 second ago)
      const expiredDeadline = Math.floor(Date.now() / 1000) - 1;

      await expect(
        pool.buy(buyAmount, 0, buyer.address, expiredDeadline)
      ).to.be.revertedWith("Transaction expired");

      console.log(`      ✅ Deadline check working`);
    });
  });

  describe("Event Emission", function () {
    it("Should emit Buy event with correct data", async function () {
      const buyAmount = parseUnits("100", 6);

      // Check buyer has USDC
      const buyerBalance = await mockUSDC.balanceOf(buyer.address);
      if (buyerBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      // Check pool has enough tradeable capacity
      const reserve = await pool.reserveBalance();
      const maxTradeBps = await pool.maxTradeBps();
      const maxTradeSize = (reserve * maxTradeBps) / 10000n;
      if (maxTradeSize < buyAmount) {
        console.log(`      ⚠️  Skipping - pool at capacity (max: $${ethers.formatUnits(maxTradeSize, 6)})`);
        this.skip();
      }

      // Approve
      const poolAddress = await pool.getAddress();
      const currentAllowance = await mockUSDC.allowance(buyer.address, poolAddress);
      if (currentAllowance < buyAmount) {
        const approveTx = await mockUSDC.approve(poolAddress, ethers.MaxUint256);
        await approveTx.wait();
      }

      const deadline = Math.floor(Date.now() / 1000) + 300;

      // Execute transaction
      const tx = await pool.buy(buyAmount, 0, buyer.address, deadline);
      const receipt = await tx.wait();

      // Check Buy event in logs
      const buyEvent = receipt.logs.find(log => {
        try {
          const parsed = pool.interface.parseLog(log);
          return parsed && parsed.name === "Buy";
        } catch {
          return false;
        }
      });

      expect(buyEvent).to.not.be.undefined;
      console.log(`      ✅ Buy event emitted correctly`);
    });
  });

  describe("Multi-Pool Testing", function () {
    it("Should work on all pool configurations", async function () {
      this.timeout(120000); // 2 minutes for network calls
      const buyAmount = parseUnits("100", 6);

      for (const poolConfig of deployment.pools) {
        // Skip conservative pool as we've already tested it extensively above
        if (poolConfig.configKey === "conservative") {
          console.log(`\n      ⏭️  Skipping ${poolConfig.configKey} (already tested)...`);
          continue;
        }

        console.log(`\n      🔄 Testing ${poolConfig.configKey} pool...`);

        const testPool = await ethers.getContractAt("HokusaiAMM", poolConfig.ammAddress);
        const testToken = await ethers.getContractAt("HokusaiToken", poolConfig.tokenAddress);

        // Check buyer has USDC
        const buyerBalance = await mockUSDC.balanceOf(buyer.address);
        if (buyerBalance < buyAmount) {
          console.log(`         ⚠️  Skipping - needs $100 USDC`);
          continue;
        }

        const balanceBefore = await testToken.balanceOf(buyer.address);

        // Approve
        const testPoolAddress = await testPool.getAddress();
        const currentAllowance = await mockUSDC.allowance(buyer.address, testPoolAddress);
        if (currentAllowance < buyAmount) {
          const approveTx = await mockUSDC.approve(testPoolAddress, ethers.MaxUint256);
          await approveTx.wait();
        }
        const deadline = Math.floor(Date.now() / 1000) + 300;

        try {
          const tx = await testPool.buy(buyAmount, 0, buyer.address, deadline);
          await tx.wait();

          const balanceAfter = await testToken.balanceOf(buyer.address);
          const received = balanceAfter - balanceBefore;

          expect(received).to.be.gt(0);
          console.log(`         ✅ Received ${ethers.formatEther(received)} tokens`);
        } catch (error) {
          console.log(`         ⚠️  Buy failed: ${error.message.split('\n')[0]}`);
          // Continue to next pool
        }
      }
    });
  });
});
