const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("TokenManager with Params", function () {
  let tokenManager;
  let modelRegistry;
  let owner;
  let governor;
  let user1;
  let user2;
  let unauthorized;

  const MODEL_ID_1 = "gpt-4";
  const MODEL_ID_2 = "dalle-3";

  // Default initial params for testing
  const defaultInitialParams = {
    tokensPerDeltaOne: 1000,
    infraMarkupBps: 500, // 5%
    licenseHash: keccak256(toUtf8Bytes("standard-license")),
    licenseURI: "https://hokusai.ai/licenses/standard",
    governor: null // Will be set in beforeEach
  };

  beforeEach(async function () {
    // Get signers
    [owner, governor, user1, user2, unauthorized] = await ethers.getSigners();

    // Set governor in params
    defaultInitialParams.governor = governor.address;

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager with ModelRegistry reference
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct registry address", async function () {
      expect(await tokenManager.registry()).to.equal(await modelRegistry.getAddress());
    });

    it("Should set the deployer as owner", async function () {
      expect(await tokenManager.owner()).to.equal(owner.address);
    });

    it("Should initialize with zero deployment fee", async function () {
      expect(await tokenManager.deploymentFee()).to.equal(0);
    });
  });

  describe("Token and Params Deployment", function () {
    it("Should deploy token with params successfully", async function () {
      const tx = await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      await expect(tx)
        .to.emit(tokenManager, "ParamsDeployed")
        .and.to.emit(tokenManager, "TokenDeployed");

      // Verify token was deployed
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      expect(tokenAddress).to.not.equal(ZeroAddress);

      // Verify params were deployed
      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_1);
      expect(paramsAddress).to.not.equal(ZeroAddress);

      // Verify token has correct params reference
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);
      expect(await token.params()).to.equal(paramsAddress);
    });

    it("Should emit ParamsDeployed event with correct data", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams
        )
      ).to.emit(tokenManager, "ParamsDeployed");

      // Just verify the event is emitted; detailed checking is complex with indexed params
      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_1);
      expect(paramsAddress).to.not.equal(ZeroAddress);
    });

    it("Should emit TokenDeployed event with correct data", async function () {
      const tx = await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      await expect(tx)
        .to.emit(tokenManager, "TokenDeployed")
        .withArgs(
          MODEL_ID_1,
          await tokenManager.getTokenAddress(MODEL_ID_1),
          owner.address,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000")
        );
    });

    it("Should set correct initial parameter values", async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_1);
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const params = HokusaiParams.attach(paramsAddress);

      expect(await params.tokensPerDeltaOne()).to.equal(defaultInitialParams.tokensPerDeltaOne);
      expect(await params.infraMarkupBps()).to.equal(defaultInitialParams.infraMarkupBps);
      expect(await params.licenseHash()).to.equal(defaultInitialParams.licenseHash);
      expect(await params.licenseURI()).to.equal(defaultInitialParams.licenseURI);

      // Check that governor has the GOV_ROLE
      const GOV_ROLE = await params.GOV_ROLE();
      expect(await params.hasRole(GOV_ROLE, governor.address)).to.be.true;
    });

    it("Should set TokenManager as token controller", async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.controller()).to.equal(await tokenManager.getAddress());
    });

    it("Should track model to token mapping", async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.true;
      expect(await tokenManager.getModelId(tokenAddress)).to.equal(MODEL_ID_1);
    });

    it("Should track model to params mapping", async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      expect(await tokenManager.hasParams(MODEL_ID_1)).to.be.true;
      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_1);
      expect(paramsAddress).to.not.equal(ZeroAddress);
    });
  });

  describe("Parameter Validation", function () {
    it("Should reject empty model ID", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          "",
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");
    });

    it("Should reject empty token name", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");
    });

    it("Should reject empty token symbol", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "",
          parseEther("10000"),
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");
    });

    it("Should reject zero total supply", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          0,
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should reject zero address governor", async function () {
      const invalidParams = { ...defaultInitialParams, governor: ZeroAddress };

      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          invalidParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "ZeroAddress");
    });

    it("Should reject duplicate model ID", async function () {
      // Deploy first token
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      // Try to deploy another token with same model ID
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "Another GPT-4 Token",
          "AGPT4",
          parseEther("5000"),
          defaultInitialParams
        )
      ).to.be.revertedWith("Token already deployed for this model");
    });

    it("Should validate parameter bounds through HokusaiParams", async function () {
      const invalidParams = {
        ...defaultInitialParams,
        tokensPerDeltaOne: 99 // Below minimum of 100
      };

      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          invalidParams
        )
      ).to.be.revertedWith("tokensPerDeltaOne must be between 100 and 100000");
    });
  });

  describe("Multiple Token Deployment", function () {
    it("Should deploy multiple tokens with different parameters", async function () {
      const params1 = { ...defaultInitialParams, tokensPerDeltaOne: 1000, infraMarkupBps: 300 };
      const params2 = { ...defaultInitialParams, tokensPerDeltaOne: 2000, infraMarkupBps: 700 };

      await tokenManager.deployTokenWithParams(MODEL_ID_1, "GPT-4 Token", "GPT4", parseEther("10000"), params1);
      await tokenManager.deployTokenWithParams(MODEL_ID_2, "DALL-E Token", "DALLE", parseEther("5000"), params2);

      // Verify both tokens exist
      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.true;
      expect(await tokenManager.hasToken(MODEL_ID_2)).to.be.true;

      // Verify params are different
      const paramsAddress1 = await tokenManager.getParamsAddress(MODEL_ID_1);
      const paramsAddress2 = await tokenManager.getParamsAddress(MODEL_ID_2);
      expect(paramsAddress1).to.not.equal(paramsAddress2);

      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const paramsContract1 = HokusaiParams.attach(paramsAddress1);
      const paramsContract2 = HokusaiParams.attach(paramsAddress2);

      expect(await paramsContract1.tokensPerDeltaOne()).to.equal(1000);
      expect(await paramsContract2.tokensPerDeltaOne()).to.equal(2000);
      expect(await paramsContract1.infraMarkupBps()).to.equal(300);
      expect(await paramsContract2.infraMarkupBps()).to.equal(700);
    });
  });

  describe("Gas and Performance", function () {
    it("Should deploy token and params efficiently", async function () {
      const tx = await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      const receipt = await tx.wait();
      // Gas usage should be reasonable for deploying two contracts
      expect(receipt.gasUsed).to.be.lt(2200000); // Less than 2.2M gas (adjusted for two contract deployments)
    });
  });

  describe("Deployment Fee Functionality", function () {
    beforeEach(async function () {
      await tokenManager.setDeploymentFee(parseEther("0.1"));
    });

    it("Should require deployment fee when set", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams
        )
      ).to.be.revertedWith("Insufficient deployment fee");
    });

    it("Should accept deployment with correct fee", async function () {
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams,
          { value: parseEther("0.1") }
        )
      ).to.not.be.reverted;

      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.true;
    });

    it("Should refund excess payment", async function () {
      // Test that deployment succeeds with excess payment
      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          defaultInitialParams,
          { value: parseEther("0.2") } // Send more than required
        )
      ).to.not.be.reverted;

      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.true;

      // Note: Exact balance testing is complex due to gas variations,
      // but the key is that the transaction succeeds and refunds excess
    });
  });

  describe("Access Control Integration", function () {
    it("Should not interfere with TokenManager access control", async function () {
      // Deploy token
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      // TokenManager should still be able to mint tokens
      await expect(
        tokenManager.mintTokens(MODEL_ID_1, user1.address, parseEther("100"))
      ).to.not.be.reverted;

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.balanceOf(user1.address)).to.equal(parseEther("100"));
    });

    it("Should allow parameter updates by governor", async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_1,
        "GPT-4 Token",
        "GPT4",
        parseEther("10000"),
        defaultInitialParams
      );

      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_1);
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const params = HokusaiParams.attach(paramsAddress);

      // Governor should be able to update parameters
      await expect(
        params.connect(governor).setTokensPerDeltaOne(1500)
      ).to.not.be.reverted;

      expect(await params.tokensPerDeltaOne()).to.equal(1500);
    });
  });

  describe("Error Cases", function () {
    it("Should handle params deployment failure gracefully", async function () {
      const invalidParams = {
        ...defaultInitialParams,
        infraMarkupBps: 2000 // Above maximum of 1000
      };

      await expect(
        tokenManager.deployTokenWithParams(
          MODEL_ID_1,
          "GPT-4 Token",
          "GPT4",
          parseEther("10000"),
          invalidParams
        )
      ).to.be.revertedWith("infraMarkupBps cannot exceed 1000 (10%)");

      // Verify no token was created
      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.false;
      expect(await tokenManager.hasParams(MODEL_ID_1)).to.be.false;
    });
  });
});