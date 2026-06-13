const path = require("path");
const hre = require("hardhat");
const { loadLaunchTokensConfig } = require("./lib/launch-tokens");
const { loadDeployment, runLaunchDeploy } = require("./create-mainnet-pools");
const { getDeploySigner } = require("./lib/get-deploy-signer");

const DEPLOYMENT_PATH = path.join(__dirname, "..", "deployments", "sepolia-latest.json");
const CONFIG_PATH = path.join(__dirname, "configs", "sepolia-launch-tokens.json");
const PENDING_ACTIONS_PATH = path.join(__dirname, "..", "deployments", "sepolia-pending-actions.json");

function getDatedDeploymentPath() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(__dirname, "..", "deployments", `sepolia-launch-${timestamp}.json`);
}

async function main() {
  const confirmationDelayMs = Number(process.env.SEPOLIA_LAUNCH_CONFIRMATION_DELAY_MS || "0");
  const deployment = await loadDeployment(DEPLOYMENT_PATH);
  const launchConfig = loadLaunchTokensConfig(CONFIG_PATH);
  const deployer = await getDeploySigner(hre);

  await runLaunchDeploy({
    deployment,
    launchConfig,
    expectedChainId: 11155111n,
    confirmationDelayMs,
    datedDeploymentPath: getDatedDeploymentPath(),
    latestDeploymentPath: DEPLOYMENT_PATH,
    pendingActionsPath: PENDING_ACTIONS_PATH,
    deployer,
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
