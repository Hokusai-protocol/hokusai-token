const hre = require('hardhat');
const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

/**
 * Backfill flatCurveThreshold and flatCurvePrice for existing deployments
 *
 * This script:
 * 1. Loads existing deployment JSON
 * 2. Queries each pool for phase parameters
 * 3. Updates the JSON with phase parameters
 * 4. Saves updated deployment artifact
 *
 * Usage: npx hardhat run scripts/backfill-phase-params.js --network sepolia
 */

async function main() {
  const network = hre.network.name;
  const deploymentPath = path.join(__dirname, '..', 'deployments', `${network}-latest.json`);

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backfilling Phase Parameters`);
  console.log(`Network: ${network}`);
  console.log(`Deployment: ${deploymentPath}`);
  console.log(`${'='.repeat(60)}\n`);

  // Check if deployment file exists
  if (!fs.existsSync(deploymentPath)) {
    console.error(`❌ Deployment file not found: ${deploymentPath}`);
    process.exit(1);
  }

  // Load deployment
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  if (!deployment.pools || deployment.pools.length === 0) {
    console.log('No pools found in deployment. Nothing to backfill.');
    process.exit(0);
  }

  console.log(`Found ${deployment.pools.length} pool(s) to process\n`);

  // Track updates
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Update each pool
  for (const pool of deployment.pools) {
    console.log(`Processing pool: ${pool.modelId}`);
    console.log(`  Address: ${pool.ammAddress}`);

    try {
      // Check if already has phase parameters
      if (pool.flatCurveThreshold && pool.flatCurvePrice) {
        console.log(`  ℹ️  Already has phase parameters - skipping`);
        console.log(`     Threshold: ${ethers.formatUnits(pool.flatCurveThreshold, 6)} USDC`);
        console.log(`     Price: $${ethers.formatUnits(pool.flatCurvePrice, 6)}`);
        skippedCount++;
        continue;
      }

      // Fetch phase parameters from contract
      const ammPool = await ethers.getContractAt('HokusaiAMM', pool.ammAddress);

      const flatCurveThreshold = await ammPool.FLAT_CURVE_THRESHOLD();
      const flatCurvePrice = await ammPool.FLAT_CURVE_PRICE();

      console.log(`  ✅ Fetched phase parameters:`);
      console.log(`     Threshold: ${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
      console.log(`     Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

      // Update pool object
      pool.flatCurveThreshold = flatCurveThreshold.toString();
      pool.flatCurvePrice = flatCurvePrice.toString();

      updatedCount++;
    } catch (error) {
      console.error(`  ❌ Error fetching parameters: ${error.message}`);
      errorCount++;
    }

    console.log(); // Blank line between pools
  }

  // Save updated deployment
  const backupPath = deploymentPath.replace('.json', '.backup.json');
  fs.writeFileSync(backupPath, JSON.stringify(deployment, null, 2));
  console.log(`Backup saved to: ${backupPath}`);

  fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Backfill Complete`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Updated: ${updatedCount} pool(s)`);
  console.log(`Skipped: ${skippedCount} pool(s) (already had parameters)`);
  console.log(`Errors:  ${errorCount} pool(s)`);
  console.log(`\n✅ Updated deployment file: ${deploymentPath}\n`);

  if (errorCount > 0) {
    console.warn('⚠️  Some pools had errors. Review logs above.');
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
