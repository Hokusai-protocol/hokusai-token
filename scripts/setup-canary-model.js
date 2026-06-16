/*
 * HOK-2223 — Stand up a dedicated CANARY model so canary/rehearsal mints never drift
 * the production Model 30 lineage (root cause of the synthetic-lineage drift).
 *
 * Creates uint model id 930 ("930" in the TokenManager string registry, which is what
 * DeltaVerifier._uintToString(modelId) resolves to when minting), with its own token,
 * genesis, and mint budget. No AMM pool (not needed for mint/reconcile/anomaly testing).
 *
 * All steps are signed by the 0xAfA9 KMS deployer (ModelRegistry owner + TokenManager
 * caller + DeltaVerifier DEFAULT_ADMIN_ROLE). Idempotent: re-running skips completed steps.
 *
 * Run:
 *   SEPOLIA_RPC_URL=... AWS_REGION=us-east-1 node scripts/setup-canary-model.js
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const UINT_MODEL_ID = 930n;
const STRING_MODEL_ID = "930"; // must equal _uintToString(UINT_MODEL_ID) — DeltaVerifier mints via this
const NAME = "Hokusai Router Canary";
const SYMBOL = "HROUTC";
const METRIC = "router_quality_score";
const ADMIN = "0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da";
const GENESIS = ethers.keccak256(ethers.toUtf8Bytes("hokusai:sepolia:canary:hroutc:genesis:v1"));
const MINT_BUDGET = ethers.parseUnits("100000000", 18); // generous so canary mints never exhaust

function dep() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "deployments", "sepolia-latest.json"), "utf8"));
}
function artifact(name) {
  return require(`../artifacts/contracts/${name}.sol/${name}.json`).abi;
}

async function main() {
  const p = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: "alias/hokusai/development/ethereum/sepolia/deployer",
    provider: p,
  });
  const me = ethers.getAddress(await signer.getAddress());
  if (me !== ethers.getAddress(ADMIN)) throw new Error(`admin pin mismatch: ${me}`);
  console.log("admin signer:", me);

  const d = dep();
  const TM = d.contracts.TokenManager;
  const MR = d.contracts.ModelRegistry;
  const DV = d.contracts.DeltaVerifier;
  console.log("TokenManager:", TM, "| ModelRegistry:", MR, "| DeltaVerifier:", DV);

  const tokenManager = new ethers.Contract(TM, artifact("TokenManager"), signer);
  const modelRegistry = new ethers.Contract(MR, artifact("ModelRegistry"), signer);
  const deltaVerifier = new ethers.Contract(DV, artifact("DeltaVerifier"), signer);

  // --- Step 1: deploy the canary token (or reuse if already deployed) ---
  let token;
  if (await tokenManager.hasToken(STRING_MODEL_ID)) {
    token = await tokenManager.getTokenAddress(STRING_MODEL_ID);
    console.log(`step 1: token already deployed for "${STRING_MODEL_ID}" -> ${token} (skip)`);
  } else {
    const initialParams = {
      tokensPerDeltaOne: ethers.parseUnits("250000", 18),
      infrastructureAccrualBps: 8000,
      initialOraclePricePerThousandUsd: 0n,
      licenseHash: ethers.keccak256(ethers.toUtf8Bytes("hokusai-sepolia-canary-license")),
      licenseURI: "https://hokus.ai/licenses/sepolia-canary",
      governor: ADMIN,
      vestingConfig: {
        enabled: true,
        immediateUnlockBps: 1000,
        vestingDurationSeconds: 31536000n,
        cliffSeconds: 0n,
      },
    };
    const tx = await tokenManager.deployTokenWithAllocations(
      STRING_MODEL_ID,
      NAME,
      SYMBOL,
      ethers.parseUnits("1", 18), // modelSupplierAllocation (minimal, must be > 0)
      ADMIN, // modelSupplierRecipient
      ethers.parseUnits("1", 18), // investorAllocation (minimal, must be > 0)
      initialParams
    );
    console.log("step 1: deployTokenWithAllocations tx:", tx.hash);
    await tx.wait(1);
    token = await tokenManager.getTokenAddress(STRING_MODEL_ID);
    console.log("step 1: canary token deployed ->", token);
  }

  // --- Step 2: register the uint model id in ModelRegistry (required for submitMintRequest) ---
  if (await modelRegistry.isRegistered(UINT_MODEL_ID)) {
    console.log(`step 2: model ${UINT_MODEL_ID} already registered (skip)`);
  } else {
    const tx = await modelRegistry.registerModel(UINT_MODEL_ID, token, METRIC);
    console.log("step 2: registerModel tx:", tx.hash);
    await tx.wait(1);
    console.log("step 2: registered model", UINT_MODEL_ID.toString());
  }

  // --- Step 3: set the canary lineage genesis ---
  const existingGenesis = await modelRegistry.weightGenesis(UINT_MODEL_ID);
  if (existingGenesis !== ethers.ZeroHash) {
    console.log("step 3: genesis already set ->", existingGenesis, "(skip)");
  } else {
    const tx = await modelRegistry.setWeightGenesis(UINT_MODEL_ID, GENESIS);
    console.log("step 3: setWeightGenesis tx:", tx.hash);
    await tx.wait(1);
    console.log("step 3: genesis set ->", GENESIS);
  }

  // --- Step 4: fund the mint budget ---
  const budget = await deltaVerifier.mintBudgetRemaining(UINT_MODEL_ID);
  if (budget >= MINT_BUDGET) {
    console.log("step 4: budget already >= target ->", budget.toString(), "(skip)");
  } else {
    const tx = await deltaVerifier.setMintBudget(UINT_MODEL_ID, MINT_BUDGET);
    console.log("step 4: setMintBudget tx:", tx.hash);
    await tx.wait(1);
    console.log("step 4: budget set ->", MINT_BUDGET.toString());
  }

  // --- Verify ---
  console.log("\n=== canary model summary ===");
  console.log("uint modelId      :", UINT_MODEL_ID.toString());
  console.log("string modelId    :", STRING_MODEL_ID, "(TokenManager registry / DeltaVerifier mint key)");
  console.log("token             :", token);
  console.log("isRegistered      :", await modelRegistry.isRegistered(UINT_MODEL_ID));
  console.log("isModelActive     :", await modelRegistry.isModelActive(UINT_MODEL_ID));
  console.log("weightGenesis     :", await modelRegistry.weightGenesis(UINT_MODEL_ID));
  console.log("currentModelHead  :", await deltaVerifier.currentModelHead(UINT_MODEL_ID));
  console.log("mintBudgetRemaining:", (await deltaVerifier.mintBudgetRemaining(UINT_MODEL_ID)).toString());
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
