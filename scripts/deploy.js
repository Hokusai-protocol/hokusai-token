const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);

  // Deploy ModelRegistry
  const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
  const registry = await ModelRegistry.deploy();
  await registry.waitForDeployment();
  console.log("ModelRegistry deployed to:", await registry.getAddress());

  // Deploy HokusaiToken
  const HokusaiToken = await hre.ethers.getContractFactory("HokusaiToken");
  const token = await HokusaiToken.deploy();
  await token.waitForDeployment();
  console.log("HokusaiToken deployed to:", await token.getAddress());

  // Deploy TokenManager
  const TokenManager = await hre.ethers.getContractFactory("TokenManager");
  const manager = await TokenManager.deploy(await registry.getAddress());
  await manager.waitForDeployment();
  console.log("TokenManager deployed to:", await manager.getAddress());

  // Set TokenManager as controller for HokusaiToken
  console.log("Setting TokenManager as controller...");
  await token.setController(await manager.getAddress());
  console.log("Controller set successfully");

  // Register the model and token in the registry
  const modelId = hre.ethers.encodeBytes32String("ModelA");
  console.log("Registering model with ID:", modelId);
  await registry.registerModel(modelId, await token.getAddress());
  console.log("Model registered successfully");

  console.log("\n=== Deployment Summary ===");
  console.log("ModelRegistry:", await registry.getAddress());
  console.log("HokusaiToken:", await token.getAddress());
  console.log("TokenManager:", await manager.getAddress());
  console.log("Controller:", await token.controller());
  console.log("========================\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});