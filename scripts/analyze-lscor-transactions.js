const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  console.log("\n🔍 LSCOR Transaction Analysis\n");
  console.log("=".repeat(80));

  const poolAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";
  const tokenAddress = "0xd6bFa8A2f85157e8a1D91E2c348c99C6Da86986c";

  const ammContract = await ethers.getContractAt("HokusaiAMM", poolAddress);
  const tokenContract = await ethers.getContractAt("HokusaiToken", tokenAddress);

  // Get current state
  const reserveBalance = await ammContract.reserveBalance();
  const totalSupply = await tokenContract.totalSupply();
  const spotPrice = await ammContract.spotPrice();
  const treasury = await ammContract.treasury();
  const tradeFee = await ammContract.tradeFee();
  const crr = await ammContract.crr();
  const threshold = await ammContract.FLAT_CURVE_THRESHOLD();
  const flatPrice = await ammContract.FLAT_CURVE_PRICE();

  console.log("\n📊 Current Pool State:");
  console.log("   Reserve Balance: $" + ethers.formatUnits(reserveBalance, 6));
  console.log("   Total Supply: " + ethers.formatEther(totalSupply) + " LSCOR tokens");
  console.log("   Spot Price: $" + ethers.formatUnits(spotPrice, 6) + " per token");
  console.log("   Treasury: " + treasury);
  console.log("   Trade Fee: " + (Number(tradeFee) / 100) + "% (" + tradeFee + " bps)");
  console.log("   CRR: " + (Number(crr) / 10000) + "%");
  console.log("   Flat Curve Threshold: $" + ethers.formatUnits(threshold, 6));
  console.log("   Flat Curve Price: $" + ethers.formatUnits(flatPrice, 6));

  // Query Buy events from block 0 to latest (use chunked approach for safety)
  console.log("\n📜 Querying Buy Events...\n");

  const currentBlock = await ethers.provider.getBlockNumber();
  const buyFilter = ammContract.filters.Buy();

  // Use chunked queries
  const chunkSize = 10000;
  let allBuyEvents = [];

  for (let start = 0; start <= currentBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, currentBlock);
    try {
      const events = await ammContract.queryFilter(buyFilter, start, end);
      allBuyEvents = allBuyEvents.concat(events);
    } catch (e) {
      // Try smaller chunks if rate limited
    }
  }

  console.log("Found " + allBuyEvents.length + " Buy events\n");
  console.log("-".repeat(80));

  let totalReserveIn = 0n;
  let totalTokensOut = 0n;
  let totalFees = 0n;

  for (let i = 0; i < allBuyEvents.length; i++) {
    const event = allBuyEvents[i];
    const args = event.args;
    const block = await event.getBlock();

    totalReserveIn += args.reserveIn;
    totalTokensOut += args.tokensOut;
    totalFees += args.fee;

    const timestamp = new Date(block.timestamp * 1000).toISOString();

    console.log("Transaction " + (i + 1) + ":");
    console.log("   Block: " + event.blockNumber);
    console.log("   Time: " + timestamp);
    console.log("   Buyer: " + args.buyer);
    console.log("   USDC In: $" + ethers.formatUnits(args.reserveIn, 6));
    console.log("   Tokens Out: " + ethers.formatEther(args.tokensOut) + " LSCOR");
    console.log("   Fee: $" + ethers.formatUnits(args.fee, 6));
    console.log("   New Spot Price: $" + ethers.formatUnits(args.spotPrice, 6));
    console.log("   Tx: " + event.transactionHash);
    console.log("-".repeat(80));
  }

  // Query PhaseTransition events
  console.log("\n📈 Phase Transition Events:");
  const phaseFilter = ammContract.filters.PhaseTransition();
  const phaseEvents = await ammContract.queryFilter(phaseFilter, 0, currentBlock);

  if (phaseEvents.length === 0) {
    console.log("   No PhaseTransition events found (may have occurred in same tx)");
  }

  for (const event of phaseEvents) {
    const args = event.args;
    const block = await event.getBlock();
    const timestamp = new Date(block.timestamp * 1000).toISOString();

    console.log("   Time: " + timestamp);
    console.log("   From Phase: " + (args.fromPhase === 0n ? "FLAT_PRICE" : "BONDING_CURVE"));
    console.log("   To Phase: " + (args.toPhase === 0n ? "FLAT_PRICE" : "BONDING_CURVE"));
    console.log("   Reserve at transition: $" + ethers.formatUnits(args.reserveBalance, 6));
    console.log("   Tx: " + event.transactionHash);
  }

  // Summary
  console.log("\n" + "=".repeat(80));
  console.log("💰 SUMMARY");
  console.log("=".repeat(80));
  console.log("   Total USDC Deposited: $" + ethers.formatUnits(totalReserveIn, 6));
  console.log("   Total Tokens Minted: " + ethers.formatEther(totalTokensOut) + " LSCOR");
  console.log("   Total Fees Paid: $" + ethers.formatUnits(totalFees, 6));
  console.log("   Fees went to Treasury: " + treasury);

  // Calculate expected reserve after fees
  const expectedReserve = totalReserveIn - totalFees;
  console.log("   Expected Reserve (deposits - fees): $" + ethers.formatUnits(expectedReserve, 6));
  console.log("   Actual Reserve: $" + ethers.formatUnits(reserveBalance, 6));

  const reserveDiff = reserveBalance - expectedReserve;
  if (reserveDiff !== 0n) {
    console.log("   Difference: $" + ethers.formatUnits(reserveDiff, 6) + " (likely initial seed)");
  } else {
    console.log("   ✅ Reserve matches expected!");
  }

  // Verify spot price calculation
  console.log("\n📐 SPOT PRICE VERIFICATION");
  console.log("=".repeat(80));

  // Formula: P = R / (w × S)
  // Where w = CRR in PPM / 1,000,000
  // P = (R × 1,000,000 × 1e18) / (crr × S)

  const PPM = 1000000n;
  const PRECISION = BigInt(1e18);

  const calculatedPrice = (reserveBalance * PPM * PRECISION) / (crr * totalSupply);

  console.log("   Formula: P = R / (w × S) where w = CRR/1,000,000");
  console.log("   R (Reserve): $" + ethers.formatUnits(reserveBalance, 6));
  console.log("   S (Supply): " + ethers.formatEther(totalSupply) + " tokens");
  console.log("   w (CRR): " + (Number(crr) / 10000) + "% = " + crr + " / 1,000,000 = " + (Number(crr) / 1000000));
  console.log("   Calculated P: $" + ethers.formatUnits(calculatedPrice, 6));
  console.log("   Contract spotPrice(): $" + ethers.formatUnits(spotPrice, 6));

  if (calculatedPrice === spotPrice) {
    console.log("   ✅ Spot price calculation CORRECT!");
  } else {
    const diff = calculatedPrice > spotPrice ? calculatedPrice - spotPrice : spotPrice - calculatedPrice;
    console.log("   ⚠️ Difference of $" + ethers.formatUnits(diff, 6));
  }

  // Market cap
  const marketCap = (totalSupply * spotPrice) / PRECISION;
  console.log("\n   Market Cap: $" + ethers.formatUnits(marketCap, 6));

  // Average price paid
  const avgPricePaid = (totalReserveIn * PRECISION) / totalTokensOut;
  console.log("   Average Price Paid: $" + ethers.formatUnits(avgPricePaid, 6) + " per token");

  // Check treasury balance
  console.log("\n📊 TREASURY VERIFICATION");
  console.log("=".repeat(80));

  const mockUSDCAddress = "0xB568cBaaBB76EC2104F830c9D2F3a806d5db4c90";
  const usdc = await ethers.getContractAt("IERC20", mockUSDCAddress);

  const treasuryBalance = await usdc.balanceOf(treasury);
  console.log("   Treasury Address: " + treasury);
  console.log("   Treasury USDC Balance: $" + ethers.formatUnits(treasuryBalance, 6));
  console.log("   Total Fees Collected: $" + ethers.formatUnits(totalFees, 6));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
