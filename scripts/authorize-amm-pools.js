const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  console.log("\n🔐 Authorizing AMM Pools to Mint/Burn Tokens");
  console.log("=".repeat(70));

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Network:", deployment.network, `(chainId: ${deployment.chainId})`);
  console.log();

  const tokenManager = await ethers.getContractAt(
    "TokenManager",
    deployment.contracts.TokenManager
  );

  // Verify deployer owns TokenManager
  const owner = await tokenManager.owner();
  if (owner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(
      `❌ Deployer (${deployer.address}) does not own TokenManager!\n` +
      `   TokenManager owner: ${owner}`
    );
  }
  console.log("✅ Deployer owns TokenManager\n");

  let authorizedCount = 0;
  let alreadyAuthorizedCount = 0;

  // Get MINTER_ROLE hash
  const MINTER_ROLE = ethers.keccak256(ethers.toUtf8Bytes("MINTER_ROLE"));

  // Authorize each pool
  for (const poolInfo of deployment.pools) {
    console.log(`📝 Processing ${poolInfo.configKey} pool...`);
    console.log(`   AMM Address: ${poolInfo.ammAddress}`);
    console.log(`   Token: ${poolInfo.tokenAddress}`);

    // Check if AMM already has MINTER_ROLE on TokenManager
    const hasRole = await tokenManager.hasRole(MINTER_ROLE, poolInfo.ammAddress);

    if (hasRole) {
      console.log(`   ⏭️  Already authorized (has MINTER_ROLE), skipping\n`);
      alreadyAuthorizedCount++;
      continue;
    }

    console.log(`   🔄 Granting MINTER_ROLE to AMM...`);

    const tx = await tokenManager.authorizeAMM(poolInfo.ammAddress);
    console.log(`   ⏳ Waiting for confirmation... (tx: ${tx.hash})`);

    const receipt = await tx.wait();
    console.log(`   ✅ Authorized!`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

    // Verify
    const nowHasRole = await tokenManager.hasRole(MINTER_ROLE, poolInfo.ammAddress);
    if (!nowHasRole) {
      throw new Error(`❌ Verification failed for ${poolInfo.configKey} pool!`);
    }
    console.log(`   ✅ Verification: AMM has MINTER_ROLE`);
    console.log(`   🔗 View on Etherscan: https://sepolia.etherscan.io/tx/${tx.hash}\n`);

    authorizedCount++;
  }

  // Summary
  console.log("=".repeat(70));
  console.log("📊 Authorization Summary:");
  console.log(`   Newly authorized: ${authorizedCount}`);
  console.log(`   Already authorized: ${alreadyAuthorizedCount}`);
  console.log(`   Total pools: ${deployment.pools.length}`);
  console.log();

  if (authorizedCount > 0) {
    console.log("✅ All pools now authorized to mint/burn tokens!");
    console.log("\n🎯 Next Steps:");
    console.log("   1. Run buy tests: npx hardhat test test/testnet/real-buy-transactions.test.js --network sepolia");
    console.log("   2. Run sell tests: npx hardhat test test/testnet/real-sell-transactions.test.js --network sepolia");
  } else {
    console.log("✅ All pools were already authorized!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Authorization failed:", error.message);
    console.error("\n📜 Full error:");
    console.error(error);
    process.exit(1);
  });
