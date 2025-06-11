const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");

describe("TokenManager-ModelRegistry Integration", function () {
  let modelRegistry;
  let hokusaiToken;
  let tokenManager;
  let owner;
  let user1;
  let user2;
  let nonOwner;
  let addrs;

  beforeEach(async function () {
    [owner, user1, user2, nonOwner, ...addrs] = await ethers.getSigners();
    
    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy HokusaiToken
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy();
    await hokusaiToken.waitForDeployment();

    // Deploy TokenManager with ModelRegistry reference
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Set TokenManager as controller for HokusaiToken
    await hokusaiToken.setController(await tokenManager.getAddress());
  });

  describe("Deployment and Initial Setup", function () {
    it("Should deploy all contracts successfully", async function () {
      expect(await modelRegistry.getAddress()).to.be.properAddress;
      expect(await hokusaiToken.getAddress()).to.be.properAddress;
      expect(await tokenManager.getAddress()).to.be.properAddress;
    });

    it("Should link TokenManager to ModelRegistry correctly", async function () {
      expect(await tokenManager.registry()).to.equal(await modelRegistry.getAddress());
    });

    it("Should set TokenManager as controller for HokusaiToken", async function () {
      expect(await hokusaiToken.controller()).to.equal(await tokenManager.getAddress());
    });

    it("Should reject deployment with zero registry address", async function () {
      const TokenManager = await ethers.getContractFactory("TokenManager");
      await expect(TokenManager.deploy(ZeroAddress))
        .to.be.revertedWith("Registry address cannot be zero");
    });
  });

  describe("ModelRegistry Functionality", function () {
    const modelId = ethers.encodeBytes32String("TestModel");
    
    it("Should register model successfully", async function () {
      await expect(modelRegistry.registerModel(modelId, await hokusaiToken.getAddress()))
        .to.emit(modelRegistry, "ModelRegistered")
        .withArgs(modelId, await hokusaiToken.getAddress());
      
      expect(await modelRegistry.isRegistered(modelId)).to.be.true;
      expect(await modelRegistry.getToken(modelId)).to.equal(await hokusaiToken.getAddress());
    });

    it("Should prevent duplicate model registration", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
      
      await expect(modelRegistry.registerModel(modelId, await hokusaiToken.getAddress()))
        .to.be.revertedWith("Model already registered");
    });

    it("Should prevent registration with zero token address", async function () {
      await expect(modelRegistry.registerModel(modelId, ZeroAddress))
        .to.be.revertedWith("Token address cannot be zero");
    });

    it("Should only allow owner to register models", async function () {
      await expect(modelRegistry.connect(nonOwner).registerModel(modelId, await hokusaiToken.getAddress()))
        .to.be.revertedWithCustomError(modelRegistry, "OwnableUnauthorizedAccount");
    });

    it("Should update existing model", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
      
      // Deploy second token for update
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy();
      await hokusaiToken2.waitForDeployment();
      
      await expect(modelRegistry.updateModel(modelId, await hokusaiToken2.getAddress()))
        .to.emit(modelRegistry, "ModelUpdated")
        .withArgs(modelId, await hokusaiToken2.getAddress());
      
      expect(await modelRegistry.getToken(modelId)).to.equal(await hokusaiToken2.getAddress());
    });

    it("Should revert when getting token for unregistered model", async function () {
      await expect(modelRegistry.getToken(modelId))
        .to.be.revertedWith("Model not registered");
    });
  });

  describe("TokenManager Integration", function () {
    const modelId = ethers.encodeBytes32String("TestModel");
    
    beforeEach(async function () {
      // Register model before each test
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
    });

    it("Should check if model is managed", async function () {
      expect(await tokenManager.isModelManaged(modelId)).to.be.true;
      
      const unregisteredId = ethers.encodeBytes32String("UnregisteredModel");
      expect(await tokenManager.isModelManaged(unregisteredId)).to.be.false;
    });

    it("Should get token address for registered model", async function () {
      expect(await tokenManager.getTokenAddress(modelId))
        .to.equal(await hokusaiToken.getAddress());
    });

    it("Should revert when getting token address for unregistered model", async function () {
      const unregisteredId = ethers.encodeBytes32String("UnregisteredModel");
      await expect(tokenManager.getTokenAddress(unregisteredId))
        .to.be.revertedWith("Model not registered");
    });
  });

  describe("Token Operations through TokenManager", function () {
    const modelId = ethers.encodeBytes32String("TestModel");
    
    beforeEach(async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
    });

    describe("Minting", function () {
      it("Should mint tokens successfully for registered model", async function () {
        const mintAmount = parseEther("1000");
        
        await expect(tokenManager.mintTokens(modelId, user1.address, mintAmount))
          .to.emit(tokenManager, "TokensMinted")
          .withArgs(modelId, user1.address, mintAmount)
          .and.to.emit(hokusaiToken, "Minted")
          .withArgs(user1.address, mintAmount);
        
        expect(await hokusaiToken.balanceOf(user1.address)).to.equal(mintAmount);
        expect(await hokusaiToken.totalSupply()).to.equal(mintAmount);
      });

      it("Should only allow owner to mint tokens", async function () {
        await expect(tokenManager.connect(nonOwner).mintTokens(modelId, user1.address, parseEther("100")))
          .to.be.revertedWithCustomError(tokenManager, "OwnableUnauthorizedAccount");
      });

      it("Should revert minting for unregistered model", async function () {
        const unregisteredId = ethers.encodeBytes32String("UnregisteredModel");
        await expect(tokenManager.mintTokens(unregisteredId, user1.address, parseEther("100")))
          .to.be.revertedWith("Model not registered");
      });

      it("Should revert minting to zero address", async function () {
        await expect(tokenManager.mintTokens(modelId, ZeroAddress, parseEther("100")))
          .to.be.revertedWith("Recipient cannot be zero address");
      });

      it("Should revert minting zero amount", async function () {
        await expect(tokenManager.mintTokens(modelId, user1.address, 0))
          .to.be.revertedWith("Amount must be greater than zero");
      });
    });

    describe("Burning", function () {
      beforeEach(async function () {
        // Mint tokens first
        await tokenManager.mintTokens(modelId, user1.address, parseEther("1000"));
        await tokenManager.mintTokens(modelId, user2.address, parseEther("500"));
      });

      it("Should burn tokens successfully for registered model", async function () {
        const burnAmount = parseEther("300");
        const initialBalance = await hokusaiToken.balanceOf(user1.address);
        const initialSupply = await hokusaiToken.totalSupply();
        
        await expect(tokenManager.burnTokens(modelId, user1.address, burnAmount))
          .to.emit(tokenManager, "TokensBurned")
          .withArgs(modelId, user1.address, burnAmount)
          .and.to.emit(hokusaiToken, "Burned")
          .withArgs(user1.address, burnAmount);
        
        expect(await hokusaiToken.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
        expect(await hokusaiToken.totalSupply()).to.equal(initialSupply - burnAmount);
      });

      it("Should only allow owner to burn tokens", async function () {
        await expect(tokenManager.connect(nonOwner).burnTokens(modelId, user1.address, parseEther("100")))
          .to.be.revertedWithCustomError(tokenManager, "OwnableUnauthorizedAccount");
      });

      it("Should revert burning for unregistered model", async function () {
        const unregisteredId = ethers.encodeBytes32String("UnregisteredModel");
        await expect(tokenManager.burnTokens(unregisteredId, user1.address, parseEther("100")))
          .to.be.revertedWith("Model not registered");
      });

      it("Should revert burning from zero address", async function () {
        await expect(tokenManager.burnTokens(modelId, ZeroAddress, parseEther("100")))
          .to.be.revertedWith("Account cannot be zero address");
      });

      it("Should revert burning zero amount", async function () {
        await expect(tokenManager.burnTokens(modelId, user1.address, 0))
          .to.be.revertedWith("Amount must be greater than zero");
      });

      it("Should revert burning more than balance", async function () {
        const balance = await hokusaiToken.balanceOf(user1.address);
        await expect(tokenManager.burnTokens(modelId, user1.address, balance + 1n))
          .to.be.reverted;
      });
    });
  });

  describe("Multiple Models Integration", function () {
    const modelId1 = ethers.encodeBytes32String("Model1");
    const modelId2 = ethers.encodeBytes32String("Model2");
    let hokusaiToken2;

    beforeEach(async function () {
      // Deploy second token
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      hokusaiToken2 = await HokusaiToken2.deploy();
      await hokusaiToken2.waitForDeployment();
      await hokusaiToken2.setController(await tokenManager.getAddress());

      // Register both models
      await modelRegistry.registerModel(modelId1, await hokusaiToken.getAddress());
      await modelRegistry.registerModel(modelId2, await hokusaiToken2.getAddress());
    });

    it("Should manage multiple models independently", async function () {
      // Mint tokens for both models
      await tokenManager.mintTokens(modelId1, user1.address, parseEther("1000"));
      await tokenManager.mintTokens(modelId2, user1.address, parseEther("2000"));

      expect(await hokusaiToken.balanceOf(user1.address)).to.equal(parseEther("1000"));
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(parseEther("2000"));
    });

    it("Should resolve correct token addresses for different models", async function () {
      expect(await tokenManager.getTokenAddress(modelId1)).to.equal(await hokusaiToken.getAddress());
      expect(await tokenManager.getTokenAddress(modelId2)).to.equal(await hokusaiToken2.getAddress());
    });

    it("Should burn tokens from correct model", async function () {
      // Mint tokens first
      await tokenManager.mintTokens(modelId1, user1.address, parseEther("1000"));
      await tokenManager.mintTokens(modelId2, user1.address, parseEther("2000"));

      // Burn from model1 only
      await tokenManager.burnTokens(modelId1, user1.address, parseEther("300"));

      expect(await hokusaiToken.balanceOf(user1.address)).to.equal(parseEther("700"));
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(parseEther("2000"));
    });
  });

  describe("End-to-End Flow", function () {
    it("Should handle complete registration to token operations flow", async function () {
      const modelId = ethers.encodeBytes32String("E2EModel");
      
      // 1. Register model
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
      expect(await modelRegistry.isRegistered(modelId)).to.be.true;
      
      // 2. Check TokenManager can see the model
      expect(await tokenManager.isModelManaged(modelId)).to.be.true;
      expect(await tokenManager.getTokenAddress(modelId)).to.equal(await hokusaiToken.getAddress());
      
      // 3. Mint tokens through TokenManager
      await tokenManager.mintTokens(modelId, user1.address, parseEther("1000"));
      expect(await hokusaiToken.balanceOf(user1.address)).to.equal(parseEther("1000"));
      
      // 4. User can transfer tokens normally
      await hokusaiToken.connect(user1).transfer(user2.address, parseEther("300"));
      expect(await hokusaiToken.balanceOf(user2.address)).to.equal(parseEther("300"));
      
      // 5. Burn tokens through TokenManager
      await tokenManager.burnTokens(modelId, user1.address, parseEther("200"));
      expect(await hokusaiToken.balanceOf(user1.address)).to.equal(parseEther("500"));
      
      // 6. Verify total supply
      expect(await hokusaiToken.totalSupply()).to.equal(parseEther("800"));
    });
  });

  describe("Gas Cost Analysis", function () {
    const modelId = ethers.encodeBytes32String("GasTestModel");
    
    beforeEach(async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress());
    });

    it("Should track gas costs for token operations", async function () {
      // Mint operation
      const mintTx = await tokenManager.mintTokens(modelId, user1.address, parseEther("1000"));
      const mintReceipt = await mintTx.wait();
      console.log("        Mint gas used:", mintReceipt.gasUsed.toString());
      
      // Burn operation
      const burnTx = await tokenManager.burnTokens(modelId, user1.address, parseEther("500"));
      const burnReceipt = await burnTx.wait();
      console.log("        Burn gas used:", burnReceipt.gasUsed.toString());
      
      // Gas costs should be reasonable (less than 200k for each operation)
      expect(mintReceipt.gasUsed).to.be.lt(200000);
      expect(burnReceipt.gasUsed).to.be.lt(200000);
    });
  });
});