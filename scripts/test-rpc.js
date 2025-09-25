require("dotenv").config({ path: '.env.sepolia' });
const { ethers } = require("ethers");

async function testRPC() {
  const rpcUrl = process.env.RPC_URL;
  console.log("Testing RPC connection to:", rpcUrl.substring(0, 50) + "...\n");

  try {
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Test 1: Get chain ID
    const chainId = await provider.getNetwork();
    console.log("✓ Connected to network:", chainId.name, "Chain ID:", chainId.chainId.toString());

    // Test 2: Get latest block
    const blockNumber = await provider.getBlockNumber();
    console.log("✓ Latest block:", blockNumber);

    // Test 3: Get gas price
    const gasPrice = await provider.getFeeData();
    console.log("✓ Current gas price:", ethers.formatUnits(gasPrice.gasPrice, "gwei"), "gwei");

    console.log("\n✅ RPC connection successful!");

  } catch (error) {
    console.error("❌ RPC connection failed:");
    console.error("Error:", error.message);

    if (error.message.includes("401") || error.message.includes("403")) {
      console.error("\n⚠️  Authentication error. Your API key may be invalid or inactive.");
      console.error("Please check your Alchemy/Infura dashboard.");
    }
  }
}

testRPC();