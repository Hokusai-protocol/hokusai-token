const deployment = require("../deployments/sepolia-latest.json");

async function main() {
  for (const poolInfo of deployment.pools) {
    const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    const reserve = await pool.reserveBalance();
    const maxTradeBps = await pool.maxTradeBps();
    const maxTradeSize = (reserve * maxTradeBps) / 10000n;

    console.log(`\n${poolInfo.configKey} pool:`);
    console.log(`  Reserve: $${ethers.formatUnits(reserve, 6)}`);
    console.log(`  Max Trade BPS: ${maxTradeBps}`);
    console.log(`  Max Trade Size: $${ethers.formatUnits(maxTradeSize, 6)}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
