import { KMSClient } from '@aws-sdk/client-kms';
import { ethers } from 'ethers';
import { KmsSigner } from '../../src/blockchain/kms-signer';

const maybeDescribe =
  process.env.KMS_BACKEND_KEY_ID &&
  process.env.KMS_BACKEND_EXPECTED_ADDRESS &&
  process.env.RPC_URL &&
  process.env.DELTA_VERIFIER_ADDRESS &&
  process.env.USAGE_FEE_ROUTER_ADDRESS
    ? describe
    : describe.skip;

maybeDescribe('Sepolia KMS backend signer', () => {
  it('derives the pinned backend signer address', async () => {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const signer = await KmsSigner.create({
      client: new KMSClient({ region: process.env.AWS_REGION || 'us-east-1' }),
      keyId: process.env.KMS_BACKEND_KEY_ID!,
      expectedAddress: process.env.KMS_BACKEND_EXPECTED_ADDRESS!,
      provider,
    });

    await expect(signer.getAddress()).resolves.toBe(
      ethers.getAddress(process.env.KMS_BACKEND_EXPECTED_ADDRESS!),
    );
  });
});
