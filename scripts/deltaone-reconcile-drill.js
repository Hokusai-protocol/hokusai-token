/*
 * HOK-2223 — DeltaOne reconciliation readiness drill (AUTO_PAUSE criterion 1).
 *
 * Produces ONE real, Ledger-attested Model-30 mint that reconciles CLEAN against an
 * authorized payout-intent record, proving the live detector wiring (on-chain
 * idempotencyKey/recipients <-> DynamoDB intent) before AUTO_PAUSE is armed.
 *
 * Unlike gate7-part1-sepolia.js (fixed rehearsal idempotency = already burned), this
 * mints with a FRESH idempotency key + candidate commitment each build, and writes the
 * payout intent to DynamoDB BEFORE submitting — exactly as the contract-deployer
 * consumer does (services/contract-deployer/src/services/payout-intent-store.ts).
 *
 *   build           : construct a fresh Model-30 MintRequest (baselineCommitment = current
 *                     head), save the typed data to deployments/gate7-part1-pending.json so
 *                     `npm run gate7:sign` can sign it on the 0x07bf Ledger, print the digest.
 *   submit 0x<sig>  : verify the sig recovers to the registered attester, WRITE the payout
 *                     intent to DynamoDB, THEN submit via the KMS backend (0xbe26), assert
 *                     DeltaOneAccepted + head advance, and print the mint block + idempotency
 *                     key so the detector run can be checked for a clean reconcile.
 *
 * Run:
 *   HARDHAT_NETWORK=sepolia node scripts/deltaone-reconcile-drill.js build
 *   npm run gate7:sign                 # Ledger signs the pending typed data; copy the 0x sig
 *   HARDHAT_NETWORK=sepolia node scripts/deltaone-reconcile-drill.js submit 0x<sig>
 *
 * Env for submit: KMS_BACKEND_KEY_ID, KMS_BACKEND_EXPECTED_ADDRESS, SEPOLIA_RPC_URL,
 *   AWS creds (kms:Sign on the submitter key + dynamodb:PutItem on the intent table),
 *   PAYOUT_INTENT_TABLE (default hokusai-deltaone-payout-intent-development).
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const { KMSClient } = require("@aws-sdk/client-kms");
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");

const MODEL_ID = 30n;
const RECIPIENT = "0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da"; // controlled rehearsal payout target
const ATTESTER = "0x07bf9b22f516d2D464511219488F019c5dFF5335"; // registered Ledger attester
const STATE = path.resolve(__dirname, "..", "deployments", "gate7-part1-pending.json");
const DEFAULT_INTENT_TABLE = "hokusai-deltaone-payout-intent-development";
const INTENT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches payout-intent-store.ts

// EIP-712 types — must match DeltaVerifier.hashMintRequest (verified on/off-chain below).
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

function dep() {
  return JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "deployments", "sepolia-latest.json"), "utf8")
  );
}
function provider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
}
function abi() {
  return require("../artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json").abi;
}
async function backendSigner(p) {
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const s = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: process.env.KMS_BACKEND_KEY_ID,
    provider: p,
  });
  const got = ethers.getAddress(await s.getAddress());
  if (got !== ethers.getAddress(process.env.KMS_BACKEND_EXPECTED_ADDRESS)) {
    throw new Error("backend KMS pin mismatch");
  }
  return s;
}

// Mirrors services/contract-deployer/src/services/payout-intent-store.ts so the detector
// reconciles this mint exactly as it would a production consumer mint.
async function writePayoutIntent({ idempotencyKey, recipients, modelId }) {
  const table = process.env.PAYOUT_INTENT_TABLE || DEFAULT_INTENT_TABLE;
  const deduped = [...new Set(recipients.map((a) => a.toLowerCase()))];
  if (deduped.length === 0) throw new Error("refusing to write intent with no recipients");
  const nowSeconds = Math.floor(Date.now() / 1000);
  const client = new DynamoDBClient({ region: process.env.AWS_REGION || "us-east-1" });
  await client.send(
    new PutItemCommand({
      TableName: table,
      Item: {
        idempotency_key: { S: idempotencyKey },
        recipients: { SS: deduped },
        model_id: { S: String(modelId) },
        written_at: { N: String(nowSeconds) },
        expires_at: { N: String(nowSeconds + INTENT_TTL_SECONDS) },
      },
    })
  );
  console.log(`payout intent written: table=${table} key=${idempotencyKey} recipients=${deduped.join(",")}`);
}

async function build() {
  const d = dep();
  const DV = d.contracts.DeltaVerifier;
  const p = provider();
  const dv = new ethers.Contract(DV, abi(), p);
  const head = await dv.currentModelHead(MODEL_ID);
  const net = await p.getNetwork();
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = `${nowSec}-${process.pid}`; // unique per build -> fresh idempotency + candidate
  const payload = {
    pipelineRunId: `hok2223-reconcile-drill-${nonce}`,
    baselineScoreBps: 4200n,
    candidateScoreBps: 4300n, // +100 bps, above minImprovementBps
    maxCostUsdMicro: 1000000n,
    actualCostUsdMicro: 500000n,
    totalSamples: 1000n,
    anchors: {
      benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes("hokusai:router:v1")),
      datasetHash: ethers.id(`hok2223-reconcile-dataset-${nonce}`),
      attestationHash: ethers.id(`hok2223-reconcile-attestation-${nonce}`),
      idempotencyKey: ethers.id(`hok2223-reconcile-idem-${nonce}`),
      metricName: "accuracy",
      metricFamily: "proportion",
    },
    baselineCommitment: head,
    candidateCommitment: ethers.id(`hok2223-reconcile-candidate-${nonce}`),
    deadline: BigInt(nowSec + 5 * 24 * 3600),
  };
  const contributors = [{ walletAddress: RECIPIENT, weight: 10000n }];
  const domain = { name: "HokusaiDeltaVerifier", version: "1", chainId: Number(net.chainId), verifyingContract: DV };
  const message = { modelId: MODEL_ID, payload, contributors };
  const onChainDigest = await dv.hashMintRequest(MODEL_ID, payload, contributors);
  const localDigest = ethers.TypedDataEncoder.hash(domain, TYPES, message);
  if (onChainDigest.toLowerCase() !== localDigest.toLowerCase()) throw new Error("digest mismatch on/off-chain");

  const ser = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  fs.writeFileSync(
    STATE,
    JSON.stringify(ser({ DV, chainId: Number(net.chainId), domain, types: TYPES, message, digest: onChainDigest, head }), null, 2)
  );

  console.log("=== HOK-2223 reconcile drill — sign this on the 0x07bf Ledger ===");
  console.log("DeltaVerifier :", DV, "(chainId", Number(net.chainId) + ")");
  console.log("Model 30 head :", head, "(baselineCommitment)");
  console.log("New candidate :", payload.candidateCommitment, "(becomes head on mint)");
  console.log("Idempotency   :", payload.anchors.idempotencyKey, "(fresh — not a replay)");
  console.log("Recipient     :", RECIPIENT, "weight 10000 (the reconciled payout recipient)");
  console.log("deadline      :", payload.deadline.toString(), "(now + 5 days)");
  console.log("Attester reqd :", ATTESTER);
  console.log("\nEIP-712 DIGEST TO SIGN:\n  " + onChainDigest);
  console.log("\nTyped-data JSON saved to:", STATE);
  console.log("Next: `npm run gate7:sign`, sign with the Ledger, copy the 0x signature, then:");
  console.log("  HARDHAT_NETWORK=sepolia node scripts/deltaone-reconcile-drill.js submit 0x<sig>");
}

async function submit(sigHex) {
  if (!sigHex || !/^0x[0-9a-fA-F]{130}$/.test(sigHex)) throw new Error("provide a 65-byte 0x signature");
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const message = st.message;
  const recovered = ethers.verifyTypedData(st.domain, TYPES, message, sigHex);
  console.log("recovered signer:", recovered);
  if (ethers.getAddress(recovered) !== ethers.getAddress(ATTESTER)) {
    throw new Error(`signature does not recover to attester ${ATTESTER} (got ${recovered})`);
  }

  // Write the authorized payout intent BEFORE submitting (as the consumer does), so the
  // detector finds it when it scans the mint's block.
  await writePayoutIntent({
    idempotencyKey: message.payload.anchors.idempotencyKey,
    recipients: message.contributors.map((c) => c.walletAddress),
    modelId: message.modelId,
  });

  const p = provider();
  const backend = await backendSigner(p);
  const dv = new ethers.Contract(st.DV, abi(), backend);

  const tx = await dv.submitMintRequest(BigInt(message.modelId), message.payload, message.contributors, [sigHex]);
  console.log("submit tx:", tx.hash);
  const rcpt = await tx.wait();
  const accepted = rcpt.logs.some((l) => {
    try { return dv.interface.parseLog(l)?.name === "DeltaOneAccepted"; } catch { return false; }
  });
  const advanced = rcpt.logs.some((l) => {
    try { return dv.interface.parseLog(l)?.name === "ModelLineageAdvanced"; } catch { return false; }
  });
  const newHead = await dv.currentModelHead(BigInt(message.modelId));
  console.log("block           :", rcpt.blockNumber);
  console.log("DeltaOneAccepted:", accepted, "| ModelLineageAdvanced:", advanced);
  console.log("head advanced   :", newHead.toLowerCase() === message.payload.candidateCommitment.toLowerCase());
  console.log("idempotencyKey  :", message.payload.anchors.idempotencyKey);
  console.log(
    `\nHOK-2223 reconcile drill: ${accepted && advanced ? "SIGNED MINT SUCCEEDED ✅" : "CHECK OUTPUT ❌"}`
  );
  console.log("Now check the detector (runs ~1/min) for a clean reconcile of this idempotency key.");
}

(async () => {
  const mode = process.argv[2];
  if (mode === "build") return build();
  if (mode === "submit") return submit(process.argv[3]);
  throw new Error("usage: build | submit <sig>");
})().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
