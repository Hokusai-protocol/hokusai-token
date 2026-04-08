const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

/**
 * Mainnet Deployment Script
 *
 * Deploys all Hokusai contracts to Ethereum mainnet:
 * 1. ModelRegistry
 * 2. TokenManager (with HokusaiParams)
 * 3. HokusaiAMMFactory
 * 4. UsageFeeRouter
 * 5. DataContributionRegistry
 * 6. DeltaVerifier
 *
 * Note: Tokens and pools are created via separate script (create-mainnet-pools.js)
 * to allow for careful review between infrastructure and pool deployment.
 *
 * Environment Variables:
 * - TREASURY_ADDRESS: Address to receive trading fees (defaults to deployer)
 *                     IMPORTANT: For mainnet, use a multi-sig wallet!
 */

// Configuration
const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

// Factory default parameters (can be overridden per pool)
const FACTORY_DEFAULTS = {
  crr: 200000,              // 20% CRR default
  tradeFee: 30,             // 0.30% trade fee default
  ibrDuration: 7 * 24 * 60 * 60  // 7 days IBR (production)
};

// DeltaVerifier parameters
const DELTA_VERIFIER_PARAMS = {
  baseRewardRate: 1000,
  minImprovementBps: 100,           // 1% minimum improvement
  maxReward: ethers.parseEther("1000000")  // 1M tokens max reward
};

// UsageFeeRouter parameters
const USAGE_FEE_PARAMS = {
  protocolFeeBps: 500  // 5% protocol fee on usage fees
};

async function main() {
  console.log("🚀 Starting Mainnet Deployment...\n");
  console.log("=".repeat(70));
  console.log("⚠️  WARNING: Deploying to MAINNET");
  console.log("⚠️  This will deploy contracts with real ETH");
  console.log("⚠️  Please verify all addresses and parameters carefully");
  console.log("=".repeat(70));
  console.log();

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  // Validate network
  if (network.chainId !== 1n) {
    throw new Error(`Wrong network! Expected mainnet (1), got ${network.chainId}`);
  }

  // Treasury address - use environment variable or default to deployer
  const treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Treasury:", treasuryAddress);
  if (treasuryAddress === deployer.address) {
    console.log("   ⚠️  WARNING: Using deployer as treasury!");
    console.log("   ⚠️  For production, set TREASURY_ADDRESS to a multi-sig wallet");
  }
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // Check minimum balance
  if (balance < ethers.parseEther("0.5")) {
    throw new Error("Insufficient ETH! Need at least 0.5 ETH for deployment");
  }

  // Check gas price
  const feeData = await ethers.provider.getFeeData();
  const gasPriceGwei = ethers.formatUnits(feeData.gasPrice || 0n, 'gwei');
  console.log("Current gas price:", gasPriceGwei, "Gwei");

  // Safety check for high gas
  if (feeData.gasPrice > ethers.parseUnits("100", "gwei")) {
    console.log("⚠️  WARNING: Gas price is high! Consider waiting for lower gas.");
  }

  console.log("=".repeat(70));
  console.log();

  // Confirmation pause
  console.log("🛑 Please review the above information");
  console.log("   Press Ctrl+C to cancel, or wait 10 seconds to continue...\n");
  await new Promise(resolve => setTimeout(resolve, 10000));

  const deployment = {
    network: "mainnet",
    chainId: network.chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    treasury: treasuryAddress,
    contracts: {},
    gasUsed: {},
    config: {
      usdcAddress: MAINNET_USDC,
      factoryDefaults: FACTORY_DEFAULTS,
      deltaVerifierParams: DELTA_VERIFIER_PARAMS,
      usageFeeParams: USAGE_FEE_PARAMS
    }
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
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(modelRegistry.deploymentTransaction().hash)).gasUsed.toString());

    // 2. Deploy TokenManager (also deploys HokusaiParams internally)
    console.log("\n2️⃣  Deploying TokenManager (with HokusaiParams)...");
    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(registryAddress);
    await tokenManager.waitForDeployment();
    const managerAddress = await tokenManager.getAddress();
    deployment.contracts.TokenManager = managerAddress;
    console.log("   ✅ TokenManager:", managerAddress);
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(tokenManager.deploymentTransaction().hash)).gasUsed.toString());

    console.log("   🔗 Linking ModelRegistry to TokenManager for string model validation...");
    const setStringModelTokenManagerTx = await modelRegistry.setStringModelTokenManager(managerAddress);
    await setStringModelTokenManagerTx.wait();
    console.log("   ✅ ModelRegistry string validation enabled");

    // Get HokusaiParams address from TokenManager
    const paramsAddress = await tokenManager.hokusaiParams();
    deployment.contracts.HokusaiParams = paramsAddress;
    console.log("   ✅ HokusaiParams:", paramsAddress);

    // 3. Deploy DataContributionRegistry
    console.log("\n3️⃣  Deploying DataContributionRegistry...");
    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();
    const contributionRegistryAddress = await contributionRegistry.getAddress();
    deployment.contracts.DataContributionRegistry = contributionRegistryAddress;
    console.log("   ✅ DataContributionRegistry:", contributionRegistryAddress);
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(contributionRegistry.deploymentTransaction().hash)).gasUsed.toString());

    // ============================================================
    // PHASE 2: AMM Factory
    // ============================================================

    console.log("\n\n📦 PHASE 2: AMM Factory");
    console.log("-".repeat(70));

    // 4. Deploy HokusaiAMMFactory
    console.log("\n4️⃣  Deploying HokusaiAMMFactory...");
    console.log(`   USDC Address: ${MAINNET_USDC}`);
    console.log(`   Treasury: ${treasuryAddress}`);

    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    const factory = await HokusaiAMMFactory.deploy(
      registryAddress,      // modelRegistry
      managerAddress,       // tokenManager
      MAINNET_USDC,         // reserveToken (real USDC)
      treasuryAddress       // treasury
    );
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    deployment.contracts.HokusaiAMMFactory = factoryAddress;
    console.log("   ✅ HokusaiAMMFactory:", factoryAddress);
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(factory.deploymentTransaction().hash)).gasUsed.toString());

    // Set default pool parameters
    console.log("\n   ⚙️  Setting factory defaults...");
    console.log(`     CRR:          ${FACTORY_DEFAULTS.crr / 10000}%`);
    console.log(`     Trade Fee:    ${FACTORY_DEFAULTS.tradeFee / 100}%`);
    console.log(`     IBR Duration: ${FACTORY_DEFAULTS.ibrDuration / 86400} days`);

    const setDefaultsTx = await factory.setDefaults(
      FACTORY_DEFAULTS.crr,
      FACTORY_DEFAULTS.tradeFee,
      FACTORY_DEFAULTS.ibrDuration
    );
    await setDefaultsTx.wait();
    console.log("   ✅ Factory defaults configured");

    // ============================================================
    // PHASE 3: Usage Fee Router
    // ============================================================

    console.log("\n\n📦 PHASE 3: Usage Fee Router");
    console.log("-".repeat(70));

    // 5. Deploy UsageFeeRouter
    console.log("\n5️⃣  Deploying UsageFeeRouter...");
    console.log(`   Treasury: ${treasuryAddress}`);
    const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
    const feeRouter = await UsageFeeRouter.deploy(
      factoryAddress,      // factory
      MAINNET_USDC,        // reserveToken (USDC)
      treasuryAddress,     // treasury
      USAGE_FEE_PARAMS.protocolFeeBps  // 5% protocol fee
    );
    await feeRouter.waitForDeployment();
    const feeRouterAddress = await feeRouter.getAddress();
    deployment.contracts.UsageFeeRouter = feeRouterAddress;
    console.log("   ✅ UsageFeeRouter:", feeRouterAddress);
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(feeRouter.deploymentTransaction().hash)).gasUsed.toString());

    // Grant FEE_DEPOSITOR_ROLE to deployer (for initial setup)
    console.log("\n   🔐 Granting FEE_DEPOSITOR_ROLE to deployer...");
    const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
    const grantRoleTx = await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, deployer.address);
    await grantRoleTx.wait();
    console.log("   ✅ FEE_DEPOSITOR_ROLE granted");

    // ============================================================
    // PHASE 4: Delta Verifier
    // ============================================================

    console.log("\n\n📦 PHASE 4: Delta Verifier");
    console.log("-".repeat(70));

    // 6. Deploy DeltaVerifier
    console.log("\n6️⃣  Deploying DeltaVerifier...");
    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      registryAddress,
      managerAddress,
      contributionRegistryAddress,
      DELTA_VERIFIER_PARAMS.baseRewardRate,
      DELTA_VERIFIER_PARAMS.minImprovementBps,
      DELTA_VERIFIER_PARAMS.maxReward
    );
    await deltaVerifier.waitForDeployment();
    const verifierAddress = await deltaVerifier.getAddress();
    deployment.contracts.DeltaVerifier = verifierAddress;
    console.log("   ✅ DeltaVerifier:", verifierAddress);
    console.log("   📊 Gas used:", (await ethers.provider.getTransactionReceipt(deltaVerifier.deploymentTransaction().hash)).gasUsed.toString());

    // Configure access control
    console.log("\n   🔐 Configuring access control...");

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    const recorderTx = await contributionRegistry.grantRole(RECORDER_ROLE, verifierAddress);
    await recorderTx.wait();
    console.log("   ✅ RECORDER_ROLE granted to DeltaVerifier");

    // Grant VERIFIER_ROLE to deployer
    const VERIFIER_ROLE = await contributionRegistry.VERIFIER_ROLE();
    const verifierRoleTx = await contributionRegistry.grantRole(VERIFIER_ROLE, deployer.address);
    await verifierRoleTx.wait();
    console.log("   ✅ VERIFIER_ROLE granted to deployer");

    // Set DeltaVerifier in TokenManager
    const setVerifierTx = await tokenManager.setDeltaVerifier(verifierAddress);
    await setVerifierTx.wait();
    console.log("   ✅ DeltaVerifier configured in TokenManager");

    // ============================================================
    // DEPLOYMENT VERIFICATION
    // ============================================================

    console.log("\n\n📋 Verifying Deployment...");
    console.log("-".repeat(70));

    // Verify TokenManager in ModelRegistry
    const registeredManager = await modelRegistry.tokenManager();
    console.log(`✅ ModelRegistry.tokenManager = ${registeredManager}`);
    if (registeredManager.toLowerCase() !== managerAddress.toLowerCase()) {
      throw new Error("TokenManager not properly set in ModelRegistry!");
    }

    // Verify DeltaVerifier in TokenManager
    const registeredVerifier = await tokenManager.deltaVerifier();
    console.log(`✅ TokenManager.deltaVerifier = ${registeredVerifier}`);
    if (registeredVerifier.toLowerCase() !== verifierAddress.toLowerCase()) {
      throw new Error("DeltaVerifier not properly set in TokenManager!");
    }

    // Verify Factory configuration
    const factoryRegistry = await factory.modelRegistry();
    const factoryManager = await factory.tokenManager();
    const factoryReserve = await factory.reserveToken();
    const factoryTreasury = await factory.treasury();

    console.log(`✅ Factory.modelRegistry = ${factoryRegistry}`);
    console.log(`✅ Factory.tokenManager = ${factoryManager}`);
    console.log(`✅ Factory.reserveToken = ${factoryReserve}`);
    console.log(`✅ Factory.treasury = ${factoryTreasury}`);

    if (factoryRegistry.toLowerCase() !== registryAddress.toLowerCase() ||
        factoryManager.toLowerCase() !== managerAddress.toLowerCase() ||
        factoryReserve.toLowerCase() !== MAINNET_USDC.toLowerCase()) {
      throw new Error("Factory configuration mismatch!");
    }

    console.log("\n✅ All verification checks passed!");

    // ============================================================
    // SAVE DEPLOYMENT ARTIFACT
    // ============================================================

    console.log("\n\n💾 Saving Deployment Artifact...");
    console.log("-".repeat(70));

    const deploymentDir = path.join(__dirname, '..', 'deployments');
    if (!fs.existsSync(deploymentDir)) {
      fs.mkdirSync(deploymentDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `mainnet-${timestamp}.json`;
    const filepath = path.join(deploymentDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
    console.log(`✅ Deployment saved to: deployments/${filename}`);

    // Also save as "latest" for easy reference
    const latestPath = path.join(deploymentDir, 'mainnet-latest.json');
    fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
    console.log(`✅ Also saved as: deployments/mainnet-latest.json`);

    // ============================================================
    // DEPLOYMENT SUMMARY
    // ============================================================

    console.log("\n\n" + "=".repeat(70));
    console.log("🎉 MAINNET DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(70));

    console.log("\n📋 Deployed Contracts:");
    console.log(`   ModelRegistry:             ${deployment.contracts.ModelRegistry}`);
    console.log(`   TokenManager:              ${deployment.contracts.TokenManager}`);
    console.log(`   HokusaiParams:             ${deployment.contracts.HokusaiParams}`);
    console.log(`   DataContributionRegistry:  ${deployment.contracts.DataContributionRegistry}`);
    console.log(`   HokusaiAMMFactory:         ${deployment.contracts.HokusaiAMMFactory}`);
    console.log(`   UsageFeeRouter:            ${deployment.contracts.UsageFeeRouter}`);
    console.log(`   DeltaVerifier:             ${deployment.contracts.DeltaVerifier}`);

    console.log("\n🔗 View on Etherscan:");
    console.log(`   ModelRegistry:    https://etherscan.io/address/${deployment.contracts.ModelRegistry}`);
    console.log(`   TokenManager:     https://etherscan.io/address/${deployment.contracts.TokenManager}`);
    console.log(`   Factory:          https://etherscan.io/address/${deployment.contracts.HokusaiAMMFactory}`);
    console.log(`   UsageFeeRouter:   https://etherscan.io/address/${deployment.contracts.UsageFeeRouter}`);
    console.log(`   DeltaVerifier:    https://etherscan.io/address/${deployment.contracts.DeltaVerifier}`);

    console.log("\n⛽ Total Gas Summary:");
    let totalGas = 0n;
    for (const [contract, address] of Object.entries(deployment.contracts)) {
      if (contract !== "HokusaiParams") {  // HokusaiParams is deployed by TokenManager
        const receipt = await ethers.provider.getTransactionReceipt(
          (await ethers.provider.getTransaction((await ethers.getContractAt("ERC20", address)).deploymentTransaction?.hash || "")).hash
        );
        if (receipt) {
          totalGas += receipt.gasUsed;
        }
      }
    }
    const gasPrice = feeData.gasPrice || 0n;
    const totalCostEth = ethers.formatEther(totalGas * gasPrice);
    console.log(`   Total gas used: ${totalGas.toString()}`);
    console.log(`   Total cost: ${totalCostEth} ETH`);

    console.log("\n📝 Next Steps:");
    console.log("   1. Verify contracts on Etherscan:");
    console.log("      npx hardhat verify --network mainnet <address> <constructor-args>");
    console.log("   2. Create initial pools:");
    console.log("      node scripts/create-mainnet-pools.js");
    console.log("   3. Start monitoring:");
    console.log("      Configure monitoring service with addresses from deployments/mainnet-latest.json");
    console.log("   4. Test pool creation on testnet first before mainnet!");

    console.log("\n⚠️  IMPORTANT SECURITY CHECKLIST:");
    console.log("   [ ] Review all deployed contract addresses");
    console.log("   [ ] Verify contracts on Etherscan");
    console.log("   [ ] Test pool creation on testnet first");
    console.log("   [ ] Configure monitoring before creating pools");
    console.log("   [ ] Set up multi-sig for treasury and admin functions");
    console.log("   [ ] Document emergency procedures");

  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
    console.error("\n📜 Full error:");
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
