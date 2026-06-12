import { generateKeyPairSync } from 'crypto';
import { ethers } from 'ethers';
import { GetPublicKeyCommand, SignCommand } from '@aws-sdk/client-kms';
import { KmsSigner } from '../../../src/blockchain/kms-signer';

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

interface JwkPrivateKey {
  d?: string;
}

function encodeDerLength(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }

  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return [0x80 | bytes.length, ...bytes];
}

function encodeDerInteger(value: bigint): number[] {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  const bytes = Array.from(Buffer.from(hex, 'hex'));
  if (bytes[0] !== undefined && bytes[0] >= 0x80) {
    bytes.unshift(0x00);
  }

  return [0x02, ...encodeDerLength(bytes.length), ...bytes];
}

function encodeDerSignature(r: bigint, s: bigint): Uint8Array {
  const encodedR = encodeDerInteger(r);
  const encodedS = encodeDerInteger(s);
  const sequence = [...encodedR, ...encodedS];
  return Uint8Array.from([0x30, ...encodeDerLength(sequence.length), ...sequence]);
}

function createMockProvider(chainId = 11155111n): ethers.Provider {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId, name: 'testnet' }),
    getTransactionCount: jest.fn().mockResolvedValue(7),
    estimateGas: jest.fn().mockResolvedValue(21000n),
    getFeeData: jest.fn().mockResolvedValue({
      gasPrice: 20_000_000_000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      toJSON: () => ({}),
    }),
    resolveName: jest.fn().mockImplementation(async (value: string) => value),
    getBalance: jest.fn(),
  } as unknown as ethers.Provider;
}

describe('KmsSigner', () => {
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'secp256k1' });
  const jwk = keyPair.privateKey.export({ format: 'jwk' }) as JwkPrivateKey;
  const privateKeyHex = `0x${Buffer.from(jwk.d!, 'base64url').toString('hex')}`;
  const wallet = new ethers.Wallet(privateKeyHex);
  const publicKeyDer = keyPair.publicKey.export({ format: 'der', type: 'spki' });

  let returnHighS = false;
  const mockClient = {
    send: jest.fn(async (command: unknown) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: publicKeyDer };
      }

      if (command instanceof SignCommand) {
        const digest = Buffer.from(command.input.Message as Uint8Array);
        const signingKey = new ethers.SigningKey(privateKeyHex);
        const signature = signingKey.sign(digest);
        const sValue = BigInt(signature.s);
        const adjustedS =
          returnHighS && sValue < SECP256K1_HALF_ORDER ? SECP256K1_ORDER - sValue : sValue;
        return {
          Signature: encodeDerSignature(BigInt(signature.r), adjustedS),
        };
      }

      throw new Error('Unexpected KMS command');
    }),
  } as any;

  beforeEach(() => {
    returnHighS = false;
    mockClient.send.mockClear();
  });

  test('derives the same address as the local wallet', async () => {
    const signer = await KmsSigner.fromKeyId({
      client: mockClient,
      keyId: 'alias/test',
    });

    expect(await signer.getAddress()).toBe(wallet.address);
  });

  test('signs messages with recoverable low-s signatures', async () => {
    returnHighS = true;
    const signer = await KmsSigner.fromKeyId({
      client: mockClient,
      keyId: 'alias/test',
    });

    const signature = await signer.signMessage('kms-backed-message');
    const parsed = ethers.Signature.from(signature);

    expect(BigInt(parsed.s)).toBeLessThanOrEqual(SECP256K1_HALF_ORDER);
    expect(ethers.verifyMessage('kms-backed-message', signature)).toBe(wallet.address);
  });

  test('signs legacy transactions that round-trip to the expected sender', async () => {
    const signer = await KmsSigner.fromKeyId({
      client: mockClient,
      keyId: 'alias/test',
      provider: createMockProvider(1n),
    });

    const serialized = await signer.signTransaction({
      to: '0x1111111111111111111111111111111111111111',
      nonce: 7,
      gasLimit: 21000n,
      gasPrice: 20_000_000_000n,
      value: 1n,
      chainId: 1,
      type: 0,
    });

    const parsed = ethers.Transaction.from(serialized);
    expect(parsed.from).toBe(wallet.address);
    expect(parsed.chainId).toBe(1n);
  });

  test('signs type-2 transactions that round-trip to the expected sender', async () => {
    const signer = await KmsSigner.fromKeyId({
      client: mockClient,
      keyId: 'alias/test',
      provider: createMockProvider(11155111n),
    });

    const serialized = await signer.signTransaction({
      to: '0x1111111111111111111111111111111111111111',
      nonce: 7,
      gasLimit: 21000n,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      value: 1n,
      chainId: 11155111,
      type: 2,
    });

    const parsed = ethers.Transaction.from(serialized);
    expect(parsed.from).toBe(wallet.address);
    expect(parsed.chainId).toBe(11155111n);
    expect(parsed.type).toBe(2);
  });

  test('signs typed data that recovers to the expected signer', async () => {
    const signer = await KmsSigner.fromKeyId({
      client: mockClient,
      keyId: 'alias/test',
    });

    const domain = {
      name: 'Hokusai',
      version: '1',
      chainId: 11155111,
      verifyingContract: '0x1111111111111111111111111111111111111111',
    };
    const types = {
      MintRequest: [
        { name: 'modelId', type: 'string' },
        { name: 'amount', type: 'uint256' },
      ],
    };
    const value = {
      modelId: 'model-123',
      amount: 42n,
    };

    const signature = await signer.signTypedData(domain, types, value);
    const recovered = ethers.verifyTypedData(domain, types, value, signature);

    expect(recovered).toBe(wallet.address);
  });
});
