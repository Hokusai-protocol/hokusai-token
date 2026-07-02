// One-off: execute the mainnet launch-posture Safe bundle from the DEPLOYER key.
//
// Pre-handoff, the deployer (not the admin Safe) holds DeltaVerifier DEFAULT_ADMIN_ROLE and
// ModelRegistry ownership, so the posture (attesters/budget/weight-genesis/disableLegacyMints)
// must be executed by the deployer — same as the Sepolia rehearsal's `--execute`. This sends the
// exact txs from deployments/mainnet-launch-posture-safe.json (already decoded + verified) via
// the KMS deploy signer, after asserting the signer actually holds the required roles.
//
//   HARDHAT_NETWORK=mainnet node scripts/execute-posture-mainnet.js
//
// Then resume the conductor: node scripts/launch-mainnet.js --network mainnet --from verify-posture-pre
const hre = require("hardhat");
const path = require("path");
const { ethers } = hre;
const { getDeploySigner } = require("./lib/get-deploy-signer");

const BUNDLE = path.resolve(process.cwd(), "deployments/mainnet-launch-posture-safe.json");
const DEPLOYMENT = path.resolve(process.cwd(), "deployments/mainnet-latest.json");
const ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

async function main() {
  const bundle = require(BUNDLE);
  const deployment = require(DEPLOYMENT);
  const DV = deployment.contracts.DeltaVerifier;
  const MR = deployment.contracts.ModelRegistry;

  const signer = await getDeploySigner(hre);
  const me = await signer.getAddress();
  const net = await ethers.provider.getNetwork();
  console.log(`network chainId ${net.chainId} · executor ${me}`);
  if (net.chainId !== 1n) throw new Error(`Expected mainnet (chainId 1), got ${net.chainId}`);

  // Safety pre-check: the executor MUST hold the roles the bundle needs, or every tx reverts.
  const dv = new ethers.Contract(DV, ["function hasRole(bytes32,address) view returns (bool)"], signer);
  const mr = new ethers.Contract(MR, ["function owner() view returns (address)"], signer);
  const hasDvAdmin = await dv.hasRole(ADMIN_ROLE, me);
  const mrOwner = await mr.owner();
  console.log(`  DeltaVerifier DEFAULT_ADMIN held by executor: ${hasDvAdmin}`);
  console.log(`  ModelRegistry owner == executor: ${mrOwner.toLowerCase() === me.toLowerCase()} (${mrOwner})`);
  if (!hasDvAdmin) throw new Error("Executor lacks DeltaVerifier DEFAULT_ADMIN_ROLE — aborting.");
  if (mrOwner.toLowerCase() !== me.toLowerCase()) throw new Error("Executor is not ModelRegistry owner — aborting.");

  console.log(`\nExecuting ${bundle.transactions.length} posture txs (all target DeltaVerifier/ModelRegistry)…`);
  for (let i = 0; i < bundle.transactions.length; i++) {
    const t = bundle.transactions[i];
    if (t.to.toLowerCase() !== DV.toLowerCase() && t.to.toLowerCase() !== MR.toLowerCase()) {
      throw new Error(`tx ${i} targets unexpected address ${t.to} — aborting.`);
    }
    process.stdout.write(`[${i}] ${t.to} ${String(t.data).slice(0, 10)} … `);
    const tx = await signer.sendTransaction({ to: t.to, data: t.data, value: BigInt(t.value || 0) });
    const r = await tx.wait();
    console.log(`✅ ${tx.hash} (gas ${r.gasUsed})`);
  }
  console.log("\n✅ Launch posture applied by the deployer. Next: verify-posture-pre.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
