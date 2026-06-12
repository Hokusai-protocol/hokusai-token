const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("ethers");

const { MINT_REQUEST_EIP712_TYPES } = require("../helpers/mintRequest");

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../services/contract-deployer/tests/fixtures/mint_request.v1.json"
);
const KNOWN_ANSWER_PATH = path.resolve(
  __dirname,
  "../../services/contract-deployer/tests/fixtures/mint_request.v1.known_answer.json"
);

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
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

describe("MintRequest digest parity", function () {
  it("matches the committed known-answer domain separator, struct hash, digest, and signer recovery", function () {
    const fixture = loadJson(FIXTURE_PATH);
    const knownAnswer = loadJson(KNOWN_ANSWER_PATH);
    const message = mapFixtureToTypedData(fixture);
    const domainSeparator = ethers.TypedDataEncoder.hashDomain(knownAnswer.eip712.domain);
    const structHash = ethers.TypedDataEncoder.hashStruct(
      knownAnswer.eip712.primary_type,
      MINT_REQUEST_EIP712_TYPES,
      message
    );
    const digest = ethers.TypedDataEncoder.hash(
      knownAnswer.eip712.domain,
      MINT_REQUEST_EIP712_TYPES,
      message
    );
    const [signer] = knownAnswer.signers;
    const recovered = ethers.verifyTypedData(
      knownAnswer.eip712.domain,
      MINT_REQUEST_EIP712_TYPES,
      message,
      signer.signature
    );

    expect(fixture.attester_signatures).to.deep.equal(knownAnswer.signatures);
    expect(knownAnswer.signer_addresses).to.deep.equal(knownAnswer.signers.map((entry) => entry.address));
    expect(domainSeparator).to.equal(knownAnswer.eip712.domain_separator);
    expect(structHash).to.equal(knownAnswer.eip712.struct_hash);
    expect(digest).to.equal(knownAnswer.eip712.digest);
    expect(recovered).to.equal(signer.address);
  });
});
