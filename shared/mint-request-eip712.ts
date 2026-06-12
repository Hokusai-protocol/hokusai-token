// TS mirror of shared/mint-request-eip712.js — kept in sync by a paired test.

export const MINT_REQUEST_EIP712_TYPES = {
  MintRequest: [
    { name: 'modelId', type: 'uint256' },
    { name: 'payload', type: 'MintRequestPayload' },
    { name: 'contributors', type: 'Contributor[]' },
  ],
  MintRequestPayload: [
    { name: 'pipelineRunId', type: 'string' },
    { name: 'baselineScoreBps', type: 'uint256' },
    { name: 'candidateScoreBps', type: 'uint256' },
    { name: 'maxCostUsdMicro', type: 'uint256' },
    { name: 'actualCostUsdMicro', type: 'uint256' },
    { name: 'totalSamples', type: 'uint256' },
    { name: 'anchors', type: 'BenchmarkAnchors' },
    { name: 'baselineCommitment', type: 'bytes32' },
    { name: 'candidateCommitment', type: 'bytes32' },
  ],
  BenchmarkAnchors: [
    { name: 'benchmarkSpecHash', type: 'bytes32' },
    { name: 'datasetHash', type: 'bytes32' },
    { name: 'attestationHash', type: 'bytes32' },
    { name: 'idempotencyKey', type: 'bytes32' },
    { name: 'metricName', type: 'string' },
    { name: 'metricFamily', type: 'string' },
  ],
  Contributor: [
    { name: 'walletAddress', type: 'address' },
    { name: 'weight', type: 'uint256' },
  ],
} as const;

export const EIP712_DOMAIN = {
  name: 'HokusaiDeltaVerifier',
  version: '1',
} as const;
