const {
  assertLaunchPosture,
  buildVerifyReportPaths,
  formatDiff,
  loadLaunchPostureConfig,
  parseArgs,
  saveJson,
} = require("./lib/launch-posture");

async function runVerifyLaunchPosture(hre, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const loaded = loadLaunchPostureConfig({
    networkName: args.network || hre.network.name,
    configPath: args.config,
    deploymentArtifactPath: args.deployment,
  });
  loaded.config.__resolvedConfigPath = loaded.configPath;
  loaded.config.__resolvedDeploymentPath = loaded.deploymentPath;

  // --skip-ownership: pre-handoff gate. Ownership/admin authority hasn't moved to governance
  // yet, so verify mint posture only and defer the ownership audit to the post-handoff run.
  // These four blocks are exactly the (opt-in) ownership audit; dropping them leaves the mint
  // posture assertions (legacyMintsDisabled, attesters, budgets, weight-genesis) intact.
  if (args["skip-ownership"]) {
    for (const key of ["expectedTokenOwner", "expectedParamsAdmin", "roleAudit", "ownershipAudit"]) {
      delete loaded.config[key];
    }
    console.log("(--skip-ownership: verifying mint posture only; ownership audit deferred to post-handoff)");
  }

  const report = await assertLaunchPosture({
    hre,
    config: loaded.config,
    deployment: loaded.deployment,
  });
  const paths = buildVerifyReportPaths(hre.network.name, report.timestamp);
  saveJson(paths.datedPath, report);
  saveJson(paths.latestPath, report);

  const summary = formatDiff(report);
  console.log(summary);

  return { report, paths, summary };
}

async function main() {
  const hre = require("hardhat");
  const { report } = await runVerifyLaunchPosture(hre);
  if (report.failures.length > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  runVerifyLaunchPosture,
};
