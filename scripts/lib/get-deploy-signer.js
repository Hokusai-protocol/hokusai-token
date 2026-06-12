const { KmsSigner, createKmsClient } = require("./kms-signer");

async function getDeploySigner(hre) {
  const { ethers } = hre;
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
  const signer = await KmsSigner.fromKeyId({
    client: createKmsClient(process.env.AWS_REGION || "us-east-1"),
    keyId,
    provider,
    ethers,
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
