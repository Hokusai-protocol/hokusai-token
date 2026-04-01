const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");

describe("FundingVault", function () {
  let fundingVault;
  let tokenManager;
  let modelRegistry;
  let owner;
  let investor1;
  let investor2;
  let unauthorized;

  const MODEL_ID_1 = "test-model-1";
  const MODEL_ID_2 = "test-model-2";
  const MODEL_ID_UNREGISTERED = "unregistered-model";

  beforeEach(async function () {
    [owner, investor1, investor2, unauthorized] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy FundingVault
    const FundingVault = await ethers.getContractFactory("FundingVault");
    fundingVault = await FundingVault.deploy();
    await fundingVault.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      expect(await fundingVault.owner()).to.equal(owner.address);
    });
  });

  describe("Proposal Registration", function () {
    it("Should register a proposal with valid parameters", async function () {
      // Deploy a token first
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);

      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60; // 90 days

      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline))
        .to.emit(fundingVault, "ProposalRegistered")
        .withArgs(MODEL_ID_1, tokenAddress, deadline);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.tokenAddress).to.equal(tokenAddress);
      expect(proposal.deadline).to.equal(deadline);
      expect(proposal.registered).to.be.true;
      expect(proposal.graduated).to.be.false;
      expect(proposal.totalDeposits).to.equal(0);
    });

    it("Should reject registration with zero address", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

      await expect(fundingVault.registerProposal(MODEL_ID_1, ZeroAddress, deadline))
        .to.be.revertedWithCustomError(fundingVault, "ZeroAddress");
    });

    it("Should reject registration with empty model ID", async function () {
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

      await expect(fundingVault.registerProposal("", investor1.address, deadline))
        .to.be.revertedWithCustomError(fundingVault, "EmptyString");
    });

    it("Should reject registration with past deadline", async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);

      const pastDeadline = Math.floor(Date.now() / 1000) - 1;

      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress, pastDeadline))
        .to.be.revertedWith("Deadline must be in the future");
    });

    it("Should reject duplicate registration", async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline);

      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline))
        .to.be.revertedWith("Proposal already registered");
    });

    it("Should reject registration by non-owner", async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

      await expect(
        fundingVault.connect(unauthorized).registerProposal(MODEL_ID_1, tokenAddress, deadline)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Deposits", function () {
    beforeEach(async function () {
      // Setup: deploy token and register proposal
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline);
    });

    it("Should allow investors to deposit", async function () {
      const depositAmount = parseEther("1000");

      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_1, depositAmount))
        .to.emit(fundingVault, "DepositMade")
        .withArgs(MODEL_ID_1, investor1.address, depositAmount);

      expect(await fundingVault.getDeposit(MODEL_ID_1, investor1.address)).to.equal(depositAmount);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalDeposits).to.equal(depositAmount);
    });

    it("Should accumulate multiple deposits from same investor", async function () {
      const deposit1 = parseEther("1000");
      const deposit2 = parseEther("500");

      await fundingVault.connect(investor1).deposit(MODEL_ID_1, deposit1);
      await fundingVault.connect(investor1).deposit(MODEL_ID_1, deposit2);

      expect(await fundingVault.getDeposit(MODEL_ID_1, investor1.address)).to.equal(deposit1 + deposit2);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalDeposits).to.equal(deposit1 + deposit2);
    });

    it("Should track deposits from multiple investors", async function () {
      const deposit1 = parseEther("1000");
      const deposit2 = parseEther("2000");

      await fundingVault.connect(investor1).deposit(MODEL_ID_1, deposit1);
      await fundingVault.connect(investor2).deposit(MODEL_ID_1, deposit2);

      expect(await fundingVault.getDeposit(MODEL_ID_1, investor1.address)).to.equal(deposit1);
      expect(await fundingVault.getDeposit(MODEL_ID_1, investor2.address)).to.equal(deposit2);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalDeposits).to.equal(deposit1 + deposit2);
    });

    it("Should reject deposit with zero amount", async function () {
      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_1, 0))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });

    it("Should reject deposit for unregistered proposal", async function () {
      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_UNREGISTERED, parseEther("1000")))
        .to.be.revertedWith("Proposal not registered");
    });

    it("Should reject deposit with empty model ID", async function () {
      await expect(fundingVault.connect(investor1).deposit("", parseEther("1000")))
        .to.be.revertedWithCustomError(fundingVault, "EmptyString");
    });
  });

  describe("Deadline Enforcement", function () {
    it("Should reject deposits after deadline", async function () {
      // Register proposal with short deadline
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);

      // Get current block timestamp and add 10 seconds
      const currentBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = currentBlock.timestamp + 10;

      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, shortDeadline);

      // Wait for deadline to pass
      await ethers.provider.send("evm_increaseTime", [15]);
      await ethers.provider.send("evm_mine");

      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_1, parseEther("1000")))
        .to.be.revertedWith("Funding period ended");
    });

    it("Should allow deposits before deadline", async function () {
      // Register proposal with future deadline
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;

      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline);

      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_1, parseEther("1000")))
        .to.not.be.reverted;
    });
  });

  describe("Graduation", function () {
    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline);
    });

    it("Should allow owner to mark proposal as graduated", async function () {
      await expect(fundingVault.markGraduated(MODEL_ID_1))
        .to.emit(fundingVault, "ProposalGraduated")
        .withArgs(MODEL_ID_1);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.graduated).to.be.true;
    });

    it("Should reject graduation by non-owner", async function () {
      await expect(fundingVault.connect(unauthorized).markGraduated(MODEL_ID_1))
        .to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should reject graduation for unregistered proposal", async function () {
      await expect(fundingVault.markGraduated(MODEL_ID_UNREGISTERED))
        .to.be.revertedWith("Proposal not registered");
    });

    it("Should reject duplicate graduation", async function () {
      await fundingVault.markGraduated(MODEL_ID_1);

      await expect(fundingVault.markGraduated(MODEL_ID_1))
        .to.be.revertedWith("Already graduated");
    });

    it("Should reject deposits after graduation", async function () {
      await fundingVault.markGraduated(MODEL_ID_1);

      await expect(fundingVault.connect(investor1).deposit(MODEL_ID_1, parseEther("1000")))
        .to.be.revertedWith("Proposal already graduated");
    });
  });

  describe("View Functions", function () {
    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      const deadline = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress, deadline);
    });

    it("Should return correct registration status", async function () {
      expect(await fundingVault.isRegistered(MODEL_ID_1)).to.be.true;
      expect(await fundingVault.isRegistered(MODEL_ID_UNREGISTERED)).to.be.false;
    });

    it("Should return correct funding active status", async function () {
      expect(await fundingVault.isFundingActive(MODEL_ID_1)).to.be.true;

      // Graduate the proposal
      await fundingVault.markGraduated(MODEL_ID_1);
      expect(await fundingVault.isFundingActive(MODEL_ID_1)).to.be.false;
    });

    it("Should return false for funding active after deadline", async function () {
      // Register proposal with short deadline
      await tokenManager.deployToken(MODEL_ID_2, "Test Token 2", "TST2", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_2);

      // Get current block timestamp and add 10 seconds
      const currentBlock = await ethers.provider.getBlock("latest");
      const shortDeadline = currentBlock.timestamp + 10;

      await fundingVault.registerProposal(MODEL_ID_2, tokenAddress, shortDeadline);

      expect(await fundingVault.isFundingActive(MODEL_ID_2)).to.be.true;

      // Wait for deadline to pass
      await ethers.provider.send("evm_increaseTime", [15]);
      await ethers.provider.send("evm_mine");

      expect(await fundingVault.isFundingActive(MODEL_ID_2)).to.be.false;
    });

    it("Should return zero deposit for non-investor", async function () {
      expect(await fundingVault.getDeposit(MODEL_ID_1, unauthorized.address)).to.equal(0);
    });
  });

  describe("Multiple Proposals", function () {
    it("Should manage multiple proposals independently", async function () {
      // Deploy tokens
      await tokenManager.deployToken(MODEL_ID_1, "Token 1", "TKN1", parseEther("1000000"));
      await tokenManager.deployToken(MODEL_ID_2, "Token 2", "TKN2", parseEther("1000000"));

      const tokenAddress1 = await tokenManager.getTokenAddress(MODEL_ID_1);
      const tokenAddress2 = await tokenManager.getTokenAddress(MODEL_ID_2);

      const deadline1 = Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60;
      const deadline2 = Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60;

      // Register both proposals
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress1, deadline1);
      await fundingVault.registerProposal(MODEL_ID_2, tokenAddress2, deadline2);

      // Make deposits to both
      await fundingVault.connect(investor1).deposit(MODEL_ID_1, parseEther("1000"));
      await fundingVault.connect(investor1).deposit(MODEL_ID_2, parseEther("2000"));

      // Verify independent tracking
      expect(await fundingVault.getDeposit(MODEL_ID_1, investor1.address)).to.equal(parseEther("1000"));
      expect(await fundingVault.getDeposit(MODEL_ID_2, investor1.address)).to.equal(parseEther("2000"));

      const proposal1 = await fundingVault.getProposal(MODEL_ID_1);
      const proposal2 = await fundingVault.getProposal(MODEL_ID_2);

      expect(proposal1.totalDeposits).to.equal(parseEther("1000"));
      expect(proposal2.totalDeposits).to.equal(parseEther("2000"));
      expect(proposal1.tokenAddress).to.equal(tokenAddress1);
      expect(proposal2.tokenAddress).to.equal(tokenAddress2);
    });
  });
});
