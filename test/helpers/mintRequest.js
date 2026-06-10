const { ethers } = require("hardhat");

// Default model-weight lineage genesis (HOK-2133). configureLineageGenesis seeds the registry with this, and
// the default payload's baselineCommitment matches it, so a model's first mint parents off genesis.
const LINEAGE_GENESIS = ethers.id("lineage-genesis-001");

// Monotonic candidate generator so chained mints advance to distinct commitments.
let _candidateCounter = 0;
function nextCandidateCommitment() {
  _candidateCounter += 1;
  return ethers.id(`lineage-candidate-${_candidateCounter}`);
}

function buildMintRequestPayload(overrides = {}) {
  const defaultAnchors = {
    benchmarkSpecHash: ethers.id("benchmark-spec-001"),
    datasetHash: ethers.id("dataset-sha256-001"),
    attestationHash: ethers.id("attestation-001"),
    idempotencyKey: ethers.id("idempotency-001"),
    metricName: "sales:revenue_per_1000_messages",
    metricFamily: "zero_inflated_continuous",
  };

  return {
    pipelineRunId: "eval-sales-001",
    baselineScoreBps: 5000,
    candidateScoreBps: 7500,
    maxCostUsdMicro: 0,
    actualCostUsdMicro: 0,
    totalSamples: 10000,
    // Lineage commitments (HOK-2133). Default baseline = genesis so a first mint parents off it.
    baselineCommitment: LINEAGE_GENESIS,
    candidateCommitment: ethers.id("lineage-candidate-001"),
    ...overrides,
    anchors: {
      ...defaultAnchors,
      ...(overrides.anchors || {}),
    }
  };
}

// Build a payload that correctly parents off the model's CURRENT on-chain head, so chained paying mints stay
// valid no matter how many came before. baselineCommitment = currentModelHead(modelId); candidate is a fresh
// distinct commitment unless overridden. Use this for any submit you expect to succeed. (HOK-2133)
async function payloadForNextLink(deltaVerifier, modelId, overrides = {}) {
  const head = await deltaVerifier.currentModelHead(modelId);
  _candidateCounter += 1;
  const n = _candidateCounter;
  return buildMintRequestPayload({
    baselineCommitment: head,
    candidateCommitment: ethers.id(`lineage-candidate-${n}`),
    ...overrides,
    anchors: {
      // Each link is a distinct mint, so it needs a distinct idempotency key (callers can override).
      idempotencyKey: ethers.id(`lineage-idem-${n}`),
      ...(overrides.anchors || {}),
    },
  });
}

// EIP-712 typed-data schema mirroring DeltaVerifier's typehashes (HOK-2132). ethers derives the
// encodeType in alphabetical order of referenced structs, matching the on-chain MINT_REQUEST_TYPEHASH.
const MINT_REQUEST_EIP712_TYPES = {
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

// EIP-712 domain must match the contract's EIP712("HokusaiDeltaVerifier", "1") + chainId + address.
async function eip712Domain(deltaVerifier) {
  const { chainId } = await ethers.provider.getNetwork();
  return {
    name: "HokusaiDeltaVerifier",
    version: "1",
    chainId,
    verifyingContract: await deltaVerifier.getAddress(),
  };
}

// Single attester signature over the full (modelId, payload, contributors) tuple.
async function signMintRequest(deltaVerifier, attesterSigner, modelId, payload, contributors) {
  const domain = await eip712Domain(deltaVerifier);
  return attesterSigner.signTypedData(domain, MINT_REQUEST_EIP712_TYPES, {
    modelId,
    payload,
    contributors,
  });
}

// 1-of-1 convenience: returns the bytes[] (single signature) submitMintRequest expects.
async function attestMintRequest(deltaVerifier, attesterSigner, modelId, payload, contributors) {
  return [await signMintRequest(deltaVerifier, attesterSigner, modelId, payload, contributors)];
}

// m-of-n: returns signatures ordered by strictly ascending signer address, as the contract requires.
async function attestMintRequestMulti(deltaVerifier, attesterSigners, modelId, payload, contributors) {
  const sorted = [...attesterSigners].sort((a, b) =>
    BigInt(a.address) < BigInt(b.address) ? -1 : 1
  );
  const signatures = [];
  for (const signer of sorted) {
    signatures.push(await signMintRequest(deltaVerifier, signer, modelId, payload, contributors));
  }
  return signatures;
}

// Launch wiring: register a single attester and set a 1-of-1 threshold (admin must hold DEFAULT_ADMIN_ROLE).
async function configureLaunchAttester(deltaVerifier, adminSigner, attesterSigner) {
  await deltaVerifier.connect(adminSigner).addAttester(attesterSigner.address);
  await deltaVerifier.connect(adminSigner).setAttesterThreshold(1);
}

// A budget large enough that it never constrains tests that aren't specifically about the budget.
// (1e12 tokens — far above any per-mint maxReward used in the suite.)
const { parseEther } = require("ethers");
const LAUNCH_MINT_BUDGET = parseEther("1000000000000");

// Per-model mint budget (HOK-2131): submitMintRequest fail-closes on a 0 budget, so any test that expects a
// positive-reward mint must fund the model's budget. Defaults to a non-constraining amount.
async function configureMintBudget(deltaVerifier, adminSigner, modelId, amount = LAUNCH_MINT_BUDGET) {
  await deltaVerifier.connect(adminSigner).setMintBudget(modelId, amount);
}

// Model-weight lineage genesis (HOK-2133): submitMintRequest fail-closes until a genesis is seeded, so any
// test expecting a mint must seed it. Set on ModelRegistry by the registration authority (owner). Defaults to
// LINEAGE_GENESIS, which matches buildMintRequestPayload's default baselineCommitment.
async function configureLineageGenesis(modelRegistry, ownerSigner, modelId, genesis = LINEAGE_GENESIS) {
  await modelRegistry.connect(ownerSigner).setWeightGenesis(modelId, genesis);
}

module.exports = {
  buildMintRequestPayload,
  payloadForNextLink,
  nextCandidateCommitment,
  LINEAGE_GENESIS,
  MINT_REQUEST_EIP712_TYPES,
  eip712Domain,
  signMintRequest,
  attestMintRequest,
  attestMintRequestMulti,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
  LAUNCH_MINT_BUDGET,
};
