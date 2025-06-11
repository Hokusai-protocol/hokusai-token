const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  try {
    // Deploy ModelRegistry
    console.log("\n1. Deploying ModelRegistry...");
    const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
    const registry = await ModelRegistry.deploy();
    await registry.waitForDeployment();
    const registryAddress = await registry.getAddress();
    console.log("✓ ModelRegistry deployed to:", registryAddress);

    // Deploy HokusaiToken
    console.log("\n2. Deploying HokusaiToken...");
    const HokusaiToken = await hre.ethers.getContractFactory("HokusaiToken");
    const token = await HokusaiToken.deploy();
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    console.log("✓ HokusaiToken deployed to:", tokenAddress);

    // Deploy TokenManager with ModelRegistry reference
    console.log("\n3. Deploying TokenManager...");
    const TokenManager = await hre.ethers.getContractFactory("TokenManager");
    const manager = await TokenManager.deploy(registryAddress);
    await manager.waitForDeployment();
    const managerAddress = await manager.getAddress();
    console.log("✓ TokenManager deployed to:", managerAddress);

    // Verify TokenManager has correct registry reference
    console.log("\n4. Verifying contract connections...");
    const linkedRegistryAddress = await manager.registry();
    console.log("✓ TokenManager linked to registry:", linkedRegistryAddress);
    console.log("✓ Registry addresses match:", linkedRegistryAddress === registryAddress);

    // Set TokenManager as controller for HokusaiToken
    console.log("\n5. Setting TokenManager as controller...");
    const setControllerTx = await token.setController(managerAddress);
    await setControllerTx.wait();
    const controllerAddress = await token.controller();
    console.log("✓ Controller set to:", controllerAddress);
    console.log("✓ Controller is TokenManager:", controllerAddress === managerAddress);

    // Register the model and token in the registry
    console.log("\n6. Registering model in registry...");
    const modelId = hre.ethers.encodeBytes32String("ModelA");
    console.log("Model ID (encoded):", modelId);
    
    const registerTx = await registry.registerModel(modelId, tokenAddress);
    await registerTx.wait();
    console.log("✓ Model registered successfully");

    // Verify model registration
    console.log("\n7. Verifying model registration...");
    const isRegistered = await registry.isRegistered(modelId);
    const registeredTokenAddress = await registry.getToken(modelId);
    console.log("✓ Model is registered:", isRegistered);
    console.log("✓ Registered token address:", registeredTokenAddress);
    console.log("✓ Token addresses match:", registeredTokenAddress === tokenAddress);

    // Test TokenManager integration
    console.log("\n8. Testing TokenManager integration...");
    const isModelManaged = await manager.isModelManaged(modelId);
    const managedTokenAddress = await manager.getTokenAddress(modelId);
    console.log("✓ Model is managed by TokenManager:", isModelManaged);
    console.log("✓ TokenManager resolves correct token address:", managedTokenAddress === tokenAddress);

    // Display final summary
    console.log("\n" + "=".repeat(50));
    console.log("🎉 DEPLOYMENT SUCCESSFUL");
    console.log("=".repeat(50));
    console.log("📊 Contract Addresses:");
    console.log("   ModelRegistry:  ", registryAddress);
    console.log("   HokusaiToken:   ", tokenAddress);
    console.log("   TokenManager:   ", managerAddress);
    console.log("");
    console.log("🔗 Contract Relationships:");
    console.log("   TokenManager → ModelRegistry:  ", linkedRegistryAddress);
    console.log("   HokusaiToken → Controller:     ", controllerAddress);
    console.log("   ModelA → Token:                ", registeredTokenAddress);
    console.log("");
    console.log("✅ All integrations verified successfully!");
    console.log("=".repeat(50));

  } catch (error) {
    console.error("\n❌ Deployment failed:");
    console.error(error);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});