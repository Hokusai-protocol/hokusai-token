const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  console.log("\n🔍 Verifying LSCOR Pool Two-Phase Parameters\n");
  console.log("=".repeat(70));

  const poolAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";

  console.log(`\n📊 LSCOR Pool`);
  console.log(`   Address: ${poolAddress}`);
  console.log("-".repeat(70));

  const ammContract = await ethers.getContractAt("HokusaiAMM", poolAddress);

  // Read two-phase parameters
  const threshold = await ammContract.FLAT_CURVE_THRESHOLD();
  const price = await ammContract.FLAT_CURVE_PRICE();
  const reserveBalance = await ammContract.reserveBalance();
  const currentPhase = await ammContract.getCurrentPhase();
  const crr = await ammContract.crr();

  // Format values
  const thresholdUSD = ethers.formatUnits(threshold, 6);
  const priceUSD = ethers.formatUnits(price, 6);
  const reserveUSD = ethers.formatUnits(reserveBalance, 6);
  const crrPercent = (Number(crr) / 10000).toFixed(1);

  console.log(`\n   Two-Phase Parameters:`);
  console.log(`     FLAT_CURVE_THRESHOLD: $${thresholdUSD}`);
  console.log(`     FLAT_CURVE_PRICE:     $${priceUSD}`);
  console.log(`\n   Current State:`);
  console.log(`     Reserve Balance:      $${reserveUSD}`);
  console.log(`     Current Phase:        ${currentPhase === 0n ? "FLAT_PRICE (0)" : "BONDING_CURVE (1)"}`);
  console.log(`     CRR:                  ${crrPercent}%`);

  // Verify expected values
  const expectedThreshold = ethers.parseUnits("25000", 6);
  const expectedPrice = ethers.parseUnits("0.01", 6);
  const expectedCRR = 100000n; // 10%

  const thresholdMatch = threshold === expectedThreshold;
  const priceMatch = price === expectedPrice;
  const crrMatch = crr === expectedCRR;
  const phaseCorrect = currentPhase === 0n; // Should be in FLAT_PRICE with $100 reserve

  console.log(`\n   ✅ Verification:`);
  console.log(`     Threshold ($25,000):  ${thresholdMatch ? "✅ CORRECT" : "❌ MISMATCH"}`);
  console.log(`     Price ($0.01):        ${priceMatch ? "✅ CORRECT" : "❌ MISMATCH"}`);
  console.log(`     CRR (10%):            ${crrMatch ? "✅ CORRECT" : "❌ MISMATCH"}`);
  console.log(`     Phase (FLAT_PRICE):   ${phaseCorrect ? "✅ CORRECT" : "❌ MISMATCH"}`);

  // Test getBuyQuote in flat phase
  console.log(`\n   📈 Testing Buy Quotes in FLAT_PRICE Phase:`);

  const testAmounts = [
    { usd: "100", expectedTokens: "10000" },
    { usd: "1000", expectedTokens: "100000" },
    { usd: "10000", expectedTokens: "1000000" },
  ];

  for (const test of testAmounts) {
    const usdIn = ethers.parseUnits(test.usd, 6);
    const tokensOut = await ammContract.getBuyQuote(usdIn);
    const tokensFormatted = ethers.formatEther(tokensOut);
    const expected = Number(test.expectedTokens).toLocaleString();
    const actual = Number(tokensFormatted).toLocaleString();
    const match = Math.abs(Number(tokensFormatted) - Number(test.expectedTokens)) < 1;

    console.log(`     Buy $${test.usd}: ${actual} tokens ${match ? "✅" : "❌"} (expected ${expected})`);
  }

  // Check remaining capacity before threshold
  const remainingCapacity = threshold - reserveBalance;
  const remainingUSD = ethers.formatUnits(remainingCapacity, 6);
  console.log(`\n   💰 Flat Phase Capacity:`);
  console.log(`     Remaining before threshold: $${remainingUSD}`);
  console.log(`     This equals: ${Number(remainingUSD) / 0.01} tokens at $0.01`);

  console.log("\n" + "=".repeat(70));
  console.log("✅ LSCOR Pool Verification Complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
