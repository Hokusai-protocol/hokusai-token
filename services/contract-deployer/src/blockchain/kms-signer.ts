import { GetPublicKeyCommand, KMSClient, SignCommand } from '@aws-sdk/client-kms';
import { createPublicKey } from 'crypto';
import { ethers } from 'ethers';

const SECP256K1_ORDER = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141',
);
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

type Provider = ethers.Provider | null;

export interface KmsSignerConfig {
  client: KMSClient;
  keyId: string;
  address: string;
  provider?: Provider;
}

export interface KmsSignerFromKeyIdConfig {
  client: KMSClient;
  keyId: string;
  provider?: Provider;
}

interface SignatureParts {
  r: bigint;
  s: bigint;
}

interface JwkKeyCoordinates {
  x?: string;
  y?: string;
}

function normalizeScalar(value: bigint): bigint {
  return value > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - value : value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  return BigInt(ethers.hexlify(bytes));
}

function bigIntToHex(value: bigint): string {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

function readDerLength(bytes: Uint8Array, offset: number): { length: number; nextOffset: number } {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error('Invalid DER signature: missing length');
  }

  if ((first & 0x80) === 0) {
    return { length: first, nextOffset: offset + 1 };
  }

  const octets = first & 0x7f;
  if (octets === 0 || octets > 4) {
    throw new Error('Invalid DER signature: unsupported length encoding');
  }

  let length = 0;
  for (let i = 0; i < octets; i += 1) {
    const byte = bytes[offset + 1 + i];
    if (byte === undefined) {
      throw new Error('Invalid DER signature: truncated length');
    }
    length = (length << 8) | byte;
  }

  return { length, nextOffset: offset + 1 + octets };
}

function decodeDerSignature(signature: Uint8Array): SignatureParts {
  if (signature[0] !== 0x30) {
    throw new Error('Invalid DER signature: expected SEQUENCE');
  }

  const { length: sequenceLength, nextOffset: sequenceOffset } = readDerLength(signature, 1);
  if (sequenceOffset + sequenceLength !== signature.length) {
    throw new Error('Invalid DER signature: trailing bytes');
  }

  if (signature[sequenceOffset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for r');
  }
  const { length: rLength, nextOffset: rOffset } = readDerLength(signature, sequenceOffset + 1);
  const rBytes = signature.slice(rOffset, rOffset + rLength);

  const sTagOffset = rOffset + rLength;
  if (signature[sTagOffset] !== 0x02) {
    throw new Error('Invalid DER signature: expected INTEGER for s');
  }
  const { length: sLength, nextOffset: sOffset } = readDerLength(signature, sTagOffset + 1);
  const sBytes = signature.slice(sOffset, sOffset + sLength);

  return {
    r: bytesToBigInt(rBytes),
    s: bytesToBigInt(sBytes),
  };
}

function getAddressFromSpki(publicKeyDer: Uint8Array): string {
  const keyObject = createPublicKey({
    key: Buffer.from(publicKeyDer),
    format: 'der',
    type: 'spki',
  });
  const jwk = keyObject.export({ format: 'jwk' }) as JwkKeyCoordinates;
  if (!jwk.x || !jwk.y) {
    throw new Error('KMS public key did not export secp256k1 coordinates');
  }

  const x = Buffer.from(jwk.x, 'base64url');
  const y = Buffer.from(jwk.y, 'base64url');
  const uncompressed = ethers.concat(['0x04', x, y]);

  return ethers.computeAddress(uncompressed);
}

async function signDigest(
  client: KMSClient,
  keyId: string,
  expectedAddress: string,
  digest: Uint8Array,
): Promise<ethers.Signature> {
  const response = await client.send(
    new SignCommand({
      KeyId: keyId,
      Message: Buffer.from(digest),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    }),
  );

  if (!response.Signature) {
    throw new Error(`KMS Sign returned no signature for key ${keyId}`);
  }

  const { r, s } = decodeDerSignature(new Uint8Array(response.Signature));
  const normalizedS = normalizeScalar(s);
  const normalizedAddress = ethers.getAddress(expectedAddress);

  for (const yParity of [0, 1] as const) {
    const signature = ethers.Signature.from({
      r: bigIntToHex(r),
      s: bigIntToHex(normalizedS),
      yParity,
    });
    const recoveredAddress = ethers.recoverAddress(digest, signature);
    if (recoveredAddress === normalizedAddress) {
      return signature;
    }
  }

  throw new Error(`Failed to recover signer address for KMS key ${keyId}`);
}

export class KmsSigner extends ethers.AbstractSigner {
  readonly client: KMSClient;
  readonly keyId: string;
  readonly address: string;

  constructor(config: KmsSignerConfig) {
    super(config.provider ?? null);
    this.client = config.client;
    this.keyId = config.keyId;
    this.address = ethers.getAddress(config.address);
  }

  static async fromKeyId(config: KmsSignerFromKeyIdConfig): Promise<KmsSigner> {
    const response = await config.client.send(
      new GetPublicKeyCommand({
        KeyId: config.keyId,
      }),
    );

    if (!response.PublicKey) {
      throw new Error(`KMS GetPublicKey returned no public key for key ${config.keyId}`);
    }

    const address = getAddressFromSpki(new Uint8Array(response.PublicKey));

    return new KmsSigner({
      client: config.client,
      keyId: config.keyId,
      address,
      provider: config.provider,
    });
  }

  async getAddress(): Promise<string> {
    return this.address;
  }

  connect(provider: Provider): KmsSigner {
    return new KmsSigner({
      client: this.client,
      keyId: this.keyId,
      address: this.address,
      provider,
    });
  }

  async signTransaction(tx: ethers.TransactionRequest): Promise<string> {
    const populated = await this.populateTransaction(tx);
    const resolved = await ethers.resolveProperties(populated);
    const { from: _from, ...unsignedTxRequest } = resolved;
    const unsignedTx = ethers.Transaction.from(unsignedTxRequest);
    const signature = await signDigest(
      this.client,
      this.keyId,
      this.address,
      ethers.getBytes(unsignedTx.unsignedHash),
    );
    unsignedTx.signature = signature;
    return unsignedTx.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const digest = ethers.getBytes(ethers.hashMessage(message));
    const signature = await signDigest(this.client, this.keyId, this.address, digest);
    return signature.serialized;
  }

  async signTypedData(
    domain: ethers.TypedDataDomain,
    types: Record<string, Array<ethers.TypedDataField>>,
    value: Record<string, unknown>,
  ): Promise<string> {
    const digest = ethers.getBytes(ethers.TypedDataEncoder.hash(domain, types, value));
    const signature = await signDigest(this.client, this.keyId, this.address, digest);
    return signature.serialized;
  }
}
