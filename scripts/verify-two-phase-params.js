const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  console.log("\n🔍 Verifying Two-Phase Parameters on Deployed Pools\n");
  console.log("=".repeat(70));

  // Pool addresses from deployment
  const pools = [
    {
      name: "Conservative Pool (30% CRR)",
      address: "0x42BBaEB00ff2ABD98AE474fC441d160B87127f61",
      expectedThreshold: ethers.parseUnits("25000", 6),
      expectedPrice: ethers.parseUnits("0.01", 6),
    },
    {
      name: "Aggressive Pool (10% CRR)",
      address: "0x3895D217AF3e1A3bfFB6650b815f41C9A80295f6",
      expectedThreshold: ethers.parseUnits("50000", 6),
      expectedPrice: ethers.parseUnits("0.02", 6),
    },
    {
      name: "Balanced Pool (20% CRR)",
      address: "0xb0AB69c80724FD4137f104CBA654b9D5bFb08475",
      expectedThreshold: ethers.parseUnits("25000", 6),
      expectedPrice: ethers.parseUnits("0.01", 6),
    },
  ];

  for (const pool of pools) {
    console.log(`\n📊 ${pool.name}`);
    console.log(`   Address: ${pool.address}`);
    console.log("-".repeat(70));

    try {
      // Get contract instance
      const ammContract = await ethers.getContractAt("HokusaiAMM", pool.address);

      // Read two-phase parameters
      const threshold = await ammContract.FLAT_CURVE_THRESHOLD();
      const price = await ammContract.FLAT_CURVE_PRICE();
      const reserveBalance = await ammContract.reserveBalance();
      const currentPhase = await ammContract.getCurrentPhase();

      // Format values
      const thresholdUSD = ethers.formatUnits(threshold, 6);
      const priceUSD = ethers.formatUnits(price, 6);
      const reserveUSD = ethers.formatUnits(reserveBalance, 6);

      console.log(`   FLAT_CURVE_THRESHOLD: $${thresholdUSD}`);
      console.log(`   FLAT_CURVE_PRICE:     $${priceUSD}`);
      console.log(`   Current Reserve:      $${reserveUSD}`);
      console.log(`   Current Phase:        ${currentPhase === 0n ? "FLAT_PRICE (0)" : "BONDING_CURVE (1)"}`);

      // Verify against expected values
      const thresholdMatch = threshold === pool.expectedThreshold;
      const priceMatch = price === pool.expectedPrice;

      console.log(`\n   ✅ Threshold: ${thresholdMatch ? "CORRECT" : "❌ MISMATCH"}`);
      console.log(`   ✅ Price:     ${priceMatch ? "CORRECT" : "❌ MISMATCH"}`);

      if (!thresholdMatch) {
        console.log(`      Expected: $${ethers.formatUnits(pool.expectedThreshold, 6)}`);
        console.log(`      Got:      $${thresholdUSD}`);
      }

      if (!priceMatch) {
        console.log(`      Expected: $${ethers.formatUnits(pool.expectedPrice, 6)}`);
        console.log(`      Got:      $${priceUSD}`);
      }

      // Get phase info
      const phaseInfo = await ammContract.getPhaseInfo();
      console.log(`\n   Phase Info:`);
      console.log(`     Current Phase:        ${phaseInfo.currentPhase === 0n ? "FLAT_PRICE" : "BONDING_CURVE"}`);
      console.log(`     Reserve Balance:      $${ethers.formatUnits(phaseInfo.reserveBalance, 6)}`);
      console.log(`     Flat Curve Threshold: $${ethers.formatUnits(phaseInfo.flatCurveThreshold, 6)}`);
      console.log(`     Flat Curve Price:     $${ethers.formatUnits(phaseInfo.flatCurvePrice, 6)}`);

    } catch (error) {
      console.log(`   ❌ Error reading pool: ${error.message}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("✅ Verification Complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
