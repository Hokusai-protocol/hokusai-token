const hre = require("hardhat");
const { ethers } = hre;
const { deployFullStack, stringifyError } = require("./lib/deploy-stack");
const { getDeploySigner } = require("./lib/get-deploy-signer");

const MAINNET_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";

function getMainnetConfig(deployerAddress) {
  return {
    name: "mainnet",
    expectedChainId: 1n,
    reserveTokenAddress: MAINNET_USDC,
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
    minDeployerBalanceEth: "0.5",
    maxGasPriceGwei: process.env.MAX_GAS_PRICE_GWEI
      ? Number(process.env.MAX_GAS_PRICE_GWEI)
      : 100,
    confirmationPauseSeconds: 10,
  };
}

async function main() {
  const deployer = await getDeploySigner(hre);
  const dryRun = process.env.DRY_RUN === "true";
  const config = getMainnetConfig(deployer.address);

  console.log("Starting mainnet deployment");
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Treasury: ${config.treasury}`);
  console.log(`Backend service: ${config.backendService || "none"}`);
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
  console.error("Mainnet deployment failed:");
  console.error(stringifyError(error));
  process.exitCode = 1;
});
