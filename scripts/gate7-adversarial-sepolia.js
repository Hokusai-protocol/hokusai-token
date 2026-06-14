/*
 * HOK-2177 Gate 7 — adversarial battery (Part 2) against the live Sepolia DeltaVerifier.
 *
 * This is the HOK-2119 proof-of-fix: on 2026-06-08 a hand-forged MintRequest with fake
 * attestation/dataset hashes and a chosen recipient minted 1,000,000 tokens. Against the
 * hardened, deadline-aware contract every forged/abusive variant below must now REVERT.
 *
 * All cases are submitted via the real SUBMITTER (KMS backend 0xbe26) using eth_call
 * (staticCall) so we read the exact revert reason without spending gas — modelling
 * "a forged message reached the legitimate submitter". The signature check is the
 * load-bearing defense; the contract never authenticated the anchor hashes.
 *
 * Part 1 (the real signed mint) and the cases that depend on it (replay, tamper-after-sign,
 * stale-lineage re-signed) require the 0x07bf hardware-wallet attester signature and are
 * driven by gate7-part1-sepolia.js after the operator signs.
 *
 * Run: HARDHAT_NETWORK=sepolia node scripts/gate7-adversarial-sepolia.js
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const { KMSClient } = require("@aws-sdk/client-kms");

const MODEL_ID = 30n;
const ATTACKER_RECIPIENT = "0x000000000000000000000000000000000000dEaD"; // attacker-chosen payout target
const NON_ATTESTER = process.env.KMS_DEPLOYER_EXPECTED_ADDRESS; // real key, NOT a registered attester

function loadDeployment() {
  const p = path.resolve(__dirname, "..", "deployments", "sepolia-latest.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function kmsSigner(keyIdEnv, expectedEnv, provider) {
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: process.env[keyIdEnv],
    provider,
  });
  const derived = ethers.getAddress(await signer.getAddress());
  const expected = ethers.getAddress(process.env[expectedEnv]);
  if (derived !== expected) throw new Error(`KMS pin mismatch ${keyIdEnv}: ${derived} != ${expected}`);
  return signer;
}

const TYPES = {
  MintRequest: [
    { name: "modelId", type: "uint256" },
    { name: "payload", type: "MintRequestPayload" },
    { name: "contributors", type: "Contributor[]" },
  ],
  MintRequestPayload: [
    { name: "pipelineRunId", type: "string" },
    { name: "baselineScoreBps", type: "uint256" },
    { name: "candidateScoreBps", type: "uint256" },
    { name: "maxCostUsdMicro", type: "uint256" },
    { name: "actualCostUsdMicro", type: "uint256" },
    { name: "totalSamples", type: "uint256" },
    { name: "anchors", type: "BenchmarkAnchors" },
    { name: "baselineCommitment", type: "bytes32" },
    { name: "candidateCommitment", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
  BenchmarkAnchors: [
    { name: "benchmarkSpecHash", type: "bytes32" },
    { name: "datasetHash", type: "bytes32" },
    { name: "attestationHash", type: "bytes32" },
    { name: "idempotencyKey", type: "bytes32" },
    { name: "metricName", type: "string" },
    { name: "metricFamily", type: "string" },
  ],
  Contributor: [
    { name: "walletAddress", type: "address" },
    { name: "weight", type: "uint256" },
  ],
};

function forgedPayload(head, { deadline, idemSuffix }) {
  // Structurally valid (so it reaches the attestation/deadline gates) but with fake anchors
  // and an attacker-chosen recipient — the essence of the June-8 forgery.
  return {
    pipelineRunId: "forged-run-" + idemSuffix,
    baselineScoreBps: 4200n,
    candidateScoreBps: 9900n, // attacker claims a huge improvement
    maxCostUsdMicro: 1000000n,
    actualCostUsdMicro: 1n,
    totalSamples: 1000n,
    anchors: {
      benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes("forged-spec")),
      datasetHash: ethers.id("FAKE-dataset-" + idemSuffix),
      attestationHash: ethers.id("FAKE-attestation-" + idemSuffix),
      idempotencyKey: ethers.id("forged-idem-" + idemSuffix),
      metricName: "accuracy",
      metricFamily: "proportion",
    },
    baselineCommitment: head,
    candidateCommitment: ethers.id("forged-candidate-" + idemSuffix),
    deadline: BigInt(deadline),
  };
}

const results = [];
// The security-critical outcome is that the forgery REVERTS (does not mint). On Sepolia the
// public/Alchemy RPCs strip eth_call revert data, so the exact custom-error name is often not
// decodable live; the exact reasons are pinned by the merged Hardhat suites
// (DeltaVerifier.attesterSignature / .deadline / .disableLegacy). A CALL_EXCEPTION here == rejected.
async function expectRevert(name, fn, expectedError) {
  try {
    await fn();
    results.push({ name, ok: false, detail: "DID NOT REVERT — TOKENS COULD MINT!" });
  } catch (e) {
    const reverted = e.code === "CALL_EXCEPTION" || /revert/i.test(e.shortMessage || e.message || "");
    const decoded = e.revert?.name || null; // present only when the RPC returns revert data
    const detail = decoded
      ? `${decoded}${expectedError && decoded !== expectedError ? ` (expected ${expectedError})` : ""}`
      : `reverted (reason stripped by RPC; expected ${expectedError})`;
    // Pass = reverted. If a specific reason is expected AND a reason decoded, it must match;
    // expectedError=null means "any revert is acceptable" (e.g. malformed sig caught at ECDSA decode).
    const ok = reverted && (!expectedError || !decoded || decoded === expectedError);
    results.push({ name, ok, detail });
  }
}

(async () => {
  const d = loadDeployment();
  const DV = d.contracts.DeltaVerifier;
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const abi = require("../artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json").abi;

  const backend = await kmsSigner("KMS_BACKEND_KEY_ID", "KMS_BACKEND_EXPECTED_ADDRESS", provider);
  const nonAttester = await kmsSigner("KMS_DEPLOYER_KEY_ID", "KMS_DEPLOYER_EXPECTED_ADDRESS", provider);
  const dv = new ethers.Contract(DV, abi, backend); // submit AS the legitimate submitter
  const net = await provider.getNetwork();
  const domain = { name: "HokusaiDeltaVerifier", version: "1", chainId: Number(net.chainId), verifyingContract: DV };

  const head = await dv.currentModelHead(MODEL_ID);
  const future = Math.floor(Date.now() / 1000) + 3600;
  const past = Math.floor(Date.now() / 1000) - 3600;
  const contributors = [{ walletAddress: ATTACKER_RECIPIENT, weight: 10000n }];
  const GARBAGE_SIG = "0x" + "11".repeat(64) + "1b";

  console.log(`Gate 7 adversarial battery vs DeltaVerifier ${DV} (chainId ${net.chainId})`);
  console.log(`Submitter (SUBMITTER_ROLE): ${await backend.getAddress()}`);
  console.log(`Registered attester: 0x07bf9b22f516d2D464511219488F019c5dFF5335 | forging key (non-attester): ${NON_ATTESTER}`);
  console.log(`Model ${MODEL_ID} head: ${head}\n`);

  // A) The June-8 forgery, UNSIGNED (no attester signatures).
  await expectRevert("forged / no signature", async () => {
    const p = forgedPayload(head, { deadline: future, idemSuffix: "nosig" });
    await dv.submitMintRequest.staticCall(MODEL_ID, p, contributors, []);
  }, "InsufficientAttesterSignatures");

  // B) Forged with a malformed signature — rejected at ECDSA decode or as a non-attester signer.
  await expectRevert("forged / garbage signature", async () => {
    const p = forgedPayload(head, { deadline: future, idemSuffix: "garbage" });
    await dv.submitMintRequest.staticCall(MODEL_ID, p, contributors, [GARBAGE_SIG]);
  }, null);

  // C) THE JUNE-8 RE-RUN: fake hashes + attacker recipient, signed by the attacker's OWN real key
  //    (KMS deployer 0xAfA9) which is NOT a registered attester. This is what minted 1M before.
  await expectRevert("forged / signed by non-attester key (June-8 re-run)", async () => {
    const p = forgedPayload(head, { deadline: future, idemSuffix: "nonattester" });
    const sig = await nonAttester.signTypedData(domain, TYPES, { modelId: MODEL_ID, payload: p, contributors });
    await dv.submitMintRequest.staticCall(MODEL_ID, p, contributors, [sig]);
  }, "SignerNotAttester");

  // D) Expired deadline (checked before signatures) — any signature, deadline in the past.
  await expectRevert("expired deadline", async () => {
    const p = forgedPayload(head, { deadline: past, idemSuffix: "expired" });
    await dv.submitMintRequest.staticCall(MODEL_ID, p, contributors, [GARBAGE_SIG]);
  }, "SignatureExpired");

  // E) Legacy SUBMITTER-only entrypoint (the pre-hardening path) — must be disabled.
  await expectRevert("legacy submitEvaluation entrypoint", async () => {
    const metrics = { accuracy: 4200, precision: 0, recall: 0, f1: 0, auroc: 0 };
    const evalData = {
      pipelineRunId: "legacy",
      baselineMetrics: metrics,
      newMetrics: { ...metrics, accuracy: 9900 },
      contributor: ATTACKER_RECIPIENT,
      contributorWeight: 10000,
      contributedSamples: 1000,
      totalSamples: 1000,
      maxCostUsd: 1000000,
      actualCostUsd: 1,
    };
    await dv.submitEvaluation.staticCall(MODEL_ID, evalData);
  }, "LegacyMintEntrypointDisabled");

  console.log("=== RESULTS ===");
  let allOk = true;
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ->  reverted: ${r.detail}`);
    if (!r.ok) allOk = false;
  }
  console.log(`\nGate 7 Part 2 (adversarial): ${allOk ? "ALL FORGERIES REJECTED ✅" : "SOMETHING MINTED — INVESTIGATE ❌"}`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
