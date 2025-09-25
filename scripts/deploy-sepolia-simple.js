const hre = require("hardhat");

async function main() {
  console.log("🚀 Starting Sepolia deployment...\n");

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
    governor: deployer.address
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

    // 3. Deploy Token with Params
    console.log("\n3️⃣ Deploying Token with Params...");
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

    // 4. Deploy DeltaVerifier
    console.log("\n4️⃣ Deploying DeltaVerifier...");
    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      registryAddress,
      managerAddress,
      1000,
      100,
      ethers.parseEther("1000000")
    );
    await deltaVerifier.waitForDeployment();
    const verifierAddress = await deltaVerifier.getAddress();
    console.log("   ✅ DeltaVerifier:", verifierAddress);

    // Summary
    console.log("\n" + "=".repeat(60));
    console.log("🎉 DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(60));
    console.log("\n📋 Contract Addresses:");
    console.log(`MODEL_REGISTRY_ADDRESS=${registryAddress}`);
    console.log(`TOKEN_MANAGER_ADDRESS=${managerAddress}`);
    console.log(`HOKUSAI_TOKEN_ADDRESS=${tokenAddress}`);
    console.log(`HOKUSAI_PARAMS_ADDRESS=${paramsAddress}`);
    console.log(`DELTA_VERIFIER_ADDRESS=${verifierAddress}`);

    console.log("\n🔗 View on Etherscan:");
    console.log(`Token: https://sepolia.etherscan.io/address/${tokenAddress}`);
    console.log(`Params: https://sepolia.etherscan.io/address/${paramsAddress}`);

    // Save to file
    const fs = require('fs');
    const deploymentInfo = {
      network: "sepolia",
      timestamp: new Date().toISOString(),
      deployer: deployer.address,
      contracts: {
        modelRegistry: registryAddress,
        tokenManager: managerAddress,
        hokusaiToken: tokenAddress,
        hokusaiParams: paramsAddress,
        deltaVerifier: verifierAddress
      }
    };

    fs.writeFileSync(
      'deployment-sepolia.json',
      JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("\n💾 Deployment info saved to deployment-sepolia.json");

  } catch (error) {
    console.error("\n❌ Deployment failed:", error.message);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });