const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

// Helper to add delays between transactions (avoid rate limiting)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const TX_DELAY = 2000; // 2 seconds between transactions

/**
 * Sepolia Deployment Script for Sales Lead Scoring Model
 *
 * Deploys a real-world model (Sales Lead Scoring v2) to Sepolia for:
 * - Pre-mainnet testing with actual model data
 * - Frontend integration testing (hokus.ai)
 * - End-to-end buying flow validation
 *
 * Model Details:
 * - Model ID: 21 (from hokus.ai/explore-models/21)
 * - Name: Sales Lead Scoring v2
 * - Description: Lead scoring model for SaaS leads
 * - Ticker: LSCOR
 * - Primary Metric: Accuracy (baseline: 0.65)
 */

// Real model configuration from hokus.ai
const MODEL_CONFIG = {
  // Model metadata (from hokus.ai API)
  modelId: "21",
  name: "Sales Lead Scoring v2",
  description: "Lead scoring model for SaaS leads",
  tokenName: "Sales Lead Scoring v2",
  tokenSymbol: "LSCOR",
  primaryMetric: "accuracy",
  baselinePerformance: 0.65,

  // Token economics
  initialSupply: ethers.parseEther("1000000"), // 1M tokens
  mintRate: ethers.parseEther("1000"), // 1000 tokens per DeltaOne improvement

  // AMM parameters (realistic for testnet)
  initialReserve: ethers.parseUnits("5000", 6), // $5K USDC (testnet)
  crr: 200000, // 20% CRR (balanced)
  tradeFee: 30, // 0.30% trade fee
  protocolFee: 3000, // 30% of fees to protocol
  ibr: 2 * 24 * 60 * 60, // 2 days IBR for testnet (faster testing)

  // Metadata
  tags: ["Prediction", "Sales", "Scoring"],
  licenseType: "Decentralized",
  licenseDescription: "Generally available API for a market price using decentralized token economics"
};

async function loadExistingDeployment() {
  const deploymentPath = path.join(__dirname, '..', 'deployments', 'sepolia-latest.json');

  if (!fs.existsSync(deploymentPath)) {
    throw new Error('❌ No existing Sepolia deployment found!\n   Please run deploy-testnet-full.js first to deploy infrastructure.');
  }

  return JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
}

async function main() {
  console.log("🚀 Deploying Sales Lead Scoring Model to Sepolia...\n");
  console.log("=".repeat(70));
  console.log("📊 Model: Sales Lead Scoring v2 (ID: 21)");
  console.log("🎯 Purpose: Pre-mainnet testing & frontend integration");
  console.log("=".repeat(70));
  console.log();

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  // Validate network
  if (network.chainId !== 11155111n) {
    throw new Error(`Wrong network! Expected Sepolia (11155111), got ${network.chainId}`);
  }

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);

  // Load existing deployment
  console.log("\n📂 Loading existing infrastructure...");
  const deployment = await loadExistingDeployment();
  console.log("✅ Loaded deployment from:", deployment.timestamp);

  const usdcAddress = deployment.contracts.MockUSDC;
  const registryAddress = deployment.contracts.ModelRegistry;
  const managerAddress = deployment.contracts.TokenManager;
  const factoryAddress = deployment.contracts.HokusaiAMMFactory;

  console.log("\n📋 Existing Contract Addresses:");
  console.log(`   MockUSDC:         ${usdcAddress}`);
  console.log(`   ModelRegistry:    ${registryAddress}`);
  console.log(`   TokenManager:     ${managerAddress}`);
  console.log(`   AMMFactory:       ${factoryAddress}`);

  // Get contract instances
  const usdc = await ethers.getContractAt("IERC20", usdcAddress);
  const modelRegistry = await ethers.getContractAt("ModelRegistry", registryAddress);
  const tokenManager = await ethers.getContractAt("TokenManager", managerAddress);
  const factory = await ethers.getContractAt("HokusaiAMMFactory", factoryAddress);

  // Check balances
  const usdcBalance = await usdc.balanceOf(deployer.address);
  const ethBalance = await ethers.provider.getBalance(deployer.address);

  console.log("\n💰 Deployer Balances:");
  console.log(`   USDC:  ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  console.log(`   ETH:   ${ethers.formatEther(ethBalance)} ETH`);

  if (usdcBalance < MODEL_CONFIG.initialReserve) {
    console.log("\n⚠️  Insufficient USDC! Minting additional funds...");
    const mockUSDC = await ethers.getContractAt("MockUSDC", usdcAddress);
    const mintTx = await mockUSDC.mint(deployer.address, MODEL_CONFIG.initialReserve);
    await mintTx.wait();
    console.log("✅ Minted additional USDC");
  }

  // Display model configuration
  console.log("\n📊 Model Configuration:");
  console.log(`   Model ID:         ${MODEL_CONFIG.modelId}`);
  console.log(`   Name:             ${MODEL_CONFIG.name}`);
  console.log(`   Symbol:           ${MODEL_CONFIG.tokenSymbol}`);
  console.log(`   Description:      ${MODEL_CONFIG.description}`);
  console.log(`   Primary Metric:   ${MODEL_CONFIG.primaryMetric}`);
  console.log(`   Baseline:         ${MODEL_CONFIG.baselinePerformance}`);
  console.log(`   Initial Supply:   ${ethers.formatEther(MODEL_CONFIG.initialSupply)} tokens`);
  console.log(`   Mint Rate:        ${ethers.formatEther(MODEL_CONFIG.mintRate)} tokens/DeltaOne`);

  console.log("\n💰 AMM Configuration:");
  console.log(`   Initial Reserve:  $${ethers.formatUnits(MODEL_CONFIG.initialReserve, 6)} USDC`);
  console.log(`   CRR:              ${MODEL_CONFIG.crr / 10000}%`);
  console.log(`   Trade Fee:        ${MODEL_CONFIG.tradeFee / 100}%`);
  console.log(`   Protocol Fee:     ${MODEL_CONFIG.protocolFee / 100}%`);
  console.log(`   IBR Duration:     ${MODEL_CONFIG.ibr / 86400} days`);

  // Confirmation pause
  console.log("\n🛑 Please review the configuration above");
  console.log("   Press Ctrl+C to cancel, or wait 10 seconds to continue...\n");
  await new Promise(resolve => setTimeout(resolve, 10000));

  // ============================================================
  // DEPLOY TOKEN
  // ============================================================

  console.log("\n📦 Step 1: Deploy Token");
  console.log("-".repeat(70));

  console.log(`📝 Deploying token: ${MODEL_CONFIG.tokenName} (${MODEL_CONFIG.tokenSymbol})`);
  const tokenTx = await tokenManager.deployToken(
    MODEL_CONFIG.modelId,
    MODEL_CONFIG.tokenName,
    MODEL_CONFIG.tokenSymbol,
    MODEL_CONFIG.initialSupply
  );
  const tokenReceipt = await tokenTx.wait();
  console.log(`⛽ Gas used: ${tokenReceipt.gasUsed.toString()}`);
  await delay(TX_DELAY);

  // Extract token address from event
  let tokenAddress;
  for (const log of tokenReceipt.logs) {
    try {
      const parsed = tokenManager.interface.parseLog(log);
      if (parsed && parsed.name === 'TokenDeployed') {
        tokenAddress = parsed.args.tokenAddress;
      }
    } catch (e) {
      // Skip logs from other contracts
    }
  }

  if (!tokenAddress) {
    throw new Error("Failed to extract token address from TokenDeployed event");
  }

  console.log(`✅ Token deployed: ${tokenAddress}`);
  console.log(`🔗 Sepolia Etherscan: https://sepolia.etherscan.io/token/${tokenAddress}`);

  // ============================================================
  // REGISTER MODEL
  // ============================================================

  console.log("\n📦 Step 2: Register Model");
  console.log("-".repeat(70));

  console.log(`📋 Registering model in ModelRegistry...`);
  const registerTx = await modelRegistry.registerStringModel(
    MODEL_CONFIG.modelId,
    tokenAddress,
    MODEL_CONFIG.primaryMetric
  );
  const registerReceipt = await registerTx.wait();
  console.log(`✅ Model registered: ${MODEL_CONFIG.modelId}`);
  console.log(`⛽ Gas used: ${registerReceipt.gasUsed.toString()}`);
  await delay(TX_DELAY);

  // ============================================================
  // CREATE AMM POOL
  // ============================================================

  console.log("\n📦 Step 3: Create AMM Pool");
  console.log("-".repeat(70));

  console.log(`🏊 Creating AMM pool...`);
  const poolTx = await factory.createPoolWithParams(
    MODEL_CONFIG.modelId,
    tokenAddress,
    MODEL_CONFIG.crr,
    MODEL_CONFIG.tradeFee,
    MODEL_CONFIG.protocolFee,
    MODEL_CONFIG.ibr
  );
  const poolReceipt = await poolTx.wait();
  console.log(`⛽ Gas used: ${poolReceipt.gasUsed.toString()}`);
  await delay(TX_DELAY);

  // Extract pool address from event
  let poolAddress;
  for (const log of poolReceipt.logs) {
    try {
      const parsed = factory.interface.parseLog(log);
      if (parsed && parsed.name === 'PoolCreated') {
        poolAddress = parsed.args.poolAddress;
      }
    } catch (e) {
      // Skip logs from other contracts
    }
  }

  if (!poolAddress) {
    throw new Error("Failed to extract pool address from PoolCreated event");
  }

  console.log(`✅ Pool created: ${poolAddress}`);
  console.log(`🔗 Sepolia Etherscan: https://sepolia.etherscan.io/address/${poolAddress}`);

  // ============================================================
  // INITIALIZE POOL WITH LIQUIDITY
  // ============================================================

  console.log("\n📦 Step 4: Initialize Pool");
  console.log("-".repeat(70));

  console.log(`💰 Adding initial liquidity ($${ethers.formatUnits(MODEL_CONFIG.initialReserve, 6)} USDC)...`);

  const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);

  // Approve USDC
  console.log(`🔓 Approving USDC...`);
  const approveTx = await usdc.approve(poolAddress, MODEL_CONFIG.initialReserve);
  await approveTx.wait();
  console.log(`✅ USDC approved`);
  await delay(TX_DELAY);

  // Deposit initial reserve
  console.log(`💵 Depositing initial reserve...`);
  const depositTx = await pool.depositFees(MODEL_CONFIG.initialReserve);
  const depositReceipt = await depositTx.wait();
  console.log(`✅ Initial reserve deposited`);
  console.log(`⛽ Gas used: ${depositReceipt.gasUsed.toString()}`);
  await delay(TX_DELAY);

  // ============================================================
  // VERIFY POOL STATE
  // ============================================================

  console.log("\n📦 Step 5: Verify Pool State");
  console.log("-".repeat(70));

  const reserveBalance = await pool.reserveBalance();
  const spotPrice = await pool.spotPrice();
  const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
  const totalSupply = await token.totalSupply();
  const poolIBREnd = await pool.buyOnlyUntil();
  const currentTime = Math.floor(Date.now() / 1000);
  const ibrRemaining = Number(poolIBREnd) - currentTime;

  console.log(`📊 Pool State:`);
  console.log(`   Reserve:         $${ethers.formatUnits(reserveBalance, 6)} USDC`);
  console.log(`   Spot Price:      $${ethers.formatUnits(spotPrice, 6)}`);
  console.log(`   Total Supply:    ${ethers.formatEther(totalSupply)} ${MODEL_CONFIG.tokenSymbol}`);
  console.log(`   Market Cap:      $${ethers.formatUnits(reserveBalance * 10n ** 18n / BigInt(MODEL_CONFIG.crr) * 1000000n / 10n ** 18n, 6)}`);
  console.log(`   IBR Ends:        ${new Date(Number(poolIBREnd) * 1000).toISOString()}`);
  console.log(`   IBR Remaining:   ${(ibrRemaining / 3600).toFixed(1)} hours`);

  // ============================================================
  // UPDATE DEPLOYMENT FILE
  // ============================================================

  console.log("\n📦 Step 6: Update Deployment Record");
  console.log("-".repeat(70));

  // Add to deployment record
  if (!deployment.models) deployment.models = [];

  deployment.models.push({
    modelId: MODEL_CONFIG.modelId,
    name: MODEL_CONFIG.name,
    description: MODEL_CONFIG.description,
    symbol: MODEL_CONFIG.tokenSymbol,
    tokenAddress: tokenAddress,
    ammAddress: poolAddress,
    primaryMetric: MODEL_CONFIG.primaryMetric,
    baselinePerformance: MODEL_CONFIG.baselinePerformance,
    initialSupply: MODEL_CONFIG.initialSupply.toString(),
    initialReserve: MODEL_CONFIG.initialReserve.toString(),
    crr: MODEL_CONFIG.crr,
    tradeFee: MODEL_CONFIG.tradeFee,
    protocolFee: MODEL_CONFIG.protocolFee,
    ibrDuration: MODEL_CONFIG.ibr,
    ibrEndsAt: new Date(Number(poolIBREnd) * 1000).toISOString(),
    deployedAt: new Date().toISOString(),
    tags: MODEL_CONFIG.tags,
    licenseType: MODEL_CONFIG.licenseType
  });

  deployment.lastUpdated = new Date().toISOString();

  // Save updated deployment
  const deploymentDir = path.join(__dirname, '..', 'deployments');
  const timestamp = new Date().toISOString().split('T')[0];
  const filename = `sepolia-${timestamp}.json`;
  const filepath = path.join(deploymentDir, filename);

  fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Deployment saved to: deployments/${filename}`);

  // Update latest
  const latestPath = path.join(deploymentDir, 'sepolia-latest.json');
  fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Updated: deployments/sepolia-latest.json`);

  // ============================================================
  // SUMMARY
  // ============================================================

  console.log("\n\n" + "=".repeat(70));
  console.log("🎉 SALES LEAD SCORING MODEL DEPLOYED!");
  console.log("=".repeat(70));

  console.log("\n📊 Model Details:");
  console.log(`   Model ID:       ${MODEL_CONFIG.modelId}`);
  console.log(`   Name:           ${MODEL_CONFIG.name}`);
  console.log(`   Symbol:         ${MODEL_CONFIG.tokenSymbol}`);
  console.log(`   hokus.ai URL:   https://hokus.ai/explore-models/${MODEL_CONFIG.modelId}`);

  console.log("\n🪙 Token:");
  console.log(`   Address:        ${tokenAddress}`);
  console.log(`   Etherscan:      https://sepolia.etherscan.io/token/${tokenAddress}`);

  console.log("\n🏊 AMM Pool:");
  console.log(`   Address:        ${poolAddress}`);
  console.log(`   Reserve:        $${ethers.formatUnits(reserveBalance, 6)} USDC`);
  console.log(`   Spot Price:     $${ethers.formatUnits(spotPrice, 6)}`);
  console.log(`   Market Cap:     $${ethers.formatUnits(reserveBalance * 10n ** 18n / BigInt(MODEL_CONFIG.crr) * 1000000n / 10n ** 18n, 6)}`);
  console.log(`   Etherscan:      https://sepolia.etherscan.io/address/${poolAddress}`);

  console.log("\n⏰ IBR Status:");
  console.log(`   Duration:       ${MODEL_CONFIG.ibr / 86400} days`);
  console.log(`   Ends:           ${new Date(Number(poolIBREnd) * 1000).toISOString()}`);
  console.log(`   Remaining:      ${(ibrRemaining / 3600).toFixed(1)} hours`);
  console.log(`   ⚠️  Sells disabled until IBR expires`);

  console.log("\n📱 Frontend Integration Info:");
  console.log(`   Network:        Sepolia (Chain ID: 11155111)`);
  console.log(`   Model ID:       "${MODEL_CONFIG.modelId}"`);
  console.log(`   AMM Address:    "${poolAddress}"`);
  console.log(`   Token Address:  "${tokenAddress}"`);
  console.log(`   USDC Address:   "${usdcAddress}"`);
  console.log(`   Registry:       "${registryAddress}"`);

  console.log("\n📝 Next Steps:");
  console.log("   1. ✅ Share contract addresses with hokus.ai frontend team");
  console.log("   2. 🔍 Monitor deployment at https://contracts.hokus.ai/health");
  console.log("   3. 🧪 Test buy transaction through hokus.ai UI");
  console.log("   4. 📊 Verify events appear in monitoring dashboard");
  console.log("   5. ⏰ Wait for IBR to expire, then test sell transaction");
  console.log("   6. 📈 Validate price impact calculations match expectations");

  console.log("\n🔗 Quick Links:");
  console.log(`   Token:   https://sepolia.etherscan.io/token/${tokenAddress}`);
  console.log(`   Pool:    https://sepolia.etherscan.io/address/${poolAddress}`);
  console.log(`   Model:   https://hokus.ai/explore-models/${MODEL_CONFIG.modelId}`);

  console.log("\n💡 Test Transaction:");
  console.log(`   Try buying $100 worth of ${MODEL_CONFIG.tokenSymbol} tokens through the UI`);
  console.log(`   Expected price impact: ~0.4% (depends on CRR and reserve size)`);

}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Deployment failed:", error);
    process.exit(1);
  });
