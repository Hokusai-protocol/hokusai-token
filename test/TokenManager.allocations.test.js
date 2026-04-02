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
  const INVESTOR_ALLOCATION = parseEther("10000000"); // 10M tokens (max cap, not immediately minted)
  const MAX_SUPPLY = MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION; // 12.5M tokens

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
    it("Should deploy token with correct allocation caps (not immediately minted)", async function () {
      const tx = await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
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

      // Verify max supply is set correctly
      expect(await token.maxSupply()).to.equal(MAX_SUPPLY);

      // Verify model supplier allocation is recorded but NOT minted yet
      expect(await token.modelSupplierAllocation()).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.modelSupplierRecipient()).to.equal(modelSupplier.address);
      expect(await token.modelSupplierDistributed()).to.equal(false);

      // No tokens should be minted yet (investor allocation is a cap)
      expect(await token.totalSupply()).to.equal(0);
      expect(await token.balanceOf(modelSupplier.address)).to.equal(0);

      // Remaining supply should equal max supply
      expect(await token.getRemainingSupply()).to.equal(MAX_SUPPLY);
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
          defaultInitialParams
        )
      ).to.emit(tokenManager, "AllocationDistributed")
        .withArgs(
          MODEL_ID,
          modelSupplier.address,
          MODEL_SUPPLIER_ALLOCATION,
          ZeroAddress, // No immediate investor recipient (minted via AMM)
          INVESTOR_ALLOCATION
        );
    });

    it("Should correctly set max supply as sum of allocations", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Max supply should be sum of allocations
      expect(await token.maxSupply()).to.equal(MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION);
      // But total supply should be 0 (nothing minted yet)
      expect(await token.totalSupply()).to.equal(0);
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
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Verify caps are set correctly
      expect(await token.modelSupplierAllocation()).to.equal(customSupplierAllocation);
      expect(await token.maxSupply()).to.equal(customSupplierAllocation + customInvestorAllocation);
      // No tokens minted yet
      expect(await token.totalSupply()).to.equal(0);
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

  describe("Model Supplier Distribution", function () {
    it("Should distribute model supplier allocation when called by owner", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Initially, model supplier should have no tokens
      expect(await token.balanceOf(modelSupplier.address)).to.equal(0);
      expect(await token.modelSupplierDistributed()).to.equal(false);

      // Distribute model supplier allocation
      await expect(tokenManager.distributeModelSupplierAllocation(MODEL_ID))
        .to.emit(tokenManager, "ModelSupplierAllocationDistributed")
        .withArgs(MODEL_ID, modelSupplier.address, MODEL_SUPPLIER_ALLOCATION);

      // Now model supplier should have tokens
      expect(await token.balanceOf(modelSupplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.modelSupplierDistributed()).to.equal(true);
      expect(await token.totalSupply()).to.equal(MODEL_SUPPLIER_ALLOCATION);
    });

    it("Should not allow distributing model supplier allocation twice", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      // Distribute once
      await tokenManager.distributeModelSupplierAllocation(MODEL_ID);

      // Try to distribute again
      await expect(
        tokenManager.distributeModelSupplierAllocation(MODEL_ID)
      ).to.be.revertedWith("Model supplier allocation already distributed");
    });

    it("Should only allow owner to distribute model supplier allocation", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      // Try to distribute as unauthorized user
      await expect(
        tokenManager.connect(unauthorized).distributeModelSupplierAllocation(MODEL_ID)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Integration with Minting", function () {
    it("Should allow minting tokens up to max supply cap", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Mint some tokens (simulating AMM purchases)
      const mintAmount = parseEther("1000000");
      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, mintAmount);

      expect(await token.balanceOf(unauthorized.address)).to.equal(mintAmount);
      expect(await token.totalSupply()).to.equal(mintAmount);
    });

    it("Should enforce max supply cap when minting", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      // Try to mint more than max supply
      await expect(
        tokenManager.mintTokens(MODEL_ID, unauthorized.address, MAX_SUPPLY + parseEther("1"))
      ).to.be.revertedWith("Minting would exceed max supply");
    });

    it("Should allow minting investor allocation after model supplier distribution", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      // Distribute model supplier allocation
      await tokenManager.distributeModelSupplierAllocation(MODEL_ID);

      // Now mint investor tokens (simulating AMM)
      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, INVESTOR_ALLOCATION);

      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
      expect(await token.balanceOf(modelSupplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.balanceOf(unauthorized.address)).to.equal(INVESTOR_ALLOCATION);
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
          defaultInitialParams,
          { value: parseEther("0.05") } // Insufficient
        )
      ).to.be.revertedWith("Insufficient deployment fee");
    });
  });
});
