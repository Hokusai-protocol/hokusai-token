const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
  const registry = await ModelRegistry.deploy();
  await registry.deployed();

  const HokusaiToken = await hre.ethers.getContractFactory("HokusaiToken");
  const token = await HokusaiToken.deploy("Hokusai Token", "HOK");
  await token.deployed();

  const TokenManager = await hre.ethers.getContractFactory("TokenManager");
  const manager = await TokenManager.deploy(registry.address);
  await manager.deployed();

  await token.setController(manager.address);

  const modelId = hre.ethers.utils.formatBytes32String("ModelA");
  await registry.registerModel(modelId, token.address);

  console.log("Contracts deployed:");
  console.log("ModelRegistry:", registry.address);
  console.log("HokusaiToken:", token.address);
  console.log("TokenManager:", manager.address);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
