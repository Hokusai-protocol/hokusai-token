const { GetPublicKeyCommand, KMSClient, SignCommand } = require("@aws-sdk/client-kms");
const { createPublicKey } = require("crypto");

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

function normalizeScalar(value) {
  return value > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - value : value;
}

function readDerLength(bytes, offset) {
  const first = bytes[offset];
  if (first === undefined) {
    throw new Error("Invalid DER signature: missing length");
  }
  if ((first & 0x80) === 0) {
    return { length: first, nextOffset: offset + 1 };
  }

  const octets = first & 0x7f;
  if (octets === 0 || octets > 4) {
    throw new Error("Invalid DER signature: unsupported length encoding");
  }

  let length = 0;
  for (let i = 0; i < octets; i += 1) {
    const byte = bytes[offset + 1 + i];
    if (byte === undefined) {
      throw new Error("Invalid DER signature: truncated length");
    }
    length = (length << 8) | byte;
  }

  return { length, nextOffset: offset + 1 + octets };
}

function decodeDerSignature(signature, ethers) {
  if (signature[0] !== 0x30) {
    throw new Error("Invalid DER signature: expected SEQUENCE");
  }

  const { length: sequenceLength, nextOffset: sequenceOffset } = readDerLength(signature, 1);
  if (sequenceOffset + sequenceLength !== signature.length) {
    throw new Error("Invalid DER signature: trailing bytes");
  }

  if (signature[sequenceOffset] !== 0x02) {
    throw new Error("Invalid DER signature: expected INTEGER for r");
  }
  const { length: rLength, nextOffset: rOffset } = readDerLength(signature, sequenceOffset + 1);
  const rBytes = signature.slice(rOffset, rOffset + rLength);

  const sTagOffset = rOffset + rLength;
  if (signature[sTagOffset] !== 0x02) {
    throw new Error("Invalid DER signature: expected INTEGER for s");
  }
  const { length: sLength, nextOffset: sOffset } = readDerLength(signature, sTagOffset + 1);
  const sBytes = signature.slice(sOffset, sOffset + sLength);

  return {
    r: BigInt(ethers.hexlify(rBytes)),
    s: BigInt(ethers.hexlify(sBytes)),
  };
}

function getAddressFromSpki(publicKeyDer, ethers) {
  const keyObject = createPublicKey({
    key: Buffer.from(publicKeyDer),
    format: "der",
    type: "spki",
  });
  const jwk = keyObject.export({ format: "jwk" });
  if (!jwk.x || !jwk.y) {
    throw new Error("KMS public key did not export secp256k1 coordinates");
  }

  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  return ethers.computeAddress(ethers.concat(["0x04", x, y]));
}

async function signDigest(client, keyId, address, digest, ethers) {
  const response = await client.send(
    new SignCommand({
      KeyId: keyId,
      Message: Buffer.from(digest),
      MessageType: "DIGEST",
      SigningAlgorithm: "ECDSA_SHA_256",
    }),
  );

  if (!response.Signature) {
    throw new Error(`KMS Sign returned no signature for key ${keyId}`);
  }

  const { r, s } = decodeDerSignature(new Uint8Array(response.Signature), ethers);
  const normalizedS = normalizeScalar(s);
  const normalizedAddress = ethers.getAddress(address);

  for (const yParity of [0, 1]) {
    const signature = ethers.Signature.from({
      r: ethers.zeroPadValue(ethers.toBeHex(r), 32),
      s: ethers.zeroPadValue(ethers.toBeHex(normalizedS), 32),
      yParity,
    });
    if (ethers.recoverAddress(digest, signature) === normalizedAddress) {
      return signature;
    }
  }

  throw new Error(`Failed to recover signer address for KMS key ${keyId}`);
}

class KmsSigner {
  constructor({ client, keyId, address, provider, ethers }) {
    this.client = client;
    this.keyId = keyId;
    this.address = ethers.getAddress(address);
    this.provider = provider || null;
    this.ethers = ethers;
  }

  static async fromKeyId({ client, keyId, provider, ethers }) {
    const response = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
    if (!response.PublicKey) {
      throw new Error(`KMS GetPublicKey returned no public key for key ${keyId}`);
    }

    const address = getAddressFromSpki(new Uint8Array(response.PublicKey), ethers);
    return new KmsSigner({ client, keyId, address, provider, ethers });
  }

  connect(provider) {
    return new KmsSigner({
      client: this.client,
      keyId: this.keyId,
      address: this.address,
      provider,
      ethers: this.ethers,
    });
  }

  async getAddress() {
    return this.address;
  }

  async signTransaction(tx) {
    const populated = await this.populateTransaction(tx);
    const resolved = await this.ethers.resolveProperties(populated);
    const unsignedTx = this.ethers.Transaction.from(resolved);
    const signature = await signDigest(
      this.client,
      this.keyId,
      this.address,
      this.ethers.getBytes(unsignedTx.unsignedHash),
      this.ethers,
    );
    unsignedTx.signature = signature;
    return unsignedTx.serialized;
  }

  async signMessage(message) {
    const signature = await signDigest(
      this.client,
      this.keyId,
      this.address,
      this.ethers.getBytes(this.ethers.hashMessage(message)),
      this.ethers,
    );
    return signature.serialized;
  }

  async signTypedData(domain, types, value) {
    const signature = await signDigest(
      this.client,
      this.keyId,
      this.address,
      this.ethers.getBytes(this.ethers.TypedDataEncoder.hash(domain, types, value)),
      this.ethers,
    );
    return signature.serialized;
  }

  async populateTransaction(tx) {
    if (!this.provider) {
      throw new Error("missing provider");
    }
    const prepared = await this.ethers.copyRequest(tx);
    if (prepared.from == null) {
      prepared.from = await this.getAddress();
    }
    return this.ethers.AbstractSigner.prototype.populateTransaction.call(this, prepared);
  }
}

function createKmsClient(region) {
  return new KMSClient({ region });
}

module.exports = {
  KmsSigner,
  createKmsClient,
};
