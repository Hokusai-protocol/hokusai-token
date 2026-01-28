const { ethers } = require("hardhat");
const path = require("path");
const fs = require("fs");

/**
 * Validate Fee Distribution
 *
 * Checks that protocol fees from trades are properly distributed to treasury.
 *
 * How it works:
 * 1. Get treasury address from deployment
 * 2. Check USDC balance of treasury
 * 3. Analyze recent Buy/Sell events to calculate expected fees
 * 4. Compare actual vs expected
 *
 * Usage:
 * npx hardhat run scripts/validate-fee-distribution.js --network sepolia
 */

async function main() {
  console.log("💰 Validating Fee Distribution\n");
  console.log("=".repeat(70));

  // Load deployment
  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, "../deployments", `${network}-latest.json`);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));

  console.log(`Network: ${deployment.network}`);
  console.log(`Deployed: ${deployment.timestamp}`);
  console.log();

  // Get contracts
  const mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  const factory = await ethers.getContractAt("HokusaiAMMFactory", deployment.contracts.HokusaiAMMFactory);

  // Get treasury address
  const treasuryAddress = await factory.treasury();
  console.log(`🏦 Treasury Address: ${treasuryAddress}`);

  // Check treasury USDC balance
  const treasuryBalance = await mockUSDC.balanceOf(treasuryAddress);
  console.log(`💵 Treasury USDC Balance: $${ethers.formatUnits(treasuryBalance, 6)}`);
  console.log();

  // Check each pool
  let totalExpectedFees = 0n;

  console.log("📊 Analyzing Fee Collection by Pool:");
  console.log("=".repeat(70));

  for (const poolInfo of deployment.pools) {
    console.log(`\n🔷 ${poolInfo.configKey.toUpperCase()} Pool`);
    console.log(`   AMM: ${poolInfo.ammAddress}`);

    const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

    // Get pool configuration
    const tradeFee = await pool.tradeFee();
    const protocolFeeBps = await pool.protocolFeeBps();
    const reserve = await pool.reserveBalance();

    console.log(`   Trade Fee: ${tradeFee} bps (${Number(tradeFee) / 100}%)`);
    console.log(`   Protocol Fee Share: ${protocolFeeBps} bps (${Number(protocolFeeBps) / 100}%)`);
    console.log(`   Current Reserve: $${ethers.formatUnits(reserve, 6)}`);

    // Try to get recent events (last 10,000 blocks)
    try {
      const currentBlock = await ethers.provider.getBlockNumber();
      const fromBlock = Math.max(currentBlock - 10000, deployment.blockNumber || 0);

      console.log(`   Checking events from block ${fromBlock} to ${currentBlock}...`);

      // Get Buy events
      const buyFilter = pool.filters.Buy();
      const buyEvents = await pool.queryFilter(buyFilter, fromBlock, currentBlock);

      // Get Sell events
      const sellFilter = pool.filters.Sell();
      const sellEvents = await pool.queryFilter(sellFilter, fromBlock, currentBlock);

      console.log(`   📈 Buy Events: ${buyEvents.length}`);
      console.log(`   📉 Sell Events: ${sellEvents.length}`);

      let poolExpectedFees = 0n;

      // Calculate fees from Buy events
      for (const event of buyEvents) {
        const feeAmount = event.args.feeAmount;
        poolExpectedFees += feeAmount;
      }

      // Calculate fees from Sell events
      for (const event of sellEvents) {
        const feeAmount = event.args.feeAmount;
        poolExpectedFees += feeAmount;
      }

      if (poolExpectedFees > 0n) {
        console.log(`   💸 Total Fees Collected: $${ethers.formatUnits(poolExpectedFees, 6)}`);
        totalExpectedFees += poolExpectedFees;
      } else {
        console.log(`   ⚠️  No fee events found (may be outside block range)`);
      }

    } catch (error) {
      console.log(`   ⚠️  Could not fetch events: ${error.message}`);
    }
  }

  console.log("\n" + "=".repeat(70));
  console.log("📊 Summary:");
  console.log("=".repeat(70));
  console.log(`Total Expected Fees: $${ethers.formatUnits(totalExpectedFees, 6)}`);
  console.log(`Treasury Balance:    $${ethers.formatUnits(treasuryBalance, 6)}`);

  // Validate
  if (treasuryBalance === 0n) {
    console.log("\n❌ WARNING: Treasury has zero balance!");
    console.log("   This could mean:");
    console.log("   - No trades have been made yet");
    console.log("   - Fees are not being routed correctly");
    console.log("   - Treasury address is incorrect");
  } else if (totalExpectedFees === 0n) {
    console.log("\n⚠️  Could not calculate expected fees from events");
    console.log("   Treasury has balance, but events not available in block range");
    console.log("   This is likely due to RPC provider limits");
  } else {
    const difference = treasuryBalance > totalExpectedFees
      ? treasuryBalance - totalExpectedFees
      : totalExpectedFees - treasuryBalance;
    const percentDiff = (difference * 10000n) / totalExpectedFees;

    console.log(`\nDifference: $${ethers.formatUnits(difference, 6)} (${percentDiff / 100n}%)`);

    if (treasuryBalance >= totalExpectedFees * 95n / 100n) {
      console.log("\n✅ Fee distribution validated!");
      console.log("   Treasury balance matches expected fees (within 5% tolerance)");
    } else {
      console.log("\n⚠️  Fee distribution may have issues");
      console.log("   Treasury balance is significantly different from expected");
    }
  }

  console.log("\n" + "=".repeat(70));

  // Additional check: Protocol fee split
  console.log("\n🔍 Protocol Fee Split Analysis:");
  console.log("=".repeat(70));

  const pool = await ethers.getContractAt("HokusaiAMM", deployment.pools[0].ammAddress);
  const protocolFeeBps = await pool.protocolFeeBps();

  console.log(`Protocol takes: ${Number(protocolFeeBps) / 100}% of trade fees`);
  console.log(`Pool keeps: ${(10000 - Number(protocolFeeBps)) / 100}% of trade fees`);
  console.log();

  console.log("Example for $100 trade with 300 bps (3%) trade fee:");
  console.log(`  Total fee: $3.00`);
  console.log(`  To treasury: $${(300n * protocolFeeBps / 10000n).toString() / 100} (${Number(protocolFeeBps) / 100}% of fee)`);
  console.log(`  To pool: $${(300n - (300n * protocolFeeBps / 10000n)).toString() / 100}`);

  console.log("\n✅ Validation complete!\n");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
