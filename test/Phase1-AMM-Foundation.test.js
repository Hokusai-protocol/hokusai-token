const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress, MaxUint256 } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");

describe("Phase 1: AMM Foundation - ModelRegistry & TokenManager Extensions", function () {
  let modelRegistry;
  let tokenManager;
  let mockUSDC;
  let owner, amm, user, nonOwner;

  beforeEach(async function () {
    [owner, amm, user, nonOwner] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();
  });

  describe("ModelRegistry - String Model Registration", function () {
    const modelId = "model-v1-abc123";
    const performanceMetric = "accuracy";
    let tokenAddress;

    beforeEach(async function () {
      // Deploy a token to use in tests
      await deployTestToken(tokenManager, modelId, "Test Token", "TEST", parseEther("1000000"), owner.address);
      tokenAddress = await tokenManager.getTokenAddress(modelId);
    });

    it("Should register a string model", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      expect(await modelRegistry.isStringRegistered(modelId)).to.be.true;
      expect(await modelRegistry.getStringToken(modelId)).to.equal(tokenAddress);
      expect(await modelRegistry.getStringModelId(tokenAddress)).to.equal(modelId);
    });

    it("Should emit StringModelRegistered event", async function () {
      await expect(modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric))
        .to.emit(modelRegistry, "StringModelRegistered")
        .withArgs(modelId, tokenAddress, performanceMetric);
    });

    it("Should prevent duplicate string model registration", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(
        modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric)
      ).to.be.revertedWith("Model already registered");
    });

    it("Should prevent registering same token twice", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(
        modelRegistry.registerStringModel("different-model", tokenAddress, performanceMetric)
      ).to.be.revertedWith("Token already registered");
    });

    it("Should revert with empty model ID", async function () {
      await expect(
        modelRegistry.registerStringModel("", tokenAddress, performanceMetric)
      ).to.be.revertedWith("Model ID cannot be empty");
    });

    it("Should revert with zero token address", async function () {
      await expect(
        modelRegistry.registerStringModel(modelId, ZeroAddress, performanceMetric)
      ).to.be.revertedWith("Token address cannot be zero");
    });

    it("Should revert with empty performance metric", async function () {
      await expect(
        modelRegistry.registerStringModel(modelId, tokenAddress, "")
      ).to.be.revertedWith("Performance metric cannot be empty");
    });

    it("Should only allow owner to register", async function () {
      await expect(
        modelRegistry.connect(nonOwner).registerStringModel(modelId, tokenAddress, performanceMetric)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should reject models missing from TokenManager when validation is enabled", async function () {
      await expect(
        modelRegistry.registerStringModel("untracked-model", tokenAddress, performanceMetric)
      ).to.be.revertedWith("Token not registered in TokenManager");
    });

    it("Should reject token address mismatches against TokenManager", async function () {
      await deployTestToken(tokenManager, "other-model", "Other Token", "OTHR", parseEther("1000000"), owner.address);

      await expect(
        modelRegistry.registerStringModel("other-model", tokenAddress, performanceMetric)
      ).to.be.revertedWith("Token address mismatch with TokenManager");
    });

    it("Should update a string model token and clear old reverse mapping", async function () {
      const newModelId = "model-v1-migrated";
      await deployTestToken(tokenManager, newModelId, "Migrated Token", "MIG", parseEther("1000000"), owner.address);
      const newTokenAddress = await tokenManager.getTokenAddress(newModelId);

      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(modelRegistry.updateStringModel(modelId, newTokenAddress))
        .to.emit(modelRegistry, "StringModelUpdated")
        .withArgs(modelId, newTokenAddress);

      expect(await modelRegistry.getStringToken(modelId)).to.equal(newTokenAddress);
      expect(await modelRegistry.getStringModelId(newTokenAddress)).to.equal(modelId);
      await expect(modelRegistry.getStringModelId(tokenAddress)).to.be.revertedWith("Token not registered");
    });

    it("Should reject updating a string model to zero address", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(
        modelRegistry.updateStringModel(modelId, ZeroAddress)
      ).to.be.revertedWith("Token address cannot be zero");
    });

    it("Should reject updating a string model to an already-registered token", async function () {
      const otherModelId = "other-model";
      await deployTestToken(tokenManager, otherModelId, "Other Token", "OTHR", parseEther("1000000"), owner.address);
      const otherTokenAddress = await tokenManager.getTokenAddress(otherModelId);

      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);
      await modelRegistry.registerStringModel(otherModelId, otherTokenAddress, performanceMetric);

      await expect(
        modelRegistry.updateStringModel(modelId, otherTokenAddress)
      ).to.be.revertedWith("Token already registered");
    });

    it("Should update a string model metric", async function () {
      const newMetric = "sharpe-ratio";
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(modelRegistry.updateStringMetric(modelId, newMetric))
        .to.emit(modelRegistry, "StringMetricUpdated")
        .withArgs(modelId, newMetric);

      const updatedModel = await modelRegistry.modelsByString(modelId);
      expect(updatedModel.performanceMetric).to.equal(newMetric);
    });

    it("Should reject updating a string model metric to empty", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(
        modelRegistry.updateStringMetric(modelId, "")
      ).to.be.revertedWith("Performance metric cannot be empty");
    });

    it("Should deactivate a string model", async function () {
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(modelRegistry.deactivateStringModel(modelId))
        .to.emit(modelRegistry, "StringModelDeactivated")
        .withArgs(modelId);

      const updatedModel = await modelRegistry.modelsByString(modelId);
      expect(updatedModel.active).to.be.false;
    });

    it("Should only allow owner to manage registered string models", async function () {
      const newModelId = "model-owner-check";
      await deployTestToken(tokenManager, newModelId, "Owner Check", "OWN", parseEther("1000000"), owner.address);
      const newTokenAddress = await tokenManager.getTokenAddress(newModelId);

      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);

      await expect(
        modelRegistry.connect(nonOwner).updateStringModel(modelId, newTokenAddress)
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        modelRegistry.connect(nonOwner).updateStringMetric(modelId, "precision")
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await expect(
        modelRegistry.connect(nonOwner).deactivateStringModel(modelId)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("ModelRegistry - AMM Pool Registration", function () {
    const modelId = "model-v1-abc123";
    const performanceMetric = "accuracy";
    let tokenAddress;

    beforeEach(async function () {
      // Deploy token and register string model
      await deployTestToken(tokenManager, modelId, "Test Token", "TEST", parseEther("1000000"), owner.address);
      tokenAddress = await tokenManager.getTokenAddress(modelId);
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);
    });

    it("Should register an AMM pool for a model", async function () {
      await modelRegistry.registerPool(modelId, amm.address);

      expect(await modelRegistry.getPool(modelId)).to.equal(amm.address);
      expect(await modelRegistry.hasPool(modelId)).to.be.true;
      expect(await modelRegistry.poolToStringModel(amm.address)).to.equal(modelId);
    });

    it("Should emit PoolRegistered event", async function () {
      await expect(modelRegistry.registerPool(modelId, amm.address))
        .to.emit(modelRegistry, "PoolRegistered")
        .withArgs(modelId, amm.address);
    });

    it("Should prevent duplicate pool registration", async function () {
      await modelRegistry.registerPool(modelId, amm.address);

      await expect(
        modelRegistry.registerPool(modelId, user.address)
      ).to.be.revertedWith("Pool already exists");
    });

    it("Should prevent registering the same pool for another model", async function () {
      const modelId2 = "model-v2";
      await deployTestToken(tokenManager, modelId2, "Test Token 2", "TEST2", parseEther("1000000"), owner.address);
      const tokenAddress2 = await tokenManager.getTokenAddress(modelId2);
      await modelRegistry.registerStringModel(modelId2, tokenAddress2, performanceMetric);

      await modelRegistry.registerPool(modelId, amm.address);

      await expect(
        modelRegistry.registerPool(modelId2, amm.address)
      ).to.be.revertedWith("Pool already registered to another model");
    });

    it("Should revert if model not registered", async function () {
      await expect(
        modelRegistry.registerPool("non-existent-model", amm.address)
      ).to.be.revertedWith("Model not registered");
    });

    it("Should revert with empty model ID", async function () {
      await expect(
        modelRegistry.registerPool("", amm.address)
      ).to.be.revertedWith("Model ID cannot be empty");
    });

    it("Should revert with zero pool address", async function () {
      await expect(
        modelRegistry.registerPool(modelId, ZeroAddress)
      ).to.be.revertedWith("Pool address cannot be zero");
    });

    it("Should only allow owner to register pool", async function () {
      await expect(
        modelRegistry.connect(nonOwner).registerPool(modelId, amm.address)
      ).to.be.revertedWith("Caller is not authorized to register pools");
    });

    it("Should allow an authorized registrar to register pool", async function () {
      await modelRegistry.setPoolRegistrar(amm.address, true);

      await modelRegistry.connect(amm).registerPool(modelId, user.address);

      expect(await modelRegistry.getPool(modelId)).to.equal(user.address);
    });

    it("Should let owner revoke registrar access", async function () {
      await modelRegistry.setPoolRegistrar(amm.address, true);
      await modelRegistry.setPoolRegistrar(amm.address, false);

      await expect(
        modelRegistry.connect(amm).registerPool(modelId, user.address)
      ).to.be.revertedWith("Caller is not authorized to register pools");
    });

    it("Should return address(0) for model without pool", async function () {
      const modelId2 = "model-v2";
      await deployTestToken(tokenManager, modelId2, "Test Token 2", "TEST2", parseEther("1000000"), owner.address);
      const tokenAddress2 = await tokenManager.getTokenAddress(modelId2);
      await modelRegistry.registerStringModel(modelId2, tokenAddress2, performanceMetric);

      expect(await modelRegistry.getPool(modelId2)).to.equal(ZeroAddress);
      expect(await modelRegistry.hasPool(modelId2)).to.be.false;
    });
  });

  describe("TokenManager - AMM Authorization", function () {
    it("Should authorize AMM contract", async function () {
      await tokenManager.authorizeAMM(amm.address);

      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      expect(await tokenManager.hasRole(MINTER_ROLE, amm.address)).to.be.true;
    });

    it("Should allow owner to revoke AMM authorization", async function () {
      await tokenManager.authorizeAMM(amm.address);
      await tokenManager.revokeAMM(amm.address);

      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      expect(await tokenManager.hasRole(MINTER_ROLE, amm.address)).to.be.false;
    });

    it("Should revert with zero address", async function () {
      await expect(
        tokenManager.authorizeAMM(ZeroAddress)
      ).to.be.revertedWithCustomError(tokenManager, "ZeroAddress");
    });

    it("Should only allow owner to authorize", async function () {
      await expect(
        tokenManager.connect(nonOwner).authorizeAMM(amm.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should only allow owner to revoke", async function () {
      await tokenManager.authorizeAMM(amm.address);

      await expect(
        tokenManager.connect(nonOwner).revokeAMM(amm.address)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("TokenManager - MINTER_ROLE Burn Authorization", function () {
    const modelId = "model-burn-test";
    let tokenAddress;

    beforeEach(async function () {
      // Deploy token
      await deployTestToken(tokenManager, modelId, "Burn Test", "BURN", parseEther("1000000"), owner.address);
      tokenAddress = await tokenManager.getTokenAddress(modelId);

      // Mint some tokens to user
      await tokenManager.mintTokens(modelId, user.address, parseEther("1000"));

      // User needs to approve TokenManager to burn their tokens
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
      await token.connect(user).approve(await tokenManager.getAddress(), MaxUint256);
    });

    it("Should allow owner to burn tokens", async function () {
      const burnAmount = parseEther("100");
      const balanceBefore = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);

      await tokenManager.burnTokens(modelId, user.address, burnAmount);

      const balanceAfter = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);
      expect(balanceAfter).to.equal(balanceBefore - burnAmount);
    });

    it("Should allow MINTER_ROLE holder to burn tokens", async function () {
      await tokenManager.authorizeAMM(amm.address);

      const burnAmount = parseEther("100");
      const balanceBefore = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);

      await tokenManager.connect(amm).burnTokens(modelId, user.address, burnAmount);

      const balanceAfter = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);
      expect(balanceAfter).to.equal(balanceBefore - burnAmount);
    });

    it("Should allow deltaVerifier to burn tokens", async function () {
      await tokenManager.setDeltaVerifier(amm.address);

      const burnAmount = parseEther("100");
      const balanceBefore = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);

      await tokenManager.connect(amm).burnTokens(modelId, user.address, burnAmount);

      const balanceAfter = await (await ethers.getContractAt("HokusaiToken", tokenAddress)).balanceOf(user.address);
      expect(balanceAfter).to.equal(balanceBefore - burnAmount);
    });

    it("Should prevent unauthorized address from burning", async function () {
      await expect(
        tokenManager.connect(nonOwner).burnTokens(modelId, user.address, parseEther("100"))
      ).to.be.revertedWith("Caller is not authorized to burn");
    });

    it("Should emit TokensBurned event", async function () {
      const burnAmount = parseEther("100");

      await expect(tokenManager.burnTokens(modelId, user.address, burnAmount))
        .to.emit(tokenManager, "TokensBurned")
        .withArgs(modelId, user.address, burnAmount);
    });
  });

  describe("MockUSDC", function () {
    it("Should have 6 decimals", async function () {
      expect(await mockUSDC.decimals()).to.equal(6);
    });

    it("Should have correct name and symbol", async function () {
      expect(await mockUSDC.name()).to.equal("Mock USDC");
      expect(await mockUSDC.symbol()).to.equal("USDC");
    });

    it("Should allow minting for tests", async function () {
      const amount = parseUnits("10000", 6); // 10,000 USDC
      await mockUSDC.mint(user.address, amount);

      expect(await mockUSDC.balanceOf(user.address)).to.equal(amount);
    });

    it("Should allow burning for tests", async function () {
      const amount = parseUnits("10000", 6);
      await mockUSDC.mint(user.address, amount);
      await mockUSDC.burn(user.address, parseUnits("1000", 6));

      expect(await mockUSDC.balanceOf(user.address)).to.equal(parseUnits("9000", 6));
    });

    it("Should support standard ERC20 transfers", async function () {
      const amount = parseUnits("1000", 6);
      await mockUSDC.mint(owner.address, amount);
      await mockUSDC.transfer(user.address, amount);

      expect(await mockUSDC.balanceOf(user.address)).to.equal(amount);
      expect(await mockUSDC.balanceOf(owner.address)).to.equal(0);
    });
  });

  describe("Integration - Full Phase 1 Flow", function () {
    const modelId = "integration-model-v1";
    const performanceMetric = "accuracy";
    let tokenAddress;

    it("Should complete full Phase 1 setup flow", async function () {
      // Step 1: Deploy token via TokenManager
      await deployTestToken(tokenManager, modelId, "Integration Token", "INT", parseEther("1000000"), owner.address);
      tokenAddress = await tokenManager.getTokenAddress(modelId);

      // Step 2: Register string model in ModelRegistry
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);
      expect(await modelRegistry.isStringRegistered(modelId)).to.be.true;

      // Step 3: Register AMM pool in ModelRegistry
      await modelRegistry.registerPool(modelId, amm.address);
      expect(await modelRegistry.getPool(modelId)).to.equal(amm.address);

      // Step 4: Authorize AMM in TokenManager
      await tokenManager.authorizeAMM(amm.address);
      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      expect(await tokenManager.hasRole(MINTER_ROLE, amm.address)).to.be.true;

      // Step 5: Mint tokens via TokenManager (simulating AMM)
      await tokenManager.connect(amm).mintTokens(modelId, user.address, parseEther("1000"));
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
      expect(await token.balanceOf(user.address)).to.equal(parseEther("1000"));

      // Step 6: Burn tokens via TokenManager (simulating AMM)
      await token.connect(user).approve(await tokenManager.getAddress(), MaxUint256);
      await tokenManager.connect(amm).burnTokens(modelId, user.address, parseEther("100"));
      expect(await token.balanceOf(user.address)).to.equal(parseEther("900"));
    });

    it("Should handle MockUSDC in preparation for AMM", async function () {
      // Mint USDC to simulated users
      const usdcAmount = parseUnits("10000", 6);
      await mockUSDC.mint(user.address, usdcAmount);

      // User approves AMM (simulated)
      await mockUSDC.connect(user).approve(amm.address, MaxUint256);

      // Verify balances
      expect(await mockUSDC.balanceOf(user.address)).to.equal(usdcAmount);
      expect(await mockUSDC.allowance(user.address, amm.address)).to.equal(MaxUint256);
    });
  });
});
