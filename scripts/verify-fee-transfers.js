const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  console.log("\n🔍 USDC Transfer Verification for LSCOR Pool\n");
  console.log("=".repeat(80));

  const poolAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";
  const treasuryAddress = "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B";
  const mockUSDCAddress = "0xB568cBaaBB76EC2104F830c9D2F3a806d5db4c90";
  const buyerAddress = "0x3937A9B521298D4c6D9d438cEFF396eD18DD7Bb6";

  const usdc = await ethers.getContractAt("MockUSDC", mockUSDCAddress);
  const ammContract = await ethers.getContractAt("HokusaiAMM", poolAddress);

  // Get current balances
  console.log("\n📊 Current USDC Balances:");
  const treasuryBalance = await usdc.balanceOf(treasuryAddress);
  const poolBalance = await usdc.balanceOf(poolAddress);
  const buyerBalance = await usdc.balanceOf(buyerAddress);
  const reserveBalance = await ammContract.reserveBalance();

  console.log("   Treasury: $" + ethers.formatUnits(treasuryBalance, 6));
  console.log("   AMM Pool: $" + ethers.formatUnits(poolBalance, 6));
  console.log("   Buyer: $" + ethers.formatUnits(buyerBalance, 6));
  console.log("   Pool reserveBalance (tracked): $" + ethers.formatUnits(reserveBalance, 6));

  // Check if pool balance matches reserve balance (they should be equal if no extra fees sitting there)
  console.log("\n   Pool USDC balance vs reserveBalance difference: $" +
    ethers.formatUnits(poolBalance - reserveBalance, 6));

  // Query all Transfer events involving the treasury
  console.log("\n📜 Querying USDC Transfer Events...\n");

  const currentBlock = await ethers.provider.getBlockNumber();

  // Get all transfers TO treasury
  const transferToTreasuryFilter = usdc.filters.Transfer(null, treasuryAddress);
  const transfersToTreasury = await usdc.queryFilter(transferToTreasuryFilter, 0, currentBlock);

  console.log("=".repeat(80));
  console.log("📥 USDC Transfers TO Treasury (" + treasuryAddress + ")");
  console.log("=".repeat(80));

  let totalReceivedByTreasury = 0n;
  let feeTransfersFromPool = [];

  for (const event of transfersToTreasury) {
    const from = event.args.from;
    const amount = event.args.value;
    totalReceivedByTreasury += amount;

    const block = await event.getBlock();
    const timestamp = new Date(block.timestamp * 1000).toISOString();

    // Check if this transfer is from the AMM pool (fee transfer)
    const isFromPool = from.toLowerCase() === poolAddress.toLowerCase();

    if (isFromPool) {
      feeTransfersFromPool.push({
        amount,
        txHash: event.transactionHash,
        block: event.blockNumber,
        timestamp
      });
    }

    console.log("\n   From: " + from + (isFromPool ? " (AMM POOL - FEE)" : ""));
    console.log("   Amount: $" + ethers.formatUnits(amount, 6));
    console.log("   Block: " + event.blockNumber);
    console.log("   Time: " + timestamp);
    console.log("   Tx: " + event.transactionHash);
  }

  // Get all transfers FROM treasury (to see if it's minting/distributing)
  const transferFromTreasuryFilter = usdc.filters.Transfer(treasuryAddress, null);
  const transfersFromTreasury = await usdc.queryFilter(transferFromTreasuryFilter, 0, currentBlock);

  console.log("\n" + "=".repeat(80));
  console.log("📤 USDC Transfers FROM Treasury");
  console.log("=".repeat(80));

  let totalSentByTreasury = 0n;

  for (const event of transfersFromTreasury) {
    const to = event.args.to;
    const amount = event.args.value;
    totalSentByTreasury += amount;

    const block = await event.getBlock();
    const timestamp = new Date(block.timestamp * 1000).toISOString();

    console.log("\n   To: " + to);
    console.log("   Amount: $" + ethers.formatUnits(amount, 6));
    console.log("   Block: " + event.blockNumber);
    console.log("   Time: " + timestamp);
    console.log("   Tx: " + event.transactionHash);
  }

  // Check MockUSDC minting
  console.log("\n" + "=".repeat(80));
  console.log("🏭 MockUSDC Minting Analysis");
  console.log("=".repeat(80));

  // Check if there's a mint function and who can call it
  try {
    const owner = await usdc.owner();
    console.log("\n   MockUSDC Owner: " + owner);
    console.log("   Is Treasury the owner? " + (owner.toLowerCase() === treasuryAddress.toLowerCase() ? "YES" : "NO"));
  } catch (e) {
    console.log("   Could not get owner (may not have owner function)");
  }

  // Query Mint/Transfer from zero address events
  const mintFilter = usdc.filters.Transfer(ethers.ZeroAddress, null);
  const mintEvents = await usdc.queryFilter(mintFilter, 0, currentBlock);

  console.log("\n   Total mint events (Transfer from 0x0): " + mintEvents.length);

  let totalMinted = 0n;
  let mintedToTreasury = 0n;

  for (const event of mintEvents) {
    const to = event.args.to;
    const amount = event.args.value;
    totalMinted += amount;

    if (to.toLowerCase() === treasuryAddress.toLowerCase()) {
      mintedToTreasury += amount;
    }
  }

  console.log("   Total USDC minted: $" + ethers.formatUnits(totalMinted, 6));
  console.log("   Minted directly to Treasury: $" + ethers.formatUnits(mintedToTreasury, 6));

  // Summary of fee transfers
  console.log("\n" + "=".repeat(80));
  console.log("💰 FEE TRANSFER SUMMARY");
  console.log("=".repeat(80));

  let totalFeesFromPool = 0n;
  console.log("\n   Fee transfers from AMM Pool to Treasury:");

  if (feeTransfersFromPool.length === 0) {
    console.log("   ⚠️ NO FEE TRANSFERS FOUND FROM POOL TO TREASURY!");
  } else {
    for (let i = 0; i < feeTransfersFromPool.length; i++) {
      const ft = feeTransfersFromPool[i];
      totalFeesFromPool += ft.amount;
      console.log("   " + (i+1) + ". $" + ethers.formatUnits(ft.amount, 6) + " at block " + ft.block);
    }
    console.log("\n   Total fees transferred to treasury: $" + ethers.formatUnits(totalFeesFromPool, 6));
  }

  // Cross-check with Buy events
  console.log("\n" + "=".repeat(80));
  console.log("🔄 CROSS-CHECK: Buy Event Fees vs Actual Transfers");
  console.log("=".repeat(80));

  const buyFilter = ammContract.filters.Buy();
  const buyEvents = await ammContract.queryFilter(buyFilter, 0, currentBlock);

  let totalFeesInBuyEvents = 0n;
  for (const event of buyEvents) {
    totalFeesInBuyEvents += event.args.fee;
  }

  console.log("\n   Fees recorded in Buy events: $" + ethers.formatUnits(totalFeesInBuyEvents, 6));
  console.log("   Fees actually transferred to treasury: $" + ethers.formatUnits(totalFeesFromPool, 6));

  if (totalFeesInBuyEvents === totalFeesFromPool) {
    console.log("   ✅ MATCH - All fees were correctly transferred!");
  } else {
    const diff = totalFeesInBuyEvents - totalFeesFromPool;
    console.log("   ❌ MISMATCH - Difference: $" + ethers.formatUnits(diff, 6));
  }

  // Net flow analysis
  console.log("\n" + "=".repeat(80));
  console.log("📊 TREASURY NET FLOW ANALYSIS");
  console.log("=".repeat(80));

  console.log("\n   Total received: $" + ethers.formatUnits(totalReceivedByTreasury, 6));
  console.log("   Total sent: $" + ethers.formatUnits(totalSentByTreasury, 6));
  console.log("   Net flow: $" + ethers.formatUnits(totalReceivedByTreasury - totalSentByTreasury, 6));
  console.log("   Current balance: $" + ethers.formatUnits(treasuryBalance, 6));

  // Expected balance calculation
  const expectedBalance = mintedToTreasury + (totalReceivedByTreasury - totalSentByTreasury);
  console.log("\n   Expected balance (minted + net received): $" + ethers.formatUnits(expectedBalance, 6));

  if (treasuryBalance === expectedBalance || mintedToTreasury === 0n) {
    // If no direct mints to treasury, check total supply flow
    const totalSupply = await usdc.totalSupply();
    console.log("\n   MockUSDC Total Supply: $" + ethers.formatUnits(totalSupply, 6));
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
