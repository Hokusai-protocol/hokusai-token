const { expect } = require("chai");
const hre = require("hardhat");
const { getDeploySigner } = require("../scripts/lib/get-deploy-signer");

describe("getDeploySigner", function () {
  it("returns the default hardhat signer when KMS is not configured", async function () {
    const previousKeyId = process.env.KMS_DEPLOYER_KEY_ID;
    const previousExpectedAddress = process.env.KMS_DEPLOYER_EXPECTED_ADDRESS;
    delete process.env.KMS_DEPLOYER_KEY_ID;
    delete process.env.KMS_DEPLOYER_EXPECTED_ADDRESS;

    try {
      const signer = await getDeploySigner(hre);
      const [defaultSigner] = await hre.ethers.getSigners();

      expect(await signer.getAddress()).to.equal(await defaultSigner.getAddress());
    } finally {
      if (previousKeyId) {
        process.env.KMS_DEPLOYER_KEY_ID = previousKeyId;
      }
      if (previousExpectedAddress) {
        process.env.KMS_DEPLOYER_EXPECTED_ADDRESS = previousExpectedAddress;
      }
    }
  });
});
