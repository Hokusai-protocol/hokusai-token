const hre = require("hardhat");

async function main() {
  console.log("🚀 Deploying to Sepolia with optimized gas settings...\n");

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");

  // Get current gas price and add 20% buffer
  const feeData = await ethers.provider.getFeeData();
  const gasPrice = (feeData.gasPrice * 120n) / 100n; // 20% buffer
  console.log("Gas Price:", ethers.formatUnits(gasPrice, "gwei"), "gwei\n");

  const overrides = {
    gasPrice: gasPrice,
    gasLimit: 3000000 // Set explicit gas limit
  };

  try {
    // Just deploy the essential contracts first
    console.log("1️⃣ Deploying ModelRegistry...");
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy(overrides);
    console.log("   Tx hash:", modelRegistry.deploymentTransaction().hash);
    console.log("   Waiting for confirmation...");
    await modelRegistry.waitForDeployment();
    const registryAddress = await modelRegistry.getAddress();
    console.log("   ✅ ModelRegistry deployed at:", registryAddress);

    console.log("\n2️⃣ Deploying TokenManager...");
    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(registryAddress, overrides);
    console.log("   Tx hash:", tokenManager.deploymentTransaction().hash);
    console.log("   Waiting for confirmation...");
    await tokenManager.waitForDeployment();
    const managerAddress = await tokenManager.getAddress();
    console.log("   ✅ TokenManager deployed at:", managerAddress);

    console.log("\n" + "=".repeat(60));
    console.log("✅ BASIC DEPLOYMENT SUCCESSFUL!");
    console.log("=".repeat(60));
    console.log("\nNow you can deploy tokens using TokenManager at:");
    console.log(managerAddress);
    console.log("\nView on Etherscan:");
    console.log(`https://sepolia.etherscan.io/address/${managerAddress}`);

    // Save addresses
    const fs = require('fs');
    const addresses = {
      modelRegistry: registryAddress,
      tokenManager: managerAddress,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync('sepolia-addresses.json', JSON.stringify(addresses, null, 2));
    console.log("\n💾 Addresses saved to sepolia-addresses.json");

  } catch (error) {
    console.error("\n❌ Error:", error.message);
    if (error.message.includes("replacement fee too low")) {
      console.error("Transaction stuck. Try increasing gas price or wait for pending tx to clear.");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });