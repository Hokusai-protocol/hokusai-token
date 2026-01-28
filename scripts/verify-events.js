const hre = require("hardhat");
const path = require("path");
const fs = require("fs");

/**
 * Event Verification Script
 *
 * Verifies that all critical events are emitted correctly on testnet deployment.
 * Queries historical events from deployed contracts and displays them.
 *
 * USAGE:
 *   node scripts/verify-events.js
 *
 * PREREQUISITES:
 *   - Contracts must be deployed (deployment JSON file exists)
 *   - Some transactions must have occurred (buys, sells, fee deposits, etc.)
 */

// Critical events to monitor
const CRITICAL_EVENTS = {
  HokusaiAMM: [
    "Buy",
    "Sell",
    "FeesDeposited",
    "Paused",
    "Unpaused",
    "ParametersUpdated"
  ],
  HokusaiAMMFactory: [
    "PoolCreated"
  ],
  TokenManager: [
    "TokenDeployed"
  ],
  ModelRegistry: [
    "StringModelRegistered",
    "PoolRegistered"
  ],
  UsageFeeRouter: [
    "FeeDeposited",
    "BatchDeposited"
  ]
};

async function main() {
  console.log("🔍 Event Verification Script\n");
  console.log("=".repeat(70));

  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, "../deployments", `${network}-latest.json`);

  if (!fs.existsSync(deploymentPath)) {
    console.error(`❌ Deployment file not found: ${deploymentPath}`);
    console.error(`   Please run deployment first:\n`);
    console.error(`   npx hardhat run scripts/deploy-testnet-full.js --network ${network}\n`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  console.log(`Network: ${deployment.network} (chainId: ${deployment.chainId})`);
  console.log(`Deployer: ${deployment.deployer}`);
  console.log("=".repeat(70));
  console.log();

  let totalEvents = 0;
  let eventsByType = {};

  try {
    // ============================================================
    // Factory Events
    // ============================================================

    console.log("📋 HokusaiAMMFactory Events");
    console.log("-".repeat(70));

    const factory = await ethers.getContractAt(
      "HokusaiAMMFactory",
      deployment.contracts.HokusaiAMMFactory
    );

    // For testnet, use deployment timestamp to estimate deployment block
    // Average block time on Sepolia is ~12 seconds
    const currentBlock = await ethers.provider.getBlockNumber();
    const deploymentTimestamp = new Date(deployment.timestamp).getTime() / 1000;
    const currentTimestamp = Date.now() / 1000;
    const estimatedBlocksSinceDeployment = Math.ceil((currentTimestamp - deploymentTimestamp) / 12);
    const estimatedDeploymentBlock = Math.max(0, currentBlock - estimatedBlocksSinceDeployment - 10);

    console.log(`\nℹ️  Deployment info:`);
    console.log(`   Deployment time: ${deployment.timestamp}`);
    console.log(`   Current block: ${currentBlock}`);
    console.log(`   Estimated deployment block: ${estimatedDeploymentBlock}`);
    console.log(`   Searching from block ${estimatedDeploymentBlock} to ${currentBlock}\n`);

    const poolCreatedFilter = factory.filters.PoolCreated();

    // Split into smaller chunks to avoid RPC limits (100 blocks per chunk)
    const chunkSize = 100;
    let poolCreatedEvents = [];

    for (let start = estimatedDeploymentBlock; start <= currentBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, currentBlock);
      try {
        const events = await factory.queryFilter(poolCreatedFilter, start, end);
        poolCreatedEvents = poolCreatedEvents.concat(events);
      } catch (error) {
        console.log(`   ⚠️  Failed to query blocks ${start}-${end}: ${error.message}`);
      }
    }

    console.log(`\n✅ PoolCreated events: ${poolCreatedEvents.length}`);
    for (const event of poolCreatedEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Model ID: ${args.modelId}`);
      console.log(`     Pool: ${args.poolAddress}`);
      console.log(`     Token: ${args.tokenAddress}`);
      console.log(`     CRR: ${args.crr / 10000}%`);
      console.log(`     Trade Fee: ${args.tradeFee / 100}%`);
      console.log(`     Tx: ${event.transactionHash}`);

      if (deployment.chainId === "11155111") {
        console.log(`     Etherscan: https://sepolia.etherscan.io/tx/${event.transactionHash}`);
      }
    }

    totalEvents += poolCreatedEvents.length;
    eventsByType["PoolCreated"] = poolCreatedEvents.length;

    // ============================================================
    // TokenManager Events
    // ============================================================

    console.log("\n\n📋 TokenManager Events");
    console.log("-".repeat(70));

    const tokenManager = await ethers.getContractAt(
      "TokenManager",
      deployment.contracts.TokenManager
    );

    const tokenDeployedFilter = tokenManager.filters.TokenDeployed();
    const tokenDeployedEvents = await tokenManager.queryFilter(tokenDeployedFilter, fromBlock, currentBlock);

    console.log(`\n✅ TokenDeployed events: ${tokenDeployedEvents.length}`);
    for (const event of tokenDeployedEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Model ID: ${args.modelId}`);
      console.log(`     Token: ${args.tokenAddress}`);
      console.log(`     Tx: ${event.transactionHash}`);
    }

    totalEvents += tokenDeployedEvents.length;
    eventsByType["TokenDeployed"] = tokenDeployedEvents.length;

    // ============================================================
    // ModelRegistry Events
    // ============================================================

    console.log("\n\n📋 ModelRegistry Events");
    console.log("-".repeat(70));

    const modelRegistry = await ethers.getContractAt(
      "ModelRegistry",
      deployment.contracts.ModelRegistry
    );

    const stringModelFilter = modelRegistry.filters.StringModelRegistered();
    const stringModelEvents = await modelRegistry.queryFilter(stringModelFilter, fromBlock, currentBlock);

    console.log(`\n✅ StringModelRegistered events: ${stringModelEvents.length}`);
    for (const event of stringModelEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Model ID: ${args.modelId}`);
      console.log(`     Token: ${args.tokenAddress}`);
      console.log(`     Metric: ${args.performanceMetric}`);
      console.log(`     Tx: ${event.transactionHash}`);
    }

    totalEvents += stringModelEvents.length;
    eventsByType["StringModelRegistered"] = stringModelEvents.length;

    const poolRegisteredFilter = modelRegistry.filters.PoolRegistered();
    const poolRegisteredEvents = await modelRegistry.queryFilter(poolRegisteredFilter, fromBlock, currentBlock);

    console.log(`\n✅ PoolRegistered events: ${poolRegisteredEvents.length}`);
    for (const event of poolRegisteredEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Model ID: ${args.modelId}`);
      console.log(`     Pool: ${args.poolAddress}`);
      console.log(`     Tx: ${event.transactionHash}`);
    }

    totalEvents += poolRegisteredEvents.length;
    eventsByType["PoolRegistered"] = poolRegisteredEvents.length;

    // ============================================================
    // AMM Pool Events
    // ============================================================

    console.log("\n\n📋 HokusaiAMM Pool Events");
    console.log("-".repeat(70));

    for (const poolInfo of deployment.pools) {
      console.log(`\n🏊 Pool: ${poolInfo.modelId} (${poolInfo.configKey})`);
      console.log(`   Address: ${poolInfo.ammAddress}`);

      const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);

      // Buy events
      const buyFilter = pool.filters.Buy();
      const buyEvents = await pool.queryFilter(buyFilter, fromBlock, currentBlock);

      console.log(`\n   ✅ Buy events: ${buyEvents.length}`);
      for (const event of buyEvents) {
        const args = event.args;
        console.log(`      Block ${event.blockNumber}:`);
        console.log(`        Buyer: ${args.buyer}`);
        console.log(`        USDC In: $${ethers.formatUnits(args.reserveIn, 6)}`);
        console.log(`        Tokens Out: ${ethers.formatEther(args.tokensOut)}`);
        console.log(`        New Spot Price: $${ethers.formatUnits(args.spotPrice, 6)}`);
        console.log(`        Tx: ${event.transactionHash}`);
      }

      totalEvents += buyEvents.length;
      eventsByType[`Buy (${poolInfo.configKey})`] = buyEvents.length;

      // Sell events
      const sellFilter = pool.filters.Sell();
      const sellEvents = await pool.queryFilter(sellFilter, fromBlock, currentBlock);

      console.log(`\n   ✅ Sell events: ${sellEvents.length}`);
      for (const event of sellEvents) {
        const args = event.args;
        console.log(`      Block ${event.blockNumber}:`);
        console.log(`        Seller: ${args.seller}`);
        console.log(`        Tokens In: ${ethers.formatEther(args.tokensIn)}`);
        console.log(`        USDC Out: $${ethers.formatUnits(args.reserveOut, 6)}`);
        console.log(`        New Spot Price: $${ethers.formatUnits(args.spotPrice, 6)}`);
        console.log(`        Tx: ${event.transactionHash}`);
      }

      totalEvents += sellEvents.length;
      eventsByType[`Sell (${poolInfo.configKey})`] = sellEvents.length;

      // FeesDeposited events
      const feesFilter = pool.filters.FeesDeposited();
      const feesEvents = await pool.queryFilter(feesFilter, fromBlock, currentBlock);

      console.log(`\n   ✅ FeesDeposited events: ${feesEvents.length}`);
      for (const event of feesEvents) {
        const args = event.args;
        console.log(`      Block ${event.blockNumber}:`);
        console.log(`        Depositor: ${args.depositor}`);
        console.log(`        Amount: $${ethers.formatUnits(args.amount, 6)}`);
        console.log(`        New Reserve: $${ethers.formatUnits(args.newReserveBalance, 6)}`);
        console.log(`        Tx: ${event.transactionHash}`);
      }

      totalEvents += feesEvents.length;
      eventsByType[`FeesDeposited (${poolInfo.configKey})`] = feesEvents.length;

      // Pause/Unpause events
      const pausedFilter = pool.filters.Paused();
      const pausedEvents = await pool.queryFilter(pausedFilter, fromBlock, currentBlock);
      const unpausedFilter = pool.filters.Unpaused();
      const unpausedEvents = await pool.queryFilter(unpausedFilter, fromBlock, currentBlock);

      if (pausedEvents.length > 0) {
        console.log(`\n   ✅ Paused events: ${pausedEvents.length}`);
        for (const event of pausedEvents) {
          console.log(`      Block ${event.blockNumber}: ${event.transactionHash}`);
        }
        totalEvents += pausedEvents.length;
        eventsByType[`Paused (${poolInfo.configKey})`] = pausedEvents.length;
      }

      if (unpausedEvents.length > 0) {
        console.log(`\n   ✅ Unpaused events: ${unpausedEvents.length}`);
        for (const event of unpausedEvents) {
          console.log(`      Block ${event.blockNumber}: ${event.transactionHash}`);
        }
        totalEvents += unpausedEvents.length;
        eventsByType[`Unpaused (${poolInfo.configKey})`] = unpausedEvents.length;
      }
    }

    // ============================================================
    // UsageFeeRouter Events
    // ============================================================

    console.log("\n\n📋 UsageFeeRouter Events");
    console.log("-".repeat(70));

    const feeRouter = await ethers.getContractAt(
      "UsageFeeRouter",
      deployment.contracts.UsageFeeRouter
    );

    const feeDepositedFilter = feeRouter.filters.FeeDeposited();
    const feeDepositedEvents = await feeRouter.queryFilter(feeDepositedFilter, fromBlock, currentBlock);

    console.log(`\n✅ FeeDeposited events: ${feeDepositedEvents.length}`);
    for (const event of feeDepositedEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Model ID: ${args.modelId}`);
      console.log(`     Pool: ${args.poolAddress}`);
      console.log(`     Amount: $${ethers.formatUnits(args.amount, 6)}`);
      console.log(`     Protocol Fee: $${ethers.formatUnits(args.protocolFee, 6)}`);
      console.log(`     Pool Deposit: $${ethers.formatUnits(args.poolDeposit, 6)}`);
      console.log(`     Tx: ${event.transactionHash}`);
    }

    totalEvents += feeDepositedEvents.length;
    eventsByType["FeeDeposited"] = feeDepositedEvents.length;

    const batchDepositedFilter = feeRouter.filters.BatchDeposited();
    const batchDepositedEvents = await feeRouter.queryFilter(batchDepositedFilter, fromBlock, currentBlock);

    console.log(`\n✅ BatchDeposited events: ${batchDepositedEvents.length}`);
    for (const event of batchDepositedEvents) {
      const args = event.args;
      console.log(`   Block ${event.blockNumber}:`);
      console.log(`     Total Amount: $${ethers.formatUnits(args.totalAmount, 6)}`);
      console.log(`     Protocol Fee: $${ethers.formatUnits(args.totalProtocolFee, 6)}`);
      console.log(`     Pool Count: ${args.poolCount}`);
      console.log(`     Tx: ${event.transactionHash}`);
    }

    totalEvents += batchDepositedEvents.length;
    eventsByType["BatchDeposited"] = batchDepositedEvents.length;

    // ============================================================
    // Summary
    // ============================================================

    console.log("\n\n" + "=".repeat(70));
    console.log("📊 Event Summary");
    console.log("=".repeat(70));

    console.log(`\nTotal events found: ${totalEvents}\n`);

    console.log("Events by type:");
    for (const [eventType, count] of Object.entries(eventsByType)) {
      console.log(`  ${eventType}: ${count}`);
    }

    if (deployment.chainId === "11155111") {
      console.log(`\n🔗 View all events on Etherscan:`);
      console.log(`   Factory: https://sepolia.etherscan.io/address/${deployment.contracts.HokusaiAMMFactory}#events`);
      console.log(`   TokenManager: https://sepolia.etherscan.io/address/${deployment.contracts.TokenManager}#events`);
      console.log(`   ModelRegistry: https://sepolia.etherscan.io/address/${deployment.contracts.ModelRegistry}#events`);

      for (const poolInfo of deployment.pools) {
        console.log(`   ${poolInfo.modelId}: https://sepolia.etherscan.io/address/${poolInfo.ammAddress}#events`);
      }
    }

    console.log(`\n✅ Event verification complete!`);

    if (totalEvents === 0) {
      console.log(`\n⚠️  No events found. This could mean:`);
      console.log(`   1. No transactions have occurred yet`);
      console.log(`   2. RPC node hasn't indexed events yet (wait a few minutes)`);
      console.log(`   3. Contracts not deployed to this network`);
    }

  } catch (error) {
    console.error("\n❌ Event verification failed:", error.message);
    console.error("\nFull error:");
    console.error(error);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
