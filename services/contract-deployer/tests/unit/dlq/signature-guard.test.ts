import { ethers } from 'ethers';
import { validateMintRequestSignatures } from '../../../src/dlq/signature-guard';
import { MintRequestProcessor } from '../../../src/services/mint-request-processor';
import { validMintRequest } from './test-helpers';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedEip712 = require('../../../../../shared/mint-request-eip712');
const { MINT_REQUEST_EIP712_TYPES, EIP712_DOMAIN } = sharedEip712;

describe('signature guard', () => {
  const domain = {
    ...EIP712_DOMAIN,
    chainId: 31337n,
    verifyingContract: '0x1111111111111111111111111111111111111111',
  };
  const attester = new ethers.Wallet(
    '0x59c6995e998f97a5a0044966f094538bc9c9ade0f2f4a73b4af65dfec58f9027',
  );
  const processor = new MintRequestProcessor({} as never);

  async function signMessage(message = validMintRequest): Promise<string> {
    return attester.signTypedData(domain, MINT_REQUEST_EIP712_TYPES, {
      modelId: BigInt(message.model_id_uint),
      payload: processor.buildPayload(message),
      contributors: processor.buildContributors(message),
    });
  }

  function fakeClient(authorized: boolean, threshold = 1n) {
    return {
      attesterThreshold: jest.fn().mockResolvedValue(threshold),
      isAttester: jest.fn().mockResolvedValue(authorized),
    };
  }

  test('accepts a signature from a currently registered attester', async () => {
    const message = {
      ...validMintRequest,
      attester_signatures: [await signMessage()],
    };
    const client = fakeClient(true);

    const result = await validateMintRequestSignatures(message, client as never, domain);

    expect(result.valid).toBe(true);
    expect(result.recoveredSigners.map((signer) => signer.toLowerCase())).toEqual([
      attester.address.toLowerCase(),
    ]);
    expect(client.isAttester).toHaveBeenCalledWith(attester.address.toLowerCase());
  });

  test('rejects schema-valid payload tampering because the recovered signer is unauthorized', async () => {
    const signedMessage = {
      ...validMintRequest,
      attester_signatures: [await signMessage()],
    };
    const tamperedMessage = {
      ...signedMessage,
      idempotency_key: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    const result = await validateMintRequestSignatures(
      tamperedMessage,
      fakeClient(false) as never,
      domain,
    );

    expect(result.valid).toBe(false);
    expect(result.error).toContain('below threshold');
  });
});
