// One-off: reconcile DeltaVerifier/DataContribution operational roles to the launch-posture
// roleAudit BEFORE the governance handoff, while the DEPLOYER still holds DEFAULT_ADMIN on both.
//
// The mainnet deploy granted the deployer bootstrap SUBMITTER (DeltaVerifier) and RECORDER
// (DataContributionRegistry), but the handoff policy neither revokes them nor grants SUBMITTER to
// the backend relayer — so post-handoff verify-launch-posture would fail and, worse, the relayer
// couldn't submit deltas. This grants the relayer SUBMITTER and revokes the deployer's leftover
// SUBMITTER + RECORDER. DeltaVerifier keeps RECORDER (the expected recorder). Idempotent.
//
//   HARDHAT_NETWORK=mainnet node scripts/fix-deployer-roles-mainnet.js
//
// Then run the handoff (deployer -> timelock/Safe) and verify-posture-post.
const hre = require("hardhat");
const path = require("path");
const { ethers } = hre;
const { getDeploySigner } = require("./lib/get-deploy-signer");

const ADMIN = "0x0000000000000000000000000000000000000000000000000000000000000000";
const RELAYER = require(path.resolve(process.cwd(), "scripts/configs/mainnet-launch-posture.json")).submitterRelayer;

async function roleHash(c, getter, name) {
  try { return await c[getter](); } catch { return ethers.id(name); }
}

async function main() {
  const dep = require(path.resolve(process.cwd(), "deployments/mainnet-latest.json"));
  const DV = dep.contracts.DeltaVerifier;
  const DC = dep.contracts.DataContributionRegistry;
  const signer = await getDeploySigner(hre);
  const me = await signer.getAddress();
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 1n) throw new Error(`Expected mainnet (chainId 1), got ${net.chainId}`);
  console.log(`executor ${me} · relayer ${RELAYER}`);

  const abi = [
    "function SUBMITTER_ROLE() view returns (bytes32)",
    "function RECORDER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function grantRole(bytes32,address)",
    "function revokeRole(bytes32,address)",
  ];
  const dv = new ethers.Contract(DV, abi, signer);
  const dc = new ethers.Contract(DC, abi, signer);
  const SUB = await roleHash(dv, "SUBMITTER_ROLE", "SUBMITTER_ROLE");
  const REC = await roleHash(dc, "RECORDER_ROLE", "RECORDER_ROLE");

  if (!(await dv.hasRole(ADMIN, me))) throw new Error("Executor lacks DeltaVerifier DEFAULT_ADMIN — aborting.");
  if (!(await dc.hasRole(ADMIN, me))) throw new Error("Executor lacks DataContribution DEFAULT_ADMIN — aborting.");

  const send = async (label, contract, fn, role, who) => {
    process.stdout.write(`${label} … `);
    const tx = await contract[fn](role, who);
    const r = await tx.wait();
    console.log(`✅ ${tx.hash} (gas ${r.gasUsed})`);
  };

  // 1) relayer must be able to submit deltas
  if (await dv.hasRole(SUB, RELAYER)) console.log("grant SUBMITTER->relayer … already-set");
  else await send("grant SUBMITTER->relayer", dv, "grantRole", SUB, RELAYER);
  // 2) deployer must not retain SUBMITTER
  if (!(await dv.hasRole(SUB, me))) console.log("revoke SUBMITTER<-deployer … already-clear");
  else await send("revoke SUBMITTER<-deployer", dv, "revokeRole", SUB, me);
  // 3) deployer must not retain RECORDER (DeltaVerifier keeps it)
  if (!(await dc.hasRole(REC, me))) console.log("revoke RECORDER<-deployer … already-clear");
  else await send("revoke RECORDER<-deployer", dc, "revokeRole", REC, me);

  console.log("\nEnd-state:");
  console.log(`  DeltaVerifier SUBMITTER  relayer=${await dv.hasRole(SUB, RELAYER)} deployer=${await dv.hasRole(SUB, me)}`);
  console.log(`  DataContribution RECORDER DeltaVerifier=${await dc.hasRole(REC, DV)} deployer=${await dc.hasRole(REC, me)}`);
  console.log("\n✅ Roles reconciled. Next: run the handoff, then verify-posture-post.");
}

main().then(() => process.exit(0)).catch((e) => { console.error("\n❌ FAILED:", e.message); process.exit(1); });
