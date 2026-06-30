const { KMSClient } = require("@aws-sdk/client-kms");

function loadKmsSigner() {
  try {
    return require("../../services/contract-deployer/dist/blockchain/kms-signer").KmsSigner;
  } catch (error) {
    throw new Error(
      "KMS deploy signer requires services/contract-deployer to be built first: run npm run build in services/contract-deployer"
    );
  }
}

async function getDeploySigner(hre) {
  const { ethers } = hre;

  // The in-process hardhat network (unit tests) must always use the in-memory signer, even if
  // KMS_DEPLOYER_KEY_ID is present in a loaded .env — a KMS signer targets a real RPC, not the
  // ephemeral test chain, so using it here would send calls to the wrong network.
  if (hre.network.name === "hardhat") {
    const [signer] = await ethers.getSigners();
    if (!signer) {
      throw new Error("No local deploy signer available");
    }
    return signer;
  }

  const keyId = process.env.KMS_DEPLOYER_KEY_ID;
  if (!keyId) {
    const [signer] = await ethers.getSigners();
    if (!signer) {
      throw new Error("No local deploy signer available");
    }
    return signer;
  }

  const expectedAddress = process.env.KMS_DEPLOYER_EXPECTED_ADDRESS;
  if (!expectedAddress) {
    throw new Error("KMS_DEPLOYER_EXPECTED_ADDRESS is required when KMS_DEPLOYER_KEY_ID is set");
  }

  const rpcUrl =
    process.env.RPC_URL ||
    process.env[hre.network.name === "mainnet" ? "MAINNET_RPC_URL" : "SEPOLIA_RPC_URL"];
  if (!rpcUrl) {
    throw new Error("RPC_URL is required when KMS_DEPLOYER_KEY_ID is set");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const KmsSigner = loadKmsSigner();
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId,
    provider,
  });
  const derivedAddress = ethers.getAddress(await signer.getAddress());
  const expected = ethers.getAddress(expectedAddress);
  if (derivedAddress !== expected) {
    throw new Error(
      `KMS deployer address pin mismatch: derived=${derivedAddress}, expected=${expected}, alias=${keyId}`,
    );
  }

  return signer;
}

module.exports = {
  getDeploySigner,
};
