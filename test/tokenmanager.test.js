const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, MaxUint256 } = require("ethers");

describe("TokenManager", function () {
  let tokenManager;
  let modelRegistry;
  let hokusaiToken1;
  let hokusaiToken2;
  let owner;
  let user1;
  let user2;
  let unauthorized;
  
  const MODEL_ID_1 = 1;
  const MODEL_ID_2 = 2;
  const UNREGISTERED_MODEL_ID = 999;
  
  beforeEach(async function () {
    // Get signers
    [owner, user1, user2, unauthorized] = await ethers.getSigners();
    
    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();
    
    // Deploy HokusaiToken instances
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken1 = await HokusaiToken.deploy("Hokusai Token 1", "HOKU1", owner.address);
    await hokusaiToken1.waitForDeployment();
    
    hokusaiToken2 = await HokusaiToken.deploy("Hokusai Token 2", "HOKU2", owner.address);
    await hokusaiToken2.waitForDeployment();
    
    // Deploy TokenManager with ModelRegistry reference
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    
    // Register models in ModelRegistry
    await modelRegistry.registerModel(MODEL_ID_1, await hokusaiToken1.getAddress(), "accuracy");
    await modelRegistry.registerModel(MODEL_ID_2, await hokusaiToken2.getAddress(), "f1-score");
    
    // Set TokenManager as controller for both tokens
    await hokusaiToken1.setController(await tokenManager.getAddress());
    await hokusaiToken2.setController(await tokenManager.getAddress());
  });

  describe("Deployment", function () {
    it("Should set the correct registry address", async function () {
      expect(await tokenManager.registry()).to.equal(await modelRegistry.getAddress());
    });

    it("Should set the deployer as owner", async function () {
      expect(await tokenManager.owner()).to.equal(owner.address);
    });

    it("Should reject zero address for registry", async function () {
      const TokenManager = await ethers.getContractFactory("TokenManager");
      await expect(TokenManager.deploy(ZeroAddress))
        .to.be.revertedWith("Registry address cannot be zero");
    });
  });

  describe("Successful Minting Flow", function () {
    it("Should mint tokens with valid parameters", async function () {
      const amount = parseEther("100");
      
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, amount))
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID_1, user1.address, amount);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount);
      expect(await hokusaiToken1.totalSupply()).to.equal(amount);
    });

    it("Should mint tokens to multiple recipients", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("200");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount1);
      await tokenManager.mintTokens(MODEL_ID_1, user2.address, amount2);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount1);
      expect(await hokusaiToken1.balanceOf(user2.address)).to.equal(amount2);
      expect(await hokusaiToken1.totalSupply()).to.equal(amount1 + amount2);
    });

    it("Should accumulate tokens for same recipient", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("50");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount1);
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount2);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount1 + amount2);
    });
  });

  describe("Registry Integration", function () {
    it("Should mint to correct token based on model ID", async function () {
      const amount = parseEther("100");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_2, user1.address, amount);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount);
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(amount);
    });

    it("Should fail when model is not registered", async function () {
      await expect(tokenManager.mintTokens(UNREGISTERED_MODEL_ID, user1.address, parseEther("100")))
        .to.be.revertedWith("Model not registered");
    });

    it("Should return correct token address", async function () {
      expect(await tokenManager.getTokenAddress(MODEL_ID_1))
        .to.equal(await hokusaiToken1.getAddress());
      expect(await tokenManager.getTokenAddress(MODEL_ID_2))
        .to.equal(await hokusaiToken2.getAddress());
    });

    it("Should correctly report managed models", async function () {
      expect(await tokenManager.isModelManaged(MODEL_ID_1)).to.be.true;
      expect(await tokenManager.isModelManaged(MODEL_ID_2)).to.be.true;
      expect(await tokenManager.isModelManaged(UNREGISTERED_MODEL_ID)).to.be.false;
    });
  });

  describe("Access Control", function () {
    it("Should allow owner to mint tokens", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, parseEther("100")))
        .to.not.be.reverted;
    });

    it("Should prevent non-owner from minting", async function () {
      await expect(tokenManager.connect(unauthorized).mintTokens(MODEL_ID_1, user1.address, parseEther("100")))
        .to.be.revertedWithCustomError(tokenManager, "OwnableUnauthorizedAccount");
    });

    it("Should maintain access control after ownership transfer", async function () {
      await tokenManager.transferOwnership(user1.address);
      
      // Original owner can no longer mint
      await expect(tokenManager.mintTokens(MODEL_ID_1, user2.address, parseEther("100")))
        .to.be.revertedWithCustomError(tokenManager, "OwnableUnauthorizedAccount");
      
      // New owner can mint
      await expect(tokenManager.connect(user1).mintTokens(MODEL_ID_1, user2.address, parseEther("100")))
        .to.not.be.reverted;
    });
  });

  describe("Input Validation", function () {
    it("Should reject zero recipient address", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, ZeroAddress, parseEther("100")))
        .to.be.revertedWith("Recipient cannot be zero address");
    });

    it("Should reject zero amount", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, 0))
        .to.be.revertedWith("Amount must be greater than zero");
    });

    it("Should handle maximum uint256 amount", async function () {
      // This will likely fail due to total supply constraints, but we test the handling
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, MaxUint256))
        .to.not.be.revertedWith("Amount must be greater than zero");
    });

    it("Should handle edge case model IDs", async function () {
      // Model ID 0
      await expect(tokenManager.mintTokens(0, user1.address, parseEther("100")))
        .to.be.revertedWith("Model not registered");
      
      // Maximum uint256 model ID
      await expect(tokenManager.mintTokens(MaxUint256, user1.address, parseEther("100")))
        .to.be.revertedWith("Model not registered");
    });
  });

  describe("Multiple Models", function () {
    it("Should isolate tokens between models", async function () {
      const amount = parseEther("100");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_2, user2.address, amount);
      
      // Check isolation - user1 should only have model1 tokens
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount);
      expect(await hokusaiToken1.balanceOf(user2.address)).to.equal(0);
      
      // user2 should only have model2 tokens
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(0);
      expect(await hokusaiToken2.balanceOf(user2.address)).to.equal(amount);
    });

    it("Should handle sequential minting to different models", async function () {
      const amount = parseEther("50");
      
      // Mint alternating between models
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_2, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_2, user1.address, amount);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount * 2n);
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(amount * 2n);
    });
  });

  describe("State Changes", function () {
    it("Should accurately track balance changes", async function () {
      const amounts = [parseEther("10"), parseEther("25"), parseEther("40")];
      let expectedBalance = 0n;
      
      for (const amount of amounts) {
        await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
        expectedBalance += amount;
        expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(expectedBalance);
      }
    });

    it("Should accurately track total supply", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("200");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount1);
      expect(await hokusaiToken1.totalSupply()).to.equal(amount1);
      
      await tokenManager.mintTokens(MODEL_ID_1, user2.address, amount2);
      expect(await hokusaiToken1.totalSupply()).to.equal(amount1 + amount2);
    });
  });

  describe("Event Emissions", function () {
    it("Should emit TokensMinted with correct parameters", async function () {
      const amount = parseEther("100");
      
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, amount))
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID_1, user1.address, amount);
    });

    it("Should emit events for multiple operations", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("200");
      
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, amount1))
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID_1, user1.address, amount1);
        
      await expect(tokenManager.mintTokens(MODEL_ID_2, user2.address, amount2))
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID_2, user2.address, amount2);
    });

    it("Should allow filtering events by indexed parameters", async function () {
      const amount = parseEther("100");
      
      // Mint to multiple models and recipients
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      await tokenManager.mintTokens(MODEL_ID_2, user2.address, amount);
      await tokenManager.mintTokens(MODEL_ID_1, user2.address, amount);
      
      // Filter by model ID
      const model1Filter = tokenManager.filters.TokensMinted(MODEL_ID_1);
      const model1Events = await tokenManager.queryFilter(model1Filter);
      expect(model1Events.length).to.equal(2);
      
      // Filter by recipient
      const user2Filter = tokenManager.filters.TokensMinted(null, user2.address);
      const user2Events = await tokenManager.queryFilter(user2Filter);
      expect(user2Events.length).to.equal(2);
    });
  });

  describe("Error Scenarios", function () {
    it("Should fail when TokenManager is not set as controller", async function () {
      // Deploy new token without setting TokenManager as controller
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const newToken = await HokusaiToken.deploy("New Token", "NEW", owner.address);
      await newToken.waitForDeployment();
      
      // Register in ModelRegistry
      const newModelId = 99;
      await modelRegistry.registerModel(newModelId, await newToken.getAddress(), "test-metric");
      
      // Try to mint without being controller
      await expect(tokenManager.mintTokens(newModelId, user1.address, parseEther("100")))
        .to.be.revertedWith("Only controller can call this function");
    });

    it("Should handle registry returning zero address gracefully", async function () {
      // This scenario shouldn't happen with proper registry implementation,
      // but we test TokenManager's handling of it
      const invalidModelId = 0;
      await expect(tokenManager.mintTokens(invalidModelId, user1.address, parseEther("100")))
        .to.be.revertedWith("Model not registered");
    });
  });

  describe("Integration Tests", function () {
    it("Should complete full deployment to minting flow", async function () {
      // Deploy fresh contracts
      const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
      const newRegistry = await ModelRegistry.deploy();
      
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const newToken = await HokusaiToken.deploy("New Token", "NEW", owner.address);
      
      const TokenManager = await ethers.getContractFactory("TokenManager");
      const newManager = await TokenManager.deploy(await newRegistry.getAddress());
      
      // Set up relationships
      const modelId = 42;
      await newRegistry.registerModel(modelId, await newToken.getAddress(), "performance");
      await newToken.setController(await newManager.getAddress());
      
      // Mint tokens
      const amount = parseEther("1000");
      await expect(newManager.mintTokens(modelId, user1.address, amount))
        .to.emit(newManager, "TokensMinted")
        .withArgs(modelId, user1.address, amount);
      
      // Verify end state
      expect(await newToken.balanceOf(user1.address)).to.equal(amount);
      expect(await newToken.totalSupply()).to.equal(amount);
    });

    it("Should handle multiple models with different recipients efficiently", async function () {
      const recipients = [user1.address, user2.address];
      const amounts = [parseEther("100"), parseEther("200")];
      const models = [MODEL_ID_1, MODEL_ID_2];
      
      // Perform multiple minting operations
      for (const model of models) {
        for (let i = 0; i < recipients.length; i++) {
          await tokenManager.mintTokens(model, recipients[i], amounts[i]);
        }
      }
      
      // Verify all balances
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amounts[0]);
      expect(await hokusaiToken1.balanceOf(user2.address)).to.equal(amounts[1]);
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(amounts[0]);
      expect(await hokusaiToken2.balanceOf(user2.address)).to.equal(amounts[1]);
    });

    it("Should measure gas usage for minting operations", async function () {
      const amount = parseEther("100");
      const tx = await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount);
      const receipt = await tx.wait();
      
      // Gas usage should be reasonable (less than 150k for a simple mint)
      expect(receipt.gasUsed).to.be.lessThan(150000n);
    });
  });
});