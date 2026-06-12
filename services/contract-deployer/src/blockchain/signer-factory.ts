import { KMSClient } from '@aws-sdk/client-kms';
import { ethers } from 'ethers';
import { Config } from '../config/env.validation';
import { createLogger } from '../utils/logger';
import { KmsSigner } from './kms-signer';

const logger = createLogger('signer-factory');

let kmsClient: KMSClient | null = null;

function getKmsClient(region: string): KMSClient {
  if (!kmsClient) {
    kmsClient = new KMSClient({ region });
  }

  return kmsClient;
}

export async function createBackendSigner(
  config: Config,
  provider: ethers.Provider,
): Promise<ethers.Signer> {
  if (config.KMS_BACKEND_KEY_ID) {
    const signer = await KmsSigner.fromKeyId({
      client: getKmsClient(config.AWS_REGION),
      keyId: config.KMS_BACKEND_KEY_ID,
      provider,
    });
    const derivedAddress = ethers.getAddress(await signer.getAddress());
    const expectedAddress = ethers.getAddress(config.KMS_BACKEND_EXPECTED_ADDRESS!);

    if (derivedAddress !== expectedAddress) {
      throw new Error(
        `KMS backend address pin mismatch: derived=${derivedAddress}, expected=${expectedAddress}, alias=${config.KMS_BACKEND_KEY_ID}`,
      );
    }

    logger.info('Using KMS backend signer', {
      keyId: config.KMS_BACKEND_KEY_ID,
      address: derivedAddress,
    });
    return signer;
  }

  if (config.DEPLOYER_PRIVATE_KEY) {
    return new ethers.Wallet(config.DEPLOYER_PRIVATE_KEY, provider);
  }

  throw new Error('No backend signer configured. Set KMS_BACKEND_KEY_ID or DEPLOYER_PRIVATE_KEY.');
}
