import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1';
import { ethers } from 'ethers';
import { KmsSigner, KmsSignerAddressMismatch } from '../../../src/blockchain/kms-signer';

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;
const PRIVATE_KEY = ethers.getBytes(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
);

function derLength(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function derSequence(...parts: number[][]): Uint8Array {
  const body = parts.flat();
  return Uint8Array.from([0x30, ...derLength(body.length), ...body]);
}

function oid(hex: string): number[] {
  const bytes = Array.from(ethers.getBytes(hex));
  return [0x06, ...derLength(bytes.length), ...bytes];
}

function spkiFromPublicKey(publicKey: Uint8Array): Uint8Array {
  const algorithm = Array.from(
    derSequence(
      oid('0x2a8648ce3d0201'), // id-ecPublicKey
      oid('0x2b8104000a'), // secp256k1
    ),
  );
  const bitString = [0x03, ...derLength(publicKey.length + 1), 0x00, ...Array.from(publicKey)];
  return derSequence(algorithm, bitString);
}

function makeKmsClient(options: { highS?: boolean } = {}): KMSClient {
  const publicKey = secp256k1.getPublicKey(PRIVATE_KEY, false);
  const spki = spkiFromPublicKey(publicKey);

  return {
    send: jest.fn(async (command: GetPublicKeyCommand | SignCommand) => {
      if (command instanceof GetPublicKeyCommand) {
        return { PublicKey: spki };
      }

      const digest = command.input.Message as Uint8Array;
      let signature: ReturnType<typeof secp256k1.Signature.fromCompact> = secp256k1.sign(
        digest,
        PRIVATE_KEY,
        { lowS: !options.highS },
      );
      if (options.highS && signature.s <= SECP256K1_HALF_N) {
        const compact = ethers.concat([
          ethers.zeroPadValue(ethers.toBeHex(signature.r), 32),
          ethers.zeroPadValue(ethers.toBeHex(SECP256K1_N - signature.s), 32),
        ]);
        signature = secp256k1.Signature.fromCompact(ethers.getBytes(compact));
      }
      return { Signature: signature.toDERRawBytes() };
    }),
  } as unknown as KMSClient;
}

describe('KmsSigner', () => {
  const expectedAddress = ethers.computeAddress(
    ethers.hexlify(secp256k1.getPublicKey(PRIVATE_KEY, false)),
  );
  const provider = new ethers.JsonRpcProvider('http://127.0.0.1:8545');

  it('creates when the pinned address matches', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient(),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });

    await expect(signer.getAddress()).resolves.toBe(expectedAddress);
  });

  it('throws when the pinned address does not match', async () => {
    await expect(
      KmsSigner.create({
        client: makeKmsClient(),
        keyId: 'alias/test',
        expectedAddress: ethers.Wallet.createRandom().address,
        provider,
      }),
    ).rejects.toBeInstanceOf(KmsSignerAddressMismatch);
  });

  it('signs messages recoverable to the pinned address', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient(),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });

    const signature = await signer.signMessage('hi');

    expect(ethers.verifyMessage('hi', signature)).toBe(expectedAddress);
  });

  it('normalizes high-s KMS signatures', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient({ highS: true }),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });

    const signature = await signer.signDigest(ethers.keccak256(ethers.toUtf8Bytes('digest')));

    expect(BigInt(signature.s)).toBeLessThanOrEqual(SECP256K1_HALF_N);
    expect(
      ethers.computeAddress(
        ethers.SigningKey.recoverPublicKey(
          ethers.keccak256(ethers.toUtf8Bytes('digest')),
          signature,
        ),
      ),
    ).toBe(expectedAddress);
  });

  it('signs legacy EIP-155 transactions', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient(),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });

    const serialized = await signer.signTransaction({
      to: ethers.ZeroAddress,
      value: 1n,
      nonce: 0,
      gasLimit: 21000n,
      gasPrice: 1_000_000_000n,
      chainId: 11155111,
      type: 0,
    });

    expect(ethers.Transaction.from(serialized).from).toBe(expectedAddress);
  });

  it('signs EIP-1559 transactions', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient(),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });

    const serialized = await signer.signTransaction({
      to: ethers.ZeroAddress,
      value: 1n,
      nonce: 0,
      gasLimit: 21000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      chainId: 11155111,
      type: 2,
    });

    expect(ethers.Transaction.from(serialized).from).toBe(expectedAddress);
  });

  it('signs typed data recoverable to the pinned address', async () => {
    const signer = await KmsSigner.create({
      client: makeKmsClient(),
      keyId: 'alias/test',
      expectedAddress,
      provider,
    });
    const domain = { name: 'Hokusai', version: '1', chainId: 1 };
    const types = { Mail: [{ name: 'contents', type: 'string' }] };
    const value = { contents: 'hello' };

    const signature = await signer.signTypedData(domain, types, value);

    expect(ethers.verifyTypedData(domain, types, value, signature)).toBe(expectedAddress);
  });
});
