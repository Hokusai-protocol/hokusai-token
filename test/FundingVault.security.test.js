const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");

describe("FundingVault Security", function () {
  const MODEL_ID = "security-model";
  const USDC_DECIMALS = 6;

  function usd(amount) {
    return parseUnits(amount.toString(), USDC_DECIMALS);
  }

  async function getDeadline(offsetDays = 30) {
    const latestBlock = await ethers.provider.getBlock("latest");
    return latestBlock.timestamp + 86400 * offsetDays;
  }

  async function deployFixture() {
    const [owner, graduator, earlyInvestor, attacker] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    const ammFactory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await usdc.getAddress(),
      owner.address
    );
    await ammFactory.waitForDeployment();

    const FundingVault = await ethers.getContractFactory("FundingVault");
    const fundingVault = await FundingVault.deploy(
      await usdc.getAddress(),
      await ammFactory.getAddress(),
      await tokenManager.getAddress(),
      await modelRegistry.getAddress(),
      owner.address
    );
    await fundingVault.waitForDeployment();

    const GRADUATOR_ROLE = await fundingVault.GRADUATOR_ROLE();
    await fundingVault.grantRole(GRADUATOR_ROLE, graduator.address);

    const MINTER_ROLE = await tokenManager.MINTER_ROLE();
    await tokenManager.grantRole(MINTER_ROLE, await fundingVault.getAddress());
    await tokenManager.grantRole(MINTER_ROLE, await ammFactory.getAddress());

    const DEFAULT_ADMIN_ROLE = await tokenManager.DEFAULT_ADMIN_ROLE();
    await tokenManager.grantRole(DEFAULT_ADMIN_ROLE, await fundingVault.getAddress());

    await ammFactory.transferOwnership(await fundingVault.getAddress());
    await modelRegistry.setPoolRegistrar(await fundingVault.getAddress(), true);

    await usdc.mint(earlyInvestor.address, usd(100000));
    await usdc.mint(attacker.address, usd(100000));

    await usdc.connect(earlyInvestor).approve(await fundingVault.getAddress(), usd(100000));
    await usdc.connect(attacker).approve(await fundingVault.getAddress(), usd(100000));

    await tokenManager.deployToken(MODEL_ID, "Security Token", "SECT", parseEther("1000000"));
    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, "security metric");
    await fundingVault.registerProposal(MODEL_ID, tokenAddress, await getDeadline());

    return {
      fundingVault,
      tokenAddress,
      owner,
      graduator,
      earlyInvestor,
      attacker
    };
  }

  it("FIXED: attacker cannot dilute commitments after graduation announcement", async function () {
    const {
      fundingVault,
      tokenAddress,
      graduator,
      earlyInvestor,
      attacker
    } = await deployFixture();

    await fundingVault.connect(earlyInvestor).deposit(MODEL_ID, usd(10000));

    await expect(fundingVault.connect(graduator).announceGraduation(MODEL_ID))
      .to.emit(fundingVault, "GraduationAnnounced")
      .withArgs(MODEL_ID, usd(10000), 1);

    await expect(fundingVault.connect(attacker).deposit(MODEL_ID, usd(90000)))
      .to.be.revertedWith("Graduation announced");

    const proposal = await fundingVault.getProposal(MODEL_ID);
    expect(proposal.snapshotTotalCommitted).to.equal(usd(10000));
    expect(await fundingVault.getSnapshottedCommitment(MODEL_ID, earlyInvestor.address)).to.equal(usd(10000));
    expect(await fundingVault.getSnapshottedCommitment(MODEL_ID, attacker.address)).to.equal(0);

    await fundingVault.connect(graduator).graduate(MODEL_ID);

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    const earlyBalanceBefore = await token.balanceOf(earlyInvestor.address);

    await expect(fundingVault.connect(earlyInvestor).claim(MODEL_ID))
      .to.emit(fundingVault, "Claimed");

    const earlyBalanceAfter = await token.balanceOf(earlyInvestor.address);
    expect(earlyBalanceAfter).to.be.gt(earlyBalanceBefore);

    await expect(fundingVault.connect(attacker).claim(MODEL_ID))
      .to.be.revertedWithCustomError(fundingVault, "InvalidAmount");
  });
});
