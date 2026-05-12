const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers");
const { buildInitialParams, buildVestingConfig } = require("./helpers/tokenDeployment");

describe("DeltaVerifier Vesting Integration", function () {
  let deltaVerifier;
  let tokenManager;
  let contributionRegistry;
  let modelRegistry;
  let vestingVault;
  let token;
  let owner;
  let contributor1;
  let contributor2;

  const MODEL_ID_STR = "1";
  const MODEL_ID_UINT = 1;
  const BASE_REWARD_RATE = parseEther("1000");
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("100000");
  const DEFAULT_DURATION = 365 * 24 * 60 * 60;

  const baselineMetrics = {
    accuracy: 8540,
    precision: 8270,
    recall: 8870,
    f1: 8390,
    auroc: 9040,
  };

  const improvedMetrics = {
    accuracy: 8840,
    precision: 8540,
    recall: 9130,
    f1: 8910,
    auroc: 9350,
  };

  beforeEach(async function () {
    [owner, contributor1, contributor2] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      BASE_REWARD_RATE,
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD
    );
    await deltaVerifier.waitForDeployment();

    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    const deployTx = await tokenManager.deployTokenWithParams(
      MODEL_ID_STR,
      "Delta Token",
      "DLTA",
      parseEther("1000000"),
      buildInitialParams(owner.address, {
        vestingConfig: buildVestingConfig(),
      })
    );
    await deployTx.wait();

    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    token = HokusaiToken.attach(tokenAddress);

    await modelRegistry.registerModel(MODEL_ID_UINT, tokenAddress, "accuracy");

    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, await deltaVerifier.getAddress());
  });

  it("keeps DeltaVerifier reward math unchanged while only minting the liquid slice to the contributor", async function () {
    const evaluationData = {
      pipelineRunId: "vesting-eval-1",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 5000,
      totalSamples: 5000,
      maxCostUsd: 0,
      actualCostUsd: 0,
    };

    const expectedDelta = await deltaVerifier.calculateDeltaOneForModel(
      MODEL_ID_UINT,
      baselineMetrics,
      improvedMetrics
    );
    const expectedReward = await deltaVerifier.calculateRewardDynamic(MODEL_ID_STR, expectedDelta, 10000, 5000);

    await expect(deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData))
      .to.emit(deltaVerifier, "RewardCalculated")
      .withArgs(contributor1.address, expectedDelta, expectedReward);

    expect(await token.balanceOf(contributor1.address)).to.equal((expectedReward * 1000n) / 10000n);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(expectedReward - ((expectedReward * 1000n) / 10000n));
  });

  it("creates one vesting schedule per contributor for batch rewards", async function () {
    const contributors = [
      { walletAddress: contributor1.address, weight: 6000 },
      { walletAddress: contributor2.address, weight: 4000 },
    ];
    const evaluationData = {
      pipelineRunId: "vesting-eval-2",
      baselineMetrics,
      newMetrics: improvedMetrics,
      maxCostUsd: 0,
      actualCostUsd: 0,
    };

    const expectedDelta = await deltaVerifier.calculateDeltaOneForModel(
      MODEL_ID_UINT,
      baselineMetrics,
      improvedMetrics
    );
    const totalReward = await deltaVerifier.calculateRewardDynamic(MODEL_ID_STR, expectedDelta, 10000, 0);

    await deltaVerifier.submitEvaluationWithMultipleContributors(MODEL_ID_UINT, evaluationData, contributors);

    const reward1 = (totalReward * 6000n) / 10000n;
    const reward2 = totalReward - reward1;

    expect(await token.balanceOf(contributor1.address)).to.equal((reward1 * 1000n) / 10000n);
    expect(await token.balanceOf(contributor2.address)).to.equal((reward2 * 1000n) / 10000n);
    expect(await vestingVault.getSchedulesByBeneficiary(contributor1.address)).to.deep.equal([0n]);
    expect(await vestingVault.getSchedulesByBeneficiary(contributor2.address)).to.deep.equal([1n]);
  });

  it("allows the contributor to claim the vested portion over time", async function () {
    const evaluationData = {
      pipelineRunId: "vesting-eval-3",
      baselineMetrics,
      newMetrics: improvedMetrics,
      contributor: contributor1.address,
      contributorWeight: 10000,
      contributedSamples: 5000,
      totalSamples: 5000,
      maxCostUsd: 0,
      actualCostUsd: 0,
    };

    const rewardAmount = await deltaVerifier.calculateRewardDynamic(
      MODEL_ID_STR,
      await deltaVerifier.calculateDeltaOneForModel(MODEL_ID_UINT, baselineMetrics, improvedMetrics),
      10000,
      5000
    );
    const immediateAmount = (rewardAmount * 1000n) / 10000n;
    const vestedAmount = rewardAmount - immediateAmount;
    const perSecondVesting = vestedAmount / BigInt(DEFAULT_DURATION);

    await deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData);

    await time.increase(1);
    await vestingVault.connect(contributor1).claim(0);

    await time.increase((DEFAULT_DURATION / 2) - 1);
    await vestingVault.connect(contributor1).claim(0);

    expect(await token.balanceOf(contributor1.address)).to.be.closeTo(
      immediateAmount + (vestedAmount / 2n),
      perSecondVesting * 3n
    );

    await time.increase(DEFAULT_DURATION / 2);
    await vestingVault.connect(contributor1).claim(0);

    expect(await token.balanceOf(contributor1.address)).to.equal(rewardAmount);
  });
});
