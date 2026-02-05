const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

/**
 * Comprehensive Testnet Deployment Script V2 (with Infrastructure Cost Accrual)
 *
 * Deploys all Hokusai contracts to Sepolia testnet:
 * 1. ModelRegistry
 * 2. TokenManager (with updated HokusaiParams - infrastructure accrual)
 * 3. MockUSDC
 * 4. HokusaiAMMFactory (with two-phase pricing)
 * 5. InfrastructureReserve (NEW)
 * 6. UsageFeeRouter (UPDATED - no protocol fee, infrastructure split)
 * 7. HokusaiToken - LSCOR token via TokenManager
 * 8. HokusaiAMM - LSCOR pool with 10% CRR and two-phase pricing
 * 9. DataContributionRegistry
 * 10. DeltaVerifier
 *
 * Environment Variables:
 * - TREASURY_ADDRESS: Address to receive fees and manage infrastructure payments (defaults to deployer)
 * - BACKEND_SERVICE_ADDRESS: Backend service for FEE_DEPOSITOR_ROLE (defaults to deployer)
 */

// Pool configurations
const POOL_CONFIGS = {
  lscor: {
    name: "LSCOR Pool (10% CRR)",
    modelId: "21", // Model ID from hokus.ai/explore-models/21
    tokenName: "Hokusai LSCOR",
    tokenSymbol: "LSCOR",
    initialReserve: ethers.parseUnits("100", 6), // $100 - Small initial reserve to test flat price phase
    initialSupply: ethers.parseEther("1000"), // 1,000 tokens initially
    crr: 100000, // 10% CRR
    tradeFee: 30, // 0.30% (30 bps)
    ibr: 7 * 24 * 60 * 60, // 7 days
    flatCurveThreshold: ethers.parseUnits("25000", 6), // $25k threshold
    flatCurvePrice: ethers.parseUnits("0.01", 6), // $0.01 per token
    infrastructureAccrualBps: 8000, // 80% infrastructure accrual (default)
  }
};

async function main() {
  console.log("🚀 Starting Full Testnet Deployment V2 (Infrastructure Cost Accrual)...\n");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  // Treasury and backend service addresses
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;
  const backendAddress = process.env.BACKEND_SERVICE_ADDRESS || deployer.address;

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Treasury:", treasuryAddress);
  console.log("Backend Service:", backendAddress);
  if (treasuryAddress === deployer.address) {
    console.log("   ⚠️  Using deployer as treasury (set TREASURY_ADDRESS env var to change)");
  }
  if (backendAddress === deployer.address) {
    console.log("   ⚠️  Using deployer as backend service (set BACKEND_SERVICE_ADDRESS env var to change)");
  }
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("=".repeat(70));
  console.log();

  const deployment = {
    network: network.name,
    chainId: network.chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    treasury: treasuryAddress,
    backendService: backendAddress,
    contracts: {},
    tokens: [],
    pools: [],
    roles: {},
    gasUsed: {}
  };

  try {
    // ============================================================
    // PHASE 1: Core Infrastructure
    // ============================================================

    console.log("📦 PHASE 1: Core Infrastructure");
    console.log("-".repeat(70));

    // 1. Deploy ModelRegistry
    console.log("\n1️⃣  Deploying ModelRegistry...");
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();
    const registryAddress = await modelRegistry.getAddress();
    deployment.contracts.ModelRegistry = registryAddress;
    console.log("   ✅ ModelRegistry:", registryAddress);

    // 2. Deploy TokenManager
    console.log("\n2️⃣  Deploying TokenManager...");
    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(registryAddress);
    await tokenManager.waitForDeployment();
    const managerAddress = await tokenManager.getAddress();
    deployment.contracts.TokenManager = managerAddress;
    console.log("   ✅ TokenManager:", managerAddress);

    // 3. Deploy DataContributionRegistry
    console.log("\n3️⃣  Deploying DataContributionRegistry...");
    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();
    const contributionRegistryAddress = await contributionRegistry.getAddress();
    deployment.contracts.DataContributionRegistry = contributionRegistryAddress;
    console.log("   ✅ DataContributionRegistry:", contributionRegistryAddress);

    // ============================================================
    // PHASE 2: Mock USDC for Testing
    // ============================================================

    console.log("\n\n📦 PHASE 2: Test Token");
    console.log("-".repeat(70));

    // 4. Deploy MockUSDC and mint test funds
    console.log("\n4️⃣  Deploying MockUSDC...");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();
    const usdcAddress = await mockUSDC.getAddress();
    deployment.contracts.MockUSDC = usdcAddress;
    console.log("   ✅ MockUSDC:", usdcAddress);

    console.log("   💰 Minting $1,000,000 test USDC to deployer...");
    const mintTx = await mockUSDC.mint(deployer.address, ethers.parseUnits("1000000", 6));
    await mintTx.wait();
    const usdcBalance = await mockUSDC.balanceOf(deployer.address);
    console.log("   ✅ Deployer USDC balance:", ethers.formatUnits(usdcBalance, 6), "USDC");

    // ============================================================
    // PHASE 3: AMM Factory
    // ============================================================

    console.log("\n\n📦 PHASE 3: AMM Factory");
    console.log("-".repeat(70));

    // 5. Deploy HokusaiAMMFactory
    console.log("\n5️⃣  Deploying HokusaiAMMFactory...");
    console.log(`   Treasury: ${treasuryAddress}`);
    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    const factory = await HokusaiAMMFactory.deploy(
      registryAddress,      // modelRegistry
      managerAddress,       // tokenManager
      usdcAddress,          // reserveToken (USDC)
      treasuryAddress       // treasury
    );
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    deployment.contracts.HokusaiAMMFactory = factoryAddress;
    console.log("   ✅ HokusaiAMMFactory:", factoryAddress);

    // ============================================================
    // PHASE 4: Infrastructure Cost Accrual System (NEW)
    // ============================================================

    console.log("\n\n📦 PHASE 4: Infrastructure Cost Accrual System");
    console.log("-".repeat(70));

    // 6. Deploy InfrastructureReserve
    console.log("\n6️⃣  Deploying InfrastructureReserve...");
    const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
    const infraReserve = await InfrastructureReserve.deploy(
      usdcAddress,       // reserveToken (USDC)
      factoryAddress,    // HokusaiAMMFactory
      treasuryAddress    // treasury (for emergency withdrawals)
    );
    await infraReserve.waitForDeployment();
    const infraReserveAddress = await infraReserve.getAddress();
    deployment.contracts.InfrastructureReserve = infraReserveAddress;
    console.log("   ✅ InfrastructureReserve:", infraReserveAddress);

    // 7. Deploy UsageFeeRouter (updated - no protocol fee)
    console.log("\n7️⃣  Deploying UsageFeeRouter (V2 - Infrastructure Split)...");
    const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
    const feeRouter = await UsageFeeRouter.deploy(
      factoryAddress,       // factory
      usdcAddress,          // reserveToken (USDC)
      infraReserveAddress   // infrastructureReserve (NEW)
    );
    await feeRouter.waitForDeployment();
    const feeRouterAddress = await feeRouter.getAddress();
    deployment.contracts.UsageFeeRouter = feeRouterAddress;
    console.log("   ✅ UsageFeeRouter:", feeRouterAddress);
    console.log("   ℹ️  No protocol fee - splits dynamically per model (default 80/20)");

    // Configure infrastructure system roles
    console.log("\n   🔐 Configuring Infrastructure System Roles...");

    const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
    const PAYER_ROLE = await infraReserve.PAYER_ROLE();
    const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();

    // Grant DEPOSITOR_ROLE to UsageFeeRouter
    await infraReserve.grantRole(DEPOSITOR_ROLE, feeRouterAddress);
    console.log("   ✅ DEPOSITOR_ROLE granted to UsageFeeRouter");
    deployment.roles.InfrastructureReserve_DEPOSITOR = feeRouterAddress;

    // Grant PAYER_ROLE to Treasury
    await infraReserve.grantRole(PAYER_ROLE, treasuryAddress);
    console.log("   ✅ PAYER_ROLE granted to Treasury");
    deployment.roles.InfrastructureReserve_PAYER = treasuryAddress;

    // Grant FEE_DEPOSITOR_ROLE to Backend Service
    await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, backendAddress);
    console.log("   ✅ FEE_DEPOSITOR_ROLE granted to Backend Service");
    deployment.roles.UsageFeeRouter_FEE_DEPOSITOR = backendAddress;

    // ============================================================
    // PHASE 5: Deploy Tokens and Pools
    // ============================================================

    console.log("\n\n📦 PHASE 5: Deploy Tokens and Pools");
    console.log("-".repeat(70));

    for (const [configKey, config] of Object.entries(POOL_CONFIGS)) {
      console.log(`\n🎯 Deploying ${config.name}...`);

      // 8. Deploy token via TokenManager (automatically creates HokusaiParams with new infrastructure accrual)
      console.log(`   🪙 Deploying ${config.tokenSymbol} token...`);
      const tokenTx = await tokenManager.deployToken(
        config.modelId,
        config.tokenName,
        config.tokenSymbol,
        config.initialSupply
      );
      const tokenReceipt = await tokenTx.wait();

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
      console.log(`   ✅ Token deployed: ${tokenAddress}`);

      // Get HokusaiParams address
      const paramsAddress = await tokenManager.modelParams(config.modelId);
      console.log(`   📋 HokusaiParams: ${paramsAddress}`);
      console.log(`   ℹ️  Default infrastructure accrual: 80% (can be adjusted by governance)`);

      // Register model in ModelRegistry
      console.log(`   📋 Registering model in ModelRegistry...`);
      await modelRegistry.registerStringModel(config.modelId, tokenAddress, "accuracy");
      console.log(`   ✅ Model registered: ${config.modelId}`);

      // 9. Create pool via Factory
      console.log(`   🏊 Creating AMM pool...`);

      const poolTx = await factory.createPoolWithParams(
        config.modelId,
        tokenAddress,
        config.crr,
        config.tradeFee,
        config.ibr,
        config.flatCurveThreshold,
        config.flatCurvePrice
      );
      const poolReceipt = await poolTx.wait();

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
      console.log(`   ✅ Pool created: ${poolAddress}`);

      // 10. Authorize AMM to mint tokens
      console.log(`   🔐 Authorizing AMM to mint tokens...`);
      const authorizeTx = await tokenManager.authorizeAMM(poolAddress);
      await authorizeTx.wait();
      console.log(`   ✅ AMM authorized with MINTER_ROLE`);

      // 11. Set provider for infrastructure payments
      console.log(`   🏭 Setting infrastructure provider to treasury...`);
      await infraReserve.setProvider(config.modelId, treasuryAddress);
      console.log(`   ✅ Provider set (can be updated later)`);

      // 12. Initialize pool with liquidity (if any)
      if (config.initialReserve > 0n) {
        console.log(`   💰 Adding initial liquidity...`);
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        const pool = HokusaiAMM.attach(poolAddress);

        // Approve and deposit initial reserve
        const approveTx = await mockUSDC.approve(poolAddress, config.initialReserve);
        await approveTx.wait();
        const depositTx = await pool.depositFees(config.initialReserve);
        await depositTx.wait();
        console.log(`   ✅ Initial reserve added: $${ethers.formatUnits(config.initialReserve, 6)} USDC`);
      } else {
        console.log(`   ✅ Pool created with $0 initial reserve (will start in FLAT_PRICE phase)`);
      }

      // Fetch phase parameters from deployed pool
      console.log(`   📊 Fetching phase parameters...`);
      const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
      const poolContract = HokusaiAMM.attach(poolAddress);
      const flatCurveThreshold = await poolContract.FLAT_CURVE_THRESHOLD();
      const flatCurvePrice = await poolContract.FLAT_CURVE_PRICE();

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
        paramsAddress: paramsAddress,
        initialSupply: config.initialSupply.toString(),
        infrastructureAccrualBps: config.infrastructureAccrualBps
      });

      deployment.pools.push({
        configKey: configKey,
        modelId: config.modelId,
        tokenAddress: tokenAddress,
        ammAddress: poolAddress,
        paramsAddress: paramsAddress,
        initialReserve: config.initialReserve.toString(),
        crr: config.crr,
        tradeFee: config.tradeFee,
        ibrDuration: config.ibr,
        flatCurveThreshold: flatCurveThreshold.toString(),
        flatCurvePrice: flatCurvePrice.toString()
      });

      console.log(`   ✅ ${config.name} complete!`);
    }

    // ============================================================
    // PHASE 6: Delta Verifier
    // ============================================================

    console.log("\n\n📦 PHASE 6: Delta Verifier");
    console.log("-".repeat(70));

    // 13. Deploy DeltaVerifier
    console.log("\n1️⃣3️⃣ Deploying DeltaVerifier...");
    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      registryAddress,
      managerAddress,
      contributionRegistryAddress,
      100000,                         // baseRewardRate - 100,000 tokens per delta-one
      100,                            // minImprovementBps (1%)
      ethers.parseEther("1000000")    // maxReward (1M tokens)
    );
    await deltaVerifier.waitForDeployment();
    const verifierAddress = await deltaVerifier.getAddress();
    deployment.contracts.DeltaVerifier = verifierAddress;
    console.log("   ✅ DeltaVerifier:", verifierAddress);

    // Configure access control
    console.log("   🔐 Configuring access control...");

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, verifierAddress);
    console.log("   ✅ RECORDER_ROLE granted to DeltaVerifier");

    // Grant VERIFIER_ROLE to deployer (can be transferred later)
    const VERIFIER_ROLE = await contributionRegistry.VERIFIER_ROLE();
    await contributionRegistry.grantRole(VERIFIER_ROLE, deployer.address);
    console.log("   ✅ VERIFIER_ROLE granted to deployer");

    // Set DeltaVerifier in TokenManager
    await tokenManager.setDeltaVerifier(verifierAddress);
    console.log("   ✅ DeltaVerifier configured in TokenManager");

    // ============================================================
    // DEPLOYMENT SUMMARY
    // ============================================================

    console.log("\n\n" + "=".repeat(70));
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(70));

    console.log("\n📋 Core Contracts:");
    console.log(`   ModelRegistry:             ${deployment.contracts.ModelRegistry}`);
    console.log(`   TokenManager:              ${deployment.contracts.TokenManager}`);
    console.log(`   DataContributionRegistry:  ${deployment.contracts.DataContributionRegistry}`);
    console.log(`   MockUSDC:                  ${deployment.contracts.MockUSDC}`);
    console.log(`   HokusaiAMMFactory:         ${deployment.contracts.HokusaiAMMFactory}`);

    console.log("\n💰 Infrastructure Cost Accrual System (NEW):");
    console.log(`   InfrastructureReserve:     ${deployment.contracts.InfrastructureReserve}`);
    console.log(`   UsageFeeRouter (V2):       ${deployment.contracts.UsageFeeRouter}`);

    console.log("\n📊 Other Contracts:");
    console.log(`   DeltaVerifier:             ${deployment.contracts.DeltaVerifier}`);

    console.log("\n🪙 Tokens:");
    for (const token of deployment.tokens) {
      console.log(`   ${token.name} (${token.symbol}):`);
      console.log(`     Token Address:   ${token.address}`);
      console.log(`     Params Address:  ${token.paramsAddress}`);
      console.log(`     Model ID:        ${token.modelId}`);
      console.log(`     Infra Accrual:   ${token.infrastructureAccrualBps / 100}%`);
    }

    console.log("\n🏊 Pools:");
    for (const pool of deployment.pools) {
      console.log(`   ${POOL_CONFIGS[pool.configKey].name}:`);
      console.log(`     AMM Address:    ${pool.ammAddress}`);
      console.log(`     Token Address:  ${pool.tokenAddress}`);
      console.log(`     Model ID:       ${pool.modelId}`);
      console.log(`     CRR:            ${pool.crr / 10000}%`);
      console.log(`     Trade Fee:      ${pool.tradeFee / 100}%`);
      console.log(`     IBR Duration:   ${pool.ibrDuration / 86400} days`);
    }

    console.log("\n🔐 Roles:");
    console.log(`   InfrastructureReserve DEPOSITOR: ${deployment.roles.InfrastructureReserve_DEPOSITOR}`);
    console.log(`   InfrastructureReserve PAYER:     ${deployment.roles.InfrastructureReserve_PAYER}`);
    console.log(`   UsageFeeRouter FEE_DEPOSITOR:    ${deployment.roles.UsageFeeRouter_FEE_DEPOSITOR}`);

    if (network.chainId === 11155111n) {
      console.log("\n🔗 View on Sepolia Etherscan:");
      console.log(`   Factory:              https://sepolia.etherscan.io/address/${deployment.contracts.HokusaiAMMFactory}`);
      console.log(`   InfrastructureReserve: https://sepolia.etherscan.io/address/${deployment.contracts.InfrastructureReserve}`);
      console.log(`   UsageFeeRouter:       https://sepolia.etherscan.io/address/${deployment.contracts.UsageFeeRouter}`);

      console.log("\n   Tokens:");
      for (const token of deployment.tokens) {
        console.log(`     ${token.symbol}: https://sepolia.etherscan.io/token/${token.address}`);
      }

      console.log("\n   Pools:");
      for (const pool of deployment.pools) {
        console.log(`     ${pool.modelId}: https://sepolia.etherscan.io/address/${pool.ammAddress}`);
      }
    }

    // Save deployment to file
    const deploymentDir = path.join(__dirname, '..', 'deployments');
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${network.name}-v2-${timestamp}.json`;
    const filepath = path.join(deploymentDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
    console.log(`\n💾 Deployment info saved to: deployments/${filename}`);

    // Also save as "latest" for easy reference
    const latestPath = path.join(deploymentDir, `${network.name}-v2-latest.json`);
    fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
    console.log(`💾 Also saved as: deployments/${network.name}-v2-latest.json`);

    console.log("\n✅ All contracts deployed successfully!");
    console.log("   - 10 contract types");
    console.log("   - Infrastructure cost accrual system integrated");
    console.log("   - 80/20 default infrastructure/profit split");

    console.log("\n📝 Next Steps:");
    console.log("   1. Test API fee deposit: feeRouter.depositFee(modelId, amount)");
    console.log("   2. Verify 80/20 split: Check infraReserve.accrued() and pool.reserveBalance()");
    console.log("   3. Test infrastructure payment: infraReserve.payInfrastructureCost()");
    console.log("   4. Monitor accrual runway: infraReserve.getAccrualRunway(modelId, dailyBurnRate)");
    console.log("   5. Adjust split via governance: params.setInfrastructureAccrualBps(newBps)");

  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
