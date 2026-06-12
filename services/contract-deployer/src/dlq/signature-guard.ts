import { ethers } from 'ethers';
import { DeltaVerifierClient } from '../blockchain/delta-verifier-client';
import { MintRequestMessage } from '../schemas/mint-request-schema';
import { MintRequestProcessor } from '../services/mint-request-processor';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MINT_REQUEST_EIP712_TYPES, EIP712_DOMAIN } = require('../../../../shared/mint-request-eip712') as {
  MINT_REQUEST_EIP712_TYPES: Record<string, { name: string; type: string }[]>;
  EIP712_DOMAIN: { name: string; version: string };
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
