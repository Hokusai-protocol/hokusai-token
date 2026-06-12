import { KMSClient } from '@aws-sdk/client-kms';
import { ethers } from 'ethers';
import { KmsSigner } from './kms-signer';

export interface BackendSignerConfig {
  awsRegion: string;
  kmsBackendKeyId?: string;
  kmsBackendExpectedAddress?: string;
  privateKey?: string;
}

export async function buildBackendSigner(
  config: BackendSignerConfig,
  provider: ethers.Provider,
): Promise<ethers.Signer> {
  if (config.kmsBackendKeyId) {
    if (!config.kmsBackendExpectedAddress) {
      throw new Error('KMS_BACKEND_EXPECTED_ADDRESS is required when KMS_BACKEND_KEY_ID is set');
    }

    return KmsSigner.create({
      client: new KMSClient({ region: config.awsRegion }),
      keyId: config.kmsBackendKeyId,
      expectedAddress: config.kmsBackendExpectedAddress,
      provider,
    });
  }

  if (!config.privateKey) {
    throw new Error('DEPLOYER_PRIVATE_KEY is required when KMS_BACKEND_KEY_ID is not set');
  }

  return new ethers.Wallet(config.privateKey, provider);
}

export function getConfiguredBackendAddress(config: {
  kmsBackendExpectedAddress?: string;
  privateKey?: string;
}): string | null {
  if (config.kmsBackendExpectedAddress) {
    return ethers.getAddress(config.kmsBackendExpectedAddress);
  }

  if (config.privateKey) {
    return new ethers.Wallet(config.privateKey).address;
  }

  return null;
}
