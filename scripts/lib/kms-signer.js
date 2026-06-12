const {
  GetPublicKeyCommand,
  KMSClient,
  SignCommand,
  SigningAlgorithmSpec,
} = require("@aws-sdk/client-kms");
const { ethers } = require("ethers");
const { secp256k1 } = require("@noble/curves/secp256k1");

const SECP256K1_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_N = SECP256K1_N / 2n;

class KmsSignerAddressMismatch extends Error {
  constructor(expectedAddress, derivedAddress) {
    super(
      `KMS signer address mismatch: expected ${expectedAddress}, derived ${derivedAddress}. ` +
        "KMS aliases are mutable; check the alias target and expected-address pin."
    );
    this.name = "KmsSignerAddressMismatch";
    this.expectedAddress = expectedAddress;
    this.derivedAddress = derivedAddress;
  }
}

class KmsSigner extends ethers.AbstractSigner {
  constructor(options) {
    super(options.provider ?? null);
    this.client = options.client;
    this.keyId = options.keyId;
    this.address = ethers.getAddress(options.address);
    this.publicKey = ethers.hexlify(options.publicKey);
  }

  static async create(options) {
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

  connect(provider) {
    return new KmsSigner({
      client: this.client,
      keyId: this.keyId,
      expectedAddress: this.address,
      address: this.address,
      publicKey: this.publicKey,
      provider,
    });
  }

  async getAddress() {
    return this.address;
  }

  async signMessage(message) {
    return (await this.signDigest(ethers.hashMessage(message))).serialized;
  }

  async signTypedData(domain, types, value) {
    const digest = ethers.TypedDataEncoder.hash(domain, types, value);
    return (await this.signDigest(digest)).serialized;
  }

  async signTransaction(transaction) {
    const populated = ethers.Transaction.from({
      ...transaction,
      from: await this.getAddress(),
    });
    populated.signature = await this.signDigest(populated.unsignedHash);
    return populated.serialized;
  }

  async signDigest(digestHex) {
    const digest = ethers.getBytes(digestHex);
    if (digest.length !== 32) {
      throw new Error(`KMS signer requires a 32-byte digest, got ${digest.length} bytes`);
    }

    const response = await this.client.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digest,
        MessageType: "DIGEST",
        SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
      })
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

function parseSpkiPublicKey(spkiDer) {
  const reader = new DerReader(spkiDer);
  const sequence = reader.readConstructed(0x30);
  sequence.readConstructed(0x30);
  const publicKeyBytes = sequence.readPrimitive(0x03);
  if (publicKeyBytes.length < 2 || publicKeyBytes[0] !== 0) {
    throw new Error("Unsupported KMS SPKI BIT STRING encoding");
  }

  const publicKey = publicKeyBytes.slice(1);
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new Error("KMS public key is not an uncompressed secp256k1 point");
  }
  if (!sequence.done() || !reader.done()) {
    throw new Error("Unexpected trailing data in KMS SPKI public key");
  }
  return ethers.hexlify(publicKey);
}

function publicKeyToAddress(publicKey) {
  return ethers.computeAddress(publicKey);
}

function toBytes32(value) {
  return ethers.zeroPadValue(ethers.toBeHex(value), 32);
}

class DerReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.offset = 0;
  }

  readConstructed(expectedTag) {
    return new DerReader(this.readTlv(expectedTag));
  }

  readPrimitive(expectedTag) {
    return this.readTlv(expectedTag);
  }

  done() {
    return this.offset === this.bytes.length;
  }

  readTlv(expectedTag) {
    const tag = this.readByte();
    if (tag !== expectedTag) {
      throw new Error(`Unexpected DER tag 0x${tag.toString(16)}, expected 0x${expectedTag.toString(16)}`);
    }

    const length = this.readLength();
    if (this.offset + length > this.bytes.length) {
      throw new Error("Truncated DER value");
    }

    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  readByte() {
    if (this.offset >= this.bytes.length) {
      throw new Error("Truncated DER input");
    }
    return this.bytes[this.offset++];
  }

  readLength() {
    const first = this.readByte();
    if (first < 0x80) {
      return first;
    }

    const lengthBytes = first & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 4) {
      throw new Error("Unsupported DER length encoding");
    }

    let length = 0;
    for (let i = 0; i < lengthBytes; i++) {
      length = (length << 8) | this.readByte();
    }
    return length;
  }
}

module.exports = {
  KmsSigner,
  KmsSignerAddressMismatch,
  KMSClient,
};
