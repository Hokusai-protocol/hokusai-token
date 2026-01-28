const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("DeltaVerifier - DataContributionRegistry Integration", function () {
  let deltaVerifier;
  let modelRegistry;
  let tokenManager;
  let hokusaiToken;
  let hokusaiParams;
  let contributionRegistry;
  let owner;
  let contributor1;
  let contributor2;
  let contributor3;

  const MODEL_ID = 1;
  const BASE_REWARD_RATE = ethers.parseEther("1000");
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = ethers.parseEther("100000");

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

  beforeEach(async function () {
    [owner, contributor1, contributor2, contributor3] = await ethers.getSigners();

    // Deploy all contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();

    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = await HokusaiParams.deploy(
      1000,
      500,
      ethers.ZeroHash,
      "",
      owner.address
    );

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy(
      "Hokusai Token",
      "HOKU",
      owner.address,
      hokusaiParams.target,
      parseEther("10000")
    );

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(modelRegistry.target);

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
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

    // Setup relationships
    await hokusaiToken.setController(tokenManager.target);
    await tokenManager.deployToken(String(MODEL_ID), "Hokusai Token", "HOKU", parseEther("10000"));
    await modelRegistry.registerModel(MODEL_ID, hokusaiToken.target, "accuracy");
    await tokenManager.setDeltaVerifier(deltaVerifier.target);

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, deltaVerifier.target);
  });

  describe("Single Contributor Flow", function () {
    it("should record contribution when evaluation with single contributor succeeds", async function () {
      const evalData = {
        pipelineRunId: "run_test_001",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 10000, // 100%
        contributedSamples: 5000,
        totalSamples: 5000
      };

      // Submit evaluation
      await deltaVerifier.submitEvaluation(MODEL_ID, evalData);

      // Check that contribution was recorded
      const contributionCount = await contributionRegistry.getModelContributionCount(String(MODEL_ID));
      expect(contributionCount).to.equal(1);

      // Verify contribution details
      const contribution = await contributionRegistry.getContribution(1);
      expect(contribution.modelId).to.equal(String(MODEL_ID));
      expect(contribution.contributor).to.equal(contributor1.address);
      expect(contribution.contributorWeightBps).to.equal(10000);
      expect(contribution.pipelineRunId).to.equal("run_test_001");
      expect(contribution.status).to.equal(0); // Pending
      expect(contribution.tokensEarned).to.be.gt(0);
    });
  });

  describe("Multiple Contributors Flow", function () {
    it("should record all contributions when evaluation with multiple contributors succeeds", async function () {
      const contributors = [
        { walletAddress: contributor1.address, weight: 6000 }, // 60%
        { walletAddress: contributor2.address, weight: 4000 }  // 40%
      ];

      const evalData = {
        pipelineRunId: "run_test_multi_001",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      // Submit evaluation with multiple contributors
      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData,
        contributors
      );

      // Check that both contributions were recorded
      const contributionCount = await contributionRegistry.getModelContributionCount(String(MODEL_ID));
      expect(contributionCount).to.equal(2);

      // Verify first contribution
      const contribution1 = await contributionRegistry.getContribution(1);
      expect(contribution1.modelId).to.equal(String(MODEL_ID));
      expect(contribution1.contributor).to.equal(contributor1.address);
      expect(contribution1.contributorWeightBps).to.equal(6000);
      expect(contribution1.pipelineRunId).to.equal("run_test_multi_001");
      expect(contribution1.tokensEarned).to.be.gt(0);

      // Verify second contribution
      const contribution2 = await contributionRegistry.getContribution(2);
      expect(contribution2.modelId).to.equal(String(MODEL_ID));
      expect(contribution2.contributor).to.equal(contributor2.address);
      expect(contribution2.contributorWeightBps).to.equal(4000);
      expect(contribution2.pipelineRunId).to.equal("run_test_multi_001");
      expect(contribution2.tokensEarned).to.be.gt(0);

      // Verify token distribution is proportional
      const ratio = Number(contribution1.tokensEarned) / Number(contribution2.tokensEarned);
      expect(ratio).to.be.closeTo(1.5, 0.01); // 60/40 = 1.5
    });

    it("should enforce batch size limit", async function () {
      const contributors = [];
      for (let i = 0; i < 101; i++) {
        contributors.push({
          walletAddress: contributor1.address,
          weight: 99 // Use integer weight
        });
      }
      // Adjust last one to make sum = 10000
      contributors[100].weight = 101;

      const evalData = {
        pipelineRunId: "run_test_batch_101",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      // Should revert with batch size > 100 (now using custom error)
      await expect(
        deltaVerifier.submitEvaluationWithMultipleContributors(
          MODEL_ID,
          evalData,
          contributors
        )
      ).to.be.revertedWithCustomError(deltaVerifier, "ArrayTooLarge");
    });
  });

  describe("Aggregate Tracking", function () {
    it("should correctly track contributor total tokens for a model", async function () {
      // First evaluation
      const contributors1 = [
        { walletAddress: contributor1.address, weight: 10000 }
      ];

      const evalData1 = {
        pipelineRunId: "run_001",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData1,
        contributors1
      );

      const firstContribution = await contributionRegistry.getContribution(1);
      const firstTokens = firstContribution.tokensEarned;

      // Second evaluation with same contributor
      const evalData2 = {
        pipelineRunId: "run_002",
        baselineMetrics: sampleNewMetrics, // Use previous new as baseline
        newMetrics: {
          accuracy: 9000,
          precision: 8700,
          recall: 9300,
          f1: 9100,
          auroc: 9500
        }
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData2,
        contributors1
      );

      const secondContribution = await contributionRegistry.getContribution(2);
      const secondTokens = secondContribution.tokensEarned;

      // Check aggregate total
      const totalTokens = await contributionRegistry.contributorTotalTokens(
        String(MODEL_ID),
        contributor1.address
      );

      expect(totalTokens).to.equal(firstTokens + secondTokens);
    });

    it("should correctly track contributor global tokens across multiple models", async function () {
      // Deploy second token for second model
      const MODEL_ID_2 = 2;
      await tokenManager.deployToken(String(MODEL_ID_2), "Hokusai Token 2", "HOKU2", parseEther("10000"));

      const HokusaiToken2 = await ethers.getContractAt(
        "HokusaiToken",
        await tokenManager.modelTokens(String(MODEL_ID_2))
      );

      await modelRegistry.registerModel(MODEL_ID_2, HokusaiToken2.target, "accuracy");

      // Evaluation for model 1
      const evalData1 = {
        pipelineRunId: "run_model1",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData1,
        [{ walletAddress: contributor1.address, weight: 10000 }]
      );

      const contribution1 = await contributionRegistry.getContribution(1);

      // Evaluation for model 2
      const evalData2 = {
        pipelineRunId: "run_model2",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID_2,
        evalData2,
        [{ walletAddress: contributor1.address, weight: 10000 }]
      );

      const contribution2 = await contributionRegistry.getContribution(2);

      // Check global tokens
      const globalTokens = await contributionRegistry.contributorGlobalTokens(contributor1.address);
      expect(globalTokens).to.equal(contribution1.tokensEarned + contribution2.tokensEarned);

      // Check models contributed to
      const [totalContributions, totalTokens, modelsContributedTo] =
        await contributionRegistry.getContributorGlobalStats(contributor1.address);

      expect(totalContributions).to.equal(2);
      expect(modelsContributedTo).to.equal(2);
    });
  });

  describe("Query Functions", function () {
    beforeEach(async function () {
      // Setup multiple contributions
      const evalData1 = {
        pipelineRunId: "run_001",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData1,
        [
          { walletAddress: contributor1.address, weight: 5000 },
          { walletAddress: contributor2.address, weight: 5000 }
        ]
      );

      const evalData2 = {
        pipelineRunId: "run_002",
        baselineMetrics: sampleNewMetrics,
        newMetrics: {
          accuracy: 9000,
          precision: 8700,
          recall: 9300,
          f1: 9100,
          auroc: 9500
        }
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData2,
        [{ walletAddress: contributor1.address, weight: 10000 }]
      );
    });

    it("should return correct contribution IDs for a model with pagination", async function () {
      const contributionIds = await contributionRegistry.getContributionIdsByModel(
        String(MODEL_ID),
        0,
        10
      );

      expect(contributionIds.length).to.equal(3);
      expect(contributionIds[0]).to.equal(1);
      expect(contributionIds[1]).to.equal(2);
      expect(contributionIds[2]).to.equal(3);
    });

    it("should return correct contribution IDs for a contributor", async function () {
      const contributionIds = await contributionRegistry.getContributionIdsByContributor(
        contributor1.address,
        0,
        10
      );

      expect(contributionIds.length).to.equal(2); // contributor1 has 2 contributions
      expect(contributionIds[0]).to.equal(1);
      expect(contributionIds[1]).to.equal(3);
    });

    it("should verify that contributor has contributed to model", async function () {
      expect(await contributionRegistry.hasContributedToModel(String(MODEL_ID), contributor1.address))
        .to.be.true;
      expect(await contributionRegistry.hasContributedToModel(String(MODEL_ID), contributor2.address))
        .to.be.true;
      expect(await contributionRegistry.hasContributedToModel(String(MODEL_ID), contributor3.address))
        .to.be.false;
    });

    it("should get correct contributor stats for model", async function () {
      const [totalContributions, totalTokens, totalSamples] =
        await contributionRegistry.getContributorStatsForModel(String(MODEL_ID), contributor1.address);

      expect(totalContributions).to.equal(2);
      expect(totalTokens).to.be.gt(0);
    });
  });

  describe("Gas Efficiency", function () {
    it("should record single contribution within gas target", async function () {
      const evalData = {
        pipelineRunId: "run_gas_test",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 10000,
        contributedSamples: 5000,
        totalSamples: 5000
      };

      const tx = await deltaVerifier.submitEvaluation(MODEL_ID, evalData);
      const receipt = await tx.wait();

      // Total gas should be reasonable (< 600k including minting and recording)
      expect(receipt.gasUsed).to.be.lt(600000);
    });

    it("should record batch contributions efficiently", async function () {
      const contributors = [
        { walletAddress: contributor1.address, weight: 6000 },
        { walletAddress: contributor2.address, weight: 4000 }
      ];

      const evalData = {
        pipelineRunId: "run_batch_gas",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics
      };

      const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evalData,
        contributors
      );
      const receipt = await tx.wait();

      // Should be reasonable for batch operations (< 1M for 2 contributors including recording)
      expect(receipt.gasUsed).to.be.lt(1000000);
    });
  });
});
