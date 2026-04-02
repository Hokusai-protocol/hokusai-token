const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("TokenManager - Allocation Split", function () {
  let tokenManager;
  let modelRegistry;
  let owner;
  let governor;
  let modelSupplier;
  let investor;
  let unauthorized;

  const MODEL_ID = "test-model-1";
  const MODEL_SUPPLIER_ALLOCATION = parseEther("2500000"); // 2.5M tokens
  const INVESTOR_ALLOCATION = parseEther("10000000"); // 10M tokens
  const TOTAL_SUPPLY = MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION; // 12.5M tokens

  // Default initial params for testing
  const defaultInitialParams = {
    tokensPerDeltaOne: 1000,
    infrastructureAccrualBps: 8000, // 80%
    licenseHash: keccak256(toUtf8Bytes("standard-license")),
    licenseURI: "https://hokusai.ai/licenses/standard",
    governor: null // Will be set in beforeEach
  };

  beforeEach(async function () {
    // Get signers
    [owner, governor, modelSupplier, investor, unauthorized] = await ethers.getSigners();

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

  describe("deployTokenWithAllocations", function () {
    it("Should deploy token with correct allocation split", async function () {
      const tx = await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        investor.address,
        defaultInitialParams
      );

      await expect(tx)
        .to.emit(tokenManager, "TokenDeployed")
        .and.to.emit(tokenManager, "ParamsDeployed")
        .and.to.emit(tokenManager, "AllocationDistributed");

      // Verify token was deployed
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      expect(tokenAddress).to.not.equal(ZeroAddress);

      // Get token instance
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Verify allocations
      expect(await token.balanceOf(modelSupplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.balanceOf(investor.address)).to.equal(INVESTOR_ALLOCATION);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY);

      // TokenManager should have zero balance after distribution
      expect(await token.balanceOf(await tokenManager.getAddress())).to.equal(0);
    });

    it("Should emit AllocationDistributed event with correct parameters", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams
        )
      ).to.emit(tokenManager, "AllocationDistributed")
        .withArgs(
          MODEL_ID,
          modelSupplier.address,
          MODEL_SUPPLIER_ALLOCATION,
          investor.address,
          INVESTOR_ALLOCATION
        );
    });

    it("Should correctly set total supply as sum of allocations", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        investor.address,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.totalSupply()).to.equal(MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION);
    });

    it("Should handle same recipient for both allocations", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        modelSupplier.address, // Same as model supplier
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Model supplier should receive both allocations
      expect(await token.balanceOf(modelSupplier.address)).to.equal(TOTAL_SUPPLY);
    });

    it("Should handle custom allocation amounts", async function () {
      const customSupplierAllocation = parseEther("1000");
      const customInvestorAllocation = parseEther("9000");

      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        customSupplierAllocation,
        modelSupplier.address,
        customInvestorAllocation,
        investor.address,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.balanceOf(modelSupplier.address)).to.equal(customSupplierAllocation);
      expect(await token.balanceOf(investor.address)).to.equal(customInvestorAllocation);
      expect(await token.totalSupply()).to.equal(customSupplierAllocation + customInvestorAllocation);
    });
  });

  describe("Input Validation", function () {
    it("Should reject zero model supplier allocation", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          0, // Zero allocation
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should reject zero investor allocation", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          0, // Zero allocation
          investor.address,
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should reject zero address for model supplier recipient", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          ZeroAddress, // Invalid address
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "ZeroAddress");
    });

    it("Should reject zero address for investor recipient", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          ZeroAddress, // Invalid address
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "ZeroAddress");
    });

    it("Should reject empty model ID", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          "", // Empty model ID
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams
        )
      ).to.be.revertedWithCustomError(tokenManager, "EmptyString");
    });

    it("Should reject duplicate model ID", async function () {
      // Deploy first token
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        investor.address,
        defaultInitialParams
      );

      // Try to deploy with same model ID
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID, // Duplicate
          "Another Token",
          "ANT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams
        )
      ).to.be.revertedWith("Token already deployed for this model");
    });
  });

  describe("Backward Compatibility", function () {
    it("Should still support deployToken without allocations", async function () {
      await tokenManager.deployToken(
        "legacy-model",
        "Legacy Token",
        "LGC",
        parseEther("10000")
      );

      const tokenAddress = await tokenManager.getTokenAddress("legacy-model");
      expect(tokenAddress).to.not.equal(ZeroAddress);

      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // All tokens should be minted to TokenManager (controller)
      expect(await token.balanceOf(await tokenManager.getAddress())).to.equal(parseEther("10000"));
    });

    it("Should still support deployTokenWithParams without allocations", async function () {
      await tokenManager.deployTokenWithParams(
        "params-model",
        "Params Token",
        "PRM",
        parseEther("10000"),
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress("params-model");
      expect(tokenAddress).to.not.equal(ZeroAddress);

      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // All tokens should be minted to TokenManager (controller)
      expect(await token.balanceOf(await tokenManager.getAddress())).to.equal(parseEther("10000"));
    });
  });

  describe("Integration with Minting", function () {
    it("Should allow minting additional tokens after deployment", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        investor.address,
        defaultInitialParams
      );

      // Mint additional tokens
      const additionalAmount = parseEther("1000");
      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, additionalAmount);

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      expect(await token.balanceOf(unauthorized.address)).to.equal(additionalAmount);
      expect(await token.totalSupply()).to.equal(TOTAL_SUPPLY + additionalAmount);
    });

    it("Should maintain correct total supply after additional minting", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        investor.address,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      const initialSupply = await token.totalSupply();

      // Mint to multiple addresses
      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, parseEther("100"));
      await tokenManager.mintTokens(MODEL_ID, owner.address, parseEther("200"));

      expect(await token.totalSupply()).to.equal(initialSupply + parseEther("300"));
    });
  });

  describe("Deployment Fee Handling", function () {
    beforeEach(async function () {
      // Set deployment fee
      await tokenManager.setDeploymentFee(parseEther("0.1"));
    });

    it("Should accept deployment fee for token with allocations", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams,
          { value: parseEther("0.1") }
        )
      ).to.not.be.reverted;
    });

    it("Should reject insufficient deployment fee", async function () {
      await expect(
        tokenManager.deployTokenWithAllocations(
          MODEL_ID,
          "Test Model Token",
          "TMT",
          MODEL_SUPPLIER_ALLOCATION,
          modelSupplier.address,
          INVESTOR_ALLOCATION,
          investor.address,
          defaultInitialParams,
          { value: parseEther("0.05") } // Insufficient
        )
      ).to.be.revertedWith("Insufficient deployment fee");
    });
  });
});
