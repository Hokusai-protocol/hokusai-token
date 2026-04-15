const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");

describe("FundingVault Comprehensive", function () {
  const MODEL_ID = "comprehensive-model";
  const USDC_DECIMALS = 6;

  function usd(amount) {
    return parseUnits(amount.toString(), USDC_DECIMALS);
  }

  async function getDeadline(offsetDays = 30) {
    const latestBlock = await ethers.provider.getBlock("latest");
    return latestBlock.timestamp + 86400 * offsetDays;
  }

  async function setup() {
    const [owner, graduator, user1, user2, user3] = await ethers.getSigners();

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

    for (const user of [user1, user2, user3]) {
      await usdc.mint(user.address, usd(100000));
      await usdc.connect(user).approve(await fundingVault.getAddress(), usd(100000));
    }

    await tokenManager.deployToken(MODEL_ID, "Comprehensive Token", "COMP", parseEther("1000000"));
    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, "comprehensive metric");
    await fundingVault.registerProposal(MODEL_ID, tokenAddress, await getDeadline());

    return {
      fundingVault,
      tokenAddress,
      graduator,
      user1,
      user2,
      user3
    };
  }

  it("uses snapshot totals for final claim allocation after lockup", async function () {
    const { fundingVault, tokenAddress, graduator, user1, user2, user3 } = await setup();

    await fundingVault.connect(user1).deposit(MODEL_ID, usd(4000));
    await fundingVault.connect(user2).deposit(MODEL_ID, usd(6000));
    await fundingVault.connect(user3).deposit(MODEL_ID, usd(1000));

    await fundingVault.connect(graduator).announceGraduation(MODEL_ID);

    await expect(fundingVault.connect(user3).deposit(MODEL_ID, usd(9000)))
      .to.be.revertedWith("Graduation announced");

    const proposalBefore = await fundingVault.getProposal(MODEL_ID);
    expect(proposalBefore.snapshotTotalCommitted).to.equal(usd(11000));
    expect(await fundingVault.claimableAccounts(MODEL_ID)).to.equal(3);

    await fundingVault.connect(graduator).graduate(MODEL_ID);

    const proposalAfter = await fundingVault.getProposal(MODEL_ID);
    const totalTokens = proposalAfter.totalTokens;

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const user1Before = await token.balanceOf(user1.address);
    const user2Before = await token.balanceOf(user2.address);
    const user3Before = await token.balanceOf(user3.address);

    await fundingVault.connect(user1).claim(MODEL_ID);
    await fundingVault.connect(user2).claim(MODEL_ID);
    await fundingVault.connect(user3).claim(MODEL_ID);

    const user1After = await token.balanceOf(user1.address);
    const user2After = await token.balanceOf(user2.address);
    const user3After = await token.balanceOf(user3.address);

    const user1Claimed = user1After - user1Before;
    const user2Claimed = user2After - user2Before;
    const user3Claimed = user3After - user3Before;

    const expected1 = (usd(4000) * totalTokens) / usd(11000);
    const expected2 = (usd(6000) * totalTokens) / usd(11000);
    const expected3 = (usd(1000) * totalTokens) / usd(11000);

    expect(user1Claimed).to.equal(expected1);
    expect(user2Claimed).to.equal(expected2);
    expect(user3Claimed).to.equal(expected3);
  });
});
