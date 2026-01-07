const hre = require("hardhat");

async function main() {
  console.log("🚀 Starting Sepolia deployment with DataContributionRegistry...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

  // Configuration
  const config = {
    modelId: "1",
    name: "Hokusai Token",
    symbol: "HOKU",
    totalSupply: ethers.parseEther("1000000"),
    tokensPerDeltaOne: 1000,
    infraMarkupBps: 500,
    licenseHash: ethers.ZeroHash,
    licenseURI: "",
    governor: deployer.address,
    verifierAddress: deployer.address // Use deployer address for VERIFIER_ROLE
  };

  try {
    // 1. Deploy ModelRegistry
    console.log("1️⃣ Deploying ModelRegistry...");
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();
    const registryAddress = await modelRegistry.getAddress();
    console.log("   ✅ ModelRegistry:", registryAddress);

    // 2. Deploy TokenManager
    console.log("\n2️⃣ Deploying TokenManager...");
    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(registryAddress);
    await tokenManager.waitForDeployment();
    const managerAddress = await tokenManager.getAddress();
    console.log("   ✅ TokenManager:", managerAddress);

    // 3. Deploy DataContributionRegistry
    console.log("\n3️⃣ Deploying DataContributionRegistry...");
    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();
    const contributionRegistryAddress = await contributionRegistry.getAddress();
    console.log("   ✅ DataContributionRegistry:", contributionRegistryAddress);

    // 4. Deploy Token with Params
    console.log("\n4️⃣ Deploying Token with Params...");
    console.log("   This may take a minute...");

    const tx = await tokenManager.deployTokenWithParams(
      config.modelId,
      config.name,
      config.symbol,
      config.totalSupply,
      {
        tokensPerDeltaOne: config.tokensPerDeltaOne,
        infraMarkupBps: config.infraMarkupBps,
        licenseHash: config.licenseHash,
        licenseURI: config.licenseURI,
        governor: config.governor
      }
    );

    console.log("   Waiting for confirmation...");
    const receipt = await tx.wait();

    // Extract addresses from events
    let tokenAddress, paramsAddress;
    for (const log of receipt.logs) {
      try {
        const parsed = tokenManager.interface.parseLog(log);
        if (parsed.name === 'TokenDeployed') {
          tokenAddress = parsed.args.tokenAddress;
        } else if (parsed.name === 'ParamsDeployed') {
          paramsAddress = parsed.args.paramsAddress;
        }
      } catch (e) {
        // Skip logs from other contracts
      }
    }

    console.log("   ✅ HokusaiToken:", tokenAddress);
    console.log("   ✅ HokusaiParams:", paramsAddress);

    // 5. Deploy DeltaVerifier (with DataContributionRegistry)
    console.log("\n5️⃣ Deploying DeltaVerifier...");
    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      registryAddress,
      managerAddress,
      contributionRegistryAddress, // NEW: Add registry address
      1000,  // baseRewardRate
      100,   // minImprovementBps
      ethers.parseEther("1000000") // maxReward
    );
    await deltaVerifier.waitForDeployment();
    const verifierAddress = await deltaVerifier.getAddress();
    console.log("   ✅ DeltaVerifier:", verifierAddress);

    // 6. Configure Access Control
    console.log("\n6️⃣ Configuring Access Control...");

    // Grant RECORDER_ROLE to DeltaVerifier
    console.log("   Granting RECORDER_ROLE to DeltaVerifier...");
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    const grantRecorderTx = await contributionRegistry.grantRole(RECORDER_ROLE, verifierAddress);
    await grantRecorderTx.wait();
    console.log("   ✅ RECORDER_ROLE granted to DeltaVerifier");

    // Grant VERIFIER_ROLE to deployer (can be transferred later)
    console.log("   Granting VERIFIER_ROLE to:", config.verifierAddress);
    const VERIFIER_ROLE = await contributionRegistry.VERIFIER_ROLE();
    const grantVerifierTx = await contributionRegistry.grantRole(VERIFIER_ROLE, config.verifierAddress);
    await grantVerifierTx.wait();
    console.log("   ✅ VERIFIER_ROLE granted to", config.verifierAddress);

    // Set DeltaVerifier in TokenManager
    console.log("   Setting DeltaVerifier in TokenManager...");
    const setVerifierTx = await tokenManager.setDeltaVerifier(verifierAddress);
    await setVerifierTx.wait();
    console.log("   ✅ DeltaVerifier configured in TokenManager");

    // Register model in ModelRegistry
    console.log("   Registering model in ModelRegistry...");
    const registerTx = await modelRegistry.registerModel(
      config.modelId,
      tokenAddress,
      "accuracy"
    );
    await registerTx.wait();
    console.log("   ✅ Model registered");

    // Summary
    console.log("\n" + "=".repeat(70));
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(70));
    console.log("\n📋 Contract Addresses:");
    console.log(`MODEL_REGISTRY_ADDRESS=${registryAddress}`);
    console.log(`TOKEN_MANAGER_ADDRESS=${managerAddress}`);
    console.log(`CONTRIBUTION_REGISTRY_ADDRESS=${contributionRegistryAddress}`);
    console.log(`HOKUSAI_TOKEN_ADDRESS=${tokenAddress}`);
    console.log(`HOKUSAI_PARAMS_ADDRESS=${paramsAddress}`);
    console.log(`DELTA_VERIFIER_ADDRESS=${verifierAddress}`);

    console.log("\n🔐 Access Control:");
    console.log(`RECORDER_ROLE (DeltaVerifier): ${verifierAddress}`);
    console.log(`VERIFIER_ROLE (Backend): ${config.verifierAddress}`);
    console.log(`DEFAULT_ADMIN_ROLE: ${deployer.address}`);

    console.log("\n🔗 View on Etherscan:");
    console.log(`ModelRegistry: https://sepolia.etherscan.io/address/${registryAddress}`);
    console.log(`TokenManager: https://sepolia.etherscan.io/address/${managerAddress}`);
    console.log(`ContributionRegistry: https://sepolia.etherscan.io/address/${contributionRegistryAddress}`);
    console.log(`Token: https://sepolia.etherscan.io/address/${tokenAddress}`);
    console.log(`Params: https://sepolia.etherscan.io/address/${paramsAddress}`);
    console.log(`DeltaVerifier: https://sepolia.etherscan.io/address/${verifierAddress}`);

    // Save to file
    const fs = require('fs');
    const deploymentInfo = {
      network: "sepolia",
      timestamp: new Date().toISOString(),
      deployer: deployer.address,
      contracts: {
        modelRegistry: registryAddress,
        tokenManager: managerAddress,
        contributionRegistry: contributionRegistryAddress,
        hokusaiToken: tokenAddress,
        hokusaiParams: paramsAddress,
        deltaVerifier: verifierAddress
      },
      accessControl: {
        recorderRole: {
          role: RECORDER_ROLE,
          grantedTo: verifierAddress,
          description: "Can record contributions (DeltaVerifier)"
        },
        verifierRole: {
          role: VERIFIER_ROLE,
          grantedTo: config.verifierAddress,
          description: "Can verify/reject contributions (Backend service)"
        },
        adminRole: {
          grantedTo: deployer.address,
          description: "Can grant/revoke roles"
        }
      },
      config: {
        modelId: config.modelId,
        tokensPerDeltaOne: config.tokensPerDeltaOne,
        infraMarkupBps: config.infraMarkupBps
      }
    };

    fs.writeFileSync(
      'deployment-sepolia-with-registry.json',
      JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("\n💾 Deployment info saved to deployment-sepolia-with-registry.json");

    // Verification instructions
    console.log("\n📝 Next Steps:");
    console.log("1. Verify contracts on Etherscan (optional):");
    console.log(`   npx hardhat verify --network sepolia ${contributionRegistryAddress}`);
    console.log(`   npx hardhat verify --network sepolia ${verifierAddress} ${registryAddress} ${managerAddress} ${contributionRegistryAddress} 1000 100 1000000000000000000000000`);
    console.log("\n2. Update backend service configuration with CONTRIBUTION_REGISTRY_ADDRESS");
    console.log("\n3. Test contribution recording with a sample evaluation");

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
