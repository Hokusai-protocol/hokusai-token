const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress, MaxUint256 } = require("ethers");

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
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("1000000"));
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
  });

  describe("ModelRegistry - AMM Pool Registration", function () {
    const modelId = "model-v1-abc123";
    const performanceMetric = "accuracy";
    let tokenAddress;

    beforeEach(async function () {
      // Deploy token and register string model
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(modelId);
      await modelRegistry.registerStringModel(modelId, tokenAddress, performanceMetric);
    });

    it("Should register an AMM pool for a model", async function () {
      await modelRegistry.registerPool(modelId, amm.address);

      expect(await modelRegistry.getPool(modelId)).to.equal(amm.address);
      expect(await modelRegistry.hasPool(modelId)).to.be.true;
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
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should return address(0) for model without pool", async function () {
      const modelId2 = "model-v2";
      await tokenManager.deployToken(modelId2, "Test Token 2", "TEST2", parseEther("1000000"));
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
      await tokenManager.deployToken(modelId, "Burn Test", "BURN", parseEther("1000000"));
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
      await tokenManager.deployToken(modelId, "Integration Token", "INT", parseEther("1000000"));
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
