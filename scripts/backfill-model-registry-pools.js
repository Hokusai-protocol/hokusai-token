/**
 * One-time remediation for the May 20, 2026 Sepolia deployment where pools
 * existed in HokusaiAMMFactory before canonical ModelRegistry registration was
 * enforced during pool creation.
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function loadDeployment(file) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

async function main() {
  const deploymentFile = process.env.POOL_BACKFILL_DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE;
  const deployment = loadDeployment(deploymentFile);
  const pools = deployment.pools || [];

  if (pools.length === 0) {
    throw new Error(`No pools found in ${deploymentFile}`);
  }

  const [signer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const modelRegistry = await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry);

  console.log(`Backfilling ModelRegistry pool mappings on chain ${chainId}`);
  console.log(`Signer: ${signer.address}`);
  console.log(`ModelRegistry: ${deployment.contracts.ModelRegistry}`);

  for (const pool of pools) {
    const modelId = String(pool.modelId);
    const poolAddress = hre.ethers.getAddress(pool.ammAddress);
    const current = await modelRegistry.getPool(modelId);

    if (current !== ZERO_ADDRESS) {
      if (hre.ethers.getAddress(current) !== poolAddress) {
        throw new Error(`Model ${modelId} already points to ${current}, expected ${poolAddress}`);
      }
      console.log(`- ${modelId}: already registered ${poolAddress}`);
      continue;
    }

    const tx = await modelRegistry.registerPool(modelId, poolAddress);
    const receipt = await tx.wait(1);
    console.log(`- ${modelId}: registered ${poolAddress} (${receipt.hash})`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
