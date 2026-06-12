import {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  SigningAlgorithmSpec,
} from '@aws-sdk/client-kms';
import { ethers } from 'ethers';
import { secp256k1 } from '@noble/curves/secp256k1';

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
const SECP256K1_HALF_N = SECP256K1_N / 2n;

export class KmsSignerAddressMismatch extends Error {
  constructor(
    public readonly expectedAddress: string,
    public readonly derivedAddress: string,
  ) {
    super(
      `KMS signer address mismatch: expected ${expectedAddress}, derived ${derivedAddress}. ` +
        'KMS aliases are mutable; check the alias target and expected-address pin.',
    );
    this.name = 'KmsSignerAddressMismatch';
  }
}

export interface KmsSignerOptions {
  client: KMSClient;
  keyId: string;
  expectedAddress: string;
  provider?: ethers.Provider | null;
}

interface VerifiedKmsSignerOptions extends KmsSignerOptions {
  address: string;
  publicKey: string;
}

export class KmsSigner extends ethers.AbstractSigner {
  private readonly client: KMSClient;
  private readonly keyId: string;
  private readonly address: string;
  private readonly publicKey: string;

  private constructor(options: VerifiedKmsSignerOptions) {
    super(options.provider ?? null);
    this.client = options.client;
    this.keyId = options.keyId;
    this.address = ethers.getAddress(options.address);
    this.publicKey = ethers.hexlify(options.publicKey);
  }

  static async create(options: KmsSignerOptions): Promise<KmsSigner> {
    const response = await options.client.send(new GetPublicKeyCommand({ KeyId: options.keyId }));
    if (!response.PublicKey) {
      throw new Error(`KMS GetPublicKey returned no public key for ${options.keyId}`);
    }

    const publicKey = parseSpkiPublicKey(response.PublicKey);
    const derivedAddress = publicKeyToAddress(publicKey);
    const expectedAddress = ethers.getAddress(options.expectedAddress);

    if (ethers.getAddress(derivedAddress) !== expectedAddress) {
      throw new KmsSignerAddressMismatch(expectedAddress, derivedAddress);
    }

    return new KmsSigner({
      ...options,
      expectedAddress,
      address: expectedAddress,
      publicKey,
    });
  }

  connect(provider: ethers.Provider | null): KmsSigner {
    return new KmsSigner({
      client: this.client,
      keyId: this.keyId,
      expectedAddress: this.address,
      address: this.address,
      publicKey: this.publicKey,
      provider,
    });
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  async signMessage(message: ethers.BytesLike | string): Promise<string> {
    const digest = ethers.hashMessage(message);
    return (await this.signDigest(digest)).serialized;
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    return (await this.signDigest(digest)).serialized;
  }

  async signTransaction(transaction: ethers.TransactionRequest): Promise<string> {
    const expectedFrom = await this.getAddress();
    if (transaction.from) {
      const transactionFrom = ethers.getAddress(await ethers.resolveAddress(transaction.from));
      if (transactionFrom !== expectedFrom) {
        throw new Error(
          `transaction from address mismatch: expected ${expectedFrom}, got ${transactionFrom}`,
        );
      }
    }

    const unsignedTransaction = { ...transaction };
    delete unsignedTransaction.from;
    const populated = ethers.Transaction.from(
      unsignedTransaction as ethers.TransactionLike<string>,
    );
    populated.signature = await this.signDigest(populated.unsignedHash);
    return populated.serialized;
  }

  async signDigest(digestHex: string): Promise<ethers.Signature> {
    const digest = ethers.getBytes(digestHex);
    if (digest.length !== 32) {
      throw new Error(`KMS signer requires a 32-byte digest, got ${digest.length} bytes`);
    }

    const response = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digest,
        MessageType: 'DIGEST',
        SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
      }),
    );
    if (!response.Signature) {
      throw new Error(`KMS Sign returned no signature for ${this.keyId}`);
    }

    const parsed = secp256k1.Signature.fromDER(response.Signature);
    const r = toBytes32(parsed.r);
    const normalizedS = parsed.s > SECP256K1_HALF_N ? SECP256K1_N - parsed.s : parsed.s;
    const s = toBytes32(normalizedS);

    for (const v of [27, 28]) {
      const candidate = ethers.Signature.from({ r, s, v });
      const recovered = ethers.SigningKey.recoverPublicKey(digestHex, candidate);
      if (ethers.hexlify(recovered).toLowerCase() === this.publicKey.toLowerCase()) {
        return candidate;
      }
    }

    throw new Error(`Unable to recover KMS signer address for ${this.keyId}`);
  }
}

export function parseSpkiToAddress(spkiDer: Uint8Array): string {
  return publicKeyToAddress(parseSpkiPublicKey(spkiDer));
}

export function parseSpkiPublicKey(spkiDer: Uint8Array): string {
  const reader = new DerReader(spkiDer);
  const sequence = reader.readConstructed(0x30);
  sequence.readConstructed(0x30);
  const publicKeyBytes = sequence.readPrimitive(0x03);
  if (publicKeyBytes.length < 2 || publicKeyBytes[0] !== 0) {
    throw new Error('Unsupported KMS SPKI BIT STRING encoding');
  }

  const publicKey = publicKeyBytes.slice(1);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error('KMS public key is not an uncompressed secp256k1 point');
  }

  if (!sequence.done() || !reader.done()) {
    throw new Error('Unexpected trailing data in KMS SPKI public key');
  }

  return ethers.hexlify(publicKey);
}

function publicKeyToAddress(publicKey: string): string {
  const bytes = ethers.getBytes(publicKey);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error('Expected uncompressed secp256k1 public key');
  }

  return ethers.computeAddress(ethers.hexlify(bytes));
}

function toBytes32(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

class DerReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readConstructed(expectedTag: number): DerReader {
    return new DerReader(this.readTlv(expectedTag));
  }

  readPrimitive(expectedTag: number): Uint8Array {
    return this.readTlv(expectedTag);
  }

  done(): boolean {
    return this.offset === this.bytes.length;
  }

  private readTlv(expectedTag: number): Uint8Array {
    const tag = this.readByte();
    if (tag !== expectedTag) {
      throw new Error(
        `Unexpected DER tag 0x${tag.toString(16)}, expected 0x${expectedTag.toString(16)}`,
      );
    }

    const length = this.readLength();
    if (this.offset + length > this.bytes.length) {
      throw new Error('Truncated DER value');
    }

    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  private readByte(): number {
    if (this.offset >= this.bytes.length) {
      throw new Error('Truncated DER input');
    }
    const value = this.bytes[this.offset];
    if (value === undefined) {
      throw new Error('Truncated DER input');
    }
    this.offset++;
    return value;
  }

  private readLength(): number {
    const first = this.readByte();
    if (first < 0x80) {
      return first;
    }

    const lengthBytes = first & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error('Unsupported DER length encoding');
    }

    let length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = (length << 8) | this.readByte();
    }
    return length;
  }
}
