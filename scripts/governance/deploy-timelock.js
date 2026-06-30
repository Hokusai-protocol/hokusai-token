const {
  buildTimelockArtifactPaths,
  getGovernanceContext,
  loadDeployment,
  loadPolicy,
  nowIso,
  writeDeployment,
  saveJson,
} = require("./lib");
const { getDeploySigner } = require("../lib/get-deploy-signer");

async function main() {
  const hre = require("hardhat");
  const { ethers, network } = hre;
  const deploymentPath = process.env.GOVERNANCE_DEPLOYMENT_FILE || `deployments/${network.name}-latest.json`;
  const dryRun = process.env.DRY_RUN === "true";
  const deployment = loadDeployment(deploymentPath);
  const policy = loadPolicy();
  // Use the KMS-aware deploy signer (mainnet + sepolia sign via KMS_DEPLOYER_KEY_ID, so the
  // hardhat `accounts` array is empty and ethers.getSigners() returns nothing).
  const deployer = await getDeploySigner(hre);
  const governance = getGovernanceContext({
    deployment,
    policy,
    deployer: deployer.address,
  });

  if (deployment.governance?.timelock) {
    console.log(`Timelock already recorded at ${deployment.governance.timelock}`);
    return;
  }

  const Timelock = await ethers.getContractFactory("HokusaiTimelockController", deployer);
  const proposerExecutors = [governance.adminSafe];

  if (dryRun) {
    console.log("DRY_RUN=true: deployment skipped");
    console.log({
      minDelay: governance.minDelay,
      proposers: proposerExecutors,
      executors: proposerExecutors,
      admin: "0x0000000000000000000000000000000000000000",
    });
    return;
  }

  const timelock = await Timelock.deploy(
    governance.minDelay,
    proposerExecutors,
    proposerExecutors,
    ethers.ZeroAddress
  );
  await timelock.waitForDeployment();

  const timestamp = nowIso();
  const timelockAddress = await timelock.getAddress();
  deployment.governance = {
    ...(deployment.governance || {}),
    timelock: timelockAddress,
    adminSafe: governance.adminSafe,
    emergencySafe: governance.emergencySafe,
    minDelay: governance.minDelay,
    deployedAt: timestamp,
  };

  writeDeployment(deploymentPath, deployment);
  const paths = buildTimelockArtifactPaths(network.name, timestamp);
  saveJson(paths.datedPath, {
    network: network.name,
    timestamp,
    timelock: timelockAddress,
    minDelay: governance.minDelay,
    adminSafe: governance.adminSafe,
    emergencySafe: governance.emergencySafe,
    deployer: deployer.address,
  });

  console.log(`Timelock deployed: ${timelockAddress}`);
  console.log(`Deployment updated: ${paths.latestDeploymentPath}`);
  console.log(`Artifact written: ${paths.datedPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
