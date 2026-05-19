const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits } = require("ethers");
const { buildInitialParams, buildVestingConfig } = require("./helpers/tokenDeployment");

// Scenario-specific separated-accounting regression coverage now lives in
// test/AllocationAccountingSeparation.regression.test.js.
describe("Investor allocation separation", function () {
  const MODEL_ID = "cap-model";
  const INVESTOR_ALLOCATION = parseEther("100");
  const SUPPLIER_ALLOCATION = parseEther("25");

  let owner;
  let buyer;
  let contributor;
  let treasury;
  let tokenManager;
  let vestingVault;
  let token;
  let amm;
  let usdc;

  beforeEach(async function () {
    [owner, buyer, contributor, treasury] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    await tokenManager.deployTokenWithAllocations(
      MODEL_ID,
      "Cap Model Token",
      "CMT",
      SUPPLIER_ALLOCATION,
      owner.address,
      INVESTOR_ALLOCATION,
      buildInitialParams(owner.address, {
        vestingConfig: buildVestingConfig(),
      })
    );

    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    amm = await HokusaiAMM.deploy(
      await usdc.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      100000,
      0,
      0,
      parseUnits("1000000", 6),
      parseUnits("1", 6)
    );
    await amm.waitForDeployment();

    await amm.setMaxTradeBps(5000);
    await tokenManager.authorizeAMM(await amm.getAddress());

    await usdc.mint(buyer.address, parseUnits("1000", 6));
    await usdc.connect(buyer).approve(await amm.getAddress(), parseUnits("1000", 6));
  });

  it("separates AMM investor minting from reward minting and restores headroom on sell", async function () {
    await amm.connect(buyer).buy(
      parseUnits("100", 6),
      INVESTOR_ALLOCATION,
      buyer.address,
      (await time.latest()) + 3600
    );

    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
    expect(await token.getRemainingInvestorAllocation()).to.equal(0);

    await expect(
      amm.connect(buyer).buy(parseUnits("1", 6), 0, buyer.address, (await time.latest()) + 3600)
    ).to.be.revertedWith("Exceeds investor allocation");

    const rewardAmount = parseEther("30");
    const immediateAmount = parseEther("3");
    const vestedAmount = rewardAmount - immediateAmount;
    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    expect(await token.rewardMinted()).to.equal(rewardAmount);
    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
    expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);
    expect(await token.totalSupply()).to.equal(INVESTOR_ALLOCATION + rewardAmount);
    expect(await token.totalSupply()).to.be.gt(await token.maxSupply());

    await token.connect(buyer).approve(await amm.getAddress(), parseEther("40"));
    await amm.connect(buyer).sell(parseEther("40"), 0, buyer.address, (await time.latest()) + 3600);

    expect(await token.investorMinted()).to.equal(parseEther("60"));
    expect(await token.getRemainingInvestorAllocation()).to.equal(parseEther("40"));

    await amm.connect(buyer).buy(
      parseUnits("40", 6),
      parseEther("40"),
      buyer.address,
      (await time.latest()) + 3600
    );

    expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
  });
});
