const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

/**
 * Mainnet Pool Creation Script
 *
 * Creates initial AMM pools on mainnet using deployed infrastructure.
 * This is separate from deploy-mainnet.js to allow review between steps.
 *
 * Prerequisites:
 * - All infrastructure contracts deployed (run deploy-mainnet.js first)
 * - Deployment artifact exists at deployments/mainnet-latest.json
 * - Deployer wallet has sufficient USDC for initial reserves
 * - Deployer wallet has sufficient ETH for gas
 */

// Initial pool configurations
// NOTE: Adjust these values carefully for mainnet!
const POOL_CONFIGS = {
  conservative: {
    name: "Conservative Pool (30% CRR)",
    modelId: "model-conservative-001",
    tokenName: "Hokusai Conservative",
    tokenSymbol: "HKS-CON",
    initialReserve: ethers.parseUnits("10000", 6), // $10k USDC
    initialSupply: ethers.parseEther("1000000"), // 1M tokens
    crr: 300000, // 30% CRR (300000 ppm)
    tradeFee: 30, // 0.30% (30 bps)
    ibr: 7 * 24 * 60 * 60, // 7 days IBR (production)
  },
  aggressive: {
    name: "Aggressive Pool (10% CRR)",
    modelId: "model-aggressive-002",
    tokenName: "Hokusai Aggressive",
    tokenSymbol: "HKS-AGG",
    initialReserve: ethers.parseUnits("50000", 6), // $50k USDC
    initialSupply: ethers.parseEther("500000"), // 500k tokens
    crr: 100000, // 10% CRR (more volatile)
    tradeFee: 30, // 0.30% (30 bps)
    ibr: 7 * 24 * 60 * 60, // 7 days IBR
  },
  balanced: {
    name: "Balanced Pool (20% CRR)",
    modelId: "model-balanced-003",
    tokenName: "Hokusai Balanced",
    tokenSymbol: "HKS-BAL",
    initialReserve: ethers.parseUnits("25000", 6), // $25k USDC
    initialSupply: ethers.parseEther("2000000"), // 2M tokens
    crr: 200000, // 20% CRR
    tradeFee: 30, // 0.30% (30 bps)
    ibr: 7 * 24 * 60 * 60, // 7 days IBR
  }
};

// Which pools to create (modify this to create specific pools)
const POOLS_TO_CREATE = ['conservative', 'aggressive', 'balanced'];

async function loadDeployment() {
  const deploymentPath = path.join(__dirname, '..', 'deployments', 'mainnet-latest.json');

  if (!fs.existsSync(deploymentPath)) {
    throw new Error('Deployment artifact not found! Run deploy-mainnet.js first.');
  }

  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
}

async function main() {
  console.log("🏊 Creating Mainnet AMM Pools...\n");
  console.log("=".repeat(70));
  console.log("⚠️  WARNING: Creating pools on MAINNET");
  console.log("⚠️  This will use real USDC for initial reserves");
  console.log("⚠️  Please verify all parameters carefully");
  console.log("=".repeat(70));
  console.log();

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  // Validate network
  if (network.chainId !== 1n) {
    throw new Error(`Wrong network! Expected mainnet (1), got ${network.chainId}`);
  }

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);

  // Load deployment info
  console.log("\n📂 Loading deployment info...");
  const deployment = await loadDeployment();
  console.log("✅ Loaded deployment from:", deployment.timestamp);

  const usdcAddress = deployment.config.usdcAddress;
  const registryAddress = deployment.contracts.ModelRegistry;
  const managerAddress = deployment.contracts.TokenManager;
  const factoryAddress = deployment.contracts.HokusaiAMMFactory;

  console.log("\n📋 Contract Addresses:");
  console.log(`   USDC:             ${usdcAddress}`);
  console.log(`   ModelRegistry:    ${registryAddress}`);
  console.log(`   TokenManager:     ${managerAddress}`);
  console.log(`   AMMFactory:       ${factoryAddress}`);

  // Get contract instances
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);
  const modelRegistry = await ethers.getContractAt("ModelRegistry", registryAddress);
  const tokenManager = await ethers.getContractAt("TokenManager", managerAddress);
  const factory = await ethers.getContractAt("HokusaiAMMFactory", factoryAddress);

  // Check USDC balance
  const usdcBalance = await usdc.balanceOf(deployer.address);
  console.log("\n💰 Deployer USDC balance:", ethers.formatUnits(usdcBalance, 6), "USDC");

  // Calculate total USDC needed
  let totalUsdcNeeded = 0n;
  for (const configKey of POOLS_TO_CREATE) {
    totalUsdcNeeded += POOL_CONFIGS[configKey].initialReserve;
  }
  console.log("💰 Total USDC needed:", ethers.formatUnits(totalUsdcNeeded, 6), "USDC");

  if (usdcBalance < totalUsdcNeeded) {
    throw new Error(`Insufficient USDC! Need ${ethers.formatUnits(totalUsdcNeeded, 6)} USDC`);
  }

  // Check ETH balance
  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Deployer ETH balance:", ethers.formatEther(ethBalance), "ETH");

  if (ethBalance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient ETH! Need at least 0.1 ETH for gas");
  }

  // Show pool configs
  console.log("\n📊 Pools to Create:");
  for (const configKey of POOLS_TO_CREATE) {
    const config = POOL_CONFIGS[configKey];
    console.log(`\n   ${config.name}:`);
    console.log(`     Model ID:        ${config.modelId}`);
    console.log(`     Token:           ${config.tokenName} (${config.tokenSymbol})`);
    console.log(`     Initial Reserve: $${ethers.formatUnits(config.initialReserve, 6)} USDC`);
    console.log(`     Initial Supply:  ${ethers.formatEther(config.initialSupply)} tokens`);
    console.log(`     CRR:             ${config.crr / 10000}%`);
    console.log(`     Trade Fee:       ${config.tradeFee / 100}%`);
    console.log(`     IBR Duration:    ${config.ibr / 86400} days`);
  }

  // Confirmation pause
  console.log("\n🛑 Please review the above information");
  console.log("   Press Ctrl+C to cancel, or wait 15 seconds to continue...\n");
  await new Promise(resolve => setTimeout(resolve, 15000));

  // Add tokens and pools arrays to deployment
  if (!deployment.tokens) deployment.tokens = [];
  if (!deployment.pools) deployment.pools = [];

  // ============================================================
  // CREATE POOLS
  // ============================================================

  console.log("\n📦 Creating Pools...");
  console.log("-".repeat(70));

  for (const configKey of POOLS_TO_CREATE) {
    const config = POOL_CONFIGS[configKey];
    console.log(`\n🏊 Creating ${config.name}...`);
    console.log("   " + "-".repeat(66));

    try {
      // 1. Deploy token via TokenManager
      console.log(`   📝 Deploying token: ${config.tokenName} (${config.tokenSymbol})`);
      const tokenTx = await tokenManager.deployToken(
        config.modelId,
        config.tokenName,
        config.tokenSymbol,
        config.initialSupply
      );
      const tokenReceipt = await tokenTx.wait();
      console.log(`   ⛽ Gas used: ${tokenReceipt.gasUsed.toString()}`);

      // Extract token address from event
      let tokenAddress;
      for (const log of tokenReceipt.logs) {
        try {
          const parsed = tokenManager.interface.parseLog(log);
          if (parsed.name === 'TokenDeployed') {
            tokenAddress = parsed.args.tokenAddress;
          }
        } catch (e) {
          // Skip logs from other contracts
        }
      }

      if (!tokenAddress) {
        throw new Error("Failed to extract token address from TokenDeployed event");
      }

      console.log(`   ✅ Token deployed: ${tokenAddress}`);
      console.log(`   🔗 View on Etherscan: https://etherscan.io/token/${tokenAddress}`);

      // 2. Register model in ModelRegistry
      console.log(`   📋 Registering model in ModelRegistry...`);
      const registerTx = await modelRegistry.registerStringModel(config.modelId, tokenAddress, "accuracy");
      const registerReceipt = await registerTx.wait();
      console.log(`   ✅ Model registered: ${config.modelId}`);
      console.log(`   ⛽ Gas used: ${registerReceipt.gasUsed.toString()}`);

      // 3. Create pool via Factory
      console.log(`   🏊 Creating AMM pool...`);
      const poolTx = await factory.createPoolWithParams(
        config.modelId,
        tokenAddress,
        config.crr,
        config.tradeFee,
        config.ibr,
        ethers.parseUnits("25000", 6), // $25k flat curve threshold
        ethers.parseUnits("0.01", 6)   // $0.01 flat curve price
      );
      const poolReceipt = await poolTx.wait();
      console.log(`   ⛽ Gas used: ${poolReceipt.gasUsed.toString()}`);

      // Extract pool address from event
      let poolAddress;
      for (const log of poolReceipt.logs) {
        try {
          const parsed = factory.interface.parseLog(log);
          if (parsed.name === 'PoolCreated') {
            poolAddress = parsed.args.poolAddress;
          }
        } catch (e) {
          // Skip logs from other contracts
        }
      }

      if (!poolAddress) {
        throw new Error("Failed to extract pool address from PoolCreated event");
      }

      console.log(`   ✅ Pool created: ${poolAddress}`);
      console.log(`   🔗 View on Etherscan: https://etherscan.io/address/${poolAddress}`);

      // 4. Authorize AMM to mint tokens
      console.log(`   🔐 Authorizing AMM to mint tokens...`);
      const authorizeTx = await tokenManager.authorizeAMM(poolAddress);
      await authorizeTx.wait();
      console.log(`   ✅ AMM authorized with MINTER_ROLE`);

      // 5. Initialize pool with liquidity
      console.log(`   💰 Adding initial liquidity ($${ethers.formatUnits(config.initialReserve, 6)} USDC)...`);

      const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);

      // Approve USDC
      console.log(`   🔓 Approving USDC...`);
      const approveTx = await usdc.approve(poolAddress, config.initialReserve);
      await approveTx.wait();
      console.log(`   ✅ USDC approved`);

      // Deposit initial reserve
      console.log(`   💵 Depositing initial reserve...`);
      const depositTx = await pool.depositFees(config.initialReserve);
      const depositReceipt = await depositTx.wait();
      console.log(`   ✅ Initial reserve deposited`);
      console.log(`   ⛽ Gas used: ${depositReceipt.gasUsed.toString()}`);

      // Verify pool state
      const reserveBalance = await pool.reserveBalance();
      const spotPrice = await pool.spotPrice();
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
      const totalSupply = await token.totalSupply();

      console.log(`\n   📊 Pool State:`);
      console.log(`     Reserve:     $${ethers.formatUnits(reserveBalance, 6)} USDC`);
      console.log(`     Spot Price:  $${ethers.formatUnits(spotPrice, 6)}`);
      console.log(`     Supply:      ${ethers.formatEther(totalSupply)} tokens`);
      console.log(`     Market Cap:  $${ethers.formatUnits(reserveBalance * 10n ** 18n / BigInt(config.crr) * 1000000n / 10n ** 18n, 6)}`);

      // Fetch phase parameters from deployed pool
      console.log(`\n   📊 Fetching phase parameters...`);
      const flatCurveThreshold = await pool.FLAT_CURVE_THRESHOLD();
      const flatCurvePrice = await pool.FLAT_CURVE_PRICE();

      console.log(`   ✅ Phase Parameters:`);
      console.log(`      Flat Curve Threshold: $${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
      console.log(`      Flat Curve Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

      // Store token and pool info
      deployment.tokens.push({
        configKey: configKey,
        modelId: config.modelId,
        name: config.tokenName,
        symbol: config.tokenSymbol,
        address: tokenAddress,
        initialSupply: config.initialSupply.toString()
      });

      deployment.pools.push({
        configKey: configKey,
        modelId: config.modelId,
        tokenAddress: tokenAddress,
        ammAddress: poolAddress,
        initialReserve: config.initialReserve.toString(),
        crr: config.crr,
        tradeFee: config.tradeFee,
        ibrDuration: config.ibr,
        ibrEndsAt: new Date(Date.now() + config.ibr * 1000).toISOString(),
        flatCurveThreshold: ethers.formatUnits(ethers.parseUnits("25000", 6), 6),
        flatCurvePrice: ethers.formatUnits(ethers.parseUnits("0.01", 6), 6)
      });

      console.log(`   ✅ ${config.name} complete!`);

    } catch (error) {
      console.error(`   ❌ Failed to create ${config.name}:`, error.message);
      throw error;
    }
  }

  // ============================================================
  // SAVE UPDATED DEPLOYMENT
  // ============================================================

  console.log("\n\n💾 Saving Updated Deployment...");
  console.log("-".repeat(70));

  deployment.poolsCreatedAt = new Date().toISOString();

  const deploymentDir = path.join(__dirname, '..', 'deployments');
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `mainnet-${timestamp}.json`;
  const filepath = path.join(deploymentDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Deployment saved to: deployments/${filename}`);

  // Update latest
  const latestPath = path.join(deploymentDir, 'mainnet-latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Updated: deployments/mainnet-latest.json`);

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log("\n\n" + "=".repeat(70));
  console.log("🎉 POOL CREATION SUCCESSFUL!");
  console.log("=".repeat(70));

  console.log("\n🪙 Tokens Created:");
  for (const token of deployment.tokens) {
    console.log(`   ${token.name} (${token.symbol}):`);
    console.log(`     Address:    ${token.address}`);
    console.log(`     Model ID:   ${token.modelId}`);
    console.log(`     Etherscan:  https://etherscan.io/token/${token.address}`);
  }

  console.log("\n🏊 Pools Created:");
  for (const pool of deployment.pools) {
    const config = POOL_CONFIGS[pool.configKey];
    console.log(`   ${config.name}:`);
    console.log(`     AMM Address:    ${pool.ammAddress}`);
    console.log(`     Token Address:  ${pool.tokenAddress}`);
    console.log(`     Model ID:       ${pool.modelId}`);
    console.log(`     Initial Reserve: $${ethers.formatUnits(pool.initialReserve, 6)} USDC`);
    console.log(`     CRR:            ${pool.crr / 10000}%`);
    console.log(`     Trade Fee:      ${pool.tradeFee / 100}%`);
    console.log(`     IBR Ends:       ${pool.ibrEndsAt}`);
    console.log(`     Etherscan:      https://etherscan.io/address/${pool.ammAddress}`);
  }

  console.log("\n📝 Next Steps:");
  console.log("   1. Configure monitoring service:");
  console.log("      - Use addresses from deployments/mainnet-latest.json");
  console.log("      - Monitoring will auto-discover new pools via PoolCreated events");
  console.log("   2. Start monitoring service BEFORE announcing pools");
  console.log("   3. Test buy/sell functionality with small amounts");
  console.log("   4. Monitor for IBR period (7 days)");
  console.log("   5. Verify all events are being captured by monitoring");

  console.log("\n⚠️  IMPORTANT POST-DEPLOYMENT:");
  console.log("   [ ] Monitoring service running and receiving events");
  console.log("   [ ] Test small buy transaction on each pool");
  console.log("   [ ] Verify reserve balances match expectations");
  console.log("   [ ] Confirm IBR end times (sells disabled until then)");
  console.log("   [ ] Set up alerts for large trades and price movements");
  console.log("   [ ] Monitor CloudWatch dashboard for metrics");
  console.log("   [ ] Document pool addresses in team documentation");

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Pool creation failed:", error);
    process.exit(1);
  });
