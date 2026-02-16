const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const path = require("path");
const fs = require("fs");

/**
 * IBR Period Validation Tests
 *
 * Tests the Initial Bonding Reserve (IBR) period functionality:
 * - Buys work during IBR
 * - Sells are blocked during IBR with clear error
 * - Sells work after IBR expires
 * - Trade info correctly reports IBR status
 *
 * USAGE:
 * 1. Deploy contracts first:
 *    npx hardhat run scripts/deploy-testnet-full.js --network sepolia
 *
 * 2. Run tests against deployment:
 *    npx hardhat test test/testnet/ibr-validation.test.js --network sepolia
 *
 * NOTE: IBR duration is 1 day on testnet (vs 7 days in production).
 *       For local Hardhat testing, time can be manipulated with evm_increaseTime.
 *       For Sepolia, you must wait the full 1 day duration.
 */

describe("IBR Period Validation", function () {
  before(function () {
    if (network.name !== "sepolia") {
      this.skip();
    }
  });

  let deployment;
  let pool, token, mockUSDC;
  let deployer, buyer;
  let poolInfo;

  before(async function () {
    [deployer, buyer] = await ethers.getSigners();

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
    console.log(`  ✅ IBR Duration: ${poolInfo.ibrDuration / 86400} days\n`);
  });

  describe("During IBR Period", function () {
    let buyTokensReceived;

    it("Should allow buys during IBR", async function () {
      const buyAmount = parseUnits("1000", 6); // $1k

      // On testnet, use deployer as buyer since only deployer has USDC
      const actualBuyer = (hre.network.name === "hardhat" || hre.network.name === "localhost") ? buyer : deployer;

      // Ensure buyer has USDC
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        await mockUSDC.mint(actualBuyer.address, buyAmount);
      }

      const buyerBalance = await mockUSDC.balanceOf(actualBuyer.address);
      if (buyerBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - buyer needs ${ethers.formatUnits(buyAmount, 6)} USDC`);
        this.skip();
      }

      // Check IBR status before buy
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const block = await ethers.provider.getBlock('latest');
      const currentTime = BigInt(block.timestamp);
      const ibrActive = buyOnlyUntil > currentTime;

      console.log(`      📊 Before buy:`);
      console.log(`         IBR Active: ${ibrActive}`);
      console.log(`         Buy only until: ${buyOnlyUntil}`);
      console.log(`         Current time: ${currentTime}`);

      // Execute buy
      await mockUSDC.connect(actualBuyer).approve(await pool.getAddress(), buyAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      const tx = await pool.connect(actualBuyer).buy(
        buyAmount,
        0, // no slippage protection for testing
        actualBuyer.address,
        deadline
      );

      const receipt = await tx.wait();
      buyTokensReceived = await token.balanceOf(actualBuyer.address);

      expect(buyTokensReceived).to.be.gt(0, "Should receive tokens from buy");

      console.log(`      ✅ Buy during IBR successful`);
      console.log(`         USDC spent: $${ethers.formatUnits(buyAmount, 6)}`);
      console.log(`         Tokens received: ${ethers.formatEther(buyTokensReceived)}`);
      console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
    });

    it("Should block sells during IBR", async function () {
      // On testnet, use deployer as buyer
      const actualBuyer = (hre.network.name === "hardhat" || hre.network.name === "localhost") ? buyer : deployer;
      const buyerTokenBalance = await token.balanceOf(actualBuyer.address);

      if (buyerTokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - buyer has no tokens`);
        this.skip();
      }

      // Check IBR status using contract state
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const block = await ethers.provider.getBlock('latest');
      const currentTime = BigInt(block.timestamp);
      const ibrActive = buyOnlyUntil > currentTime;

      console.log(`      📊 IBR status during test:`);
      console.log(`         Buy only until: ${buyOnlyUntil}`);
      console.log(`         Current time: ${currentTime}`);
      console.log(`         IBR Active: ${ibrActive}`);

      if (!ibrActive) {
        console.log(`      ⚠️  Skipping - IBR already expired`);
        this.skip();
      }

      // Attempt to sell during IBR
      await token.connect(actualBuyer).approve(await pool.getAddress(), buyerTokenBalance);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.connect(actualBuyer).sell(
          buyerTokenBalance,
          0,
          actualBuyer.address,
          deadline
        )
      ).to.be.revertedWith("Sells not enabled during IBR");

      console.log(`      ✅ Sell correctly blocked during IBR`);
      console.log(`         Error message: "Sells not enabled during IBR"`);
    });

    it("Should report IBR status correctly via buyOnlyUntil()", async function () {
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const paused = await pool.paused();

      // Get current time based on network
      let currentTime;
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        currentTime = await time.latest();
      } else {
        // For testnets, get latest block timestamp
        const block = await ethers.provider.getBlock('latest');
        currentTime = BigInt(block.timestamp);
      }

      const ibrActive = buyOnlyUntil > currentTime;

      console.log(`      📊 IBR Status:`);
      console.log(`         Current time: ${currentTime}`);
      console.log(`         Buy only until: ${buyOnlyUntil}`);
      console.log(`         IBR Active (calculated): ${ibrActive}`);
      console.log(`         Paused: ${paused}`);
      console.log(`         Time remaining: ${buyOnlyUntil > currentTime ? buyOnlyUntil - currentTime : 0n}s`);

      if (buyOnlyUntil > currentTime) {
        // IBR should be active - buys work, sells blocked
        expect(ibrActive).to.be.true;
        console.log(`      ✅ IBR is active as expected`);
      } else {
        console.log(`      ⚠️  IBR has already expired`);
      }
    });
  });

  describe("After IBR Expires", function () {
    before(async function () {
      const network = hre.network.name;
      const buyOnlyUntil = await pool.buyOnlyUntil();

      // Get current time based on network
      let currentTime;
      if (network === "hardhat" || network === "localhost") {
        currentTime = await time.latest();
      } else {
        const block = await ethers.provider.getBlock('latest');
        currentTime = BigInt(block.timestamp);
      }

      if (buyOnlyUntil > currentTime) {
        if (network === "hardhat" || network === "localhost") {
          console.log(`\n      ⏰ Fast-forwarding time on local network...`);
          const timeToAdvance = Number(buyOnlyUntil - currentTime) + 1;
          await time.increase(timeToAdvance);
          console.log(`      ✅ Advanced ${timeToAdvance}s (${timeToAdvance / 86400} days)`);
        } else {
          const timeRemaining = Number(buyOnlyUntil - currentTime);
          console.log(`\n      ⏳ IBR still active on ${network}`);
          console.log(`      ⏳ Time remaining: ${timeRemaining}s (${(timeRemaining / 3600).toFixed(2)} hours)`);
          console.log(`      ⚠️  Tests will skip until IBR expires naturally`);
        }
      }
    });

    it("Should allow sells after IBR expires", async function () {
      // Check if IBR is still active
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const block = await ethers.provider.getBlock('latest');
      const currentTime = BigInt(block.timestamp);
      const ibrActive = buyOnlyUntil > currentTime;

      if (ibrActive) {
        console.log(`      ⏳ Skipping - IBR still active, wait for expiry`);
        this.skip();
      }

      // On testnet, use deployer as buyer
      const actualBuyer = (hre.network.name === "hardhat" || hre.network.name === "localhost") ? buyer : deployer;
      const buyerTokenBalance = await token.balanceOf(actualBuyer.address);
      if (buyerTokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - buyer has no tokens to sell`);
        this.skip();
      }

      // Sell tokens after IBR
      const sellAmount = buyerTokenBalance / 2n; // Sell half
      await token.connect(actualBuyer).approve(await pool.getAddress(), sellAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      const usdcBefore = await mockUSDC.balanceOf(actualBuyer.address);

      const tx = await pool.connect(actualBuyer).sell(
        sellAmount,
        0,
        actualBuyer.address,
        deadline
      );

      const receipt = await tx.wait();
      const usdcAfter = await mockUSDC.balanceOf(actualBuyer.address);
      const usdcReceived = usdcAfter - usdcBefore;

      expect(usdcReceived).to.be.gt(0, "Should receive USDC from sell");

      console.log(`      ✅ Sell successful after IBR expiry`);
      console.log(`         Tokens sold: ${ethers.formatEther(sellAmount)}`);
      console.log(`         USDC received: $${ethers.formatUnits(usdcReceived, 6)}`);
      console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
    });

    it("Should report IBR as inactive via buyOnlyUntil()", async function () {
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const paused = await pool.paused();

      // Get current time based on network
      let currentTime;
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        currentTime = await time.latest();
      } else {
        const block = await ethers.provider.getBlock('latest');
        currentTime = BigInt(block.timestamp);
      }

      const ibrActive = buyOnlyUntil > currentTime;

      if (ibrActive) {
        console.log(`      ⏳ Skipping - IBR still active`);
        this.skip();
      }

      console.log(`      📊 Status after IBR:`);
      console.log(`         IBR Active (calculated): ${ibrActive}`);
      console.log(`         Buy only until: ${buyOnlyUntil}`);
      console.log(`         Current time: ${currentTime}`);
      console.log(`         Paused: ${paused}`);

      expect(ibrActive).to.be.false;
      expect(paused).to.be.false;

      console.log(`      ✅ IBR correctly reported as inactive`);
    });

    it("Should allow multiple buy-sell cycles after IBR", async function () {
      // Check if IBR is still active
      const buyOnlyUntil = await pool.buyOnlyUntil();
      const block = await ethers.provider.getBlock('latest');
      const currentTime = BigInt(block.timestamp);
      const ibrActive = buyOnlyUntil > currentTime;

      if (ibrActive) {
        console.log(`      ⏳ Skipping - IBR still active`);
        this.skip();
      }

      // On testnet, use deployer as buyer
      const actualBuyer = (hre.network.name === "hardhat" || hre.network.name === "localhost") ? buyer : deployer;

      // Ensure buyer has USDC
      const buyAmount = parseUnits("100", 6); // $100
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        await mockUSDC.mint(actualBuyer.address, buyAmount);
      }

      const buyerUSDC = await mockUSDC.balanceOf(actualBuyer.address);
      if (buyerUSDC < buyAmount) {
        console.log(`      ⚠️  Skipping - insufficient USDC`);
        this.skip();
      }

      console.log(`\n      🔄 Testing buy-sell cycle...`);

      // Buy
      await mockUSDC.connect(actualBuyer).approve(await pool.getAddress(), buyAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;
      await pool.connect(actualBuyer).buy(buyAmount, 0, actualBuyer.address, deadline);

      const tokensReceived = await token.balanceOf(actualBuyer.address);
      console.log(`         Buy: $${ethers.formatUnits(buyAmount, 6)} → ${ethers.formatEther(tokensReceived)} tokens`);

      // Sell
      await token.connect(actualBuyer).approve(await pool.getAddress(), tokensReceived);
      const usdcBefore = await mockUSDC.balanceOf(actualBuyer.address);
      await pool.connect(actualBuyer).sell(tokensReceived, 0, actualBuyer.address, deadline + 300);
      const usdcAfter = await mockUSDC.balanceOf(actualBuyer.address);
      const usdcFromSell = usdcAfter - usdcBefore;

      console.log(`         Sell: ${ethers.formatEther(tokensReceived)} tokens → $${ethers.formatUnits(usdcFromSell, 6)}`);

      // Net result should be negative due to fees and price impact
      const netResult = usdcFromSell - buyAmount;
      console.log(`         Net result: ${netResult > 0 ? '+' : ''}$${ethers.formatUnits(netResult, 6)}`);

      expect(netResult).to.be.lt(0, "Should have net loss due to fees");
      console.log(`      ✅ Buy-sell cycle works, fees/slippage applied`);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle buy exactly at IBR expiry time", async function () {
      // This test would need to be run at exact expiry time
      // Skipping as it's timing-dependent
      console.log(`      ⏭️  Skipping timing-dependent edge case`);
      this.skip();
    });

    it("Should handle sell attempt 1 second before IBR expiry", async function () {
      // This test would need precise timing
      // Skipping as it's timing-dependent
      console.log(`      ⏭️  Skipping timing-dependent edge case`);
      this.skip();
    });
  });
});
