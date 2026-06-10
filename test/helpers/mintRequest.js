const { ethers } = require("hardhat");

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
    ...overrides,
    anchors: {
      ...defaultAnchors,
      ...(overrides.anchors || {}),
    }
  };
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

module.exports = {
  buildMintRequestPayload,
  MINT_REQUEST_EIP712_TYPES,
  eip712Domain,
  signMintRequest,
  attestMintRequest,
  attestMintRequestMulti,
  configureLaunchAttester,
};
