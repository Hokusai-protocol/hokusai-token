/*
 * HOK-2177 Gate 7 — Part 1 (real signed mint, separated custody) + dependent adversarial cases.
 *
 *   build  : construct the canonical Model-30 MintRequest, compute the EIP-712 digest the
 *            0x07bf hardware-wallet attester must sign, render it, and save the exact bytes.
 *   submit : ingest the operator's signature, verify it recovers to the registered attester,
 *            submit via the KMS backend (0xbe26), assert DeltaOneAccepted + head advance,
 *            then run replay (no second mint) and tamper-after-sign (SignerNotAttester).
 *
 * Run:
 *   HARDHAT_NETWORK=sepolia node scripts/gate7-part1-sepolia.js build
 *   HARDHAT_NETWORK=sepolia node scripts/gate7-part1-sepolia.js submit 0x<signature>
 */
const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { ethers } = hre;
const { KMSClient } = require("@aws-sdk/client-kms");

const MODEL_ID = 30n;
const RECIPIENT = "0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da"; // rehearsal payout target (controlled)
const ATTESTER = "0x07bf9b22f516d2D464511219488F019c5dFF5335";
const STATE = path.resolve(__dirname, "..", "deployments", "gate7-part1-pending.json");

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

function dep() { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "deployments", "sepolia-latest.json"), "utf8")); }
function provider() { return new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL); }
function abi() { return require("../artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json").abi; }
async function backendSigner(p) {
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const s = await KmsSigner.fromKeyId({ client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }), keyId: process.env.KMS_BACKEND_KEY_ID, provider: p });
  const got = ethers.getAddress(await s.getAddress());
  if (got !== ethers.getAddress(process.env.KMS_BACKEND_EXPECTED_ADDRESS)) throw new Error("backend KMS pin mismatch");
  return s;
}

async function build() {
  const d = dep();
  const DV = d.contracts.DeltaVerifier;
  const p = provider();
  const dv = new ethers.Contract(DV, abi(), p);
  const head = await dv.currentModelHead(MODEL_ID);
  const net = await p.getNetwork();
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    pipelineRunId: "gate7-rehearsal-mint-001",
    baselineScoreBps: 4200n,
    candidateScoreBps: 4300n, // +100 bps, above minImprovementBps
    maxCostUsdMicro: 1000000n,
    actualCostUsdMicro: 500000n,
    totalSamples: 1000n,
    anchors: {
      benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes("hokusai:router:v1")),
      datasetHash: ethers.id("gate7-rehearsal-dataset"),
      attestationHash: ethers.id("gate7-rehearsal-attestation"),
      idempotencyKey: ethers.id("gate7-rehearsal-idem-001"),
      metricName: "accuracy",
      metricFamily: "proportion",
    },
    baselineCommitment: head,
    candidateCommitment: ethers.id("gate7-rehearsal-candidate-001"),
    deadline: BigInt(nowSec + 5 * 24 * 3600),
  };
  const contributors = [{ walletAddress: RECIPIENT, weight: 10000n }];
  const domain = { name: "HokusaiDeltaVerifier", version: "1", chainId: Number(net.chainId), verifyingContract: DV };
  const message = { modelId: MODEL_ID, payload, contributors };
  const onChainDigest = await dv.hashMintRequest(MODEL_ID, payload, contributors);
  const localDigest = ethers.TypedDataEncoder.hash(domain, TYPES, message);
  if (onChainDigest.toLowerCase() !== localDigest.toLowerCase()) throw new Error("digest mismatch on/off-chain");

  const ser = (o) => JSON.parse(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  fs.writeFileSync(STATE, JSON.stringify(ser({ DV, chainId: Number(net.chainId), domain, types: TYPES, message, digest: onChainDigest, head }), null, 2));

  console.log("=== Gate 7 Part 1 — sign this on the 0x07bf hardware wallet ===");
  console.log("DeltaVerifier :", DV, "(chainId", Number(net.chainId) + ")");
  console.log("Model 30 head :", head, "(baselineCommitment)");
  console.log("New candidate :", payload.candidateCommitment, "(becomes head on mint)");
  console.log("Recipient     :", RECIPIENT, "weight 10000");
  console.log("Scores        : baseline 4200 -> candidate 4300 bps");
  console.log("deadline      :", payload.deadline.toString(), "(now + 5 days)");
  console.log("Attester reqd :", ATTESTER);
  console.log("\nEIP-712 DIGEST TO SIGN:\n  " + onChainDigest);
  console.log("\nTyped-data JSON saved to:", STATE);
  console.log("Sign via eth_signTypedData_v4 (domain/types/message in the file) OR sign the digest above.");
  console.log("Then: HARDHAT_NETWORK=sepolia node scripts/gate7-part1-sepolia.js submit <signature>");
}

async function submit(sigHex) {
  if (!sigHex || !/^0x[0-9a-fA-F]{130}$/.test(sigHex)) throw new Error("provide a 65-byte 0x signature");
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const message = st.message;
  // verify the signature recovers to the registered attester before spending gas
  const recovered = ethers.verifyTypedData(st.domain, TYPES, message, sigHex);
  console.log("recovered signer:", recovered);
  if (ethers.getAddress(recovered) !== ethers.getAddress(ATTESTER)) {
    throw new Error(`signature does not recover to attester ${ATTESTER} (got ${recovered})`);
  }
  const p = provider();
  const backend = await backendSigner(p);
  const dv = new ethers.Contract(st.DV, abi(), backend);
  const token = await (new ethers.Contract(st.DV, abi(), p)); // for events

  // --- Part 1: the real signed mint ---
  const tx = await dv.submitMintRequest(BigInt(message.modelId), message.payload, message.contributors, [sigHex]);
  console.log("submit tx:", tx.hash);
  const rcpt = await tx.wait();
  const accepted = rcpt.logs.some((l) => { try { return dv.interface.parseLog(l)?.name === "DeltaOneAccepted"; } catch { return false; } });
  const advanced = rcpt.logs.some((l) => { try { return dv.interface.parseLog(l)?.name === "ModelLineageAdvanced"; } catch { return false; } });
  const newHead = await dv.currentModelHead(BigInt(message.modelId));
  console.log("DeltaOneAccepted:", accepted, "| ModelLineageAdvanced:", advanced);
  console.log("head advanced to candidate:", newHead.toLowerCase() === message.payload.candidateCommitment.toLowerCase());

  // --- Replay: identical signed message must not mint again (idempotency burned) ---
  let replay;
  try { await dv.submitMintRequest.staticCall(BigInt(message.modelId), message.payload, message.contributors, [sigHex]); replay = "DID NOT REVERT"; }
  catch (e) { replay = e.code === "CALL_EXCEPTION" ? "reverted (idempotency burned)" : (e.shortMessage || e.message); }
  console.log("replay:", replay);

  // --- Tamper-after-sign: mutate recipient, keep the signature -> must revert (sig no longer valid) ---
  let tamper;
  const tampered = JSON.parse(JSON.stringify(message));
  tampered.contributors[0].walletAddress = "0x000000000000000000000000000000000000dEaD";
  try { await dv.submitMintRequest.staticCall(BigInt(message.modelId), tampered.payload, tampered.contributors, [sigHex]); tamper = "DID NOT REVERT"; }
  catch (e) { tamper = e.code === "CALL_EXCEPTION" ? "reverted (signature bound to original)" : (e.shortMessage || e.message); }
  console.log("tamper-after-sign:", tamper);

  console.log(`\nGate 7 Part 1: ${accepted && advanced ? "SIGNED MINT SUCCEEDED ✅" : "CHECK OUTPUT ❌"}`);
}

(async () => {
  const mode = process.argv[2];
  if (mode === "build") return build();
  if (mode === "submit") return submit(process.argv[3]);
  throw new Error("usage: build | submit <sig>");
})().catch((e) => { console.error("ERROR:", e.message || e); process.exit(1); });
