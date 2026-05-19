const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");
const { buildDisabledVestingConfig, deployTestToken } = require("./helpers/tokenDeployment");

describe("TokenManager - Allocation Split", function () {
  let tokenManager;
  let modelRegistry;
  let owner;
  let governor;
  let modelSupplier;
  let investor;
  let unauthorized;

  const MODEL_ID = "1101";
  const MODEL_SUPPLIER_ALLOCATION = parseEther("2500000"); // 2.5M tokens
  const INVESTOR_ALLOCATION = parseEther("10000000"); // 10M tokens (max cap, not immediately minted)
  const MAX_SUPPLY = MODEL_SUPPLIER_ALLOCATION + INVESTOR_ALLOCATION; // 12.5M tokens

  // Default initial params for testing
  const defaultInitialParams = {
    tokensPerDeltaOne: 1000,
    infrastructureAccrualBps: 8000, // 80%
    initialOraclePricePerThousandUsd: 0,
    licenseHash: keccak256(toUtf8Bytes("standard-license")),
    licenseURI: "https://hokusai.ai/licenses/standard",
    governor: null, // Will be set in beforeEach
    vestingConfig: buildDisabledVestingConfig()
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
      expect(await token.investorAllocation()).to.equal(INVESTOR_ALLOCATION);
      expect(await token.investorMinted()).to.equal(0);
      expect(await token.rewardMinted()).to.equal(0);

      // Verify model supplier allocation is recorded but NOT minted yet
      expect(await token.modelSupplierAllocation()).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.modelSupplierRecipient()).to.equal(modelSupplier.address);
      expect(await token.modelSupplierDistributed()).to.equal(false);

      // No tokens should be minted yet (investor allocation is a cap)
      expect(await token.totalSupply()).to.equal(0);
      expect(await token.balanceOf(modelSupplier.address)).to.equal(0);

      // Remaining investor allocation should match investor cap
      expect(await token.getRemainingSupply()).to.equal(INVESTOR_ALLOCATION);
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
      await deployTestToken(
        tokenManager,
        "legacy-model",
        "Legacy Token",
        "LGC",
        parseEther("10000"),
        owner.address
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
    it("Should allow minting tokens up to the investor allocation cap", async function () {
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
      expect(await token.investorMinted()).to.equal(mintAmount);
    });

    it("Should enforce the investor allocation cap when minting", async function () {
      await tokenManager.deployTokenWithAllocations(
        MODEL_ID,
        "Test Model Token",
        "TMT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        defaultInitialParams
      );

      // Try to mint more than the investor allocation
      await expect(
        tokenManager.mintTokens(MODEL_ID, unauthorized.address, INVESTOR_ALLOCATION + parseEther("1"))
      ).to.be.revertedWith("Exceeds investor allocation");
    });

    it("Should allow reward minting after the investor allocation is exhausted", async function () {
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

      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, INVESTOR_ALLOCATION);
      const rewardAmount = parseEther("25000");
      await tokenManager.mintReward(MODEL_ID, investor.address, rewardAmount);

      expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
      expect(await token.rewardMinted()).to.equal(rewardAmount);
      expect(await token.balanceOf(unauthorized.address)).to.equal(INVESTOR_ALLOCATION);
      expect(await token.balanceOf(investor.address)).to.equal(rewardAmount);
      expect(await token.getRemainingSupply()).to.equal(0);
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

      await tokenManager.distributeModelSupplierAllocation(MODEL_ID);
      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, INVESTOR_ALLOCATION);

      expect(await token.totalSupply()).to.equal(MAX_SUPPLY);
      expect(await token.balanceOf(modelSupplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
      expect(await token.balanceOf(unauthorized.address)).to.equal(INVESTOR_ALLOCATION);
      expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
    });

    it("Should let investor burns free headroom without affecting non-investor burns", async function () {
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

      await tokenManager.mintTokens(MODEL_ID, unauthorized.address, parseEther("100"));
      await tokenManager.burnInvestorTokens(MODEL_ID, unauthorized.address, parseEther("40"));

      expect(await token.investorMinted()).to.equal(parseEther("60"));
      expect(await token.getRemainingInvestorAllocation()).to.equal(INVESTOR_ALLOCATION - parseEther("60"));

      await tokenManager.distributeModelSupplierAllocation(MODEL_ID);
      await tokenManager.burnTokens(MODEL_ID, modelSupplier.address, parseEther("10"));

      expect(await token.investorMinted()).to.equal(parseEther("60"));
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
