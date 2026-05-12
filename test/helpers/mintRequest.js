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

module.exports = {
  buildMintRequestPayload,
};
