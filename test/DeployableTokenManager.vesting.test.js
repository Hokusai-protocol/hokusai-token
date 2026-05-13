const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers");
const {
  buildDisabledVestingConfig,
  buildInitialParams,
  buildVestingConfig,
} = require("./helpers/tokenDeployment");

describe("DeployableTokenManager Vesting", function () {
  let tokenManager;
  let modelRegistry;
  let tokenDeploymentFactory;
  let vestingVault;
  let owner;
  let contributor;
  let contributor2;
  let other;

  const MODEL_ID = "vesting-model";
  const DEFAULT_VESTING_SENTINEL = {
    enabled: false,
    immediateUnlockBps: 0,
    vestingDurationSeconds: 0,
    cliffSeconds: 0,
  };

  async function deployToken(modelId, vestingConfig) {
    await tokenManager.deployTokenWithParams(
      modelId,
      "Vesting Token",
      "VEST",
      parseEther("1000000"),
      buildInitialParams(owner.address, { vestingConfig })
    );

    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    const paramsAddress = await tokenManager.getParamsAddress(modelId);
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");

    return {
      token: HokusaiToken.attach(tokenAddress),
      params: HokusaiParams.attach(paramsAddress),
      tokenAddress,
      paramsAddress,
    };
  }

  beforeEach(async function () {
    [owner, contributor, contributor2, other] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
    tokenDeploymentFactory = await TokenDeploymentFactory.deploy();
    await tokenDeploymentFactory.waitForDeployment();

    const DeployableTokenManager = await ethers.getContractFactory("DeployableTokenManager");
    tokenManager = await DeployableTokenManager.deploy(
      await modelRegistry.getAddress(),
      await tokenDeploymentFactory.getAddress()
    );
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());
  });

  it("defaults to 10% immediate unlock and 12-month vesting when the config is omitted", async function () {
    const { token, params } = await deployToken(MODEL_ID, DEFAULT_VESTING_SENTINEL);
    const rewardAmount = parseEther("250000");
    const immediateAmount = parseEther("25000");
    const vestedAmount = rewardAmount - immediateAmount;

    expect(await params.vestingEnabled()).to.equal(true);
    expect(await params.immediateUnlockBps()).to.equal(1000);
    expect(await params.vestingDurationSeconds()).to.equal(365 * 24 * 60 * 60);
    expect(await params.cliffSeconds()).to.equal(0);

    await expect(tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount))
      .to.emit(tokenManager, "RewardVestingCreated")
      .withArgs(
        MODEL_ID,
        contributor.address,
        rewardAmount,
        immediateAmount,
        vestedAmount,
        anyValue,
        anyValue
      );

    expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);
    expect(await vestingVault.getSchedulesByBeneficiary(contributor.address)).to.deep.equal([0n]);
  });

  it("supports custom immediate unlock percentages and durations", async function () {
    const customConfig = buildVestingConfig({
      immediateUnlockBps: 2500,
      vestingDurationSeconds: 30 * 24 * 60 * 60,
    });
    const { token, params } = await deployToken("custom-vesting", customConfig);
    const rewardAmount = parseEther("1000");

    await tokenManager.mintReward("custom-vesting", contributor.address, rewardAmount);

    expect(await params.immediateUnlockBps()).to.equal(2500);
    expect(await params.vestingDurationSeconds()).to.equal(30 * 24 * 60 * 60);
    expect(await token.balanceOf(contributor.address)).to.equal(parseEther("250"));
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(parseEther("750"));
  });

  it("lets contributors claim vested rewards over time and rejects over-claims", async function () {
    const { token } = await deployToken(
      MODEL_ID,
      buildVestingConfig({ cliffSeconds: 7 * 24 * 60 * 60 })
    );
    const rewardAmount = parseEther("250000");
    const vestedAmount = parseEther("225000");
    const perSecondVesting = vestedAmount / BigInt(365 * 24 * 60 * 60);

    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    await expect(vestingVault.connect(contributor).claim(0)).to.be.revertedWith("No vested rewards available");

    await time.increase((365 * 24 * 60 * 60) / 2);
    const halfVested = (vestedAmount * BigInt((365 * 24 * 60 * 60) / 2)) / BigInt(365 * 24 * 60 * 60);

    await vestingVault.connect(contributor).claim(0);
    expect(await token.balanceOf(contributor.address)).to.be.closeTo(
      parseEther("25000") + halfVested,
      perSecondVesting * 3n
    );

    await time.increase((365 * 24 * 60 * 60) / 2);
    await vestingVault.connect(contributor).claim(0);

    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
    await expect(vestingVault.connect(contributor).claim(0)).to.be.revertedWith("No vested rewards available");
  });

  it("applies vesting per recipient during batch minting", async function () {
    const { token } = await deployToken(MODEL_ID, buildVestingConfig());
    const recipients = [contributor.address, contributor2.address, other.address];
    const amounts = [parseEther("100"), parseEther("50"), 0];

    await expect(tokenManager.batchMintReward(MODEL_ID, recipients, amounts))
      .to.emit(tokenManager, "ContributorSkipped")
      .withArgs(other.address, 2);

    expect(await token.balanceOf(contributor.address)).to.equal(parseEther("10"));
    expect(await token.balanceOf(contributor2.address)).to.equal(parseEther("5"));

    const scheduleIds1 = await vestingVault.getSchedulesByBeneficiary(contributor.address);
    const scheduleIds2 = await vestingVault.getSchedulesByBeneficiary(contributor2.address);
    expect(scheduleIds1).to.deep.equal([0n]);
    expect(scheduleIds2).to.deep.equal([1n]);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(parseEther("135"));
  });

  it("mints entire reward as liquid when immediateUnlockBps is 10000 (100%)", async function () {
    const { token } = await deployToken(
      "full-liquid",
      buildVestingConfig({ immediateUnlockBps: 10000 })
    );
    const rewardAmount = parseEther("1000");

    await tokenManager.mintReward("full-liquid", contributor.address, rewardAmount);

    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
    expect(await vestingVault.getSchedulesByBeneficiary(contributor.address)).to.deep.equal([]);
  });

  it("sends entire reward to vault when immediateUnlockBps is 0 (100% vested)", async function () {
    const { token } = await deployToken(
      "full-vested",
      buildVestingConfig({ immediateUnlockBps: 0 })
    );
    const rewardAmount = parseEther("1000");

    await tokenManager.mintReward("full-vested", contributor.address, rewardAmount);

    expect(await token.balanceOf(contributor.address)).to.equal(0);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(rewardAmount);
    const scheduleIds = await vestingVault.getSchedulesByBeneficiary(contributor.address);
    expect(scheduleIds).to.deep.equal([0n]);
    const schedule = await vestingVault.getSchedule(0);
    expect(schedule.totalAmount).to.equal(rewardAmount);
  });

  it("keeps rewards fully liquid when vesting is disabled", async function () {
    const { token, params } = await deployToken("no-vesting", buildDisabledVestingConfig());
    const rewardAmount = parseEther("500");

    expect(await params.vestingEnabled()).to.equal(false);

    await tokenManager.mintReward("no-vesting", contributor.address, rewardAmount);

    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount);
    expect(await vestingVault.getSchedulesByBeneficiary(contributor.address)).to.deep.equal([]);
  });

  it("setVestingVault can only be called once and only by owner", async function () {
    await expect(
      tokenManager.connect(other).setVestingVault(other.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      tokenManager.setVestingVault(contributor.address)
    ).to.be.revertedWith("Vesting vault already set");
  });
});
