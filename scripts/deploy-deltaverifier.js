const hre = require("hardhat");

async function main() {
  console.log("Starting DeltaVerifier deployment...");

  // Get the contract factories
  const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
  const HokusaiToken = await hre.ethers.getContractFactory("HokusaiToken");
  const TokenManager = await hre.ethers.getContractFactory("TokenManager");
  const DeltaVerifier = await hre.ethers.getContractFactory("DeltaVerifier");

  // Deploy ModelRegistry
  console.log("Deploying ModelRegistry...");
  const modelRegistry = await ModelRegistry.deploy();
  await modelRegistry.waitForDeployment();
  console.log("ModelRegistry deployed to:", await modelRegistry.getAddress());

  // Deploy HokusaiToken
  console.log("Deploying HokusaiToken...");
  const hokusaiToken = await HokusaiToken.deploy();
  await hokusaiToken.waitForDeployment();
  console.log("HokusaiToken deployed to:", await hokusaiToken.getAddress());

  // Deploy TokenManager
  console.log("Deploying TokenManager...");
  const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
  await tokenManager.waitForDeployment();
  console.log("TokenManager deployed to:", await tokenManager.getAddress());

  // Deploy DeltaVerifier with configuration
  console.log("Deploying DeltaVerifier...");
  const baseRewardRate = hre.ethers.parseEther("1000"); // 1000 tokens per 1% improvement
  const minImprovementBps = 100; // 1% minimum improvement
  const maxReward = hre.ethers.parseEther("100000"); // Max reward cap

  const deltaVerifier = await DeltaVerifier.deploy(
    await modelRegistry.getAddress(),
    await tokenManager.getAddress(),
    baseRewardRate,
    minImprovementBps,
    maxReward
  );
  await deltaVerifier.waitForDeployment();
  console.log("DeltaVerifier deployed to:", await deltaVerifier.getAddress());

  // Setup relationships
  console.log("\nSetting up contract relationships...");

  // Set TokenManager as controller of HokusaiToken
  await hokusaiToken.setController(await tokenManager.getAddress());
  console.log("✓ Set TokenManager as HokusaiToken controller");

  // Set DeltaVerifier in TokenManager
  await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
  console.log("✓ Set DeltaVerifier in TokenManager");

  // Register a sample model
  const modelId = 1;
  await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
  console.log(`✓ Registered model ${modelId} with HokusaiToken`);

  // Grant minter role to DeltaVerifier (optional, depends on implementation)
  // await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
  // console.log("✓ Granted MINTER_ROLE to DeltaVerifier");

  console.log("\nDeployment complete!");
  console.log("==================");
  console.log("Contract addresses:");
  console.log("ModelRegistry:", await modelRegistry.getAddress());
  console.log("HokusaiToken:", await hokusaiToken.getAddress());
  console.log("TokenManager:", await tokenManager.getAddress());
  console.log("DeltaVerifier:", await deltaVerifier.getAddress());
  console.log("==================");
  console.log("\nConfiguration:");
  console.log("Base Reward Rate:", hre.ethers.formatEther(baseRewardRate), "tokens per 1% improvement");
  console.log("Min Improvement:", minImprovementBps / 100, "%");
  console.log("Max Reward:", hre.ethers.formatEther(maxReward), "tokens");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });