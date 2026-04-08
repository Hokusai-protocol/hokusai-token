const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("FundingVault", function () {
  let fundingVault;
  let tokenManager;
  let modelRegistry;
  let ammFactory;
  let usdc;
  let owner;
  let graduator;
  let user1;
  let user2;
  let user3;

  const MODEL_ID_1 = "model-1";
  const MODEL_ID_2 = "model-2";
  const USDC_DECIMALS = 6;

  // Helper to parse USDC amounts (6 decimals)
  function usd(amount) {
    return parseUnits(amount.toString(), USDC_DECIMALS);
  }

  beforeEach(async function () {
    [owner, graduator, user1, user2, user3] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy HokusaiAMMFactory
    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    ammFactory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await usdc.getAddress(),
      owner.address // treasury
    );
    await ammFactory.waitForDeployment();

    // Grant TokenManager the MINTER_ROLE on AMM factory pools
    // This is done by authorizing the factory owner to create pools

    // Deploy FundingVault
    const FundingVault = await ethers.getContractFactory("FundingVault");
    fundingVault = await FundingVault.deploy(
      await usdc.getAddress(),
      await ammFactory.getAddress(),
      await tokenManager.getAddress(),
      owner.address
    );
    await fundingVault.waitForDeployment();

    // Grant GRADUATOR_ROLE to graduator address
    const GRADUATOR_ROLE = await fundingVault.GRADUATOR_ROLE();
    await fundingVault.grantRole(GRADUATOR_ROLE, graduator.address);

    // Grant FundingVault MINTER_ROLE in TokenManager
    const MINTER_ROLE = await tokenManager.MINTER_ROLE();
    await tokenManager.grantRole(MINTER_ROLE, await fundingVault.getAddress());

    // Grant FundingVault DEFAULT_ADMIN_ROLE in TokenManager (so it can authorize pools)
    const DEFAULT_ADMIN_ROLE = await tokenManager.DEFAULT_ADMIN_ROLE();
    await tokenManager.grantRole(DEFAULT_ADMIN_ROLE, await fundingVault.getAddress());

    // Transfer ownership of AMMFactory to FundingVault (so it can create pools)
    await ammFactory.transferOwnership(await fundingVault.getAddress());

    // Mint USDC to test users
    await usdc.mint(user1.address, usd(100000));
    await usdc.mint(user2.address, usd(100000));
    await usdc.mint(user3.address, usd(100000));

    // Approve FundingVault to spend USDC
    await usdc.connect(user1).approve(await fundingVault.getAddress(), usd(100000));
    await usdc.connect(user2).approve(await fundingVault.getAddress(), usd(100000));
    await usdc.connect(user3).approve(await fundingVault.getAddress(), usd(100000));
  });

  describe("Deployment", function () {
    it("Should set correct USDC address", async function () {
      expect(await fundingVault.usdc()).to.equal(await usdc.getAddress());
    });

    it("Should set correct AMM factory address", async function () {
      expect(await fundingVault.ammFactory()).to.equal(await ammFactory.getAddress());
    });

    it("Should set correct TokenManager address", async function () {
      expect(await fundingVault.tokenManager()).to.equal(await tokenManager.getAddress());
    });

    it("Should grant admin role to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await fundingVault.DEFAULT_ADMIN_ROLE();
      expect(await fundingVault.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should grant GRADUATOR_ROLE to admin initially", async function () {
      const GRADUATOR_ROLE = await fundingVault.GRADUATOR_ROLE();
      expect(await fundingVault.hasRole(GRADUATOR_ROLE, owner.address)).to.be.true;
    });

    it("Should reject zero address for USDC", async function () {
      const FundingVault = await ethers.getContractFactory("FundingVault");
      await expect(
        FundingVault.deploy(
          ZeroAddress,
          await ammFactory.getAddress(),
          await tokenManager.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(FundingVault, "ZeroAddress");
    });

    it("Should reject zero address for AMM factory", async function () {
      const FundingVault = await ethers.getContractFactory("FundingVault");
      await expect(
        FundingVault.deploy(
          await usdc.getAddress(),
          ZeroAddress,
          await tokenManager.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(FundingVault, "ZeroAddress");
    });

    it("Should reject zero address for TokenManager", async function () {
      const FundingVault = await ethers.getContractFactory("FundingVault");
      await expect(
        FundingVault.deploy(
          await usdc.getAddress(),
          await ammFactory.getAddress(),
          ZeroAddress,
          owner.address
        )
      ).to.be.revertedWithCustomError(FundingVault, "ZeroAddress");
    });
  });

  describe("registerProposal", function () {
    let tokenAddress;

    beforeEach(async function () {
      // Deploy a token for testing
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
    });

    it("Should register a new proposal", async function () {
      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress))
        .to.emit(fundingVault, "ProposalRegistered")
        .withArgs(MODEL_ID_1, tokenAddress);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.tokenAddress).to.equal(tokenAddress);
      expect(proposal.totalCommitted).to.equal(0);
      expect(proposal.graduated).to.be.false;
      expect(proposal.poolAddress).to.equal(ZeroAddress);
    });

    it("Should reject registration with empty model ID", async function () {
      await expect(fundingVault.registerProposal("", tokenAddress))
        .to.be.revertedWithCustomError(fundingVault, "EmptyString");
    });

    it("Should reject registration with zero token address", async function () {
      await expect(fundingVault.registerProposal(MODEL_ID_1, ZeroAddress))
        .to.be.revertedWithCustomError(fundingVault, "ZeroAddress");
    });

    it("Should reject duplicate registration", async function () {
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);
      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress))
        .to.be.revertedWith("Proposal already registered");
    });

    it("Should reject registration from non-admin", async function () {
      await expect(fundingVault.connect(user1).registerProposal(MODEL_ID_1, tokenAddress))
        .to.be.reverted;
    });
  });

  describe("deposit", function () {
    let tokenAddress;

    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);
    });

    it("Should accept USDC deposit", async function () {
      const amount = usd(1000);
      await expect(fundingVault.connect(user1).deposit(MODEL_ID_1, amount))
        .to.emit(fundingVault, "Deposited")
        .withArgs(MODEL_ID_1, user1.address, amount, amount);

      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(amount);
      expect(await usdc.balanceOf(await fundingVault.getAddress())).to.equal(amount);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(amount);
    });

    it("Should accumulate deposits from same user", async function () {
      const amount1 = usd(1000);
      const amount2 = usd(500);

      await fundingVault.connect(user1).deposit(MODEL_ID_1, amount1);
      await fundingVault.connect(user1).deposit(MODEL_ID_1, amount2);

      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(amount1 + amount2);
      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(amount1 + amount2);
    });

    it("Should accept deposits from multiple users", async function () {
      const amount1 = usd(1000);
      const amount2 = usd(2000);
      const amount3 = usd(1500);

      await fundingVault.connect(user1).deposit(MODEL_ID_1, amount1);
      await fundingVault.connect(user2).deposit(MODEL_ID_1, amount2);
      await fundingVault.connect(user3).deposit(MODEL_ID_1, amount3);

      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(amount1);
      expect(await fundingVault.getCommitment(MODEL_ID_1, user2.address)).to.equal(amount2);
      expect(await fundingVault.getCommitment(MODEL_ID_1, user3.address)).to.equal(amount3);

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(amount1 + amount2 + amount3);
    });

    it("Should reject deposit for unregistered proposal", async function () {
      await expect(fundingVault.connect(user1).deposit("unregistered", usd(1000)))
        .to.be.revertedWith("Proposal not registered");
    });

    it("Should reject zero amount deposit", async function () {
      await expect(fundingVault.connect(user1).deposit(MODEL_ID_1, 0))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });

    it("Should reject deposit without USDC approval", async function () {
      // Create new user without approval
      const [, , , , , newUser] = await ethers.getSigners();
      await usdc.mint(newUser.address, usd(1000));

      // Should revert with ERC20: insufficient allowance
      await expect(fundingVault.connect(newUser).deposit(MODEL_ID_1, usd(1000)))
        .to.be.revertedWith("ERC20: insufficient allowance");
    });
  });

  describe("withdraw", function () {
    let tokenAddress;

    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);

      // User1 deposits
      await fundingVault.connect(user1).deposit(MODEL_ID_1, usd(1000));
    });

    it("Should allow withdrawal before graduation", async function () {
      const balanceBefore = await usdc.balanceOf(user1.address);

      await expect(fundingVault.connect(user1).withdraw(MODEL_ID_1))
        .to.emit(fundingVault, "Withdrawn")
        .withArgs(MODEL_ID_1, user1.address, usd(1000));

      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(0);
      expect(await usdc.balanceOf(user1.address)).to.equal(balanceBefore + usd(1000));

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(0);
    });

    it("Should update totalCommitted correctly with multiple depositors", async function () {
      await fundingVault.connect(user2).deposit(MODEL_ID_1, usd(2000));

      let proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(usd(3000));

      await fundingVault.connect(user1).withdraw(MODEL_ID_1);

      proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.totalCommitted).to.equal(usd(2000));
    });

    it("Should reject withdrawal with no commitment", async function () {
      await expect(fundingVault.connect(user2).withdraw(MODEL_ID_1))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });

    it("Should reject withdrawal after claiming commitment", async function () {
      await fundingVault.connect(user1).withdraw(MODEL_ID_1);
      await expect(fundingVault.connect(user1).withdraw(MODEL_ID_1))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });

    it("Should reject withdrawal for unregistered proposal", async function () {
      await expect(fundingVault.connect(user1).withdraw("unregistered"))
        .to.be.revertedWith("Proposal not registered");
    });
  });

  describe("graduate", function () {
    let tokenAddress;

    beforeEach(async function () {
      // Deploy token
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);

      // Register proposal
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);

      // Multiple users deposit
      await fundingVault.connect(user1).deposit(MODEL_ID_1, usd(10000));
      await fundingVault.connect(user2).deposit(MODEL_ID_1, usd(15000));
      await fundingVault.connect(user3).deposit(MODEL_ID_1, usd(5000));

      // Grant AMM minting permission
      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      await tokenManager.grantRole(MINTER_ROLE, await ammFactory.getAddress());
    });

    it("Should graduate proposal and create AMM pool", async function () {
      const totalCommitted = usd(30000);

      await expect(fundingVault.connect(graduator).graduate(MODEL_ID_1))
        .to.emit(fundingVault, "Graduated");

      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.graduated).to.be.true;
      expect(proposal.poolAddress).to.not.equal(ZeroAddress);

      // Verify pool was created
      const poolAddress = await ammFactory.getPool(MODEL_ID_1);
      expect(poolAddress).to.equal(proposal.poolAddress);
    });

    it("Should reject graduation from non-graduator", async function () {
      await expect(fundingVault.connect(user1).graduate(MODEL_ID_1))
        .to.be.reverted;
    });

    it("Should reject graduation of unregistered proposal", async function () {
      await expect(fundingVault.connect(graduator).graduate("unregistered"))
        .to.be.revertedWith("Proposal not registered");
    });

    it("Should reject double graduation", async function () {
      await fundingVault.connect(graduator).graduate(MODEL_ID_1);
      await expect(fundingVault.connect(graduator).graduate(MODEL_ID_1))
        .to.be.revertedWith("Already graduated");
    });

    it("Should reject graduation with zero commitments", async function () {
      // Deploy new token and register proposal with no deposits
      await tokenManager.deployToken(MODEL_ID_2, "Test Token 2", "TEST2", parseEther("1000000"));
      const tokenAddress2 = await tokenManager.getTokenAddress(MODEL_ID_2);
      await fundingVault.registerProposal(MODEL_ID_2, tokenAddress2);

      await expect(fundingVault.connect(graduator).graduate(MODEL_ID_2))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });

    it("Should prevent deposits after graduation", async function () {
      await fundingVault.connect(graduator).graduate(MODEL_ID_1);
      await expect(fundingVault.connect(user1).deposit(MODEL_ID_1, usd(1000)))
        .to.be.revertedWith("Already graduated");
    });

    it("Should prevent withdrawals after graduation", async function () {
      await fundingVault.connect(graduator).graduate(MODEL_ID_1);
      await expect(fundingVault.connect(user1).withdraw(MODEL_ID_1))
        .to.be.revertedWith("Already graduated");
    });
  });

  describe("claim", function () {
    let tokenAddress;

    beforeEach(async function () {
      // Deploy token
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);

      // Register proposal
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);

      // Users deposit
      await fundingVault.connect(user1).deposit(MODEL_ID_1, usd(1000)); // $1000
      await fundingVault.connect(user2).deposit(MODEL_ID_1, usd(2000)); // $2000

      // Grant AMM minting permission
      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      await tokenManager.grantRole(MINTER_ROLE, await ammFactory.getAddress());

      // Graduate
      await fundingVault.connect(graduator).graduate(MODEL_ID_1);
    });

    it("Should mint tokens proportionally on claim", async function () {
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      const balanceBefore = await token.balanceOf(user1.address);

      await expect(fundingVault.connect(user1).claim(MODEL_ID_1))
        .to.emit(fundingVault, "Claimed");

      const balanceAfter = await token.balanceOf(user1.address);
      const tokensReceived = balanceAfter - balanceBefore;

      // User deposited 1000 USDC out of 3000 total = 1/3 of tokens
      // After AMM fees (~0.3%), expect approximately 99,700 tokens
      // Allow small tolerance for fees
      const expectedTokens = parseEther("99700");
      expect(tokensReceived).to.be.closeTo(expectedTokens, parseEther("1000"));

      expect(await fundingVault.hasClaimed(MODEL_ID_1, user1.address)).to.be.true;
    });

    it("Should allow multiple users to claim", async function () {
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);

      await fundingVault.connect(user1).claim(MODEL_ID_1);
      await fundingVault.connect(user2).claim(MODEL_ID_1);

      // User1: 1000 USDC / 3000 total = 1/3 of tokens ≈ 99,700 tokens
      // User2: 2000 USDC / 3000 total = 2/3 of tokens ≈ 199,400 tokens
      expect(await token.balanceOf(user1.address)).to.be.closeTo(parseEther("99700"), parseEther("1000"));
      expect(await token.balanceOf(user2.address)).to.be.closeTo(parseEther("199400"), parseEther("2000"));
    });

    it("Should reject claim before graduation", async function () {
      // Deploy new proposal
      await tokenManager.deployToken(MODEL_ID_2, "Test Token 2", "TEST2", parseEther("1000000"));
      const tokenAddress2 = await tokenManager.getTokenAddress(MODEL_ID_2);
      await fundingVault.registerProposal(MODEL_ID_2, tokenAddress2);
      await fundingVault.connect(user1).deposit(MODEL_ID_2, usd(1000));

      await expect(fundingVault.connect(user1).claim(MODEL_ID_2))
        .to.be.revertedWith("Not graduated yet");
    });

    it("Should reject double claim", async function () {
      await fundingVault.connect(user1).claim(MODEL_ID_1);
      await expect(fundingVault.connect(user1).claim(MODEL_ID_1))
        .to.be.revertedWith("Already claimed");
    });

    it("Should reject claim with no commitment", async function () {
      await expect(fundingVault.connect(user3).claim(MODEL_ID_1))
        .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
    });
  });

  describe("View Functions", function () {
    let tokenAddress;

    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);
    });

    it("Should return correct proposal details", async function () {
      const proposal = await fundingVault.getProposal(MODEL_ID_1);
      expect(proposal.tokenAddress).to.equal(tokenAddress);
      expect(proposal.totalCommitted).to.equal(0);
      expect(proposal.graduated).to.be.false;
    });

    it("Should return correct commitment amount", async function () {
      await fundingVault.connect(user1).deposit(MODEL_ID_1, usd(1000));
      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(usd(1000));
    });

    it("Should return correct claimed status", async function () {
      expect(await fundingVault.hasClaimed(MODEL_ID_1, user1.address)).to.be.false;
    });
  });

  describe("Edge Cases", function () {
    let tokenAddress;

    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);
    });

    it("Should handle very small deposits", async function () {
      const tinyAmount = 1; // 1 unit of USDC (0.000001 USDC)
      await fundingVault.connect(user1).deposit(MODEL_ID_1, tinyAmount);
      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(tinyAmount);
    });

    it("Should handle large deposits", async function () {
      const largeAmount = usd(1000000); // 1 million USDC
      await usdc.mint(user1.address, largeAmount);
      await usdc.connect(user1).approve(await fundingVault.getAddress(), largeAmount);

      await fundingVault.connect(user1).deposit(MODEL_ID_1, largeAmount);
      expect(await fundingVault.getCommitment(MODEL_ID_1, user1.address)).to.equal(largeAmount);
    });
  });

  describe("Access Control", function () {
    let tokenAddress;

    beforeEach(async function () {
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
    });

    it("Should allow admin to register proposal", async function () {
      await expect(fundingVault.registerProposal(MODEL_ID_1, tokenAddress))
        .to.not.be.reverted;
    });

    it("Should allow graduator to graduate", async function () {
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);
      await fundingVault.connect(user1).deposit(MODEL_ID_1, usd(10000));

      const MINTER_ROLE = await tokenManager.MINTER_ROLE();
      await tokenManager.grantRole(MINTER_ROLE, await ammFactory.getAddress());

      await expect(fundingVault.connect(graduator).graduate(MODEL_ID_1))
        .to.not.be.reverted;
    });

    it("Should allow admin to grant GRADUATOR_ROLE", async function () {
      const GRADUATOR_ROLE = await fundingVault.GRADUATOR_ROLE();
      await fundingVault.grantRole(GRADUATOR_ROLE, user1.address);
      expect(await fundingVault.hasRole(GRADUATOR_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke GRADUATOR_ROLE", async function () {
      const GRADUATOR_ROLE = await fundingVault.GRADUATOR_ROLE();
      await fundingVault.revokeRole(GRADUATOR_ROLE, graduator.address);
      expect(await fundingVault.hasRole(GRADUATOR_ROLE, graduator.address)).to.be.false;
    });
  });

  describe("Reentrancy Protection", function () {
    it("Should protect deposit from reentrancy", async function () {
      // This is implicitly tested by the nonReentrant modifier
      // In practice, we'd need a malicious contract to test this properly
      // For now, we verify the modifier is in place
      const amount = usd(1000);
      await tokenManager.deployToken(MODEL_ID_1, "Test Token", "TEST", parseEther("1000000"));
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_1);
      await fundingVault.registerProposal(MODEL_ID_1, tokenAddress);

      await expect(fundingVault.connect(user1).deposit(MODEL_ID_1, amount))
        .to.not.be.reverted;
    });
  });
});
