// HOK-3291 step 4: retire the July 2026 mainnet deployment after the cutover.
//
// Reads the legacy addresses from deployments/legacy-2026-07/mainnet.addresses.json
// and checks the current role holders on-chain, then writes two admin Safe bundles:
//
//   1-safe     immediate: pause the legacy pools (old factory pauser = Safe),
//              revoke SUBMITTER_ROLE from the backend on the old DeltaVerifier and
//              pause it (both Safe-held), and schedule, through the 48h timelock,
//              the FEE_DEPOSITOR_ROLE revoke on the old UsageFeeRouter (timelock-admin)
//   2-execute  after the delay: execute that timelock operation
//
//   node scripts/legacy-drain/retire-safe-bundle.js      (read-only; mainnet RPC)

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const tl = require("../lib/timelock-ops");

const ROOT = path.resolve(__dirname, "..", "..");
const LEGACY = path.join(ROOT, "deployments/legacy-2026-07/mainnet.addresses.json");
const RPC = process.env.MAINNET_READ_RPC_URL || "https://ethereum-rpc.publicnode.com";

const ROLE_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function revokeRole(bytes32 role, address account)",
  "function pause()",
  "function paused() view returns (bool)",
];
const FACTORY_ABI = ["function pausePools(string[] modelIds)", "function pauser() view returns (address)"];

async function main() {
  const legacy = JSON.parse(fs.readFileSync(LEGACY, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  const { timelock, adminSafe } = legacy.governance;
  const backend = legacy.settlement.backendSettler;
  const c = legacy.contracts;
  const modelIds = legacy.tokens.map((p) => String(p.modelId));

  const factory = new ethers.Contract(c.HokusaiAMMFactory, FACTORY_ABI, provider);
  const verifier = new ethers.Contract(c.DeltaVerifier, ROLE_ABI, provider);
  const router = new ethers.Contract(c.UsageFeeRouter, ROLE_ABI, provider);
  const SUBMITTER = ethers.id("SUBMITTER_ROLE");
  const FEE_DEPOSITOR = ethers.id("FEE_DEPOSITOR_ROLE");

  const require_ = (ok, msg) => { if (!ok) throw new Error(msg); };
  require_((await factory.pauser()).toLowerCase() === adminSafe.toLowerCase(), "admin Safe is not the legacy factory pauser");
  require_(await verifier.hasRole(ethers.ZeroHash, adminSafe), "admin Safe is not legacy DeltaVerifier admin");
  require_(await router.hasRole(ethers.ZeroHash, timelock), "timelock is not legacy UsageFeeRouter admin");

  const immediate = [{
    to: c.HokusaiAMMFactory,
    data: factory.interface.encodeFunctionData("pausePools", [modelIds]),
    label: `legacyFactory.pausePools([${modelIds.join(",")}])`,
  }];
  if (await verifier.hasRole(SUBMITTER, backend)) {
    immediate.push({
      to: c.DeltaVerifier,
      data: verifier.interface.encodeFunctionData("revokeRole", [SUBMITTER, backend]),
      label: `legacyDeltaVerifier.revokeRole(SUBMITTER_ROLE, ${backend})`,
    });
  }
  if (!(await verifier.paused())) {
    immediate.push({ to: c.DeltaVerifier, data: verifier.interface.encodeFunctionData("pause"), label: "legacyDeltaVerifier.pause()" });
  }

  const files = [];
  const write = (name, title, calls) => {
    const file = path.join(ROOT, "deployments", `mainnet-legacy-retire-${name}-safe.json`);
    const bundle = tl.safeBundle({ chainId: 1, safe: adminSafe, name: title, description: calls.map((x) => x.label).join("; "), calls });
    fs.writeFileSync(file, JSON.stringify(bundle, null, 2) + "\n");
    files.push(file);
    console.log(`  ${path.relative(process.cwd(), file)}`);
    calls.forEach((x) => console.log(`    - ${x.label}`));
  };

  if (await router.hasRole(FEE_DEPOSITOR, backend)) {
    const op = tl.batchOp(ethers, {
      calls: [{
        to: c.UsageFeeRouter,
        data: router.interface.encodeFunctionData("revokeRole", [FEE_DEPOSITOR, backend]),
        label: `legacyUsageFeeRouter.revokeRole(FEE_DEPOSITOR_ROLE, ${backend})`,
      }],
      salt: "HOK-3291 legacy router FEE_DEPOSITOR revoke",
    });
    immediate.push(tl.scheduleCall(ethers, timelock, op, 172800));
    write("1", "HOK-3291 retire legacy deployment (pause, revoke, schedule)", immediate);
    write("2-execute", "HOK-3291 retire legacy deployment — execute router revoke (after 48h)", [tl.executeCall(ethers, timelock, op)]);
    console.log(`  timelock operation id ${tl.operationId(ethers, op)}`);
  } else {
    write("1", "HOK-3291 retire legacy deployment (pause, revoke)", immediate);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
