const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("\n💰 Token Balances for Deployer");
  console.log("=".repeat(50));
  console.log(`Deployer: ${deployer.address}\n`);

  for (const tokenInfo of deployment.tokens) {
    const token = await ethers.getContractAt("HokusaiToken", tokenInfo.address);
    const balance = await token.balanceOf(deployer.address);
    console.log(`${tokenInfo.symbol}:`);
    console.log(`  Address: ${tokenInfo.address}`);
    console.log(`  Balance: ${ethers.formatEther(balance)} tokens`);
    console.log(`  Has tokens: ${balance > 0n ? "✅ YES" : "❌ NO"}\n`);
  }
}

main().catch(console.error);
