const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

/**
 * Infrastructure Cost Accrual System Deployment
 *
 * Deploys and configures the new infrastructure cost accrual contracts:
 * 1. InfrastructureReserve - Tracks and manages infrastructure cost accrual
 * 2. UsageFeeRouter (updated) - Routes API fees with dynamic infrastructure splits
 *
 * Prerequisites:
 * - HokusaiAMMFactory must be deployed
 * - MockUSDC (or real USDC) must be deployed
 * - Treasury address must be configured
 *
 * Usage:
 *   # Deploy to testnet
 *   npx hardhat run scripts/deploy-infrastructure-system.js --network sepolia
 *
 *   # Deploy to mainnet
 *   TREASURY_ADDRESS=0x... npx hardhat run scripts/deploy-infrastructure-system.js --network mainnet
 *
 * Environment Variables:
 * - FACTORY_ADDRESS: HokusaiAMMFactory address (required if not in deployment file)
 * - USDC_ADDRESS: USDC token address (required if not in deployment file)
 * - TREASURY_ADDRESS: Treasury multisig address (defaults to deployer)
 * - BACKEND_SERVICE_ADDRESS: Backend service for FEE_DEPOSITOR_ROLE
 */

async function main() {
  console.log("🏗️  Infrastructure Cost Accrual System Deployment");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH");
  console.log("=".repeat(70));
  console.log();

  // ============================================================
  // LOAD EXISTING DEPLOYMENT OR USE ENV VARS
  // ============================================================

  let factoryAddress, usdcAddress, treasuryAddress;

  // Try to load from existing deployment file
  const deploymentPath = path.join(__dirname, '../deployments', `${network.name}-latest.json`);
  if (fs.existsSync(deploymentPath)) {
    console.log("📂 Loading existing deployment...");
    const existingDeployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

    factoryAddress = existingDeployment.contracts.HokusaiAMMFactory;
    usdcAddress = existingDeployment.contracts.MockUSDC || existingDeployment.contracts.USDC;
    treasuryAddress = existingDeployment.treasury;

    console.log("   ✅ Loaded from:", deploymentPath);
    console.log("   Factory:", factoryAddress);
    console.log("   USDC:", usdcAddress);
    console.log("   Treasury:", treasuryAddress);
  } else {
    console.log("⚠️  No deployment file found, using environment variables");

    factoryAddress = process.env.FACTORY_ADDRESS;
    usdcAddress = process.env.USDC_ADDRESS;
    treasuryAddress = process.env.TREASURY_ADDRESS || deployer.address;

    if (!factoryAddress) {
      throw new Error("FACTORY_ADDRESS environment variable required");
    }
    if (!usdcAddress) {
      throw new Error("USDC_ADDRESS environment variable required");
    }
  }

  // Backend service address for fee depositor role
  const backendAddress = process.env.BACKEND_SERVICE_ADDRESS || deployer.address;

  console.log("\n📋 Configuration:");
  console.log("   Factory:", factoryAddress);
  console.log("   USDC:", usdcAddress);
  console.log("   Treasury:", treasuryAddress);
  console.log("   Backend Service:", backendAddress);
  if (treasuryAddress === deployer.address) {
    console.log("   ⚠️  Treasury is deployer (set TREASURY_ADDRESS for production)");
  }
  if (backendAddress === deployer.address) {
    console.log("   ⚠️  Backend service is deployer (set BACKEND_SERVICE_ADDRESS for production)");
  }
  console.log();

  const deployment = {
    network: network.name,
    chainId: network.chainId.toString(),
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    treasury: treasuryAddress,
    backendService: backendAddress,
    contracts: {
      HokusaiAMMFactory: factoryAddress,
      USDC: usdcAddress
    },
    roles: {},
    gasUsed: {}
  };

  try {
    // ============================================================
    // PHASE 1: Deploy InfrastructureReserve
    // ============================================================

    console.log("📦 PHASE 1: Deploy InfrastructureReserve");
    console.log("-".repeat(70));

    console.log("\n1️⃣  Deploying InfrastructureReserve...");
    console.log("   Parameters:");
    console.log("   - Reserve Token:", usdcAddress);
    console.log("   - Factory:", factoryAddress);
    console.log("   - Treasury:", treasuryAddress);

    const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
    const infraReserve = await InfrastructureReserve.deploy(
      usdcAddress,      // reserveToken (USDC)
      factoryAddress,   // HokusaiAMMFactory
      treasuryAddress   // treasury (for emergency withdrawals)
    );
    await infraReserve.waitForDeployment();
    const infraReserveAddress = await infraReserve.getAddress();
    deployment.contracts.InfrastructureReserve = infraReserveAddress;

    const infraDeployTx = infraReserve.deploymentTransaction();
    const infraReceipt = await infraDeployTx.wait();
    deployment.gasUsed.InfrastructureReserve = infraReceipt.gasUsed.toString();

    console.log("   ✅ InfrastructureReserve deployed!");
    console.log("   Address:", infraReserveAddress);
    console.log("   Gas used:", infraReceipt.gasUsed.toString());

    // ============================================================
    // PHASE 2: Deploy UsageFeeRouter
    // ============================================================

    console.log("\n\n📦 PHASE 2: Deploy UsageFeeRouter");
    console.log("-".repeat(70));

    console.log("\n2️⃣  Deploying UsageFeeRouter...");
    console.log("   Parameters:");
    console.log("   - Factory:", factoryAddress);
    console.log("   - Reserve Token:", usdcAddress);
    console.log("   - Infrastructure Reserve:", infraReserveAddress);

    const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
    const feeRouter = await UsageFeeRouter.deploy(
      factoryAddress,      // HokusaiAMMFactory
      usdcAddress,         // reserveToken (USDC)
      infraReserveAddress  // InfrastructureReserve
    );
    await feeRouter.waitForDeployment();
    const feeRouterAddress = await feeRouter.getAddress();
    deployment.contracts.UsageFeeRouter = feeRouterAddress;

    const routerDeployTx = feeRouter.deploymentTransaction();
    const routerReceipt = await routerDeployTx.wait();
    deployment.gasUsed.UsageFeeRouter = routerReceipt.gasUsed.toString();

    console.log("   ✅ UsageFeeRouter deployed!");
    console.log("   Address:", feeRouterAddress);
    console.log("   Gas used:", routerReceipt.gasUsed.toString());

    // ============================================================
    // PHASE 3: Configure Roles
    // ============================================================

    console.log("\n\n📦 PHASE 3: Configure Access Control");
    console.log("-".repeat(70));

    // Get role identifiers
    const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
    const PAYER_ROLE = await infraReserve.PAYER_ROLE();
    const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();

    console.log("\n3️⃣  Granting DEPOSITOR_ROLE to UsageFeeRouter...");
    console.log("   Router:", feeRouterAddress);
    const grantDepositorTx = await infraReserve.grantRole(DEPOSITOR_ROLE, feeRouterAddress);
    await grantDepositorTx.wait();
    console.log("   ✅ DEPOSITOR_ROLE granted");
    deployment.roles.InfrastructureReserve_DEPOSITOR = feeRouterAddress;

    console.log("\n4️⃣  Granting PAYER_ROLE to Treasury...");
    console.log("   Treasury:", treasuryAddress);
    const grantPayerTx = await infraReserve.grantRole(PAYER_ROLE, treasuryAddress);
    await grantPayerTx.wait();
    console.log("   ✅ PAYER_ROLE granted");
    deployment.roles.InfrastructureReserve_PAYER = treasuryAddress;

    console.log("\n5️⃣  Granting FEE_DEPOSITOR_ROLE to Backend Service...");
    console.log("   Backend:", backendAddress);
    const grantFeeDepositorTx = await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, backendAddress);
    await grantFeeDepositorTx.wait();
    console.log("   ✅ FEE_DEPOSITOR_ROLE granted");
    deployment.roles.UsageFeeRouter_FEE_DEPOSITOR = backendAddress;

    // ============================================================
    // PHASE 4: Verification
    // ============================================================

    console.log("\n\n📦 PHASE 4: Verify Configuration");
    console.log("-".repeat(70));

    console.log("\n6️⃣  Verifying contract state...");

    // Verify InfrastructureReserve
    const verifiedReserveToken = await infraReserve.reserveToken();
    const verifiedFactory = await infraReserve.factory();
    const verifiedTreasury = await infraReserve.treasury();

    console.log("   InfrastructureReserve:");
    console.log("   ✅ Reserve Token:", verifiedReserveToken === usdcAddress ? "✓" : "✗", verifiedReserveToken);
    console.log("   ✅ Factory:", verifiedFactory === factoryAddress ? "✓" : "✗", verifiedFactory);
    console.log("   ✅ Treasury:", verifiedTreasury === treasuryAddress ? "✓" : "✗", verifiedTreasury);

    // Verify UsageFeeRouter
    const verifiedRouterFactory = await feeRouter.factory();
    const verifiedRouterReserve = await feeRouter.reserveToken();
    const verifiedRouterInfra = await feeRouter.infraReserve();

    console.log("\n   UsageFeeRouter:");
    console.log("   ✅ Factory:", verifiedRouterFactory === factoryAddress ? "✓" : "✗", verifiedRouterFactory);
    console.log("   ✅ Reserve Token:", verifiedRouterReserve === usdcAddress ? "✓" : "✗", verifiedRouterReserve);
    console.log("   ✅ Infrastructure Reserve:", verifiedRouterInfra === infraReserveAddress ? "✓" : "✗", verifiedRouterInfra);

    // Verify roles
    const hasDepositorRole = await infraReserve.hasRole(DEPOSITOR_ROLE, feeRouterAddress);
    const hasPayerRole = await infraReserve.hasRole(PAYER_ROLE, treasuryAddress);
    const hasFeeDepositorRole = await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, backendAddress);

    console.log("\n   Roles:");
    console.log("   ✅ Router has DEPOSITOR_ROLE:", hasDepositorRole ? "✓" : "✗");
    console.log("   ✅ Treasury has PAYER_ROLE:", hasPayerRole ? "✓" : "✗");
    console.log("   ✅ Backend has FEE_DEPOSITOR_ROLE:", hasFeeDepositorRole ? "✓" : "✗");

    // ============================================================
    // SAVE DEPLOYMENT
    // ============================================================

    console.log("\n\n📝 Saving Deployment");
    console.log("-".repeat(70));

    const deploymentsDir = path.join(__dirname, '../deployments');
    if (!fs.existsSync(deploymentsDir)) {
      fs.mkdirSync(deploymentsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `${network.name}-infrastructure-${timestamp}.json`;
    const filepath = path.join(deploymentsDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(deployment, null, 2));
    console.log("   ✅ Saved:", filepath);

    // Also save as latest
    const latestPath = path.join(deploymentsDir, `${network.name}-infrastructure-latest.json`);
    fs.writeFileSync(latestPath, JSON.stringify(deployment, null, 2));
    console.log("   ✅ Saved:", latestPath);

    // ============================================================
    // SUMMARY
    // ============================================================

    console.log("\n\n✨ Deployment Complete!");
    console.log("=".repeat(70));
    console.log("\n📋 Contract Addresses:");
    console.log("   InfrastructureReserve:", infraReserveAddress);
    console.log("   UsageFeeRouter:", feeRouterAddress);

    console.log("\n🔐 Roles Configured:");
    console.log("   DEPOSITOR_ROLE →", feeRouterAddress);
    console.log("   PAYER_ROLE →", treasuryAddress);
    console.log("   FEE_DEPOSITOR_ROLE →", backendAddress);

    console.log("\n💰 Total Gas Used:");
    const totalGas = BigInt(deployment.gasUsed.InfrastructureReserve) + BigInt(deployment.gasUsed.UsageFeeRouter);
    console.log("   ", totalGas.toString(), "gas");

    console.log("\n📖 Next Steps:");
    console.log("   1. Update backend configuration with new UsageFeeRouter address");
    console.log("   2. Set provider addresses: infraReserve.setProvider(modelId, providerAddress)");
    console.log("   3. Test API fee deposits via UsageFeeRouter.depositFee()");
    console.log("   4. Verify infrastructure accrual rates in HokusaiParams (default 80%)");
    console.log("   5. Configure monitoring for accrual runway");

    if (network.name !== "hardhat" && network.name !== "localhost") {
      console.log("\n🔍 Verify on Etherscan:");
      console.log(`   npx hardhat verify --network ${network.name} ${infraReserveAddress} ${usdcAddress} ${factoryAddress} ${treasuryAddress}`);
      console.log(`   npx hardhat verify --network ${network.name} ${feeRouterAddress} ${factoryAddress} ${usdcAddress} ${infraReserveAddress}`);
    }

    console.log("\n" + "=".repeat(70));

  } catch (error) {
    console.error("\n❌ Deployment failed:", error);
    throw error;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
