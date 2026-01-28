const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  console.log("\n📊 Normalized Price Impact Testing");
  console.log("Testing equal percentages of reserve to isolate CRR effect");
  console.log("=".repeat(70));

  // Test at same percentage of reserve for each pool
  const reservePercentages = [0.1, 1, 5, 10, 20]; // 0.1%, 1%, 5%, 10%, 20%

  const results = [];

  for (const poolInfo of deployment.pools) {
    const poolName = poolInfo.configKey.toUpperCase();
    const crrPercent = poolInfo.crr / 10000;
    const initialReserve = BigInt(poolInfo.initialReserve);

    console.log(`\n💰 ${poolName} Pool (${crrPercent}% CRR, $${ethers.formatUnits(initialReserve, 6)} reserve)`);
    console.log("-".repeat(70));

    const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    const initialSpotPrice = await pool.spotPrice();

    const poolResults = {
      pool: poolName,
      crr: crrPercent,
      reserve: Number(ethers.formatUnits(initialReserve, 6)),
      impacts: []
    };

    for (const pct of reservePercentages) {
      const buyAmount = (initialReserve * BigInt(Math.floor(pct * 100))) / BigInt(10000);

      try {
        const tokensOut = await pool.getBuyQuote(buyAmount);
        const avgPrice = buyAmount * BigInt(1e18) / tokensOut;
        const priceImpactBps = Number((avgPrice - initialSpotPrice) * BigInt(10000) / initialSpotPrice);

        console.log(`${pct}% of reserve ($${ethers.formatUnits(buyAmount, 6)}):`);
        console.log(`  Price impact: ${(priceImpactBps / 100).toFixed(2)}%`);

        poolResults.impacts.push({
          pct,
          amount: ethers.formatUnits(buyAmount, 6),
          impact: priceImpactBps / 100
        });
      } catch (error) {
        console.log(`${pct}% of reserve: ERROR`);
        poolResults.impacts.push({ pct, error: true });
      }
    }

    results.push(poolResults);
  }

  // Summary comparison
  console.log("\n\n📈 SUMMARY: Price Impact Comparison (at same % of reserve)");
  console.log("=".repeat(70));

  for (const pct of reservePercentages) {
    console.log(`\n${pct}% of Reserve:`);
    for (const pool of results) {
      const impact = pool.impacts.find(i => i.pct === pct);
      if (impact && !impact.error) {
        console.log(`  ${pool.pool} (${pool.crr}% CRR): ${impact.impact.toFixed(2)}% impact`);
      }
    }
  }

  console.log("\n✅ Expected: Lower CRR → Higher price impact at same trade size");
  console.log("   Aggressive (10% CRR) should show highest impact");
  console.log("   Conservative (30% CRR) should show lowest impact");
}

main().catch(console.error);
