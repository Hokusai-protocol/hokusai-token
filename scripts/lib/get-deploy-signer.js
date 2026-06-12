const { ethers } = require("ethers");
const { KMSClient, KmsSigner } = require("./kms-signer");

async function getDeploySigner(hre) {
  if (process.env.KMS_DEPLOYER_KEY_ID) {
    if (!process.env.KMS_DEPLOYER_EXPECTED_ADDRESS) {
      throw new Error("KMS_DEPLOYER_EXPECTED_ADDRESS is required when KMS_DEPLOYER_KEY_ID is set");
    }

    const rpcUrl =
      process.env.RPC_URL ||
      process.env.MAINNET_RPC_URL ||
      process.env.SEPOLIA_RPC_URL ||
      hre.network.config.url;
    if (!rpcUrl) {
      throw new Error("RPC_URL is required when KMS_DEPLOYER_KEY_ID is set");
    }

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    return KmsSigner.create({
      client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
      keyId: process.env.KMS_DEPLOYER_KEY_ID,
      expectedAddress: process.env.KMS_DEPLOYER_EXPECTED_ADDRESS,
      provider,
    });
  }

  const [deployer] = await hre.ethers.getSigners();
  return deployer;
}

module.exports = { getDeploySigner };
