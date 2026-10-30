// HOK-3318: move per-model HokusaiToken ownership from the admin Safe to the
// 48h timelock, so `setController` (the token's only owner power) carries the
// same public notice as a pool upgrade.
//
// The factory makes the governor (admin Safe) the owner at token creation and
// the deployer never owns the tokens, so the governance handoff cannot move
// them. Run this after create-pools and before the handoff:
//
//   HARDHAT_NETWORK=mainnet node scripts/governance/token-ownership-safe-bundle.js bundle
//     -> deployments/<network>-token-ownership-safe.json (Transaction Builder)
//   HARDHAT_NETWORK=mainnet node scripts/governance/token-ownership-safe-bundle.js check
//     -> exits non-zero unless every launch token is owned by the timelock
//
// The timelock comes from TIMELOCK_ADDRESS, else deployment.governance.timelock.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const tl = require("../lib/timelock-ops");
const { resolveDeploymentPath, DEFAULT_ADMIN_SAFE } = require("./lib");

const OWNABLE_ABI = [
  "function owner() view returns (address)",
  "function transferOwnership(address newOwner)",
];

function eq(a, b) {
  return String(a).toLowerCase() === String(b).toLowerCase();
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "bundle" && mode !== "check") {
    throw new Error("usage: token-ownership-safe-bundle.js <bundle|check>");
  }

  const network = hre.network.name;
  const deploymentPath = resolveDeploymentPath(network);
  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  const timelock = process.env.TIMELOCK_ADDRESS || deployment.governance?.timelock;
  if (!timelock || !ethers.isAddress(timelock)) {
    throw new Error("Set TIMELOCK_ADDRESS (or record deployment.governance.timelock)");
  }
  const adminSafe = process.env.ADMIN_SAFE_ADDRESS || DEFAULT_ADMIN_SAFE;
  const { chainId } = await ethers.provider.getNetwork();

  const pools = deployment.pools || [];
  if (pools.length === 0) throw new Error(`No pools recorded in ${deploymentPath}`);

  const iface = new ethers.Interface(OWNABLE_ABI);
  const calls = [];
  const failures = [];
  for (const pool of pools) {
    const token = new ethers.Contract(pool.tokenAddress, OWNABLE_ABI, ethers.provider);
    const owner = await token.owner();
    const label = `${pool.configKey} (model ${pool.modelId}) ${pool.tokenAddress}`;
    console.log(`  ${label}: owner ${owner}`);

    if (mode === "check") {
      if (!eq(owner, timelock)) failures.push(`${label} owned by ${owner}, expected timelock ${timelock}`);
      continue;
    }
    if (eq(owner, timelock)) continue;
    if (!eq(owner, adminSafe)) {
      failures.push(`${label} owned by ${owner}, not the admin Safe ${adminSafe}; the Safe cannot move it`);
      continue;
    }
    calls.push({
      to: pool.tokenAddress,
      data: iface.encodeFunctionData("transferOwnership", [timelock]),
      label: `${pool.configKey}.transferOwnership(${timelock})`,
    });
  }

  if (failures.length > 0) {
    failures.forEach((f) => console.error(`  FAIL ${f}`));
    process.exitCode = 1;
    return;
  }
  if (mode === "check") {
    console.log(`  OK: all ${pools.length} launch tokens are owned by the timelock ${timelock}`);
    return;
  }
  if (calls.length === 0) {
    console.log("  Nothing to do: every launch token is already owned by the timelock.");
    return;
  }

  const bundle = tl.safeBundle({
    chainId,
    safe: adminSafe,
    name: "HOK-3318 token ownership to timelock",
    description: calls.map((c) => c.label).join("; "),
    calls,
  });
  const file = path.resolve(__dirname, "..", "..", "deployments", `${network}-token-ownership-safe.json`);
  fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
  console.log(`\n  Safe bundle: ${path.relative(process.cwd(), file)}`);
  calls.forEach((c) => console.log(`    - ${c.label}`));
  console.log("  Load it in the Safe Transaction Builder, sign 2-of-3 and execute, then run `check`.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
