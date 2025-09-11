const hre = require("hardhat");
require("dotenv").config();

async function main() {
  console.log("🚀 Deploying updated TokenManager to Sepolia...\n");

  // The ModelRegistry address we deployed earlier
  const MODEL_REGISTRY_ADDRESS = "0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f";
  
  console.log(`Using ModelRegistry at: ${MODEL_REGISTRY_ADDRESS}`);

  // Get deployer account
  const [deployer] = await hre.ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  
  // Check balance
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log(`Account balance: ${hre.ethers.formatEther(balance)} ETH`);

  // Deploy TokenManager
  console.log("\n📝 Deploying TokenManager with new features...");
  const TokenManager = await hre.ethers.getContractFactory("TokenManager");
  const tokenManager = await TokenManager.deploy(MODEL_REGISTRY_ADDRESS);
  
  await tokenManager.waitForDeployment();
  const tokenManagerAddress = await tokenManager.getAddress();
  
  console.log(`✅ TokenManager deployed to: ${tokenManagerAddress}`);
  
  // Verify the deployment
  const deployedCode = await hre.ethers.provider.getCode(tokenManagerAddress);
  if (deployedCode === "0x") {
    console.error("❌ Contract not deployed properly!");
    process.exit(1);
  }
  console.log("✅ Contract code verified");

  console.log("\n✨ Deployment complete!");
  console.log("\n📊 Deployment Summary:");
  console.log("=======================");
  console.log(`TokenManager: ${tokenManagerAddress}`);
  console.log(`ModelRegistry: ${MODEL_REGISTRY_ADDRESS}`);
  console.log(`View on Etherscan: https://sepolia.etherscan.io/address/${tokenManagerAddress}`);
  console.log("\n🎯 New Features:");
  console.log("- deployToken() function for direct user deployment");
  console.log("- Internal token tracking via modelTokens mapping");
  console.log("- Optional deployment fee mechanism");
  console.log("- Users pay gas fees directly when deploying");
  
  console.log("\n📝 Next Steps:");
  console.log("1. Update SSM parameter /hokusai/contracts/sepolia/tokenManager with:", tokenManagerAddress);
  console.log("2. Update frontend code to use new TokenManager address");
  console.log("3. Test deployToken() function from frontend");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });