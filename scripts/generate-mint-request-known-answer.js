const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { ethers, TypedDataEncoder } = require("ethers");

const DeltaVerifierArtifact = require("../services/contract-deployer/contracts/DeltaVerifier.json");
const { MINT_REQUEST_EIP712_TYPES } = require("../test/helpers/mintRequest");

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../services/contract-deployer/tests/fixtures/mint_request.v1.json"
);
const KNOWN_ANSWER_PATH = path.resolve(
  __dirname,
  "../services/contract-deployer/tests/fixtures/mint_request.v1.known_answer.json"
);

const SYNTHETIC_DOMAIN = {
  name: "HokusaiDeltaVerifier",
  version: "1",
  chainId: 31337,
  verifyingContract: "0x0000000000000000000000000000000000000bee",
};

const TEST_SIGNER_PRIVATE_KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
];

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, "utf8"));
}

function mapFixtureToTypedData(fixture) {
  return {
    modelId: BigInt(fixture.model_id_uint),
    payload: {
      pipelineRunId: fixture.eval_id,
      baselineScoreBps: fixture.evaluation.baseline_score_bps,
      candidateScoreBps: fixture.evaluation.new_score_bps,
      maxCostUsdMicro: fixture.evaluation.max_cost_usd_micro,
      actualCostUsdMicro: fixture.evaluation.actual_cost_usd_micro,
      totalSamples: fixture.totalSamples,
      anchors: {
        benchmarkSpecHash: ethers.keccak256(ethers.toUtf8Bytes(fixture.benchmark_spec_id)),
        datasetHash: fixture.dataset_hash,
        attestationHash: fixture.attestation_hash,
        idempotencyKey: fixture.idempotency_key,
        metricName: fixture.evaluation.metric_name,
        metricFamily: fixture.evaluation.metric_family,
      },
      baselineCommitment: fixture.baseline_commitment,
      candidateCommitment: fixture.candidate_commitment,
    },
    contributors: fixture.contributors.map((contributor) => ({
      walletAddress: contributor.wallet_address,
      weight: contributor.weight_bps,
    })),
  };
}

async function signKnownAnswer(message) {
  const signers = [];

  for (const privateKey of TEST_SIGNER_PRIVATE_KEYS) {
    const wallet = new ethers.Wallet(privateKey);
    const signature = await wallet.signTypedData(SYNTHETIC_DOMAIN, MINT_REQUEST_EIP712_TYPES, message);
    const recoveredAddress = ethers.verifyTypedData(
      SYNTHETIC_DOMAIN,
      MINT_REQUEST_EIP712_TYPES,
      message,
      signature
    );

    if (recoveredAddress.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(`Recovered signer ${recoveredAddress} did not match wallet ${wallet.address}`);
    }

    signers.push({
      address: wallet.address,
      signature,
    });
  }

  return signers;
}

async function main() {
  const fixture = loadFixture();
  const message = mapFixtureToTypedData(fixture);
  const signers = await signKnownAnswer(message);
  const signatures = signers.map((signer) => signer.signature);
  const signedFixture = {
    ...fixture,
    attester_signatures: signatures,
  };
  const fixtureText = `${JSON.stringify(signedFixture, null, 2)}\n`;
  fs.writeFileSync(FIXTURE_PATH, fixtureText);

  const domainSeparator = TypedDataEncoder.hashDomain(SYNTHETIC_DOMAIN);
  const structHash = TypedDataEncoder.hashStruct("MintRequest", MINT_REQUEST_EIP712_TYPES, message);
  const digest = TypedDataEncoder.hash(SYNTHETIC_DOMAIN, MINT_REQUEST_EIP712_TYPES, message);
  const submitCalldata = new ethers.Interface(DeltaVerifierArtifact.abi).encodeFunctionData(
    "submitMintRequest",
    [message.modelId, message.payload, message.contributors, signatures]
  );

  const knownAnswer = {
    comment:
      "Known-answer for Gate 6 cross-repo signed-mint conformance. Regenerate via scripts/generate-mint-request-known-answer.js.",
    fixture_sha256: sha256Hex(fixtureText),
    eip712: {
      domain: SYNTHETIC_DOMAIN,
      primary_type: "MintRequest",
      domain_separator: domainSeparator,
      struct_hash: structHash,
      digest,
    },
    signatures,
    signer_addresses: signers.map((signer) => signer.address),
    signers,
    submit_calldata: submitCalldata,
    submit_calldata_selector: submitCalldata.slice(0, 10),
  };

  fs.writeFileSync(KNOWN_ANSWER_PATH, `${JSON.stringify(knownAnswer, null, 2)}\n`);

  console.log(
    JSON.stringify(
      {
        fixture: path.relative(process.cwd(), FIXTURE_PATH),
        fixture_sha256: knownAnswer.fixture_sha256,
        digest: knownAnswer.eip712.digest,
        signer_addresses: knownAnswer.signer_addresses,
        submit_calldata_selector: knownAnswer.submit_calldata_selector,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
