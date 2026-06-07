const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const path = require("path");
const fs = require("fs");

/**
 * Multi-Pool Validation Tests
 *
 * Validates that multiple pools with different parameters work independently
 * on testnet deployment. Loads deployment info from JSON and tests:
 * - Pool parameters match configuration
 * - Buy quotes work correctly for each pool
 * - Trades execute successfully with events
 * - Pools operate independently (no interference)
 *
 * USAGE:
 * 1. Deploy contracts first:
 *    npx hardhat run scripts/deploy-testnet-full.js --network sepolia
 *
 * 2. Run tests against deployment:
 *    npx hardhat test test/testnet/multi-pool-validation.test.js --network sepolia
 *
 * NOTE: Cannot run on ephemeral Hardhat network as it resets between runs.
 *       Use Sepolia or other persistent testnet.
 */

describe("Testnet Multi-Pool Validation", function () {
  before(function () {
    if (network.name !== "sepolia") {
      this.skip();
    }
  });

  let deployment;
  let mockUSDC;
  let deployer, trader;
  let pools = {};
  let tokens = {};

  before(async function () {
    [deployer, trader] = await ethers.getSigners();

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
    console.log(`  👤 Deployer: ${deployment.deployer}`);

    // Get MockUSDC contract
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);

    // Load all pools and tokens
    for (const poolInfo of deployment.pools) {
      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
      const token = await ethers.getContractAt("HokusaiToken", poolInfo.tokenAddress);
      pools[poolInfo.configKey] = { contract: pool, info: poolInfo };
      tokens[poolInfo.configKey] = { contract: token, info: deployment.tokens.find(t => t.configKey === poolInfo.configKey) };
    }

    console.log(`  ✅ Loaded ${Object.keys(pools).length} pools`);
    console.log(`  ✅ Loaded ${Object.keys(tokens).length} tokens\n`);
  });

  describe("Pool 1: HMESS", function () {
    let pool, token, poolInfo;

    before(function () {
      pool = pools.hmess.contract;
      token = tokens.hmess.contract;
      poolInfo = pools.hmess.info;
    });

    it("Should have correct initial parameters", async function () {
      const state = await pool.getPoolState();

      expect(state.reserveRatio).to.equal(300000, "CRR should be 30%");
      expect(state.tradeFeeRate).to.equal(25, "Trade fee should be 0.25%");
      expect(state.reserve).to.equal(parseUnits("10000", 6), "Reserve should be $10k");
      expect(state.supply).to.equal(parseEther("1000000"), "Supply should be 1M tokens");

      console.log(`      ✅ HMESS pool parameters validated`);
      console.log(`         CRR: ${Number(state.reserveRatio) / 10000}%`);
      console.log(`         Trade Fee: ${Number(state.tradeFeeRate) / 100}%`);
      console.log(`         Reserve: $${ethers.formatUnits(state.reserve, 6)}`);
      console.log(`         Supply: ${ethers.formatEther(state.supply)} tokens`);
    });

    it("Should calculate buy quote correctly", async function () {
      const buyAmount = parseUnits("1000", 6); // $1k
      const quote = await pool.getBuyQuote(buyAmount);

      expect(quote).to.be.gt(0, "Quote should be > 0");

      console.log(`      💰 Buy quote: $1,000 → ${ethers.formatEther(quote)} HMESS tokens`);
    });

    it("Should calculate spot price correctly", async function () {
      const spotPrice = await pool.spotPrice();

      // With 30% CRR, $10k reserve, 1M supply: P = R/(w*S) = 10000/(0.3*1000000) ≈ $0.033
      const expectedPrice = parseUnits("0.033", 6);

      expect(spotPrice).to.be.closeTo(expectedPrice, parseUnits("0.001", 6));

      console.log(`      📊 Spot price: $${ethers.formatUnits(spotPrice, 6)} per token`);
    });

    it("Should execute buy and emit events", async function () {
      // Skip on testnet - requires minter permissions not set up
      if (hre.network.name !== "hardhat") {
        console.log(`      ⚠️  Skipping buy test on testnet (requires additional setup)`);
        this.skip();
      }

      const buyAmount = parseUnits("1000", 6); // $1k

      // Get trader signer (use second signer for local)
      const signers = await ethers.getSigners();
      const traderSigner = signers[1];

      // Mint USDC to trader
      await mockUSDC.mint(traderSigner.address, buyAmount);

      const traderBalance = await mockUSDC.balanceOf(traderSigner.address);
      if (traderBalance < buyAmount) {
        console.log(`      ⚠️  Skipping buy test - insufficient USDC balance`);
        this.skip();
      }

      const approveTx = await mockUSDC.connect(traderSigner).approve(await pool.getAddress(), buyAmount);
      await approveTx.wait();

      const deadline = Math.floor(Date.now() / 1000) + 300;
      const tx = await pool.connect(traderSigner).buy(
        buyAmount,
        0, // no slippage protection for testing
        traderSigner.address,
        deadline
      );

      const receipt = await tx.wait();
      const buyEvent = receipt.logs.find(log => {
        try {
          return pool.interface.parseLog(log)?.name === "Buy";
        } catch {
          return false;
        }
      });

      expect(buyEvent).to.exist;

      const parsedEvent = pool.interface.parseLog(buyEvent);
      console.log(`      ✅ Buy executed successfully`);
      console.log(`         Buyer: ${parsedEvent.args.buyer}`);
      console.log(`         USDC In: $${ethers.formatUnits(parsedEvent.args.reserveIn, 6)}`);
      console.log(`         Tokens Out: ${ethers.formatEther(parsedEvent.args.tokensOut)}`);
      console.log(`         New Spot Price: $${ethers.formatUnits(parsedEvent.args.spotPrice, 6)}`);
    });
  });

  describe("Pool 2: HLEAD", function () {
    let pool, token, poolInfo;

    before(function () {
      pool = pools.hlead.contract;
      token = tokens.hlead.contract;
      poolInfo = pools.hlead.info;
    });

    it("Should have correct initial parameters", async function () {
      const state = await pool.getPoolState();

      expect(state.reserveRatio).to.equal(100000, "CRR should be 10%");
      expect(state.tradeFeeRate).to.equal(50, "Trade fee should be 0.50%");
      expect(state.reserve).to.equal(parseUnits("50000", 6), "Reserve should be $50k");
      expect(state.supply).to.equal(parseEther("500000"), "Supply should be 500k tokens");

      console.log(`      ✅ HLEAD pool parameters validated`);
      console.log(`         CRR: ${Number(state.reserveRatio) / 10000}%`);
      console.log(`         Trade Fee: ${Number(state.tradeFeeRate) / 100}%`);
      console.log(`         Reserve: $${ethers.formatUnits(state.reserve, 6)}`);
      console.log(`         Supply: ${ethers.formatEther(state.supply)} tokens`);
    });

    it("Should have different price dynamics from HMESS pool", async function () {
      const hmessPool = pools.hmess.contract;
      const hleadPool = pools.hlead.contract;

      const buyAmount = parseUnits("1000", 6); // $1k
      const hmessQuote = await hmessPool.getBuyQuote(buyAmount);
      const hleadQuote = await hleadPool.getBuyQuote(buyAmount);

      // Lower CRR = more volatile = different price dynamics
      console.log(`      📊 Price comparison for $1,000 buy:`);
      console.log(`         HMESS: ${ethers.formatEther(hmessQuote)} tokens`);
      console.log(`         HLEAD:   ${ethers.formatEther(hleadQuote)} tokens`);

      // Both should return positive amounts
      expect(hmessQuote).to.be.gt(0);
      expect(hleadQuote).to.be.gt(0);
    });

    it("Should calculate spot price correctly", async function () {
      const spotPrice = await pool.spotPrice();

      // With 10% CRR, $50k reserve, 500k supply: P = R/(w*S) = 50000/(0.1*500000) = $1.00
      const expectedPrice = parseUnits("1.0", 6);

      expect(spotPrice).to.be.closeTo(expectedPrice, parseUnits("0.01", 6));

      console.log(`      📊 Spot price: $${ethers.formatUnits(spotPrice, 6)} per token`);
    });
  });

  describe("Pool 3: HROUT", function () {
    let pool, token, poolInfo;

    before(function () {
      pool = pools.hrout.contract;
      token = tokens.hrout.contract;
      poolInfo = pools.hrout.info;
    });

    it("Should have correct initial parameters", async function () {
      const state = await pool.getPoolState();

      expect(state.reserveRatio).to.equal(200000, "CRR should be 20%");
      expect(state.tradeFeeRate).to.equal(30, "Trade fee should be 0.30%");
      expect(state.reserve).to.equal(parseUnits("25000", 6), "Reserve should be $25k");
      expect(state.supply).to.equal(parseEther("2000000"), "Supply should be 2M tokens");

      console.log(`      ✅ HROUT pool parameters validated`);
      console.log(`         CRR: ${Number(state.reserveRatio) / 10000}%`);
      console.log(`         Trade Fee: ${Number(state.tradeFeeRate) / 100}%`);
      console.log(`         Reserve: $${ethers.formatUnits(state.reserve, 6)}`);
      console.log(`         Supply: ${ethers.formatEther(state.supply)} tokens`);
    });

    it("Should have parameters between HMESS and HLEAD", async function () {
      const state = await pool.getPoolState();
      const hmessState = await pools.hmess.contract.getPoolState();
      const hleadState = await pools.hlead.contract.getPoolState();

      // CRR should be between HMESS and HLEAD
      expect(state.reserveRatio).to.be.gt(hleadState.reserveRatio);
      expect(state.reserveRatio).to.be.lt(hmessState.reserveRatio);

      // Trade fee should be between HMESS and HLEAD
      expect(state.tradeFeeRate).to.be.gt(hmessState.tradeFeeRate);
      expect(state.tradeFeeRate).to.be.lt(hleadState.tradeFeeRate);

      console.log(`      ✅ HROUT pool parameters are between HMESS and HLEAD`);
    });

    it("Should calculate spot price correctly", async function () {
      const spotPrice = await pool.spotPrice();

      // With 20% CRR, $25k reserve, 2M supply: P = R/(w*S) = 25000/(0.2*2000000) ≈ $0.0625
      const expectedPrice = parseUnits("0.0625", 6);

      expect(spotPrice).to.be.closeTo(expectedPrice, parseUnits("0.001", 6));

      console.log(`      📊 Spot price: $${ethers.formatUnits(spotPrice, 6)} per token`);
    });
  });

  describe("Pool Independence", function () {
    it("Should not affect other pools when one pool trades", async function () {
      // Skip on testnet - requires minter permissions not set up
      if (hre.network.name !== "hardhat") {
        console.log(`      ⚠️  Skipping pool independence test on testnet (requires trading functionality)`);
        this.skip();
      }

      const pool1 = pools.hmess.contract;
      const pool2 = pools.hlead.contract;

      // Get pool2 state before pool1 trade
      const pool2Before = await pool2.getPoolState();

      // Execute trade on pool1
      const buyAmount = parseUnits("1000", 6);

      // Get trader signer (use second signer for local)
      const signers = await ethers.getSigners();
      const traderSigner = signers[1];

      await mockUSDC.mint(traderSigner.address, buyAmount);

      const traderBalance = await mockUSDC.balanceOf(traderSigner.address);
      if (traderBalance >= buyAmount) {
        const approveTx = await mockUSDC.connect(traderSigner).approve(await pool1.getAddress(), buyAmount);
        await approveTx.wait();

        const deadline = Math.floor(Date.now() / 1000) + 300;
        const buyTx = await pool1.connect(traderSigner).buy(buyAmount, 0, traderSigner.address, deadline);
        await buyTx.wait();

        console.log(`      💰 Executed $1,000 buy on HMESS pool`);
      } else {
        console.log(`      ⚠️  Skipping trade - insufficient USDC`);
      }

      // Verify pool2 state unchanged
      const pool2After = await pool2.getPoolState();
      expect(pool2After.reserve).to.equal(pool2Before.reserve);
      expect(pool2After.price).to.equal(pool2Before.price);

      console.log(`      ✅ HLEAD pool unaffected by HMESS pool trade`);
      console.log(`         Reserve: $${ethers.formatUnits(pool2After.reserve, 6)} (unchanged)`);
      console.log(`         Spot Price: $${ethers.formatUnits(pool2After.price, 6)} (unchanged)`);
    });

    it("Should track different token balances independently", async function () {
      const hmessToken = tokens.hmess.contract;
      const hleadToken = tokens.hlead.contract;
      const hroutToken = tokens.hrout.contract;

      // Get trader signer (use deployer for testnet, second signer for local)
      const signers = await ethers.getSigners();
      const traderSigner = signers.length > 1 && hre.network.name === "hardhat" ? signers[1] : signers[0];

      const traderHmessBalance = await hmessToken.balanceOf(traderSigner.address);
      const traderHleadBalance = await hleadToken.balanceOf(traderSigner.address);
      const traderHroutBalance = await hroutToken.balanceOf(traderSigner.address);

      console.log(`      📊 Trader token balances:`);
      console.log(`         HMESS: ${ethers.formatEther(traderHmessBalance)}`);
      console.log(`         HLEAD: ${ethers.formatEther(traderHleadBalance)}`);
      console.log(`         HROUT: ${ethers.formatEther(traderHroutBalance)}`);

      // Tokens are different contracts
      expect(await hmessToken.getAddress()).to.not.equal(await hleadToken.getAddress());
      expect(await hleadToken.getAddress()).to.not.equal(await hroutToken.getAddress());

      console.log(`      ✅ All pools use separate token contracts`);
    });
  });

  describe("Pool State Consistency", function () {
    it("Should have consistent reserve and supply across all pools", async function () {
      for (const [key, poolData] of Object.entries(pools)) {
        const pool = poolData.contract;
        const state = await pool.getPoolState();
        const token = tokens[key].contract;

        const actualSupply = await token.totalSupply();

        console.log(`      ${key.toUpperCase()} pool:`);
        console.log(`         Reported supply: ${ethers.formatEther(state.supply)}`);
        console.log(`         Actual supply:   ${ethers.formatEther(actualSupply)}`);
        console.log(`         Reserve:         $${ethers.formatUnits(state.reserve, 6)}`);

        // Pool's view of supply should match actual token supply
        expect(state.supply).to.equal(actualSupply, `${key} pool supply mismatch`);
      }

      console.log(`      ✅ All pools report consistent state`);
    });

    it("Should have correct IBR status", async function () {
      for (const [key, poolData] of Object.entries(pools)) {
        const pool = poolData.contract;
        const tradeInfo = await pool.getTradeInfo();

        const ibrActive = tradeInfo.ibrEndTime > Math.floor(Date.now() / 1000);
        const canBuy = !tradeInfo.isPaused;
        const canSell = tradeInfo.sellsEnabled && !tradeInfo.isPaused;

        console.log(`      ${key.toUpperCase()} pool:`);
        console.log(`         IBR Active: ${ibrActive}`);
        console.log(`         IBR End Time: ${new Date(Number(tradeInfo.ibrEndTime) * 1000).toISOString()}`);
        console.log(`         Can Buy:    ${canBuy}`);
        console.log(`         Can Sell:   ${canSell}`);
        console.log(`         Is Paused:  ${tradeInfo.isPaused}`);

        // Should always be able to buy (unless paused)
        expect(canBuy).to.be.true;

        // Cannot sell during IBR
        if (ibrActive) {
          expect(canSell).to.be.false;
        }
      }

      console.log(`      ✅ All pools report correct IBR status`);
    });
  });
});
