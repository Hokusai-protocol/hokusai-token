const { expect } = require("chai");
const { ethers } = require("hardhat");
const { buildInitialParams } = require("./helpers/tokenDeployment");

describe("DeltaVerifier - Vesting Integration", function () {
  let deltaVerifier;
  let modelRegistry;
  let tokenManager;
  let vault;
  let token;
  let contributionRegistry;
  let owner;
  let governor;
  let contributor1;
  let contributor2;
  let contributor3;

  const MODEL_ID_NUM = 1;
  const MODEL_ID_STR = "1";
  const TOTAL_SUPPLY = ethers.parseEther("1000000");
  const BASE_REWARD_RATE = ethers.parseEther("1000");
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = ethers.parseEther("1000000");

  // Metrics that produce a clear improvement (multi-metric default path)
  const baselineMetrics = {
    accuracy: 5000,
    precision: 5000,
    recall: 5000,
    f1: 5000,
    auroc: 5000
  };

  const improvedMetrics = {
    accuracy: 6000,
    precision: 6000,
    recall: 6000,
    f1: 6000,
    auroc: 6000
  };

  beforeEach(async function () {
    [owner, governor, contributor1, contributor2, contributor3] =
      await ethers.getSigners();

    // Deploy infrastructure
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(modelRegistry.target);

    const RewardVestingVault =
      await ethers.getContractFactory("RewardVestingVault");
    vault = await RewardVestingVault.deploy();
    await vault.setController(tokenManager.target);
    await tokenManager.setRewardVestingVault(vault.target);

    const DataContributionRegistry = await ethers.getContractFactory(
      "DataContributionRegistry"
    );
    contributionRegistry = await DataContributionRegistry.deploy();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      modelRegistry.target,
      tokenManager.target,
      contributionRegistry.target,
      BASE_REWARD_RATE,
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD
    );

    // Wire up permissions
    await tokenManager.setDeltaVerifier(deltaVerifier.target);
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, deltaVerifier.target);

    // Deploy token with default vesting (10% immediate / 90% over 365 days)
    const params = buildInitialParams(governor.address);
    await tokenManager.deployTokenWithParams(
      MODEL_ID_STR,
      "Test Token",
      "TEST",
      TOTAL_SUPPLY,
      params
    );

    const tokenAddress = await tokenManager.modelTokens(MODEL_ID_STR);
    token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    // Register model in ModelRegistry so DeltaVerifier can look it up by uint256
    await modelRegistry.registerModel(MODEL_ID_NUM, tokenAddress, "multiclass");
  });

  it("submitEvaluation routes reward through vesting: 10% immediate + 90% vested", async function () {
    const evalData = {
      pipelineRunId: "run_vesting_001",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 1000,
      totalSamples: 1000,
      maxCostUsd: 0,
      actualCostUsd: 0
    };

    await deltaVerifier.submitEvaluation(MODEL_ID_NUM, evalData);

    const immediateBalance = await token.balanceOf(contributor1.address);
    const vaultBalance = await token.balanceOf(vault.target);
    const totalReward = immediateBalance + vaultBalance;

    expect(totalReward).to.be.gt(0);
    // 10% immediate
    expect(immediateBalance).to.equal(totalReward / 10n);
    // 90% in vault
    expect(vaultBalance).to.equal(totalReward - totalReward / 10n);

    // Vesting schedule created
    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    expect(schedules.length).to.equal(1);

    const schedule = await vault.getSchedule(schedules[0]);
    expect(schedule.vestedTotal).to.equal(vaultBalance);
    expect(schedule.endTimestamp - schedule.startTimestamp).to.equal(365n * 24n * 60n * 60n);
  });

  it("submitEvaluationWithMultipleContributors: three contributors each get own schedule", async function () {
    const contributors = [
      { walletAddress: contributor1.address, weight: 5000 },
      { walletAddress: contributor2.address, weight: 3000 },
      { walletAddress: contributor3.address, weight: 2000 }
    ];

    const evalData = {
      pipelineRunId: "run_batch_vesting",
      baselineMetrics,
      newMetrics: improvedMetrics,
      maxCostUsd: 0,
      actualCostUsd: 0
    };

    await deltaVerifier.submitEvaluationWithMultipleContributors(
      MODEL_ID_NUM,
      evalData,
      contributors
    );

    // Each contributor has exactly one schedule
    for (const c of [contributor1, contributor2, contributor3]) {
      const schedules = await vault.getSchedulesForBeneficiary(c.address);
      expect(schedules.length).to.equal(1);
    }

    // Proportionality: contributor1 (50%) vested ≈ 2.5× contributor3 (20%) vested
    const sched1Id = (await vault.getSchedulesForBeneficiary(contributor1.address))[0];
    const sched3Id = (await vault.getSchedulesForBeneficiary(contributor3.address))[0];
    const sched1 = await vault.getSchedule(sched1Id);
    const sched3 = await vault.getSchedule(sched3Id);

    // 5000/2000 = 2.5 ratio; allow a 1-token rounding tolerance
    expect(sched1.vestedTotal).to.be.closeTo(
      (sched3.vestedTotal * 5n) / 2n,
      ethers.parseEther("1")
    );

    // Immediate balances are also proportional
    const bal1 = await token.balanceOf(contributor1.address);
    const bal3 = await token.balanceOf(contributor3.address);
    expect(bal1).to.be.closeTo((bal3 * 5n) / 2n, ethers.parseEther("1"));
  });

  it("AMM cannot drain unvested rewards: transfer of full reward reverts", async function () {
    const evalData = {
      pipelineRunId: "run_amm_drain",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 1000,
      totalSamples: 1000,
      maxCostUsd: 0,
      actualCostUsd: 0
    };

    await deltaVerifier.submitEvaluation(MODEL_ID_NUM, evalData);

    const liquidBalance = await token.balanceOf(contributor1.address);
    const vaultBalance = await token.balanceOf(vault.target);
    const totalReward = liquidBalance + vaultBalance;

    // Contributor only holds the liquid 10%; the other 90% is in the vault
    expect(liquidBalance).to.equal(totalReward / 10n);

    // Approve a mock AMM for the full reward amount
    const mockAmm = contributor2;
    await token.connect(contributor1).approve(mockAmm.address, totalReward);

    // AMM trying to pull the full reward (liquid + unvested) must revert —
    // the contributor simply doesn't hold the unvested portion
    await expect(
      token
        .connect(contributor1)
        .transfer(mockAmm.address, totalReward)
    ).to.be.reverted;

    // AMM can successfully pull exactly the liquid 10%
    await expect(
      token
        .connect(contributor1)
        .transfer(mockAmm.address, liquidBalance)
    ).to.not.be.reverted;
  });

  it("Should allow ~50% claim after 6 months and full claim after 12 months", async function () {
    const evalData = {
      pipelineRunId: "run_time_vesting",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 1000,
      totalSamples: 1000,
      maxCostUsd: 0,
      actualCostUsd: 0
    };

    await deltaVerifier.submitEvaluation(MODEL_ID_NUM, evalData);

    const immediateBalance = await token.balanceOf(contributor1.address);
    const scheduleIds = await vault.getSchedulesForBeneficiary(contributor1.address);
    const scheduleId = scheduleIds[0];
    const schedule = await vault.getSchedule(scheduleId);
    const vestedTotal = schedule.vestedTotal;

    // 6-month claim: expect ~50% of vested tokens
    await ethers.provider.send("evm_increaseTime", [182 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine");

    await vault.connect(contributor1).claim(scheduleId);

    const balanceAfter6m = await token.balanceOf(contributor1.address);
    const claimed6m = balanceAfter6m - immediateBalance;
    // 182/365 ≈ 49.86%, not exactly 50% — allow ~2000-token rounding tolerance
    expect(claimed6m).to.be.closeTo(vestedTotal / 2n, ethers.parseEther("2000"));

    // 12-month claim: remaining vested tokens become claimable
    await ethers.provider.send("evm_increaseTime", [183 * 24 * 60 * 60]);
    await ethers.provider.send("evm_mine");

    await vault.connect(contributor1).claim(scheduleId);

    const finalBalance = await token.balanceOf(contributor1.address);
    // Should equal immediate + full vested portion
    expect(finalBalance).to.be.closeTo(
      immediateBalance + vestedTotal,
      ethers.parseEther("1")
    );
  });

  it("Should work with vesting disabled: full amount minted immediately", async function () {
    const { buildInitialParams: build } = require("./helpers/tokenDeployment");
    const noVestParams = build(governor.address, {
      vestingConfig: {
        enabled: false,
        immediateUnlockBps: 10000,
        vestingDurationSeconds: 0,
        cliffSeconds: 0
      }
    });

    await tokenManager.deployTokenWithParams(
      "2",
      "No Vest Token",
      "NOVEST",
      TOTAL_SUPPLY,
      noVestParams
    );

    const noVestTokenAddr = await tokenManager.modelTokens("2");
    const noVestToken = await ethers.getContractAt("HokusaiToken", noVestTokenAddr);

    await modelRegistry.registerModel(2, noVestTokenAddr, "multiclass");

    const evalData = {
      pipelineRunId: "run_no_vest",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 1000,
      totalSamples: 1000,
      maxCostUsd: 0,
      actualCostUsd: 0
    };

    await deltaVerifier.submitEvaluation(2, evalData);

    const balance = await noVestToken.balanceOf(contributor1.address);
    expect(balance).to.be.gt(0);

    // No vault balance — full reward is liquid
    const vaultBalance = await noVestToken.balanceOf(vault.target);
    expect(vaultBalance).to.equal(0);

    // No schedule created
    const schedules = await vault.getSchedulesForBeneficiary(contributor1.address);
    expect(schedules.length).to.equal(0);
  });
});
