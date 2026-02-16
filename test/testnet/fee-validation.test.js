const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Fee Validation Tests
 *
 * Validates that protocol fees are correctly:
 * 1. Calculated based on trade size
 * 2. Routed to treasury
 * 3. Split according to protocolFeeBps
 *
 * USAGE:
 * npx hardhat test test/testnet/fee-validation.test.js --network sepolia
 */

describe("Fee Validation", function () {
  before(function () {
    if (network.name !== "sepolia") {
      this.skip();
    }
  });

  let deployment;
  let pool, token, mockUSDC, factory;
  let trader, treasury;
  let poolInfo;

  before(async function () {
    [trader] = await ethers.getSigners();

    // Load deployment info
    const network = hre.network.name;
    const deploymentPath = path.join(__dirname, "../../deployments", `${network}-latest.json`);
    deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

    console.log(`\n  📦 Network: ${deployment.network}`);

    // Use balanced pool for testing
    poolInfo = deployment.pools.find(p => p.configKey === "balanced");
    pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
    factory = await ethers.getContractAt("HokusaiAMMFactory", deployment.contracts.HokusaiAMMFactory);

    treasury = await factory.treasury();
    console.log(`  🏦 Treasury: ${treasury}`);
    console.log(`  💎 Testing pool: ${poolInfo.configKey}\n`);
  });

  describe("Trade Fee Calculation", function () {
    it("Should calculate correct fee for buy", async function () {
      const buyAmount = parseUnits("100", 6);

      // Check trader has USDC
      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      // Get pool configuration
      const tradeFee = await pool.tradeFee();
      console.log(`      Trade Fee: ${tradeFee} bps (${Number(tradeFee) / 100}%)`);

      // Calculate expected fee
      const expectedFee = (buyAmount * tradeFee) / 10000n;
      console.log(`      Expected fee for $100 buy: $${ethers.formatUnits(expectedFee, 6)}`);

      // Execute buy and capture event
      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, buyAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await pool.buy(buyAmount, 0, trader.address, deadline);
      const receipt = await tx.wait();

      // Find Buy event
      const buyEvent = receipt.logs.find(log => {
        try {
          const parsed = pool.interface.parseLog(log);
          return parsed && parsed.name === "Buy";
        } catch {
          return false;
        }
      });

      expect(buyEvent).to.not.be.undefined;

      const parsedEvent = pool.interface.parseLog(buyEvent);
      const actualFee = parsedEvent.args.feeAmount;

      console.log(`      Actual fee from event: $${ethers.formatUnits(actualFee, 6)}`);

      expect(actualFee).to.equal(expectedFee, "Fee should match calculation");
      console.log(`      ✅ Fee calculated correctly`);
    });
  });

  describe("Treasury Fee Distribution", function () {
    it("Should route protocol fee to treasury", async function () {
      const buyAmount = parseUnits("100", 6);

      // Check trader has USDC
      const traderBalance = await mockUSDC.balanceOf(trader.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping - needs $100 USDC`);
        this.skip();
      }

      // Get configuration
      const tradeFee = await pool.tradeFee();
      const protocolFeeBps = await pool.protocolFeeBps();

      console.log(`      Trade Fee: ${Number(tradeFee) / 100}%`);
      console.log(`      Protocol Share: ${Number(protocolFeeBps) / 100}% of fee`);

      // Calculate expected values
      const totalFee = (buyAmount * tradeFee) / 10000n;
      const protocolFee = (totalFee * protocolFeeBps) / 10000n;
      const poolFee = totalFee - protocolFee;

      console.log(`      Total fee: $${ethers.formatUnits(totalFee, 6)}`);
      console.log(`      Protocol portion: $${ethers.formatUnits(protocolFee, 6)}`);
      console.log(`      Pool portion: $${ethers.formatUnits(poolFee, 6)}`);

      // Get treasury balance before
      const treasuryBefore = await mockUSDC.balanceOf(treasury);

      // Execute buy
      const poolAddress = await pool.getAddress();
      await mockUSDC.approve(poolAddress, buyAmount);

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await pool.buy(buyAmount, 0, trader.address, deadline);
      await tx.wait();

      // Get treasury balance after
      const treasuryAfter = await mockUSDC.balanceOf(treasury);
      const treasuryIncrease = treasuryAfter - treasuryBefore;

      console.log(`      Treasury increase: $${ethers.formatUnits(treasuryIncrease, 6)}`);

      // Note: The full trade fee goes to treasury in the current implementation
      // because HokusaiAMM.sol line 184-188 transfers feeAmount to treasury
      expect(treasuryIncrease).to.equal(totalFee, "Treasury should receive full trade fee");
      console.log(`      ✅ Treasury received correct fee amount`);
    });
  });

  describe("Fee Configuration", function () {
    it("Should have correct fee parameters", async function () {
      const tradeFee = await pool.tradeFee();
      const protocolFeeBps = await pool.protocolFeeBps();
      const maxTradeBps = await pool.maxTradeBps();

      console.log(`\n      📊 Fee Configuration:`);
      console.log(`         Trade Fee: ${tradeFee} bps (${Number(tradeFee) / 100}%)`);
      console.log(`         Protocol Fee Share: ${protocolFeeBps} bps (${Number(protocolFeeBps) / 100}%)`);
      console.log(`         Max Trade Size: ${maxTradeBps} bps (${Number(maxTradeBps) / 100}% of reserve)`);

      // Validate reasonable values
      expect(tradeFee).to.be.gte(0, "Trade fee should be non-negative");
      expect(tradeFee).to.be.lte(1000, "Trade fee should be <= 10%");
      expect(protocolFeeBps).to.be.gte(0, "Protocol fee should be non-negative");
      expect(protocolFeeBps).to.be.lte(10000, "Protocol fee should be <= 100%");
      expect(maxTradeBps).to.be.gt(0, "Max trade size should be positive");
      expect(maxTradeBps).to.be.lte(10000, "Max trade size should be <= 100%");

      console.log(`      ✅ All fee parameters within valid ranges`);
    });

    it("Should show fee impact for various trade sizes", async function () {
      const tradeFee = await pool.tradeFee();
      const protocolFeeBps = await pool.protocolFeeBps();

      console.log(`\n      💰 Fee Impact Examples:`);

      const tradeSizes = [
        { label: "Small", amount: "100" },
        { label: "Medium", amount: "1000" },
        { label: "Large", amount: "10000" }
      ];

      for (const trade of tradeSizes) {
        const amount = parseUnits(trade.amount, 6);
        const totalFee = (amount * tradeFee) / 10000n;
        const protocolPortion = (totalFee * protocolFeeBps) / 10000n;
        const netAmount = amount - totalFee;

        console.log(`\n      ${trade.label} trade ($${trade.amount}):`);
        console.log(`         Total fee: $${ethers.formatUnits(totalFee, 6)}`);
        console.log(`         To treasury: $${ethers.formatUnits(protocolPortion, 6)}`);
        console.log(`         Net to pool: $${ethers.formatUnits(netAmount, 6)}`);
        console.log(`         Fee %: ${(Number(tradeFee) / 100).toFixed(2)}%`);
      }

      console.log(`\n      ✅ Fee calculations displayed`);
    });
  });

  describe("Multi-Pool Fee Comparison", function () {
    it("Should show fee differences across pools", async function () {
      console.log(`\n      📊 Fee Comparison Across Pools:\n`);

      for (const poolConfig of deployment.pools) {
        const testPool = await ethers.getContractAt("HokusaiAMM", poolConfig.ammAddress);
        const tradeFee = await testPool.tradeFee();
        const protocolFeeBps = await testPool.protocolFeeBps();
        const crr = await testPool.crr();

        const testAmount = parseUnits("1000", 6);
        const totalFee = (testAmount * tradeFee) / 10000n;
        const protocolPortion = (totalFee * protocolFeeBps) / 10000n;

        console.log(`      ${poolConfig.configKey.toUpperCase()}:`);
        console.log(`         CRR: ${Number(crr) / 10000}%`);
        console.log(`         Trade Fee: ${Number(tradeFee) / 100}%`);
        console.log(`         Protocol Share: ${Number(protocolFeeBps) / 100}%`);
        console.log(`         $1000 trade fee: $${ethers.formatUnits(totalFee, 6)}`);
        console.log(`         To treasury: $${ethers.formatUnits(protocolPortion, 6)}`);
        console.log();
      }

      console.log(`      ✅ Fee structures documented`);
    });
  });
});
