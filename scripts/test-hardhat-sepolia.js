async function main() {
  console.log("Testing Hardhat Sepolia connection...\n");

  try {
    // Get signers
    const signers = await ethers.getSigners();
    console.log("✓ Got", signers.length, "signer(s)");

    if (signers.length > 0) {
      const deployer = signers[0];
      console.log("✓ Deployer address:", deployer.address);

      // Get balance
      const balance = await ethers.provider.getBalance(deployer.address);
      console.log("✓ Deployer balance:", ethers.formatEther(balance), "ETH");

      // Get network
      const network = await ethers.provider.getNetwork();
      console.log("✓ Connected to:", network.name, "(Chain ID:", network.chainId.toString() + ")");

      // Get block number
      const blockNumber = await ethers.provider.getBlockNumber();
      console.log("✓ Current block:", blockNumber);
    }

    console.log("\n✅ Hardhat is properly configured for Sepolia!");

  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.message.includes("Must be authenticated")) {
      console.error("\nThe RPC endpoint requires authentication.");
      console.error("Please check your API key in .env.sepolia");
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });