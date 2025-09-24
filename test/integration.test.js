const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("TokenManager-ModelRegistry Integration", function () {
  let modelRegistry;
  let hokusaiToken;
  let hokusaiParams;
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

    // Deploy HokusaiParams for test token
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = await HokusaiParams.deploy(
      1000, // tokensPerDeltaOne
      500,  // infraMarkupBps (5%)
      keccak256(toUtf8Bytes("test-license")), // licenseHash
      "https://test.license", // licenseURI
      owner.address // governor
    );
    await hokusaiParams.waitForDeployment();

    // Deploy HokusaiToken
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy("Hokusai Token", "HOKU", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
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
    const modelId = "12345";
    
    it("Should register model successfully", async function () {
      const metric = "accuracy";
      await expect(modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), metric))
        .to.emit(modelRegistry, "ModelRegistered")
        .withArgs(modelId, await hokusaiToken.getAddress(), metric);
      
      expect(await modelRegistry.isRegistered(modelId)).to.be.true;
      expect(await modelRegistry.getToken(modelId)).to.equal(await hokusaiToken.getAddress());
      expect(await modelRegistry.getMetric(modelId)).to.equal(metric);
    });

    it("Should prevent duplicate model registration", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      await expect(modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy"))
        .to.be.revertedWith("Model already registered");
    });

    it("Should prevent registration with zero token address", async function () {
      await expect(modelRegistry.registerModel(modelId, ZeroAddress, "accuracy"))
        .to.be.revertedWith("Token address cannot be zero");
    });

    it("Should only allow owner to register models", async function () {
      await expect(modelRegistry.connect(nonOwner).registerModel(modelId, await hokusaiToken.getAddress(), "accuracy"))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should update existing model", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      // Deploy second token for update
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy("Hokusai Token 2", "HOKU2", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
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

    it("Should prevent registration with empty metric", async function () {
      await expect(modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), ""))
        .to.be.revertedWith("Performance metric cannot be empty");
    });

    it("Should update performance metric successfully", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      const newMetric = "f1-score";
      await expect(modelRegistry.updateMetric(modelId, newMetric))
        .to.emit(modelRegistry, "MetricUpdated")
        .withArgs(modelId, newMetric);
      
      expect(await modelRegistry.getMetric(modelId)).to.equal(newMetric);
    });

    it("Should deactivate model successfully", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      await modelRegistry.deactivateModel(modelId);
      
      const modelInfo = await modelRegistry.getModel(modelId);
      expect(modelInfo.active).to.be.false;
    });

    it("Should get complete model information", async function () {
      const metric = "accuracy";
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), metric);
      
      const modelInfo = await modelRegistry.getModel(modelId);
      expect(modelInfo.tokenAddress).to.equal(await hokusaiToken.getAddress());
      expect(modelInfo.performanceMetric).to.equal(metric);
      expect(modelInfo.active).to.be.true;
    });
  });

  describe("TokenManager Integration", function () {
    const modelId = "54321";
    
    beforeEach(async function () {
      // Deploy token through TokenManager (new approach)
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("10000"));
    });

    it("Should check if model is managed", async function () {
      expect(await tokenManager.hasToken(modelId)).to.be.true;

      const unregisteredId = "99999";
      expect(await tokenManager.hasToken(unregisteredId)).to.be.false;
    });

    it("Should get token address for registered model", async function () {
      const tokenAddress = await tokenManager.getTokenAddress(modelId);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
    });

    it("Should return zero address for unregistered model", async function () {
      const unregisteredId = "99999";
      const tokenAddress = await tokenManager.getTokenAddress(unregisteredId);
      expect(tokenAddress).to.equal(ethers.ZeroAddress);
    });
  });

  describe("Token Operations through TokenManager", function () {
    const modelId = "67890";

    beforeEach(async function () {
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("10000"));
    });

    describe("Minting", function () {
      it("Should mint tokens successfully for registered model", async function () {
        const mintAmount = parseEther("1000");
        
        const tokenAddress = await tokenManager.getTokenAddress(modelId);
        const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
        const deployedToken = HokusaiToken.attach(tokenAddress);

        await expect(tokenManager.mintTokens(modelId, user1.address, mintAmount))
          .to.emit(tokenManager, "TokensMinted")
          .withArgs(modelId, user1.address, mintAmount)
          .and.to.emit(deployedToken, "Minted")
          .withArgs(user1.address, mintAmount);
        
        expect(await deployedToken.balanceOf(user1.address)).to.equal(mintAmount);
        expect(await deployedToken.totalSupply()).to.equal(parseEther("10000") + mintAmount);
      });

      it("Should only allow owner to mint tokens", async function () {
        await expect(tokenManager.connect(nonOwner).mintTokens(modelId, user1.address, parseEther("100")))
          .to.be.revertedWith("Caller is not authorized to mint");
      });

      it("Should revert minting for unregistered model", async function () {
        const unregisteredId = "88888";
        await expect(tokenManager.mintTokens(unregisteredId, user1.address, parseEther("100")))
          .to.be.revertedWith("Token not deployed for this model");
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
      let deployedToken;

      beforeEach(async function () {
        // Get the deployed token instance
        const tokenAddress = await tokenManager.getTokenAddress(modelId);
        const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
        deployedToken = HokusaiToken.attach(tokenAddress);

        // Mint tokens first
        await tokenManager.mintTokens(modelId, user1.address, parseEther("1000"));
        await tokenManager.mintTokens(modelId, user2.address, parseEther("500"));
      });

      it("Should burn tokens successfully for registered model", async function () {
        const burnAmount = parseEther("300");
        const initialBalance = await deployedToken.balanceOf(user1.address);
        const initialSupply = await deployedToken.totalSupply();
        
        await expect(tokenManager.burnTokens(modelId, user1.address, burnAmount))
          .to.emit(tokenManager, "TokensBurned")
          .withArgs(modelId, user1.address, burnAmount)
          .and.to.emit(deployedToken, "Burned")
          .withArgs(user1.address, burnAmount);
        
        expect(await deployedToken.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
        expect(await deployedToken.totalSupply()).to.equal(initialSupply - burnAmount);
      });

      it("Should only allow owner to burn tokens", async function () {
        await expect(tokenManager.connect(nonOwner).burnTokens(modelId, user1.address, parseEther("100")))
          .to.be.revertedWith("Ownable: caller is not the owner");
      });

      it("Should revert burning for unregistered model", async function () {
        const unregisteredId = "77777";
        await expect(tokenManager.burnTokens(unregisteredId, user1.address, parseEther("100")))
          .to.be.revertedWith("Token not deployed for this model");
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
        const balance = await deployedToken.balanceOf(user1.address);
        await expect(tokenManager.burnTokens(modelId, user1.address, balance + 1n))
          .to.be.reverted;
      });
    });
  });

  describe("Multiple Models Integration", function () {
    const modelId1 = "100";
    const modelId2 = "200";
    let hokusaiToken2;

    beforeEach(async function () {
      // Deploy both tokens through TokenManager
      await tokenManager.deployToken(modelId1, "Hokusai Token 1", "HOKU1", parseEther("10000"));
      await tokenManager.deployToken(modelId2, "Hokusai Token 2", "HOKU2", parseEther("10000"));

      // Get the deployed token addresses
      const tokenAddress1 = await tokenManager.getTokenAddress(modelId1);
      const tokenAddress2 = await tokenManager.getTokenAddress(modelId2);

      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      hokusaiToken = HokusaiToken.attach(tokenAddress1);
      hokusaiToken2 = HokusaiToken.attach(tokenAddress2);
    });

    it("Should manage multiple models independently", async function () {
      // Mint tokens for both models
      await tokenManager.mintTokens(modelId1, user1.address, parseEther("1000"));
      await tokenManager.mintTokens(modelId2, user1.address, parseEther("2000"));

      expect(await hokusaiToken.balanceOf(user1.address)).to.equal(parseEther("1000"));
      expect(await hokusaiToken2.balanceOf(user1.address)).to.equal(parseEther("2000"));
    });

    it("Should resolve correct token addresses for different models", async function () {
      const tokenAddress1 = await tokenManager.getTokenAddress(modelId1);
      const tokenAddress2 = await tokenManager.getTokenAddress(modelId2);
      expect(tokenAddress1).to.not.equal(ethers.ZeroAddress);
      expect(tokenAddress2).to.not.equal(ethers.ZeroAddress);
      expect(tokenAddress1).to.not.equal(tokenAddress2);
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
      const modelId = "300";
      
      // 1. Deploy token through TokenManager
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("10000"));
      expect(await tokenManager.hasToken(modelId)).to.be.true;
      
      // 2. Check TokenManager can see the model
      expect(await tokenManager.hasToken(modelId)).to.be.true;
      const tokenAddress = await tokenManager.getTokenAddress(modelId);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
      
      // 3. Mint tokens through TokenManager
      await tokenManager.mintTokens(modelId, user1.address, parseEther("1000"));
      const deployedTokenAddress = await tokenManager.getTokenAddress(modelId);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const deployedToken = HokusaiToken.attach(deployedTokenAddress);
      expect(await deployedToken.balanceOf(user1.address)).to.equal(parseEther("1000"));
      
      // 4. User can transfer tokens normally
      await deployedToken.connect(user1).transfer(user2.address, parseEther("300"));
      expect(await deployedToken.balanceOf(user2.address)).to.equal(parseEther("300"));
      
      // 5. Burn tokens through TokenManager
      await tokenManager.burnTokens(modelId, user1.address, parseEther("200"));
      expect(await deployedToken.balanceOf(user1.address)).to.equal(parseEther("500"));
      
      // 6. Verify total supply
      expect(await deployedToken.totalSupply()).to.equal(parseEther("10800")); // 10000 initial + 1000 minted - 200 burned
    });
  });

  describe("Gas Cost Analysis", function () {
    const modelId = "400";

    beforeEach(async function () {
      await tokenManager.deployToken(modelId, "Test Token", "TEST", parseEther("10000"));
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

  describe("New uint256 Mapping Features", function () {
    const modelId = "500";
    
    it("Should provide reverse lookup from token address to modelId", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      expect(await modelRegistry.getModelId(await hokusaiToken.getAddress())).to.equal(modelId);
    });

    it("Should revert reverse lookup for unregistered token", async function () {
      await expect(modelRegistry.getModelId(await hokusaiToken.getAddress()))
        .to.be.revertedWith("Token not registered");
    });

    it("Should support getTokenAddress function", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      expect(await modelRegistry.getTokenAddress(modelId)).to.equal(await hokusaiToken.getAddress());
    });

    it("Should support exists function", async function () {
      expect(await modelRegistry.exists(modelId)).to.be.false;
      
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      expect(await modelRegistry.exists(modelId)).to.be.true;
    });

    it("Should auto-increment model IDs", async function () {
      const initialNextId = await modelRegistry.nextModelId();
      
      await expect(modelRegistry.registerModelAutoId(await hokusaiToken.getAddress(), "accuracy"))
        .to.emit(modelRegistry, "ModelRegistered")
        .withArgs(initialNextId, await hokusaiToken.getAddress(), "accuracy");
      
      expect(await modelRegistry.nextModelId()).to.equal(initialNextId + 1n);
      expect(await modelRegistry.getToken(initialNextId)).to.equal(await hokusaiToken.getAddress());
      expect(await modelRegistry.getModelId(await hokusaiToken.getAddress())).to.equal(initialNextId);
    });

    it("Should prevent duplicate token registration", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      await expect(modelRegistry.registerModel(modelId + 1, await hokusaiToken.getAddress(), "f1-score"))
        .to.be.revertedWith("Token already registered");
    });

    it("Should prevent duplicate token registration with auto-increment", async function () {
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      await expect(modelRegistry.registerModelAutoId(await hokusaiToken.getAddress(), "accuracy"))
        .to.be.revertedWith("Token already registered");
    });

    it("Should handle token updates correctly with reverse mapping", async function () {
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy("Hokusai Token 2", "HOKU2", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
      await hokusaiToken2.waitForDeployment();

      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      
      // Verify initial reverse mapping
      expect(await modelRegistry.getModelId(await hokusaiToken.getAddress())).to.equal(modelId);
      
      // Update to new token
      await modelRegistry.updateModel(modelId, await hokusaiToken2.getAddress());
      
      // Verify reverse mapping updated
      expect(await modelRegistry.getModelId(await hokusaiToken2.getAddress())).to.equal(modelId);
      
      // Old token should no longer be mapped
      await expect(modelRegistry.getModelId(await hokusaiToken.getAddress()))
        .to.be.revertedWith("Token not registered");
    });

    it("Should prevent updating to already registered token", async function () {
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy("Hokusai Token 2", "HOKU2", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
      await hokusaiToken2.waitForDeployment();
      
      const modelId2 = "600";
      
      await modelRegistry.registerModel(modelId, await hokusaiToken.getAddress(), "accuracy");
      await modelRegistry.registerModel(modelId2, await hokusaiToken2.getAddress(), "f1-score");
      
      await expect(modelRegistry.updateModel(modelId, await hokusaiToken2.getAddress()))
        .to.be.revertedWith("Token already registered");
    });

    it("Should handle multiple sequential auto-increments", async function () {
      const HokusaiToken2 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken2 = await HokusaiToken2.deploy("Hokusai Token 2", "HOKU2", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
      await hokusaiToken2.waitForDeployment();

      const HokusaiToken3 = await ethers.getContractFactory("HokusaiToken");
      const hokusaiToken3 = await HokusaiToken3.deploy("Hokusai Token 3", "HOKU3", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
      await hokusaiToken3.waitForDeployment();
      
      const initialNextId = await modelRegistry.nextModelId();
      
      // Register first auto-increment
      await modelRegistry.registerModelAutoId(await hokusaiToken.getAddress(), "accuracy");
      expect(await modelRegistry.nextModelId()).to.equal(initialNextId + 1n);
      
      // Register second auto-increment
      await modelRegistry.registerModelAutoId(await hokusaiToken2.getAddress(), "f1-score");
      expect(await modelRegistry.nextModelId()).to.equal(initialNextId + 2n);
      
      // Register third auto-increment
      await modelRegistry.registerModelAutoId(await hokusaiToken3.getAddress(), "precision");
      expect(await modelRegistry.nextModelId()).to.equal(initialNextId + 3n);
      
      // Verify all mappings work
      expect(await modelRegistry.getToken(initialNextId)).to.equal(await hokusaiToken.getAddress());
      expect(await modelRegistry.getToken(initialNextId + 1n)).to.equal(await hokusaiToken2.getAddress());
      expect(await modelRegistry.getToken(initialNextId + 2n)).to.equal(await hokusaiToken3.getAddress());
    });
  });
});