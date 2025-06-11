const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");

describe("AuctionBurner", function () {
  let auctionBurner;
  let token;
  let tokenManager;
  let owner;
  let user1;
  let user2;
  let addrs;

  beforeEach(async function () {
    [owner, user1, user2, ...addrs] = await ethers.getSigners();
    
    // Deploy HokusaiToken
    const Token = await ethers.getContractFactory("HokusaiToken");
    token = await Token.deploy();
    await token.waitForDeployment();

    // Deploy TokenManager (needed as controller)
    const TokenManager = await ethers.getContractFactory("TokenManager");
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const registry = await ModelRegistry.deploy();
    await registry.waitForDeployment();
    
    tokenManager = await TokenManager.deploy(await registry.getAddress());
    await tokenManager.waitForDeployment();

    // Set TokenManager as controller
    await token.setController(await tokenManager.getAddress());

    // Deploy AuctionBurner
    const AuctionBurner = await ethers.getContractFactory("AuctionBurner");
    auctionBurner = await AuctionBurner.deploy(await token.getAddress());
    await auctionBurner.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct token address", async function () {
      expect(await auctionBurner.token()).to.equal(await token.getAddress());
    });

    it("Should set the deployer as owner", async function () {
      expect(await auctionBurner.owner()).to.equal(owner.address);
    });

    it("Should revert if token address is zero", async function () {
      const AuctionBurner = await ethers.getContractFactory("AuctionBurner");
      await expect(AuctionBurner.deploy(ZeroAddress))
        .to.be.revertedWith("Token address cannot be zero");
    });
  });

  describe("Token Reference Management", function () {
    it("Should allow owner to update token address", async function () {
      const Token2 = await ethers.getContractFactory("HokusaiToken");
      const token2 = await Token2.deploy();
      await token2.waitForDeployment();

      await expect(auctionBurner.setToken(await token2.getAddress()))
        .to.emit(auctionBurner, "TokenContractUpdated")
        .withArgs(await token2.getAddress());

      expect(await auctionBurner.token()).to.equal(await token2.getAddress());
    });

    it("Should revert when non-owner tries to update token", async function () {
      const Token2 = await ethers.getContractFactory("HokusaiToken");
      const token2 = await Token2.deploy();
      await token2.waitForDeployment();

      await expect(auctionBurner.connect(user1).setToken(await token2.getAddress()))
        .to.be.revertedWithCustomError(auctionBurner, "OwnableUnauthorizedAccount");
    });

    it("Should revert when setting token to zero address", async function () {
      await expect(auctionBurner.setToken(ZeroAddress))
        .to.be.revertedWith("Token address cannot be zero");
    });
  });

  describe("Burn Functionality", function () {
    beforeEach(async function () {
      // Register a model and mint tokens to user1
      const modelRegistry = await ethers.getContractAt("ModelRegistry", await tokenManager.registry());
      await modelRegistry.registerModel(1, await token.getAddress(), "accuracy");
      await tokenManager.mintTokens(1, user1.address, parseEther("1000"));
    });

    it("Should burn tokens from user's balance", async function () {
      const burnAmount = parseEther("100");
      const initialBalance = await token.balanceOf(user1.address);
      const initialSupply = await token.totalSupply();

      // User needs to approve the burner to burn their tokens
      await token.connect(user1).approve(await auctionBurner.getAddress(), burnAmount);

      await expect(auctionBurner.connect(user1).burn(burnAmount))
        .to.emit(auctionBurner, "TokensBurned")
        .withArgs(user1.address, burnAmount)
        .to.emit(token, "Burned")
        .withArgs(await auctionBurner.getAddress(), burnAmount);

      expect(await token.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
      expect(await token.totalSupply()).to.equal(initialSupply - burnAmount);
    });

    it("Should revert when burning zero amount", async function () {
      await expect(auctionBurner.connect(user1).burn(0))
        .to.be.revertedWith("Amount must be greater than zero");
    });

    it("Should revert when user has insufficient balance", async function () {
      const burnAmount = parseEther("2000"); // More than user1's balance
      await token.connect(user1).approve(await auctionBurner.getAddress(), burnAmount);

      await expect(auctionBurner.connect(user1).burn(burnAmount))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });

    it("Should revert when user hasn't approved enough tokens", async function () {
      const burnAmount = parseEther("100");
      // Don't approve or approve less than burn amount
      await token.connect(user1).approve(await auctionBurner.getAddress(), parseEther("50"));

      await expect(auctionBurner.connect(user1).burn(burnAmount))
        .to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
    });

    it("Should work with multiple users burning tokens", async function () {
      // Mint tokens to user2 as well
      await tokenManager.mintTokens(1, user2.address, parseEther("500"));

      const burnAmount1 = parseEther("100");
      const burnAmount2 = parseEther("50");

      // Both users approve and burn
      await token.connect(user1).approve(await auctionBurner.getAddress(), burnAmount1);
      await token.connect(user2).approve(await auctionBurner.getAddress(), burnAmount2);

      await auctionBurner.connect(user1).burn(burnAmount1);
      await auctionBurner.connect(user2).burn(burnAmount2);

      expect(await token.balanceOf(user1.address)).to.equal(parseEther("900"));
      expect(await token.balanceOf(user2.address)).to.equal(parseEther("450"));
    });
  });

  describe("Edge Cases", function () {
    beforeEach(async function () {
      const modelRegistry = await ethers.getContractAt("ModelRegistry", await tokenManager.registry());
      await modelRegistry.registerModel(1, await token.getAddress(), "accuracy");
      await tokenManager.mintTokens(1, user1.address, parseEther("1000"));
    });

    it("Should handle burning entire balance", async function () {
      const balance = await token.balanceOf(user1.address);
      await token.connect(user1).approve(await auctionBurner.getAddress(), balance);

      await auctionBurner.connect(user1).burn(balance);

      expect(await token.balanceOf(user1.address)).to.equal(0);
    });

    it("Should revert when token contract is changed to invalid address", async function () {
      // Change token to an invalid contract (one that doesn't implement required interface)
      const InvalidContract = await ethers.getContractFactory("ModelRegistry");
      const invalidContract = await InvalidContract.deploy();
      await invalidContract.waitForDeployment();

      await auctionBurner.setToken(await invalidContract.getAddress());

      const burnAmount = parseEther("100");
      await expect(auctionBurner.connect(user1).burn(burnAmount))
        .to.be.reverted;
    });
  });

  describe("Gas Efficiency", function () {
    beforeEach(async function () {
      const modelRegistry = await ethers.getContractAt("ModelRegistry", await tokenManager.registry());
      await modelRegistry.registerModel(1, await token.getAddress(), "accuracy");
      await tokenManager.mintTokens(1, user1.address, parseEther("1000"));
    });

    it("Should burn tokens efficiently", async function () {
      const burnAmount = parseEther("100");
      await token.connect(user1).approve(await auctionBurner.getAddress(), burnAmount);

      const tx = await auctionBurner.connect(user1).burn(burnAmount);
      const receipt = await tx.wait();
      
      // Basic gas usage check - should be reasonable
      expect(receipt.gasUsed).to.be.below(100000); // Should use less than 100k gas
    });
  });

  describe("Events", function () {
    beforeEach(async function () {
      const modelRegistry = await ethers.getContractAt("ModelRegistry", await tokenManager.registry());
      await modelRegistry.registerModel(1, await token.getAddress(), "accuracy");
      await tokenManager.mintTokens(1, user1.address, parseEther("1000"));
    });

    it("Should emit TokensBurned event with correct parameters", async function () {
      const burnAmount = parseEther("100");
      await token.connect(user1).approve(await auctionBurner.getAddress(), burnAmount);

      await expect(auctionBurner.connect(user1).burn(burnAmount))
        .to.emit(auctionBurner, "TokensBurned")
        .withArgs(user1.address, burnAmount);
    });

    it("Should emit TokenContractUpdated event when token is changed", async function () {
      const Token2 = await ethers.getContractFactory("HokusaiToken");
      const token2 = await Token2.deploy();
      await token2.waitForDeployment();

      await expect(auctionBurner.setToken(await token2.getAddress()))
        .to.emit(auctionBurner, "TokenContractUpdated")
        .withArgs(await token2.getAddress());
    });
  });
});