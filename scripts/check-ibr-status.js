const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  const pool = await ethers.getContractAt("HokusaiAMM", deployment.pools[0].ammAddress);

  const buyOnlyUntil = await pool.buyOnlyUntil();
  const block = await ethers.provider.getBlock('latest');
  const currentTime = BigInt(block.timestamp);
  const ibrActive = buyOnlyUntil > currentTime;

  console.log("\n🕐 IBR Status Check");
  console.log("=".repeat(50));
  console.log(`Current time:     ${currentTime} (${new Date(Number(currentTime) * 1000).toISOString()})`);
  console.log(`IBR expires at:   ${buyOnlyUntil} (${new Date(Number(buyOnlyUntil) * 1000).toISOString()})`);
  console.log(`IBR Active:       ${ibrActive}`);

  if (ibrActive) {
    const timeRemaining = Number(buyOnlyUntil - currentTime);
    console.log(`\nTime remaining:   ${timeRemaining}s (${(timeRemaining / 3600).toFixed(2)} hours)`);
    console.log("⏳ IBR still active - sell tests will skip");
  } else {
    console.log("\n✅ IBR has expired - all tests can run!");
  }
}

main().catch(console.error);
