const { expect } = require("chai");
const { generateKeyPairSync } = require("crypto");
const { ethers } = require("hardhat");
require("ts-node").register({
  transpileOnly: true,
  compilerOptions: {
    module: "commonjs",
    moduleResolution: "node",
  },
});

const { KmsSigner } = require("../../services/contract-deployer/src/blockchain/kms-signer");

const SECP256K1_ORDER = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

function encodeDerLength(length) {
  if (length < 0x80) {
    return [length];
  }

  const bytes = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }

  return [0x80 | bytes.length, ...bytes];
}

function encodeDerInteger(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  const bytes = Array.from(Buffer.from(hex, "hex"));
  if (bytes[0] !== undefined && bytes[0] >= 0x80) {
    bytes.unshift(0x00);
  }

  return [0x02, ...encodeDerLength(bytes.length), ...bytes];
}

function encodeDerSignature(r, s) {
  const encodedR = encodeDerInteger(r);
  const encodedS = encodeDerInteger(s);
  const sequence = [...encodedR, ...encodedS];
  return Uint8Array.from([0x30, ...encodeDerLength(sequence.length), ...sequence]);
}

function makeMockKmsClient(privateKey, publicKeyDer) {
  return {
    async send(command) {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return { PublicKey: publicKeyDer };
      }

      if (command.constructor.name === "SignCommand") {
        const digest = Buffer.from(command.input.Message);
        const signature = new ethers.SigningKey(privateKey).sign(digest);
        const s = BigInt(signature.s);
        return {
          Signature: encodeDerSignature(
            BigInt(signature.r),
            s > SECP256K1_HALF_ORDER ? SECP256K1_ORDER - s : s
          ),
        };
      }

      throw new Error("Unexpected KMS command");
    },
  };
}

describe("KmsSigner sendTransaction e2e", function () {
  beforeEach(async function () {
    await ethers.provider.send("hardhat_reset", []);
  });

  it("broadcasts with the populated chainId, nonce, and recipient intact", async function () {
    const keyPair = generateKeyPairSync("ec", { namedCurve: "secp256k1" });
    const jwk = keyPair.privateKey.export({ format: "jwk" });
    const privateKey = `0x${Buffer.from(jwk.d, "base64url").toString("hex")}`;
    const wallet = new ethers.Wallet(privateKey);
    const publicKeyDer = keyPair.publicKey.export({ format: "der", type: "spki" });
    const [funder, recipient] = await ethers.getSigners();

    await funder.sendTransaction({
      to: wallet.address,
      value: ethers.parseEther("1"),
    });

    const signer = await KmsSigner.fromKeyId({
      client: makeMockKmsClient(privateKey, publicKeyDer),
      keyId: "alias/test/deployer",
      provider: ethers.provider,
    });
    const expectedNonce = await ethers.provider.getTransactionCount(wallet.address);

    const response = await signer.sendTransaction({
      to: recipient.address,
      value: 1234n,
    });
    await response.wait();

    const broadcast = await ethers.provider.getTransaction(response.hash);
    expect(broadcast.from).to.equal(wallet.address);
    expect(broadcast.chainId).to.equal(31337n);
    expect(broadcast.nonce).to.equal(expectedNonce);
    expect(broadcast.to).to.equal(recipient.address);
    expect(broadcast.value).to.equal(1234n);
  });
});
