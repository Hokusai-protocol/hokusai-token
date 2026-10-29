// Post-verification supplier distribution through the 48h timelock.
//
// Launch tokens with `distributionTiming: post-verification` leave their supplier
// mints in the pending-actions file. TokenManager is timelock-owned after the
// handoff, so the admin Safe schedules `distributeModelSupplierAllocation` for
// each pending model and executes it once the delay has passed. The July 2026
// launch built these two bundles by hand.
//
//   HARDHAT_NETWORK=mainnet node scripts/governance/supplier-distribution-safe-bundle.js
//     -> deployments/<network>-supplier-distribute-1-schedule-safe.json
//        deployments/<network>-supplier-distribute-2-execute-safe.json (valid after the delay)
//
// Both bundles share one salt, derived from the deployment timestamp, so the
// execute bundle matches the scheduled operation.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const tl = require("../lib/timelock-ops");
const { resolveDeploymentPath, DEFAULT_ADMIN_SAFE } = require("./lib");

const ROOT = path.resolve(__dirname, "..", "..");

async function main() {
  const network = hre.network.name;
  const deployment = JSON.parse(fs.readFileSync(resolveDeploymentPath(network), "utf8"));
  const timelockAddress = deployment.governance?.timelock;
  if (!timelockAddress) throw new Error("deployment.governance.timelock is not recorded; run the handoff first");
  const tokenManager = deployment.contracts.TokenManager;
  const adminSafe = process.env.ADMIN_SAFE_ADDRESS || DEFAULT_ADMIN_SAFE;

  const pendingPath = path.resolve(ROOT, deployment.pendingActionsPath || `deployments/${network}-pending-actions.json`);
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  const actions = (pending.actions || []).filter((a) => a.reason === "post-verification supplier mint");
  if (actions.length === 0) throw new Error(`No pending supplier mints in ${pendingPath}`);

  const tm = await ethers.getContractAt("TokenManager", tokenManager);
  if ((await tm.owner()).toLowerCase() !== timelockAddress.toLowerCase()) {
    throw new Error(`TokenManager ${tokenManager} is not owned by the timelock ${timelockAddress}`);
  }
  const timelock = new ethers.Contract(timelockAddress, ["function getMinDelay() view returns (uint256)"], ethers.provider);
  const delay = await timelock.getMinDelay();

  const calls = actions.map((a) => ({
    to: tokenManager,
    data: tm.interface.encodeFunctionData("distributeModelSupplierAllocation", [String(a.modelId)]),
    label: `distributeModelSupplierAllocation(${a.modelId})`,
  }));
  const op = tl.batchOp(ethers, { calls, salt: `supplier-distribution:${network}:${deployment.timestamp}` });
  const { chainId } = await ethers.provider.getNetwork();

  const write = (step, name, call) => {
    const file = path.join(ROOT, "deployments", `${network}-supplier-distribute-${step}-safe.json`);
    const bundle = tl.safeBundle({ chainId, safe: adminSafe, name, description: call.label, calls: [call] });
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
    console.log(`  ${path.relative(process.cwd(), file)}`);
  };
  write("1-schedule", `Supplier distribution — STEP 1 schedule (${delay}s timelock)`, tl.scheduleCall(ethers, timelockAddress, op, delay));
  write("2-execute", "Supplier distribution — STEP 2 execute (after the delay)", tl.executeCall(ethers, timelockAddress, op));
  console.log(`  operation id ${tl.operationId(ethers, op)}`);
  calls.forEach((c) => console.log(`    - ${c.label}`));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
