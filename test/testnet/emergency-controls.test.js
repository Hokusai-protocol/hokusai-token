const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Emergency Control Tests
 *
 * Validates pause/unpause mechanism works correctly for emergency scenarios:
 * - Owner can pause/unpause
 * - Trading blocked when paused
 * - Trading resumes after unpause
 * - Events emitted correctly
 * - Non-owners cannot pause/unpause
 * - Rapid pause/unpause cycles work
 *
 * USAGE:
 * 1. Deploy contracts first:
 *    npx hardhat run scripts/deploy-testnet-full.js --network sepolia
 *
 * 2. Run tests against deployment:
 *    npx hardhat test test/testnet/emergency-controls.test.js --network sepolia
 */

describe("Emergency Control Validation", function () {
  let deployment;
  let pool, token, mockUSDC;
  let owner, user, attacker;
  let poolInfo;

  // Helper to check if deployer owns the pool
  async function isDeployerPoolOwner() {
    const poolOwner = await pool.owner();
    const [deployer] = await ethers.getSigners();
    return poolOwner.toLowerCase() === deployer.address.toLowerCase();
  }

  before(async function () {
    [owner, user, attacker] = await ethers.getSigners();

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

    // Check pool ownership
    const poolOwner = await pool.owner();
    const isDeployer = poolOwner.toLowerCase() === owner.address.toLowerCase();

    console.log(`  📝 Pool owner: ${poolOwner}`);
    console.log(`  📝 Deployer: ${owner.address}`);
    console.log(`  📝 Deployer is owner: ${isDeployer}`);

    if (!isDeployer) {
      console.log(`\n  ⚠️  WARNING: Pools created by factory are owned by factory contract`);
      console.log(`  ⚠️  Emergency control tests will be SKIPPED on testnet`);
      console.log(`  ℹ️  On testnet, factory (${poolOwner}) owns pools`);
      console.log(`  ℹ️  For emergency controls, transfer ownership from factory to EOA\n`);
    }

    // Ensure user has USDC for testing
    if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
      await mockUSDC.mint(user.address, parseUnits("10000", 6));
    }
  });

  describe("Pause Mechanism", function () {
    it("Should allow owner to pause", async function () {
      // Check if deployer is the owner
      const poolOwner = await pool.owner();
      const [deployer] = await ethers.getSigners();
      const isDeployerOwner = poolOwner.toLowerCase() === deployer.address.toLowerCase();

      if (!isDeployerOwner) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner (factory owns pool on testnet)`);
        this.skip();
      }

      const isPausedBefore = await pool.paused();

      // Skip if already paused
      if (isPausedBefore) {
        console.log(`      ⚠️  Pool already paused, unpausing first...`);
        await pool.unpause();
      }

      const tx = await pool.pause();
      const receipt = await tx.wait();

      const isPausedAfter = await pool.paused();
      expect(isPausedAfter).to.be.true;

      console.log(`      ✅ Pool paused successfully`);
      console.log(`         Tx: ${tx.hash}`);
      console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
    });

    it("Should emit Paused event", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();

      // Unpause first if already paused
      if (isPaused) {
        await pool.unpause();
      }

      const tx = await pool.pause();
      const receipt = await tx.wait();

      const pausedEvent = receipt.logs.find(log => {
        try {
          return pool.interface.parseLog(log)?.name === "Paused";
        } catch {
          return false;
        }
      });

      expect(pausedEvent).to.exist;

      const parsedEvent = pool.interface.parseLog(pausedEvent);
      console.log(`      ✅ Paused event emitted`);
      console.log(`         Account: ${parsedEvent.args.account}`);
      console.log(`         Tx: ${tx.hash}`);
    });

    it("Should block buys when paused", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();

      // Ensure paused
      if (!isPaused) {
        await pool.pause();
      }

      const buyAmount = parseUnits("1000", 6);
      const userBalance = await mockUSDC.balanceOf(user.address);

      if (userBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - user needs USDC`);
        this.skip();
      }

      await mockUSDC.connect(user).approve(await pool.getAddress(), buyAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.connect(user).buy(
          buyAmount,
          0,
          user.address,
          deadline
        )
      ).to.be.revertedWith("Pausable: paused");

      console.log(`      ✅ Buy correctly blocked when paused`);
    });

    it("Should block sells when paused", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();

      // Ensure paused
      if (!isPaused) {
        await pool.pause();
      }

      const userTokenBalance = await token.balanceOf(user.address);

      if (userTokenBalance === 0n) {
        console.log(`      ⚠️  Skipping - user has no tokens`);
        this.skip();
      }

      await token.connect(user).approve(await pool.getAddress(), userTokenBalance);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      await expect(
        pool.connect(user).sell(
          userTokenBalance,
          0,
          user.address,
          deadline
        )
      ).to.be.revertedWith("Pausable: paused");

      console.log(`      ✅ Sell correctly blocked when paused`);
    });
  });

  describe("Unpause Mechanism", function () {
    it("Should allow owner to unpause", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPausedBefore = await pool.paused();

      // Skip if already unpaused
      if (!isPausedBefore) {
        console.log(`      ⚠️  Pool not paused, pausing first...`);
        await pool.pause();
      }

      const tx = await pool.unpause();
      const receipt = await tx.wait();

      const isPausedAfter = await pool.paused();
      expect(isPausedAfter).to.be.false;

      console.log(`      ✅ Pool unpaused successfully`);
      console.log(`         Tx: ${tx.hash}`);
      console.log(`         Gas used: ${receipt.gasUsed.toString()}`);
    });

    it("Should emit Unpaused event", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();

      // Pause first if not paused
      if (!isPaused) {
        await pool.pause();
      }

      const tx = await pool.unpause();
      const receipt = await tx.wait();

      const unpausedEvent = receipt.logs.find(log => {
        try {
          return pool.interface.parseLog(log)?.name === "Unpaused";
        } catch {
          return false;
        }
      });

      expect(unpausedEvent).to.exist;

      const parsedEvent = pool.interface.parseLog(unpausedEvent);
      console.log(`      ✅ Unpaused event emitted`);
      console.log(`         Account: ${parsedEvent.args.account}`);
      console.log(`         Tx: ${tx.hash}`);
    });

    it("Should allow trading after unpause", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();

      // Ensure unpaused
      if (isPaused) {
        await pool.unpause();
      }

      const buyAmount = parseUnits("100", 6);
      const userBalance = await mockUSDC.balanceOf(user.address);

      if (userBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - user needs USDC`);
        this.skip();
      }

      await mockUSDC.connect(user).approve(await pool.getAddress(), buyAmount);
      const deadline = Math.floor(Date.now() / 1000) + 300;

      const tx = await pool.connect(user).buy(
        buyAmount,
        0,
        user.address,
        deadline
      );

      await tx.wait();

      console.log(`      ✅ Trading resumed after unpause`);
      console.log(`         Buy successful: $${ethers.formatUnits(buyAmount, 6)}`);
    });
  });

  describe("Access Control", function () {
    it("Should prevent non-owner from pausing", async function () {
      await expect(
        pool.connect(attacker).pause()
      ).to.be.revertedWith("Ownable: caller is not the owner");

      console.log(`      ✅ Non-owner correctly blocked from pausing`);
    });

    it("Should prevent non-owner from unpausing", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      // Pause as owner first
      const isPaused = await pool.paused();
      if (!isPaused) {
        await pool.pause();
      }

      await expect(
        pool.connect(attacker).unpause()
      ).to.be.revertedWith("Ownable: caller is not the owner");

      // Clean up - unpause as owner
      await pool.unpause();

      console.log(`      ✅ Non-owner correctly blocked from unpausing`);
    });
  });

  describe("Emergency Scenarios", function () {
    it("Should handle rapid pause/unpause cycles", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      console.log(`      🔄 Testing rapid pause/unpause cycles...`);

      for (let i = 0; i < 3; i++) {
        console.log(`         Cycle ${i + 1}/3:`);

        await pool.pause();
        expect(await pool.paused()).to.be.true;
        console.log(`           - Paused`);

        await pool.unpause();
        expect(await pool.paused()).to.be.false;
        console.log(`           - Unpaused`);
      }

      console.log(`      ✅ Rapid pause/unpause cycles work correctly`);
    });

    it("Should allow parameter updates while paused", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      const isPaused = await pool.paused();
      if (!isPaused) {
        await pool.pause();
      }

      const newCrr = 300000;
      const newTradeFee = 30;
      const newProtocolFee = 2000;

      const tx = await pool.setParameters(newCrr, newTradeFee, newProtocolFee);
      await tx.wait();

      console.log(`      ✅ Parameter updates work while paused`);
      console.log(`         New CRR: ${newCrr / 10000}%`);
      console.log(`         New Trade Fee: ${newTradeFee / 100}%`);

      // Clean up - unpause
      await pool.unpause();
    });

    it("Should show correct pause status in getTradeInfo()", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      // Test paused state
      await pool.pause();
      let tradeInfo = await pool.getTradeInfo();

      console.log(`      📊 Trade info when paused:`);
      console.log(`         Is Paused: ${tradeInfo.isPaused}`);
      console.log(`         Can Buy: ${tradeInfo.canBuy}`);
      console.log(`         Can Sell: ${tradeInfo.canSell}`);

      expect(tradeInfo.isPaused).to.be.true;
      expect(tradeInfo.canBuy).to.be.false;
      expect(tradeInfo.canSell).to.be.false;

      // Test unpaused state
      await pool.unpause();
      tradeInfo = await pool.getTradeInfo();

      console.log(`\n      📊 Trade info when unpaused:`);
      console.log(`         Is Paused: ${tradeInfo.isPaused}`);
      console.log(`         Can Buy: ${tradeInfo.canBuy}`);

      expect(tradeInfo.isPaused).to.be.false;
      expect(tradeInfo.canBuy).to.be.true;

      console.log(`      ✅ getTradeInfo() correctly reflects pause status`);
    });
  });

  describe("Multi-Pool Independence", function () {
    it("Should not affect other pools when one pool is paused", async function () {
      if (!(await isDeployerPoolOwner())) {
        console.log(`      ⏭️  Skipping - deployer is not pool owner`);
        this.skip();
      }

      // Get another pool
      const aggressivePoolInfo = deployment.pools.find(p => p.configKey === "aggressive");
      if (!aggressivePoolInfo) {
        console.log(`      ⚠️  Skipping - aggressive pool not found`);
        this.skip();
      }

      const pool2 = await ethers.getContractAt("HokusaiAMM", aggressivePoolInfo.ammAddress);

      // Pause conservative pool
      await pool.pause();
      console.log(`      ⏸️  Paused conservative pool`);

      // Check aggressive pool is still unpaused
      const pool2Paused = await pool2.paused();
      expect(pool2Paused).to.be.false;

      console.log(`      ✅ Aggressive pool unaffected by conservative pool pause`);
      console.log(`         Conservative paused: ${await pool.paused()}`);
      console.log(`         Aggressive paused: ${pool2Paused}`);

      // Clean up
      await pool.unpause();
    });
  });
});
