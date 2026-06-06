const { buildGovernanceReportPaths, loadDeployment, loadPolicy, saveJson, verifyGovernance } = require("./lib");

async function main() {
  const hre = require("hardhat");
  const { network } = hre;
  const deploymentPath = process.env.GOVERNANCE_DEPLOYMENT_FILE || `deployments/${network.name}-latest.json`;
  const deployment = loadDeployment(deploymentPath);
  const policy = loadPolicy();
  const report = await verifyGovernance({ hre, deployment, policy });
  const paths = buildGovernanceReportPaths(network.name, report.timestamp);
  saveJson(paths.datedPath, report);
  saveJson(paths.latestPath, report);

  const failingChecks = report.checks.filter((check) => check.status === "fail");
  console.log(`${report.overall.toUpperCase()}: ${report.checks.length - failingChecks.length}/${report.checks.length} checks passed`);
  if (failingChecks.length > 0) {
    for (const failure of failingChecks) {
      console.log(`FAIL ${failure.contract} ${failure.check}: expected ${failure.expected}, actual ${failure.actual}`);
    }
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
