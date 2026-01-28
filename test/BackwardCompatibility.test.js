const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, keccak256, toUtf8Bytes } = require("ethers");

describe("Backward Compatibility", function () {
  let tokenManager;
  let modelRegistry;
  let owner;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
  });

  describe("TokenManager.deployToken (old signature)", function () {
    it("Should deploy token with default parameters using old function signature", async function () {
      // Use the old deployToken function signature
      const tx = await tokenManager.deployToken(
        "test-model-1",
        "Test Model Token",
        "TMT",
        parseEther("1000")
      );

      await expect(tx)
        .to.emit(tokenManager, "ParamsDeployed")
        .and.to.emit(tokenManager, "TokenDeployed");

      // Verify token was deployed
      const tokenAddress = await tokenManager.getTokenAddress("test-model-1");
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

      // Verify params were deployed with defaults
      const paramsAddress = await tokenManager.getParamsAddress("test-model-1");
      expect(paramsAddress).to.not.equal(ethers.ZeroAddress);

      // Check default parameter values
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const params = HokusaiParams.attach(paramsAddress);

      expect(await params.tokensPerDeltaOne()).to.equal(1000); // Default
      expect(await params.infraMarkupBps()).to.equal(500); // Default 5%
      expect(await params.licenseHash()).to.equal(keccak256(toUtf8Bytes("default-license")));
      expect(await params.licenseURI()).to.equal("https://hokusai.ai/licenses/default");

      // Governor should be the owner of TokenManager
      const GOV_ROLE = await params.GOV_ROLE();
      expect(await params.hasRole(GOV_ROLE, owner.address)).to.be.true;

      // Verify token has params reference
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);
      expect(await token.params()).to.equal(paramsAddress);
    });

    it("Should handle multiple deployments with old signature", async function () {
      // Deploy multiple tokens using old signature
      await tokenManager.deployToken("model-1", "Model 1", "M1", parseEther("1000"));
      await tokenManager.deployToken("model-2", "Model 2", "M2", parseEther("2000"));
      await tokenManager.deployToken("model-3", "Model 3", "M3", parseEther("3000"));

      // All should be deployed successfully
      expect(await tokenManager.hasToken("model-1")).to.be.true;
      expect(await tokenManager.hasToken("model-2")).to.be.true;
      expect(await tokenManager.hasToken("model-3")).to.be.true;

      // All should have params
      expect(await tokenManager.hasParams("model-1")).to.be.true;
      expect(await tokenManager.hasParams("model-2")).to.be.true;
      expect(await tokenManager.hasParams("model-3")).to.be.true;

      // All params should have default values
      for (const modelId of ["model-1", "model-2", "model-3"]) {
        const paramsAddress = await tokenManager.getParamsAddress(modelId);
        const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
        const params = HokusaiParams.attach(paramsAddress);

        expect(await params.tokensPerDeltaOne()).to.equal(1000);
        expect(await params.infraMarkupBps()).to.equal(500);
      }
    });

    it("Should maintain same behavior as original function", async function () {
      // Test all original validations still work (now using custom errors)
      await expect(
        tokenManager.deployToken("", "Token", "TOK", parseEther("1000"))
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");

      await expect(
        tokenManager.deployToken("model-1", "", "TOK", parseEther("1000"))
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");

      await expect(
        tokenManager.deployToken("model-1", "Token", "", parseEther("1000"))
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");

      await expect(
        tokenManager.deployToken("model-1", "Token", "TOK", 0)
      ).to.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should prevent duplicate model deployments", async function () {
      // Deploy first token
      await tokenManager.deployToken("duplicate-test", "Test", "TEST", parseEther("1000"));

      // Attempt to deploy with same model ID should fail
      await expect(
        tokenManager.deployToken("duplicate-test", "Test 2", "TEST2", parseEther("2000"))
      ).to.be.revertedWith("Token already deployed for this model");
    });
  });

  describe("Mixed usage of old and new functions", function () {
    it("Should allow using both old and new deployment functions", async function () {
      // Deploy using old function
      await tokenManager.deployToken("old-model", "Old Model", "OLD", parseEther("1000"));

      // Deploy using new function
      const customParams = {
        tokensPerDeltaOne: 2000,
        infraMarkupBps: 300,
        licenseHash: keccak256(toUtf8Bytes("custom-license")),
        licenseURI: "https://example.com/license",
        governor: owner.address
      };

      await tokenManager.deployTokenWithParams(
        "new-model",
        "New Model",
        "NEW",
        parseEther("2000"),
        customParams
      );

      // Both should exist and work
      expect(await tokenManager.hasToken("old-model")).to.be.true;
      expect(await tokenManager.hasToken("new-model")).to.be.true;

      // Verify different parameter values
      const oldParamsAddr = await tokenManager.getParamsAddress("old-model");
      const newParamsAddr = await tokenManager.getParamsAddress("new-model");

      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const oldParams = HokusaiParams.attach(oldParamsAddr);
      const newParams = HokusaiParams.attach(newParamsAddr);

      expect(await oldParams.tokensPerDeltaOne()).to.equal(1000); // Default
      expect(await newParams.tokensPerDeltaOne()).to.equal(2000); // Custom

      expect(await oldParams.infraMarkupBps()).to.equal(500); // Default
      expect(await newParams.infraMarkupBps()).to.equal(300); // Custom
    });
  });
});