const { loadDeployment, loadPolicy, runGovernanceTransfer, writeDeployment } = require("./lib");

async function main() {
  const hre = require("hardhat");
  const { network } = hre;
  const deploymentPath = process.env.GOVERNANCE_DEPLOYMENT_FILE || `deployments/${network.name}-latest.json`;
  const dryRun = process.env.DRY_RUN === "true";
  const deployment = loadDeployment(deploymentPath);
  const policy = loadPolicy();
  const result = await runGovernanceTransfer({
    hre,
    deployment,
    policy,
    dryRun,
    logger: console,
  });

  if (!dryRun) {
    writeDeployment(deploymentPath, result.deployment);
  }

  console.log(JSON.stringify({
    network: deployment.network,
    dryRun,
    timelock: result.governance.timelock,
    adminSafe: result.governance.adminSafe,
    emergencySafe: result.governance.emergencySafe,
    actionCount: result.actions.length,
    actions: result.actions,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
