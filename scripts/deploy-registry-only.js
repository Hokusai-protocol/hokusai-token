const hre = require("hardhat");
const fs = require('fs');

/**
 * Deploy DataContributionRegistry to an existing Hokusai deployment
 * Usage: npx hardhat run scripts/deploy-registry-only.js --network sepolia
 */
async function main() {
  console.log("🚀 Deploying DataContributionRegistry to existing deployment...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Load existing deployment (if available)
  let existingDeployment;
  try {
    existingDeployment = JSON.parse(fs.readFileSync('deployment-sepolia.json', 'utf8'));
    console.log("📋 Loaded existing deployment:");
    console.log(`   DeltaVerifier: ${existingDeployment.contracts.deltaVerifier}`);
    console.log(`   TokenManager: ${existingDeployment.contracts.tokenManager}`);
    console.log();
  } catch (e) {
    console.log("⚠️  No existing deployment file found (deployment-sepolia.json)");
    console.log("   You'll need to manually configure role grants\n");
  }

  // Prompt for configuration
  const config = {
    deltaVerifierAddress: existingDeployment?.contracts?.deltaVerifier || process.env.DELTA_VERIFIER_ADDRESS,
    verifierRoleAddress: deployer.address, // Default to deployer, can be changed
  };

  try {
    // 1. Deploy DataContributionRegistry
    console.log("1️⃣ Deploying DataContributionRegistry...");
    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();
    const contributionRegistryAddress = await contributionRegistry.getAddress();
    console.log("   ✅ DataContributionRegistry:", contributionRegistryAddress);

    // 2. Grant RECORDER_ROLE to DeltaVerifier (if address provided)
    if (config.deltaVerifierAddress) {
      console.log("\n2️⃣ Granting RECORDER_ROLE to DeltaVerifier...");
      const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
      const grantRecorderTx = await contributionRegistry.grantRole(
        RECORDER_ROLE,
        config.deltaVerifierAddress
      );
      await grantRecorderTx.wait();
      console.log(`   ✅ RECORDER_ROLE granted to ${config.deltaVerifierAddress}`);
    } else {
      console.log("\n⚠️  Skipping RECORDER_ROLE grant (DeltaVerifier address not provided)");
      console.log("   Set DELTA_VERIFIER_ADDRESS env var or update deployment-sepolia.json");
    }

    // 3. Grant VERIFIER_ROLE to deployer/backend
    console.log("\n3️⃣ Granting VERIFIER_ROLE...");
    const VERIFIER_ROLE = await contributionRegistry.VERIFIER_ROLE();
    const grantVerifierTx = await contributionRegistry.grantRole(
      VERIFIER_ROLE,
      config.verifierRoleAddress
    );
    await grantVerifierTx.wait();
    console.log(`   ✅ VERIFIER_ROLE granted to ${config.verifierRoleAddress}`);

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("🎉 REGISTRY DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(70));
    console.log("\n📋 Contract Address:");
    console.log(`CONTRIBUTION_REGISTRY_ADDRESS=${contributionRegistryAddress}`);

    console.log("\n🔐 Access Control:");
    console.log(`RECORDER_ROLE: ${config.deltaVerifierAddress || 'NOT SET'}`);
    console.log(`VERIFIER_ROLE: ${config.verifierRoleAddress}`);
    console.log(`DEFAULT_ADMIN_ROLE: ${deployer.address}`);

    console.log("\n🔗 View on Etherscan:");
    console.log(`https://sepolia.etherscan.io/address/${contributionRegistryAddress}`);

    // Save deployment info
    const registryDeployment = {
      network: "sepolia",
      timestamp: new Date().toISOString(),
      deployer: deployer.address,
      contract: {
        contributionRegistry: contributionRegistryAddress
      },
      accessControl: {
        recorderRole: {
          role: await contributionRegistry.RECORDER_ROLE(),
          grantedTo: config.deltaVerifierAddress || "NOT_SET",
          description: "Can record contributions (DeltaVerifier)"
        },
        verifierRole: {
          role: await contributionRegistry.VERIFIER_ROLE(),
          grantedTo: config.verifierRoleAddress,
          description: "Can verify/reject contributions (Backend service)"
        }
      }
    };

    fs.writeFileSync(
      'deployment-registry-only.json',
      JSON.stringify(registryDeployment, null, 2)
    );
    console.log("\n💾 Registry deployment info saved to deployment-registry-only.json");

    // Next steps
    console.log("\n📝 Next Steps:");
    console.log("\n1. Verify contract on Etherscan:");
    console.log(`   npx hardhat verify --network sepolia ${contributionRegistryAddress}`);

    if (!config.deltaVerifierAddress) {
      console.log("\n2. Grant RECORDER_ROLE to DeltaVerifier manually:");
      console.log("   const registry = await ethers.getContractAt('DataContributionRegistry', '<REGISTRY_ADDRESS>');");
      console.log("   const RECORDER_ROLE = await registry.RECORDER_ROLE();");
      console.log("   await registry.grantRole(RECORDER_ROLE, '<DELTA_VERIFIER_ADDRESS>');");
    }

    console.log("\n3. IMPORTANT: Redeploy DeltaVerifier with registry address");
    console.log("   The existing DeltaVerifier does NOT have the registry parameter.");
    console.log("   You'll need to deploy a new DeltaVerifier instance:");
    console.log("   - Include contributionRegistryAddress in constructor");
    console.log("   - Update TokenManager.setDeltaVerifier() to new address");
    console.log("   - Grant RECORDER_ROLE to new DeltaVerifier");

    console.log("\n4. Update backend service .env:");
    console.log(`   CONTRIBUTION_REGISTRY_ADDRESS=${contributionRegistryAddress}`);

  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
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
