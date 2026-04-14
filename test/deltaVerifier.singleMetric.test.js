const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");

describe("DeltaVerifier - Single Metric Support", function () {
  let deltaVerifier;
  let modelRegistry;
  let tokenManager;
  let hokusaiToken;
  let hokusaiParams;
  let contributionRegistry;
  let owner;
  let contributor1;
  let contributor2;

  const MULTI_METRIC_MODEL_ID = 1;
  const SINGLE_METRIC_MODEL_ID = 2;
  const MODEL_ID_STR = "1";
  const SINGLE_MODEL_ID_STR = "2";
  const BASE_REWARD_RATE = parseEther("1000");
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("100000");

  const sampleBaselineMetrics = {
    accuracy: 8540,
    precision: 8270,
    recall: 8870,
    f1: 8390,
    auroc: 9040
  };

  const sampleNewMetrics = {
    accuracy: 8840,
    precision: 8540,
    recall: 9130,
    f1: 8910,
    auroc: 9350
  };

  // Single-metric benchmarks: only accuracy field matters
  const singleMetricBaseline = {
    accuracy: 7500, // 75% success rate
    precision: 0,
    recall: 0,
    f1: 0,
    auroc: 0
  };

  const singleMetricNew = {
    accuracy: 7600, // 76% success rate (1pp improvement)
    precision: 0,
    recall: 0,
    f1: 0,
    auroc: 0
  };

  beforeEach(async function () {
    [owner, contributor1, contributor2] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();

    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = await HokusaiParams.deploy(
      1000, 8000, ethers.ZeroHash, "", owner.address
    );

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy(
      "Hokusai Token", "HOKU", owner.address, hokusaiParams.target,
      parseEther("10000"), 0, 0, ZeroAddress
    );

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(modelRegistry.target);

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    contributionRegistry = await DataContributionRegistry.deploy();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      modelRegistry.target, tokenManager.target, contributionRegistry.target,
      BASE_REWARD_RATE, MIN_IMPROVEMENT_BPS, MAX_REWARD
    );

    await hokusaiToken.setController(tokenManager.target);
    await tokenManager.deployToken(MODEL_ID_STR, "Multi Token", "MTK", parseEther("10000"));
    await tokenManager.deployToken(SINGLE_MODEL_ID_STR, "Single Token", "STK", parseEther("10000"));
    await modelRegistry.registerModel(MULTI_METRIC_MODEL_ID, hokusaiToken.target, "accuracy");

    // Register single-metric model with its TokenManager-deployed token
    const singleTokenAddr = await tokenManager.getTokenAddress(SINGLE_MODEL_ID_STR);
    await modelRegistry.registerModel(SINGLE_METRIC_MODEL_ID, singleTokenAddr, "success_rate");

    await tokenManager.setDeltaVerifier(deltaVerifier.target);

    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, deltaVerifier.target);
  });

  describe("MetricType Configuration", function () {
    it("should default to MultiMetric (0) for all models", async function () {
      expect(await deltaVerifier.modelMetricType(MULTI_METRIC_MODEL_ID)).to.equal(0);
      expect(await deltaVerifier.modelMetricType(SINGLE_METRIC_MODEL_ID)).to.equal(0);
    });

    it("should allow owner to set metric type to SingleMetric", async function () {
      await deltaVerifier.setModelMetricType(SINGLE_METRIC_MODEL_ID, 1);
      expect(await deltaVerifier.modelMetricType(SINGLE_METRIC_MODEL_ID)).to.equal(1);
    });

    it("should emit ModelMetricTypeSet event", async function () {
      await expect(deltaVerifier.setModelMetricType(SINGLE_METRIC_MODEL_ID, 1))
        .to.emit(deltaVerifier, "ModelMetricTypeSet")
        .withArgs(SINGLE_METRIC_MODEL_ID, 1);
    });

    it("should revert if non-owner tries to set metric type", async function () {
      await expect(
        deltaVerifier.connect(contributor1).setModelMetricType(SINGLE_METRIC_MODEL_ID, 1)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("should revert if model is not registered", async function () {
      await expect(
        deltaVerifier.setModelMetricType(999, 1)
      ).to.be.revertedWith("Model not registered");
    });
  });

  describe("calculateDeltaOneSingleMetric", function () {
    it("should compute delta on a single value", async function () {
      // baseline=7500, new=7600 => (7600-7500)*10000/7500 = 133 bps
      const delta = await deltaVerifier.calculateDeltaOneSingleMetric(7500, 7600);
      expect(delta).to.equal(133);
    });

    it("should return 0 for no improvement", async function () {
      const delta = await deltaVerifier.calculateDeltaOneSingleMetric(7500, 7500);
      expect(delta).to.equal(0);
    });

    it("should return 0 for regression", async function () {
      const delta = await deltaVerifier.calculateDeltaOneSingleMetric(7600, 7500);
      expect(delta).to.equal(0);
    });

    it("should handle zero baseline", async function () {
      const delta = await deltaVerifier.calculateDeltaOneSingleMetric(0, 5000);
      expect(delta).to.equal(10000); // 100% improvement
    });
  });

  describe("calculateDeltaOne backward compatibility", function () {
    it("should still compute multi-metric average correctly", async function () {
      const deltaOne = await deltaVerifier.calculateDeltaOne(
        sampleBaselineMetrics, sampleNewMetrics
      );
      expect(deltaOne).to.be.within(385, 389);
    });
  });

  describe("submitEvaluation with SingleMetric model", function () {
    beforeEach(async function () {
      await deltaVerifier.setModelMetricType(SINGLE_METRIC_MODEL_ID, 1);
    });

    it("should use single-metric delta for SingleMetric models", async function () {
      const evaluationData = {
        pipelineRunId: "wavemill_run_001",
        baselineMetrics: singleMetricBaseline,
        newMetrics: singleMetricNew,
        contributor: contributor1.address,
        contributorWeight: 10000,
        contributedSamples: 1000,
        totalSamples: 1000
      };

      await expect(
        deltaVerifier.submitEvaluation(SINGLE_METRIC_MODEL_ID, evaluationData)
      ).to.emit(deltaVerifier, "RewardCalculated");
    });

    it("should still use multi-metric delta for MultiMetric models", async function () {
      const evaluationData = {
        pipelineRunId: "standard_run_001",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation(MULTI_METRIC_MODEL_ID, evaluationData)
      ).to.emit(deltaVerifier, "RewardCalculated");
    });
  });

  describe("submitEvaluationWithMultipleContributors with SingleMetric", function () {
    beforeEach(async function () {
      await deltaVerifier.setModelMetricType(SINGLE_METRIC_MODEL_ID, 1);
    });

    it("should distribute rewards using single-metric delta", async function () {
      const evalData = {
        pipelineRunId: "wavemill_multi_001",
        baselineMetrics: singleMetricBaseline,
        newMetrics: singleMetricNew
      };

      const contributors = [
        { walletAddress: contributor1.address, weight: 6000 },
        { walletAddress: contributor2.address, weight: 4000 }
      ];

      await expect(
        deltaVerifier.submitEvaluationWithMultipleContributors(
          SINGLE_METRIC_MODEL_ID, evalData, contributors
        )
      ).to.emit(deltaVerifier, "BatchRewardsDistributed");
    });
  });

  describe("Single vs Multi metric delta values diverge correctly", function () {
    it("single-metric delta uses only accuracy field", async function () {
      // For single-metric: only accuracy matters => (8840-8540)*10000/8540 = 351 bps
      const singleDelta = await deltaVerifier.calculateDeltaOneSingleMetric(
        sampleBaselineMetrics.accuracy, sampleNewMetrics.accuracy
      );

      // For multi-metric: average of all 5 => ~387 bps
      const multiDelta = await deltaVerifier.calculateDeltaOne(
        sampleBaselineMetrics, sampleNewMetrics
      );

      // They should differ
      expect(singleDelta).to.not.equal(multiDelta);
      expect(singleDelta).to.equal(351);
      expect(multiDelta).to.be.within(385, 389);
    });
  });
});
