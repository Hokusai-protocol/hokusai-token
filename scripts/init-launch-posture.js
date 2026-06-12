const path = require("path");

const {
  buildSafeTx,
  executeLaunchPosturePlan,
  loadLaunchPostureConfig,
  parseArgs,
  planLaunchPostureInit,
  saveJson,
} = require("./lib/launch-posture");

function printPlan(plan) {
  if (plan.plan.length === 0) {
    console.log("Launch posture already matches the requested initialization state");
    return;
  }

  for (const step of plan.plan) {
    console.log(`${step.name}: ${step.contractName}.${step.method}(${step.args.join(", ")})`);
    console.log(`  reason: ${step.reason}`);
  }
}

async function runInitLaunchPosture(hre, argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const mode = args.execute ? "execute" : args["safe-txs"] ? "safe-txs" : "dry-run";
  const loaded = loadLaunchPostureConfig({
    networkName: args.network || hre.network.name,
    configPath: args.config,
    deploymentArtifactPath: args.deployment,
  });
  const plan = await planLaunchPostureInit({
    hre,
    config: loaded.config,
    deployment: loaded.deployment,
  });

  printPlan(plan);
  if (mode === "execute" && plan.plan.length > 0) {
    const [signer] = await hre.ethers.getSigners();
    await executeLaunchPosturePlan({ signer, hre, plan });
  } else if (mode === "safe-txs") {
    const providerNetwork = await hre.ethers.provider.getNetwork();
    const safeJson = buildSafeTx(providerNetwork.chainId, loaded.config.adminSafe, plan.plan);
    const outputPath = path.resolve(process.cwd(), args["safe-txs"]);
    saveJson(outputPath, safeJson);
    console.log(`Safe Transaction Builder JSON written to ${outputPath}`);
  }

  return { plan, mode, hasChanges: plan.plan.length > 0 };
}

async function main() {
  const hre = require("hardhat");
  const result = await runInitLaunchPosture(hre);
  if (result.mode === "dry-run" && result.hasChanges) {
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
  runInitLaunchPosture,
};
