const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildInitialParams, defaultVestingConfig } = require("./helpers/tokenDeployment");

describe("DeltaVerifier - Vesting Integration", function () {
  let tokenManager;
  let registry;
  let vault;
  let token;
  let owner;
  let governor;
  let contributor1;

  const MODEL_ID = "integration-model";
  const TOTAL_SUPPLY = ethers.parseEther("1000000");

  beforeEach(async function () {
    [owner, governor, contributor1] = await ethers.getSigners();

    // Deploy registry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    registry = await ModelRegistry.deploy();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(registry.target);

    // Deploy vault
    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vault = await RewardVestingVault.deploy();
    await vault.setController(tokenManager.target);
    await tokenManager.setRewardVestingVault(vault.target);

    // Deploy token with default vesting
    const params = buildInitialParams(governor.address);
    await tokenManager.deployTokenWithParams(
      MODEL_ID,
      "Test Token",
      "TEST",
      TOTAL_SUPPLY,
      params
    );

    const tokenAddress = await tokenManager.modelTokens(MODEL_ID);
    token = await ethers.getContractAt("HokusaiToken", tokenAddress);
  });

  it("Should vest 90% of reward for 365 days", async function () {
    const rewardAmount = ethers.parseEther("10000");
    
    // Simulate reward via mintReward (DeltaVerifier would call this)
    await tokenManager.mintReward(MODEL_ID, contributor1.address, rewardAmount);

    // Check immediate balance (10%)
    const immediateBalance = await token.balanceOf(contributor1.address);
    expect(immediateBalance).to.equal(rewardAmount / 10n);

    // Check vault balance (90%)
    const vaultBalance = await token.balanceOf(vault.target);
    expect(vaultBalance).to.equal(rewardAmount * 9n / 10n);

    // Check schedule created
    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    expect(schedules.length).to.equal(1);

    const schedule = await vault.getSchedule(schedules[0]);
    expect(schedule.vestedTotal).to.equal(rewardAmount * 9n / 10n);
  });

  it("Should allow ~50% claim after 6 months", async function () {
    const rewardAmount = ethers.parseEther("10000");
    await tokenManager.mintReward(MODEL_ID, contributor1.address, rewardAmount);

    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    const scheduleId = schedules[0];

    // Fast forward 6 months (182.5 days)
    await ethers.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine");

    // Claim
    await vault.connect(contributor1).claim(scheduleId);

    // Should have ~10% immediate + ~45% vested (90% * 50%)
    const balance = await token.balanceOf(contributor1.address);
    const expected = (rewardAmount / 10n) + (rewardAmount * 9n / 20n);
    
    // Allow 1% tolerance for rounding
    expect(balance).to.be.closeTo(expected, ethers.parseEther("100"));
  });

  it("Should allow full claim after 12 months", async function () {
    const rewardAmount = ethers.parseEther("10000");
    await tokenManager.mintReward(MODEL_ID, contributor1.address, rewardAmount);

    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    const scheduleId = schedules[0];

    // Fast forward 12 months
    await ethers.provider.send("evm_increaseTime", [365 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine");

    // Claim
    await vault.connect(contributor1).claim(scheduleId);

    // Should have full reward
    const balance = await token.balanceOf(contributor1.address);
    expect(balance).to.equal(rewardAmount);
  });

  it("Should work with vesting disabled", async function () {
    // Deploy new token with vesting disabled
    const params = buildInitialParams(governor.address, {
      vestingConfig: {
        enabled: false,
        immediateUnlockBps: 10000,
        vestingDurationSeconds: 0,
        cliffSeconds: 0
      }
    });

    await tokenManager.deployTokenWithParams(
      "model-no-vest",
      "No Vest",
      "NOVEST",
      TOTAL_SUPPLY,
      params
    );

    const rewardAmount = ethers.parseEther("10000");
    await tokenManager.mintReward("model-no-vest", contributor1.address, rewardAmount);

    const tokenAddr = await tokenManager.modelTokens("model-no-vest");
    const noVestToken = await ethers.getContractAt("HokusaiToken", tokenAddr);

    // Should get full amount immediately
    const balance = await noVestToken.balanceOf(contributor1.address);
    expect(balance).to.equal(rewardAmount);

    // No schedule created
    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    expect(schedules.length).to.equal(0);
  });
});
