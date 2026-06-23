/*
 * HOK-2178 Gate 9 — pause kill-switch latency drill (live Sepolia).
 *
 * Times the "execute pause" leg of the kill-switch: sends DeltaVerifier.pause() from the DEDICATED
 * pauser key, waits until paused()==true, records the wall-clock, then unpauses from the ADMIN key
 * (the dedicated pauser intentionally cannot unpause) and verifies normal state resumes. (The
 * detection→decide legs are operator/automation timing recorded separately in the runbook; this
 * measures the on-chain act, the part the contract owns.)
 *
 * Mechanism correctness is covered deterministically by test/drills/gate9-ops-drills.test.js;
 * this script produces the live timed record the runbook requires.
 *
 * Run (after assuming the pause-operator role so KMS_PAUSER_KEY_ID is signable):
 *   set -a; . ./.env.sepolia; set +a
 *   KMS_PAUSER_KEY_ID=alias/hokusai/development/ethereum/sepolia/pauser \
 *   KMS_PAUSER_EXPECTED_ADDRESS=0x11EA... \
 *     node scripts/drills/pause-drill.js
 *   # PAUSE_HOLD_SECONDS=30 to hold paused before unpausing
 *
 * Requires: RPC_URL; KMS_PAUSER_KEY_ID (+ KMS_PAUSER_EXPECTED_ADDRESS) for pause; KMS_DEPLOYER_KEY_ID
 * (the admin, + KMS_DEPLOYER_EXPECTED_ADDRESS) for unpause; AWS creds with kms:Sign on each.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

function nowMs() {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function buildSigner(keyId, expectedEnv, provider) {
  const { KmsSigner } = require("../../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId,
    provider,
  });
  const addr = ethers.getAddress(await signer.getAddress());
  const expected = process.env[expectedEnv];
  if (expected && addr !== ethers.getAddress(expected)) {
    throw new Error(`${keyId} pin mismatch: ${addr} != ${expected}`);
  }
  return { signer, addr };
}

const ABI = [
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function PAUSER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const DV = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "..", "deployments", "sepolia-latest.json"), "utf8"),
  ).contracts.DeltaVerifier;

  const pauserKeyId = process.env.KMS_PAUSER_KEY_ID;
  if (!pauserKeyId) throw new Error("KMS_PAUSER_KEY_ID is required (the dedicated pauser key)");
  const pauser = await buildSigner(pauserKeyId, "KMS_PAUSER_EXPECTED_ADDRESS", provider);
  const dv = new ethers.Contract(DV, ABI, pauser.signer);

  if (!(await dv.hasRole(await dv.PAUSER_ROLE(), pauser.addr))) {
    throw new Error(`${pauser.addr} lacks PAUSER_ROLE on DeltaVerifier ${DV} (run the handoff first)`);
  }
  if (await dv.paused()) throw new Error("DeltaVerifier is already paused — unpause first");
  console.log("pauser:", pauser.addr, "| DeltaVerifier:", DV);

  // --- time the pause (dedicated pauser key) ---
  const t0 = nowMs();
  const pauseTx = await dv.pause();
  console.log("pause tx:", pauseTx.hash);
  await pauseTx.wait();
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

  // --- restore (admin key; the dedicated pauser cannot unpause) ---
  const adminKeyId = process.env.KMS_DEPLOYER_KEY_ID;
  if (!adminKeyId) {
    console.warn(
      "WARNING: contract is PAUSED and KMS_DEPLOYER_KEY_ID (admin) is not set — unpause manually " +
        "with the admin/Safe. (The dedicated pauser key cannot unpause by design.)",
    );
    return;
  }
  const admin = await buildSigner(adminKeyId, "KMS_DEPLOYER_EXPECTED_ADDRESS", provider);
  const dvAdmin = new ethers.Contract(DV, ABI, admin.signer);
  if (!(await dvAdmin.hasRole(await dvAdmin.DEFAULT_ADMIN_ROLE(), admin.addr))) {
    console.warn(`WARNING: ${admin.addr} lacks DEFAULT_ADMIN_ROLE; unpause via the admin/Safe. Contract left PAUSED.`);
    return;
  }
  const t1 = nowMs();
  const unpauseTx = await dvAdmin.unpause();
  console.log("unpause tx:", unpauseTx.hash);
  await unpauseTx.wait();
  while (await dvAdmin.paused()) {
    /* wait for state propagation */
  }
  const unpausedMs = nowMs() - t1;
  console.log(`UNPAUSED after ${(unpausedMs / 1000).toFixed(1)}s (admin ${admin.addr}); normal processing resumes.`);

  console.log(
    `\nGate 9 pause drill record: pause=${(pausedMs / 1000).toFixed(1)}s unpause=${(unpausedMs / 1000).toFixed(1)}s ` +
      `network=sepolia DeltaVerifier=${DV} pauser=${pauser.addr}`,
  );
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
