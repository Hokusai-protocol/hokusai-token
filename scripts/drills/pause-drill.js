/*
 * HOK-2178 Gate 9 — pause kill-switch latency drill (live Sepolia).
 *
 * Times the "execute pause" leg of the kill-switch: sends DeltaVerifier.pause() from the PAUSER
 * key, waits until paused()==true, records the wall-clock, then unpauses and verifies normal
 * state resumes. (The detection→decide legs are operator/automation timing recorded separately in
 * the runbook; this measures the on-chain act, the part the contract owns.)
 *
 * Mechanism correctness is covered deterministically by test/drills/gate9-ops-drills.test.js;
 * this script produces the live timed record the runbook requires.
 *
 * Run:
 *   set -a; . ./.env.sepolia; set +a
 *   node scripts/drills/pause-drill.js            # pause -> measure -> unpause -> verify
 *   PAUSE_HOLD_SECONDS=30 node scripts/drills/pause-drill.js   # hold paused N s before unpausing
 *
 * Requires: RPC_URL, the PAUSER key in KMS (KMS_DEPLOYER_KEY_ID / KMS_DEPLOYER_EXPECTED_ADDRESS —
 * the deployer/admin holds PAUSER_ROLE on the current Sepolia deployment), AWS creds (kms:Sign).
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const dep = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "deployments", "sepolia-latest.json"), "utf8"),
  );
  const DV = dep.contracts.DeltaVerifier;

  const keyId = process.env.KMS_DEPLOYER_KEY_ID;
  if (!keyId) throw new Error("KMS_DEPLOYER_KEY_ID is required (the PAUSER key)");
  const { KmsSigner } = require("../../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId,
    provider,
  });
  const me = ethers.getAddress(await signer.getAddress());
  const expected = process.env.KMS_DEPLOYER_EXPECTED_ADDRESS;
  if (expected && me !== ethers.getAddress(expected)) {
    throw new Error(`PAUSER KMS pin mismatch: ${me} != ${expected}`);
  }

  const abi = [
    "function pause()",
    "function unpause()",
    "function paused() view returns (bool)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function PAUSER_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  ];
  const dv = new ethers.Contract(DV, abi, signer);

  if (!(await dv.hasRole(await dv.PAUSER_ROLE(), me))) {
    throw new Error(`${me} lacks PAUSER_ROLE on DeltaVerifier ${DV}`);
  }
  if (await dv.paused()) throw new Error("DeltaVerifier is already paused — unpause first");
  console.log("pauser:", me, "| DeltaVerifier:", DV);

  // --- time the pause ---
  const t0 = nowMs();
  const pauseTx = await dv.pause();
  console.log("pause tx:", pauseTx.hash);
  await pauseTx.wait();
  // Poll until paused() reflects true.
  while (!(await dv.paused())) {
    /* wait for state propagation */
  }
  const pausedMs = nowMs() - t0;
  console.log(`PAUSED after ${(pausedMs / 1000).toFixed(1)}s (submit -> paused()==true)`);

  const hold = Number(process.env.PAUSE_HOLD_SECONDS || "0");
  if (hold > 0) {
    console.log(`holding paused for ${hold}s ...`);
    await new Promise((r) => setTimeout(r, hold * 1000));
  }

  // --- restore ---
  if (!(await dv.hasRole(await dv.DEFAULT_ADMIN_ROLE(), me))) {
    console.warn(`WARNING: ${me} lacks DEFAULT_ADMIN_ROLE; cannot unpause from this key. Unpause via admin.`);
    return;
  }
  const t1 = nowMs();
  const unpauseTx = await dv.unpause();
  console.log("unpause tx:", unpauseTx.hash);
  await unpauseTx.wait();
  while (await dv.paused()) {
    /* wait for state propagation */
  }
  const unpausedMs = nowMs() - t1;
  console.log(`UNPAUSED after ${(unpausedMs / 1000).toFixed(1)}s; normal processing resumes.`);

  console.log(
    `\nGate 9 pause drill record: pause=${(pausedMs / 1000).toFixed(1)}s unpause=${(unpausedMs / 1000).toFixed(1)}s ` +
      `network=sepolia DeltaVerifier=${DV}`,
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
