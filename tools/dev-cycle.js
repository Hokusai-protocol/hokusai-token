// scripts/dev-cycle.js

const { ethers } = require("hardhat");

async function main() {
  const [deployer, contributor, modelUser] = await ethers.getSigners();

  // Deploy ModelRegistry
  const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
  const registry = await ModelRegistry.deploy();
  console.log("ModelRegistry deployed to:", registry.target);

  // Deploy a HokusaiToken
  const Token = await ethers.getContractFactory("HokusaiToken");
  const token = await Token.deploy();
  console.log("HokusaiToken deployed to:", token.target);

  // Deploy TokenManager
  const TokenManager = await ethers.getContractFactory("TokenManager");
  const manager = await TokenManager.deploy(registry.target);
  console.log("TokenManager deployed to:", manager.target);

  // Set controller on token
  await token.setController(manager.target);

  // Register the model
  const modelName = "TestModelV1";
  const metric = "accuracy";
  const dataFormat = "json";
  const tx = await registry.registerModelAutoId(token.target, metric);
  const receipt = await tx.wait();
  const parsedLog = registry.interface.parseLog(receipt.logs[0]);
  const modelId = parsedLog.args.modelId;

  console.log("Model registered with ID:", modelId.toString());

  // Mint test tokens to contributor
  const rewardAmount = ethers.parseEther("100");
  await manager.mintTokens(modelId, contributor.address, rewardAmount);
  const balance = await token.balanceOf(contributor.address);
  console.log("Contributor balance:", ethers.formatEther(balance));

  // Simulate burn via AuctionBurner (mock interaction)
  // Assume AuctionBurner has a burn function accepting modelId and amount
  const AuctionBurner = await ethers.getContractFactory("AuctionBurner");
  const burner = await AuctionBurner.deploy(token.target);
  console.log("AuctionBurner deployed to:", burner.target);

  // Contributor approves and burns tokens
  await token.connect(contributor).approve(burner.target, rewardAmount);
  await burner.connect(contributor).burn(rewardAmount);
  const finalBalance = await token.balanceOf(contributor.address);
  console.log("Final contributor balance:", ethers.formatEther(finalBalance));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});