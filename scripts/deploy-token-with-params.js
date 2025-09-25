const hre = require("hardhat");

async function main() {
  console.log("Deploying new Hokusai Token with Params Module on Sepolia...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());

  // Configuration for the new token
  const config = {
    modelId: "1",  // Or whatever model ID you want
    name: "Hokusai Token",
    symbol: "HOKU",
    totalSupply: ethers.parseEther("1000000"), // 1M tokens

    // Initial parameter values
    tokensPerDeltaOne: 1000,
    infraMarkupBps: 500, // 5%
    licenseHash: ethers.ZeroHash, // Can update later
    licenseURI: "",
    governor: deployer.address // Change this to your governance address
  };

  // Deploy ModelRegistry (if not already deployed)
  console.log("\n1. Deploying ModelRegistry...");
  const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
  const modelRegistry = await ModelRegistry.deploy();
  await modelRegistry.waitForDeployment();
  console.log("ModelRegistry deployed to:", await modelRegistry.getAddress());

  // Deploy TokenManager
  console.log("\n2. Deploying TokenManager...");
  const TokenManager = await ethers.getContractFactory("TokenManager");
  const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
  await tokenManager.waitForDeployment();
  console.log("TokenManager deployed to:", await tokenManager.getAddress());

  // Deploy Token with Params using TokenManager
  console.log("\n3. Deploying HokusaiToken with HokusaiParams...");

  // Set deployment fee if needed (optional)
  // await tokenManager.setDeploymentFee(ethers.parseEther("0.01"));

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

  const receipt = await tx.wait();

  // Get deployed addresses from events
  const tokenDeployedEvent = receipt.logs.find(
    log => log.fragment && log.fragment.name === 'TokenDeployed'
  );
  const paramsDeployedEvent = receipt.logs.find(
    log => log.fragment && log.fragment.name === 'ParamsDeployed'
  );

  const tokenAddress = tokenDeployedEvent.args.tokenAddress;
  const paramsAddress = paramsDeployedEvent.args.paramsAddress;

  console.log("\n✅ Deployment Complete!");
  console.log("=======================");
  console.log("HokusaiToken deployed to:", tokenAddress);
  console.log("HokusaiParams deployed to:", paramsAddress);
  console.log("ModelRegistry:", await modelRegistry.getAddress());
  console.log("TokenManager:", await tokenManager.getAddress());

  // Deploy DeltaVerifier (optional - for rewards)
  console.log("\n4. Deploying DeltaVerifier...");
  const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
  const deltaVerifier = await DeltaVerifier.deploy(
    await modelRegistry.getAddress(),
    await tokenManager.getAddress(),
    1000, // baseRewardRate (will be overridden by params)
    100,  // minImprovementBps (1%)
    ethers.parseEther("1000000") // maxReward
  );
  await deltaVerifier.waitForDeployment();
  console.log("DeltaVerifier deployed to:", await deltaVerifier.getAddress());

  console.log("\n📝 Deployment Summary for .env file:");
  console.log("=====================================");
  console.log(`MODEL_REGISTRY_ADDRESS=${await modelRegistry.getAddress()}`);
  console.log(`TOKEN_MANAGER_ADDRESS=${await tokenManager.getAddress()}`);
  console.log(`DELTA_VERIFIER_ADDRESS=${await deltaVerifier.getAddress()}`);
  console.log(`HOKUSAI_TOKEN_ADDRESS=${tokenAddress}`);
  console.log(`HOKUSAI_PARAMS_ADDRESS=${paramsAddress}`);

  console.log("\n🔗 Verify on Etherscan:");
  console.log(`npx hardhat verify --network sepolia ${tokenAddress} "${config.name}" "${config.symbol}" ${tokenManager.target} ${paramsAddress} ${config.totalSupply}`);
  console.log(`npx hardhat verify --network sepolia ${paramsAddress} ${config.tokensPerDeltaOne} ${config.infraMarkupBps} "${config.licenseHash}" "${config.licenseURI}" ${config.governor}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });