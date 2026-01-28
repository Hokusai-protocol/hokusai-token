const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  console.log("\n💰 Buy Quote Analysis - Price Impact Testing");
  console.log("=".repeat(70));

  const testAmounts = [
    { label: "$100", usdc: "100" },
    { label: "$1,000", usdc: "1000" },
    { label: "$10,000", usdc: "10000" },
    { label: "$50,000", usdc: "50000" }
  ];

  for (const poolInfo of deployment.pools) {
    const poolName = poolInfo.configKey.toUpperCase();
    const crrPercent = poolInfo.crr / 10000;

    console.log(`\n📊 ${poolName} Pool (${crrPercent}% CRR)`);
    console.log("-".repeat(70));

    const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

    // Get spot price
    let initialSpotPrice;
    try {
      initialSpotPrice = await pool.getSpotPrice();
    } catch (e) {
      // Try alternate method name
      initialSpotPrice = await pool.spotPrice();
    }

    console.log(`Initial Spot Price: $${ethers.formatUnits(initialSpotPrice, 6)}`);
    console.log(`Initial Reserve: $${ethers.formatUnits(poolInfo.initialReserve, 6)}`);
    console.log(`CRR: ${crrPercent}% (lower = more volatile)`);
    console.log();

    let cumulativeReserve = BigInt(0);

    for (const test of testAmounts) {
      const amount = ethers.parseUnits(test.usdc, 6);

      try {
        const tokensOut = await pool.getBuyQuote(amount);

        // Calculate average price for this purchase
        const avgPrice = amount * BigInt(1e18) / tokensOut;

        // Calculate price impact vs initial spot price
        const priceImpactBps = ((avgPrice - initialSpotPrice) * BigInt(10000)) / initialSpotPrice;

        // Calculate percentage of reserve
        cumulativeReserve += amount;
        const reservePercent = Number(cumulativeReserve * BigInt(100)) / Number(poolInfo.initialReserve);

        console.log(`${test.label} buy:`);
        console.log(`  Tokens received: ${ethers.formatEther(tokensOut)}`);
        console.log(`  Average price: $${ethers.formatUnits(avgPrice, 6)}`);
        console.log(`  Price impact vs initial: ${Number(priceImpactBps) / 100}%`);
        console.log(`  Cumulative % of reserve: ${reservePercent.toFixed(2)}%`);
        console.log();
      } catch (error) {
        console.log(`${test.label} buy: ERROR - ${error.message}`);
      }
    }
  }

  console.log("\n📈 Expected Behavior:");
  console.log("- Lower CRR = Higher price impact (more volatile)");
  console.log("- Conservative (30% CRR) should have LOWEST price impact");
  console.log("- Aggressive (10% CRR) should have HIGHEST price impact");
  console.log("- Balanced (20% CRR) should be in between");
}

main().catch(console.error);
