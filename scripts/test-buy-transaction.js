const hre = require("hardhat");

async function main() {
  const ammAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";
  const userAddress = "0x3937A9B521298D4c6D9d438cEFF396eD18DD7Bb6";

  const amm = await hre.ethers.getContractAt("HokusaiAMM", ammAddress);

  console.log("Testing buy quotes...\n");

  // Try different buy amounts
  const amounts = ["1", "10", "100", "1000"];

  for (const amt of amounts) {
    try {
      const reserveIn = hre.ethers.parseUnits(amt, 6);
      const quote = await amm.getBuyQuote(reserveIn);
      console.log(`✓ Quote for ${amt} USDC: ${hre.ethers.formatUnits(quote, 18)} tokens`);
    } catch (e) {
      console.log(`✗ Quote for ${amt} USDC failed: ${e.message}`);
    }
  }

  // Check current phase
  console.log("\n");
  try {
    const phase = await amm.getCurrentPhase();
    console.log("Current Phase:", phase === 0n ? "FLAT_PRICE" : "BONDING_CURVE");
  } catch (e) {
    console.log("Could not get phase:", e.message);
  }

  // Try to simulate a buy call
  console.log("\nSimulating buy transaction for 1000 USDC...");
  const reserveIn = hre.ethers.parseUnits("1000", 6);
  const minTokensOut = 0;
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  try {
    const result = await amm.buy.staticCall(reserveIn, minTokensOut, userAddress, deadline, {
      from: userAddress
    });
    console.log("✓ Buy would succeed! Tokens out:", hre.ethers.formatUnits(result, 18));
  } catch (e) {
    console.log("✗ Buy would fail:");
    console.log("Error:", e.message);

    // Try to decode the revert reason
    if (e.data) {
      console.log("Error data:", e.data);
      try {
        const reason = hre.ethers.toUtf8String("0x" + e.data.slice(138));
        console.log("Revert reason:", reason);
      } catch (decodeErr) {
        // Could not decode
      }
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
