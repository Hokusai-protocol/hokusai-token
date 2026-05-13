const hre = require("hardhat");
const { ethers } = hre;
const { deployFullStack, stringifyError } = require("./lib/deploy-stack");

function getSepoliaConfig(deployerAddress) {
  return {
    name: "sepolia",
    expectedChainId: 11155111n,
    reserveTokenAddress: process.env.SEPOLIA_USDC_ADDRESS || null,
    factoryDefaults: {
      crr: 200000,
      tradeFee: 30,
      ibrDuration: 7 * 24 * 60 * 60,
      flatCurveThreshold: 25000n * 10n ** 6n,
      flatCurvePrice: 10000,
    },
    deltaVerifierParams: {
      baseRewardRate: 1000,
      minImprovementBps: 100,
      maxReward: ethers.parseEther("1000000"),
    },
    infrastructureCostOracleParams: {
      initialGrossMarginBps: Number(process.env.INFRASTRUCTURE_GROSS_MARGIN_BPS || "1500"),
    },
    treasury: process.env.TREASURY_ADDRESS || deployerAddress,
    backendService: process.env.BACKEND_SERVICE_ADDRESS || null,
    verifierAddress: process.env.VERIFIER_ADDRESS || deployerAddress,
    minDeployerBalanceEth: "0.1",
    maxGasPriceGwei: process.env.MAX_GAS_PRICE_GWEI
      ? Number(process.env.MAX_GAS_PRICE_GWEI)
      : null,
    confirmationPauseSeconds: 0,
  };
}

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const dryRun = process.env.DRY_RUN === "true";
  const config = getSepoliaConfig(deployer.address);

  console.log("Starting Sepolia deployment");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Treasury: ${config.treasury}`);
  console.log(`Backend service: ${config.backendService || "none"}`);
  console.log(`Reserve token: ${config.reserveTokenAddress || "MockUSDC fallback"}`);
  console.log(`DRY_RUN: ${dryRun}`);

  const result = await deployFullStack(config, {
    hre,
    dryRun,
    logger: console,
    skipArtifactWrite: process.env.SKIP_ARTIFACT_WRITE === "true",
  });

  const { artifact, paths } = await result.writeArtifact();
  console.log("Deployment complete");
  console.log(JSON.stringify(artifact.contracts, null, 2));
  if (paths) {
    console.log(`Artifact: ${paths.datedPath}`);
    if (!artifact.dryRun) {
      console.log(`Latest: ${paths.latestPath}`);
    }
  }
}

main().catch((error) => {
  console.error("Sepolia deployment failed:");
  console.error(stringifyError(error));
  process.exitCode = 1;
});
