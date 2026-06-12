const mockInfo = jest.fn();

jest.mock('../../../src/utils/logger', () => ({
  createLogger: () => ({
    info: mockInfo,
  }),
}));

jest.mock('../../../src/blockchain/kms-signer', () => ({
  KmsSigner: {
    fromKeyId: jest.fn(),
  },
}));

import { ethers } from 'ethers';
import { createBackendSigner } from '../../../src/blockchain/signer-factory';
import { KmsSigner } from '../../../src/blockchain/kms-signer';

describe('createBackendSigner', () => {
  const provider = {} as ethers.Provider;

  beforeEach(() => {
    mockInfo.mockReset();
    (KmsSigner.fromKeyId as jest.Mock).mockReset();
  });

  test('returns a KMS signer when the derived address matches the pin', async () => {
    const signer = {
      getAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    };
    (KmsSigner.fromKeyId as jest.Mock).mockResolvedValue(signer);

    const result = await createBackendSigner(
      {
        AWS_REGION: 'us-east-1',
        KMS_BACKEND_KEY_ID: 'alias/test/backend',
        KMS_BACKEND_EXPECTED_ADDRESS: '0x1234567890123456789012345678901234567890',
      } as any,
      provider,
    );

    expect(result).toBe(signer);
    expect(mockInfo).toHaveBeenCalledWith('Using KMS backend signer', {
      keyId: 'alias/test/backend',
      address: '0x1234567890123456789012345678901234567890',
    });
  });

  test('throws when the derived address does not match the pin', async () => {
    (KmsSigner.fromKeyId as jest.Mock).mockResolvedValue({
      getAddress: jest.fn().mockResolvedValue('0x1234567890123456789012345678901234567890'),
    });

    await expect(
      createBackendSigner(
        {
          AWS_REGION: 'us-east-1',
          KMS_BACKEND_KEY_ID: 'alias/test/backend',
          KMS_BACKEND_EXPECTED_ADDRESS: '0x2234567890123456789012345678901234567890',
        } as any,
        provider,
      ),
    ).rejects.toThrow('KMS backend address pin mismatch');
  });

  test('falls back to a raw wallet in development mode', async () => {
    const result = await createBackendSigner(
      {
        DEPLOYER_PRIVATE_KEY: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      } as any,
      provider,
    );

    expect(result).toBeInstanceOf(ethers.Wallet);
  });
});
