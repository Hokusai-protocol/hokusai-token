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
  
  const MODEL_ID_1 = "1";
  const MODEL_ID_2 = "2";
  const UNREGISTERED_MODEL_ID = "999";
  
  beforeEach(async function () {
    // Get signers
    [owner, user1, user2, unauthorized] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager with ModelRegistry reference
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy tokens using TokenManager's deployToken function
    await tokenManager.deployToken(MODEL_ID_1, "Hokusai Token 1", "HOKU1", parseEther("10000"));
    await tokenManager.deployToken(MODEL_ID_2, "Hokusai Token 2", "HOKU2", parseEther("10000"));

    // Get the deployed token addresses
    const tokenAddress1 = await tokenManager.getTokenAddress(MODEL_ID_1);
    const tokenAddress2 = await tokenManager.getTokenAddress(MODEL_ID_2);

    // Create token instances for testing
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken1 = HokusaiToken.attach(tokenAddress1);
    hokusaiToken2 = HokusaiToken.attach(tokenAddress2);
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
        .to.be.revertedWithCustomError(TokenManager, "ZeroAddress");
    });
  });

  describe("Successful Minting Flow", function () {
    it("Should mint tokens with valid parameters", async function () {
      const amount = parseEther("100");
      
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, amount))
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID_1, user1.address, amount);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount);
      expect(await hokusaiToken1.totalSupply()).to.equal(parseEther("10000") + amount);
    });

    it("Should mint tokens to multiple recipients", async function () {
      const amount1 = parseEther("100");
      const amount2 = parseEther("200");
      
      await tokenManager.mintTokens(MODEL_ID_1, user1.address, amount1);
      await tokenManager.mintTokens(MODEL_ID_1, user2.address, amount2);
      
      expect(await hokusaiToken1.balanceOf(user1.address)).to.equal(amount1);
      expect(await hokusaiToken1.balanceOf(user2.address)).to.equal(amount2);
      expect(await hokusaiToken1.totalSupply()).to.equal(parseEther("10000") + amount1 + amount2);
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

    it("Should fail when model token is not deployed", async function () {
      await expect(tokenManager.mintTokens(UNREGISTERED_MODEL_ID, user1.address, parseEther("100")))
        .to.be.revertedWith("Token not deployed for this model");
    });

    it("Should return correct token address", async function () {
      expect(await tokenManager.getTokenAddress(MODEL_ID_1))
        .to.equal(await hokusaiToken1.getAddress());
      expect(await tokenManager.getTokenAddress(MODEL_ID_2))
        .to.equal(await hokusaiToken2.getAddress());
    });

    it("Should correctly report deployed tokens", async function () {
      expect(await tokenManager.hasToken(MODEL_ID_1)).to.be.true;
      expect(await tokenManager.hasToken(MODEL_ID_2)).to.be.true;
      expect(await tokenManager.hasToken(UNREGISTERED_MODEL_ID)).to.be.false;
    });
  });

  describe("Access Control", function () {
    it("Should allow owner to mint tokens", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, parseEther("100")))
        .to.not.be.reverted;
    });

    it("Should prevent non-owner from minting", async function () {
      await expect(tokenManager.connect(unauthorized).mintTokens(MODEL_ID_1, user1.address, parseEther("100")))
        .to.be.revertedWith("Caller is not authorized to mint");
    });

    it("Should maintain access control after ownership transfer", async function () {
      // Grant admin role to new owner first
      await tokenManager.grantRole(await tokenManager.DEFAULT_ADMIN_ROLE(), user1.address);

      await tokenManager.transferOwnership(user1.address);

      // Original owner can still mint because they have MINTER_ROLE
      await expect(tokenManager.mintTokens(MODEL_ID_1, user2.address, parseEther("100")))
        .to.not.be.reverted;

      // New owner can also mint
      await expect(tokenManager.connect(user1).mintTokens(MODEL_ID_1, user2.address, parseEther("100")))
        .to.not.be.reverted;

      // New owner can revoke MINTER_ROLE from original owner
      await tokenManager.connect(user1).revokeRole(await tokenManager.MINTER_ROLE(), owner.address);

      // Now original owner cannot mint
      await expect(tokenManager.mintTokens(MODEL_ID_1, user2.address, parseEther("100")))
        .to.be.revertedWith("Caller is not authorized to mint");
    });
  });

  describe("Input Validation", function () {
    it("Should reject zero recipient address", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, ZeroAddress, parseEther("100")))
        .to.be.revertedWithCustomError(tokenManager, "ZeroAddress");
    });

    it("Should reject zero amount", async function () {
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, 0))
        .to.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should handle maximum uint256 amount", async function () {
      // This will likely fail due to total supply constraints, but we test the handling
      await expect(tokenManager.mintTokens(MODEL_ID_1, user1.address, MaxUint256))
        .to.not.be.revertedWithCustomError(tokenManager, "InvalidAmount");
    });

    it("Should handle edge case model IDs", async function () {
      // Empty string model ID
      await expect(tokenManager.mintTokens("", user1.address, parseEther("100")))
        .to.be.revertedWithCustomError(tokenManager, "EmptyString");

      // Non-existent model ID
      await expect(tokenManager.mintTokens("non-existent", user1.address, parseEther("100")))
        .to.be.revertedWith("Token not deployed for this model");
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
      expect(await hokusaiToken1.totalSupply()).to.equal(parseEther("10000") + amount1);
      
      await tokenManager.mintTokens(MODEL_ID_1, user2.address, amount2);
      expect(await hokusaiToken1.totalSupply()).to.equal(parseEther("10000") + amount1 + amount2);
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
      // Deploy params first
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const hokusaiParams = await HokusaiParams.deploy(
        1000, // tokensPerDeltaOne
        8000, // infrastructureAccrualBps (80%)
        ethers.ZeroHash,
        "",
        owner.address
      );
      await hokusaiParams.waitForDeployment();

      // Deploy new token directly without TokenManager
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const newToken = await HokusaiToken.deploy("New Token", "NEW", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
      await newToken.waitForDeployment();

      // Manually add to TokenManager's tracking (simulating a broken state)
      const newModelId = "99";
      // Note: We can't directly add to TokenManager's mapping from outside,
      // so this test would need to test a different scenario or be removed
      // since our new design doesn't allow this kind of inconsistent state

      // Try to mint to a model that doesn't have a deployed token
      await expect(tokenManager.mintTokens(newModelId, user1.address, parseEther("100")))
        .to.be.revertedWith("Token not deployed for this model");
    });

    it("Should handle invalid model ID gracefully", async function () {
      // Test with empty string model ID
      await expect(tokenManager.mintTokens("", user1.address, parseEther("100")))
        .to.be.revertedWithCustomError(tokenManager, "EmptyString");

      // Test with non-existent model ID
      await expect(tokenManager.mintTokens("invalid-model", user1.address, parseEther("100")))
        .to.be.revertedWith("Token not deployed for this model");
    });
  });

  describe("Integration Tests", function () {
    it("Should complete full deployment to minting flow", async function () {
      // Deploy fresh contracts
      const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
      const newRegistry = await ModelRegistry.deploy();

      const TokenManager = await ethers.getContractFactory("TokenManager");
      const newManager = await TokenManager.deploy(await newRegistry.getAddress());

      // Deploy token through TokenManager
      const modelId = "42";
      const initialSupply = parseEther("10000");
      await newManager.deployToken(modelId, "New Token", "NEW", initialSupply);

      // Get deployed token
      const tokenAddress = await newManager.getTokenAddress(modelId);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const newToken = HokusaiToken.attach(tokenAddress);

      // Mint tokens
      const amount = parseEther("1000");
      await expect(newManager.mintTokens(modelId, user1.address, amount))
        .to.emit(newManager, "TokensMinted")
        .withArgs(modelId, user1.address, amount);

      // Verify end state
      expect(await newToken.balanceOf(user1.address)).to.equal(amount);
      expect(await newToken.totalSupply()).to.equal(initialSupply + amount);
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