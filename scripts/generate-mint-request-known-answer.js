#!/usr/bin/env node
// SECURITY: the private keys in this file are TEST-ONLY keys from Hardhat's canonical mnemonic.
// They have zero value on any network. They exist here so anyone can regenerate the known-answer
// deterministically without coordination.
//
// Usage:
//   node scripts/generate-mint-request-known-answer.js          # write the known-answer file
//   node scripts/generate-mint-request-known-answer.js --check  # verify committed file matches

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { MINT_REQUEST_EIP712_TYPES, EIP712_DOMAIN } = require("../shared/mint-request-eip712");

const GOLDEN_FIXTURE_PATH = path.resolve(__dirname, "../test/fixtures/deltaverifier-mint-request.golden.json");
const KNOWN_ANSWER_PATH = path.resolve(__dirname, "../test/fixtures/deltaverifier-mint-request.known-answer.json");
// Vendored consumer-side ABI (kept in lockstep with artifacts by the abi-sync test).
const DEPLOYER_ABI_PATH = path.resolve(__dirname, "../services/contract-deployer/contracts/DeltaVerifier.json");

// Hardhat signer[0] (owner/deployer): deterministic from the canonical mnemonic
// "test test test test test test test test test test test junk"
const DEPLOYER_ADDRESS = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Hardhat signer[2] (attester) — used as the test attester key
const ATTESTER_PRIVATE_KEY = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const ATTESTER_ADDRESS = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";

// DeltaVerifier is deployed at deployer nonce=3 in the conformance test's deploy sequence:
// nonce 0: ModelRegistry, nonce 1: TokenManager, nonce 2: DataContributionRegistry, nonce 3: DeltaVerifier
const DEPLOYER_NONCE = 3;
const CHAIN_ID = 31337; // Hardhat default

function computeVerifyingContract() {
  return ethers.getCreateAddress({ from: DEPLOYER_ADDRESS, nonce: DEPLOYER_NONCE });
}

function loadGoldenFixture() {
  return JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, "utf8"));
}

function buildEip712Value(golden) {
  return {
    modelId: BigInt(golden.modelId),
    payload: {
      pipelineRunId: golden.pipelineRunId,
      baselineScoreBps: golden.baselineScoreBps,
      candidateScoreBps: golden.candidateScoreBps,
      maxCostUsdMicro: golden.maxCostUsdMicro,
      actualCostUsdMicro: golden.actualCostUsdMicro,
      totalSamples: golden.totalSamples,
      anchors: {
        benchmarkSpecHash: golden.benchmarkSpecHash,
        datasetHash: golden.datasetHash,
        attestationHash: golden.attestationHash,
        idempotencyKey: golden.idempotencyKey,
        metricName: golden.metricName,
        metricFamily: golden.metricFamily,
      },
      baselineCommitment: golden.baselineCommitment,
      candidateCommitment: golden.candidateCommitment,
    },
    contributors: golden.contributors.map(c => ({
      walletAddress: c.walletAddress,
      weight: c.weight,
    })),
  };
}

async function generate() {
  const golden = loadGoldenFixture();
  const verifyingContract = computeVerifyingContract();

  const domain = {
    ...EIP712_DOMAIN,
    chainId: CHAIN_ID,
    verifyingContract,
  };

  const value = buildEip712Value(golden);

  // Compute struct hash (domain-free) and typed-data digest (domain-bound)
  const structHash = ethers.TypedDataEncoder.hashStruct("MintRequest", MINT_REQUEST_EIP712_TYPES, value);
  const typedDataDigest = ethers.TypedDataEncoder.hash(domain, MINT_REQUEST_EIP712_TYPES, value);

  // Sign with the test attester key
  const attesterWallet = new ethers.Wallet(ATTESTER_PRIVATE_KEY);
  const signature = await attesterWallet.signTypedData(domain, MINT_REQUEST_EIP712_TYPES, value);

  // Verify round-trip: recovered address must match the attester
  const recovered = ethers.verifyTypedData(domain, MINT_REQUEST_EIP712_TYPES, value, signature);
  if (recovered.toLowerCase() !== ATTESTER_ADDRESS.toLowerCase()) {
    throw new Error(`Signature recovery mismatch: expected ${ATTESTER_ADDRESS}, got ${recovered}`);
  }

  // Pin the exact submitMintRequest calldata bytes. The consumer parity test rebuilds this
  // from the production MintRequestProcessor mapping; byte-equality pins every signed field.
  const deployerAbi = JSON.parse(fs.readFileSync(DEPLOYER_ABI_PATH, "utf8")).abi;
  const submitCalldata = new ethers.Interface(deployerAbi).encodeFunctionData("submitMintRequest", [
    value.modelId,
    value.payload,
    value.contributors,
    [signature],
  ]);

  const knownAnswer = {
    _comment: "SECURITY: test-only keys from Hardhat canonical mnemonic. Zero value on any network.",
    structHash,
    domain,
    typedDataDigest,
    submitCalldata,
    signatures: [signature],
    signerAddresses: [ATTESTER_ADDRESS],
    attesterPrivateKeys: [ATTESTER_PRIVATE_KEY],
  };

  return knownAnswer;
}

async function main() {
  const checkMode = process.argv.includes("--check");
  const knownAnswer = await generate();
  const output = JSON.stringify(knownAnswer, null, 2) + "\n";

  if (checkMode) {
    if (!fs.existsSync(KNOWN_ANSWER_PATH)) {
      console.error("FAIL: known-answer file does not exist. Run: npm run conformance:regen");
      process.exit(1);
    }
    const committed = fs.readFileSync(KNOWN_ANSWER_PATH, "utf8");
    if (committed !== output) {
      console.error("FAIL: committed known-answer does not match regenerated output.");
      console.error("Run: npm run conformance:regen");
      process.exit(1);
    }
    console.log("OK: committed known-answer matches regenerated output.");
  } else {
    fs.writeFileSync(KNOWN_ANSWER_PATH, output, "utf8");
    console.log("Wrote:", KNOWN_ANSWER_PATH);
    console.log("  structHash:      ", knownAnswer.structHash);
    console.log("  typedDataDigest: ", knownAnswer.typedDataDigest);
    console.log("  verifyingContract:", knownAnswer.domain.verifyingContract);
    console.log("  signer:          ", knownAnswer.signerAddresses[0]);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
