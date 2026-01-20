const hre = require("hardhat");

async function main() {
  const poolAddress = "0x3CB2fe746c1A4290c94C24AEeD5d1ec912C5Ee7E";
  const tokenAddress = "0x645e4cB0741203E77fbb20ECb8299540544Cebf3";

  const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);
  const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

  const [
    reserveBalance,
    spotPrice,
    totalSupply,
    buyOnlyUntil,
    crr,
    tradeFee
  ] = await Promise.all([
    pool.reserveBalance(),
    pool.spotPrice(),
    token.totalSupply(),
    pool.buyOnlyUntil(),
    pool.crr(),
    pool.tradeFee()
  ]);

  const currentTime = Math.floor(Date.now() / 1000);
  const ibrRemaining = Number(buyOnlyUntil) - currentTime;

  console.log("\n📊 Sales Lead Scoring v2 Pool Info");
  console.log("=".repeat(70));
  console.log(`Token Address:    ${tokenAddress}`);
  console.log(`Pool Address:     ${poolAddress}`);
  console.log(`Model ID:         21`);
  console.log(`Symbol:           LSCOR`);
  console.log();
  console.log(`Reserve:          $${ethers.formatUnits(reserveBalance, 6)} USDC`);
  console.log(`Spot Price:       $${ethers.formatUnits(spotPrice, 6)}`);
  console.log(`Total Supply:     ${ethers.formatEther(totalSupply)} LSCOR`);
  console.log(`Market Cap:       $${ethers.formatUnits(reserveBalance * 10n ** 18n / BigInt(crr) * 1000000n / 10n ** 18n, 6)}`);
  console.log();
  console.log(`CRR:              ${Number(crr) / 10000}%`);
  console.log(`Trade Fee:        ${Number(tradeFee) / 100}%`);
  console.log();
  console.log(`IBR Ends:         ${new Date(Number(buyOnlyUntil) * 1000).toISOString()}`);
  console.log(`IBR Remaining:    ${(ibrRemaining / 3600).toFixed(1)} hours`);
  console.log(`Sells Enabled:    ${ibrRemaining <= 0 ? 'YES ✅' : 'NO ⏳'}`);
  console.log();
  console.log(`Sepolia Etherscan:`);
  console.log(`  Token: https://sepolia.etherscan.io/token/${tokenAddress}`);
  console.log(`  Pool:  https://sepolia.etherscan.io/address/${poolAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
