import { ethers } from 'ethers';
import { buildBackendSigner } from '../../../src/blockchain/signer-factory';
import { KmsSigner } from '../../../src/blockchain/kms-signer';

describe('buildBackendSigner', () => {
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
  const privateKey = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns a wallet when only DEPLOYER_PRIVATE_KEY is configured', async () => {
    const signer = await buildBackendSigner(
      {
        awsRegion: 'us-east-1',
        privateKey,
      },
      provider,
    );

    expect(signer).toBeInstanceOf(ethers.Wallet);
    await expect(signer.getAddress()).resolves.toBe(new ethers.Wallet(privateKey).address);
  });

  it('returns a KMS signer when KMS_BACKEND_KEY_ID is configured', async () => {
    const kmsSigner = new ethers.VoidSigner('0x1234567890123456789012345678901234567890', provider);
    const createSpy = jest
      .spyOn(KmsSigner, 'create')
      .mockResolvedValue(kmsSigner as unknown as KmsSigner);

    const signer = await buildBackendSigner(
      {
        awsRegion: 'us-east-1',
        kmsBackendKeyId: 'alias/hokusai/test/submitter',
        kmsBackendExpectedAddress: '0x1234567890123456789012345678901234567890',
      },
      provider,
    );

    expect(signer).toBe(kmsSigner);
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'alias/hokusai/test/submitter',
        expectedAddress: '0x1234567890123456789012345678901234567890',
        provider,
      }),
    );
  });
});
