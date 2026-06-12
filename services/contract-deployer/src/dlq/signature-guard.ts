import { ethers } from 'ethers';
import { DeltaVerifierClient } from '../blockchain/delta-verifier-client';
import { MintRequestMessage } from '../schemas/mint-request-schema';
import { MintRequestProcessor } from '../services/mint-request-processor';

const MINT_REQUEST_EIP712_TYPES = {
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
};

const EIP712_DOMAIN = {
  name: 'HokusaiDeltaVerifier',
  version: '1',
};

export interface SignatureValidationResult {
  valid: boolean;
  threshold: bigint;
  recoveredSigners: string[];
  authorizedSigners: string[];
  error?: string;
}

export async function validateMintRequestSignatures(
  message: MintRequestMessage,
  client: DeltaVerifierClient,
  domain: { chainId: bigint; verifyingContract: string },
): Promise<SignatureValidationResult> {
  const processor = new MintRequestProcessor(client);
  const value = {
    modelId: BigInt(message.model_id_uint),
    payload: processor.buildPayload(message),
    contributors: processor.buildContributors(message),
  };
  const typedDataDomain = {
    ...EIP712_DOMAIN,
    chainId: domain.chainId,
    verifyingContract: domain.verifyingContract,
  };
  const recoveredSigners: string[] = [];

  try {
    for (const signature of message.attester_signatures) {
      recoveredSigners.push(
        ethers.verifyTypedData(typedDataDomain, MINT_REQUEST_EIP712_TYPES, value, signature),
      );
    }
  } catch (error) {
    return {
      valid: false,
      threshold: 0n,
      recoveredSigners,
      authorizedSigners: [],
      error: error instanceof Error ? error.message : 'Invalid attester signature',
    };
  }

  const threshold = await client.attesterThreshold();
  const uniqueRecoveredSigners = [
    ...new Set(recoveredSigners.map((signer) => signer.toLowerCase())),
  ];
  const authorizedSigners: string[] = [];

  for (const signer of uniqueRecoveredSigners) {
    if (await client.isAttester(signer)) {
      authorizedSigners.push(signer);
    }
  }

  const valid = threshold > 0n && BigInt(authorizedSigners.length) >= threshold;
  return {
    valid,
    threshold,
    recoveredSigners,
    authorizedSigners,
    error: valid
      ? undefined
      : `authorized attester signatures ${authorizedSigners.length} below threshold ${threshold.toString()}`,
  };
}
