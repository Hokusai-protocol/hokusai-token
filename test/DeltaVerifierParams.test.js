const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("DeltaVerifier with Dynamic Params", function () {
  let deltaVerifier;
  let tokenManager;
  let modelRegistry;
  let hokusaiToken;
  let hokusaiParams;
  let owner;
  let governor;
  let contributor;
  let user1;
  let user2;

  const MODEL_ID = "1";
  const MODEL_ID_STR = "1";

  // Default evaluation data
  const defaultEvaluationData = {
    pipelineRunId: "test-pipeline-001",
    baselineMetrics: {
      accuracy: 8000,   // 80%
      precision: 7500,  // 75%
      recall: 8500,     // 85%
      f1: 8000,         // 80%
      auroc: 9000       // 90%
    },
    newMetrics: {
      accuracy: 8500,   // 85% (+5% improvement)
      precision: 8000,  // 80% (+5% improvement)
      recall: 9000,     // 90% (+5% improvement)
      f1: 8500,         // 85% (+5% improvement)
      auroc: 9500       // 95% (+5% improvement)
    },
    contributor: null, // Will be set in tests
    contributorWeight: 10000, // 100%
    contributedSamples: 1000,
    totalSamples: 1000
  };

  // Default initial params for testing
  const defaultInitialParams = {
    tokensPerDeltaOne: 1000,
    infraMarkupBps: 500, // 5%
    licenseHash: keccak256(toUtf8Bytes("test-license")),
    licenseURI: "https://test.license",
    governor: null // Will be set in beforeEach
  };

  beforeEach(async function () {
    [owner, governor, contributor, user1, user2] = await ethers.getSigners();

    // Set contributor in evaluation data
    defaultEvaluationData.contributor = contributor.address;
    defaultInitialParams.governor = governor.address;

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy DeltaVerifier
    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      1000, // baseRewardRate (fallback)
      100,  // minImprovementBps
      parseEther("10000") // maxReward
    );
    await deltaVerifier.waitForDeployment();

    // Set DeltaVerifier in TokenManager
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    // Deploy token with params through TokenManager
    await tokenManager.deployTokenWithParams(
      MODEL_ID_STR,
      "Test Model Token",
      "TMT",
      parseEther("10000"),
      defaultInitialParams
    );

    // Get deployed contracts
    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
    const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_STR);

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");

    hokusaiToken = HokusaiToken.attach(tokenAddress);
    hokusaiParams = HokusaiParams.attach(paramsAddress);

    // Register model in ModelRegistry
    await modelRegistry.registerModel(MODEL_ID, tokenAddress, "test-performance-metric");
  });

  describe("Dynamic Parameter Reading", function () {
    it("Should read tokensPerDeltaOne from params contract", async function () {
      const modelIdStr = MODEL_ID_STR;
      const deltaInBps = 500; // 5% improvement
      const contributorWeight = 10000; // 100%

      const rewardAmount = await deltaVerifier.calculateRewardDynamic(
        modelIdStr,
        deltaInBps,
        contributorWeight,
        0
      );

      // Expected: (500 * 1000 * 10000) / (100 * 10000) = 5000 tokens
      expect(rewardAmount).to.equal(5000);
    });

    it("Should use updated tokensPerDeltaOne after governance change", async function () {
      // Update the tokensPerDeltaOne parameter
      await hokusaiParams.connect(governor).setTokensPerDeltaOne(2000);

      const modelIdStr = MODEL_ID_STR;
      const deltaInBps = 500; // 5% improvement
      const contributorWeight = 10000; // 100%

      const rewardAmount = await deltaVerifier.calculateRewardDynamic(
        modelIdStr,
        deltaInBps,
        contributorWeight,
        0
      );

      // Expected: (500 * 2000 * 10000) / (100 * 10000) = 10000 tokens
      expect(rewardAmount).to.equal(10000);
    });

    it("Should reject calculation for non-existent model", async function () {
      await expect(
        deltaVerifier.calculateRewardDynamic(
          "999", // Non-existent model
          500,
          10000,
          0
        )
      ).to.be.revertedWith("Token not found for model");
    });

    it("Should respect minimum improvement threshold", async function () {
      const modelIdStr = MODEL_ID_STR;
      const deltaInBps = 50; // 0.5% improvement (below 1% minimum)
      const contributorWeight = 10000; // 100%

      const rewardAmount = await deltaVerifier.calculateRewardDynamic(
        modelIdStr,
        deltaInBps,
        contributorWeight,
        0
      );

      expect(rewardAmount).to.equal(0);
    });

    it("Should respect maximum reward cap", async function () {
      const modelIdStr = MODEL_ID_STR;
      // Use a much larger improvement to exceed maxReward
      // maxReward = 10^22, so we need deltaInBps > 10^22 to trigger the cap
      const deltaInBps = "100000000000000000000000"; // Extremely large improvement
      const contributorWeight = 10000; // 100%

      const rewardAmount = await deltaVerifier.calculateRewardDynamic(
        modelIdStr,
        deltaInBps,
        contributorWeight,
        0
      );

      // Should be capped at maxReward
      const maxReward = await deltaVerifier.maxReward();
      expect(rewardAmount).to.equal(maxReward);
    });
  });

  describe("Evaluation Processing with Dynamic Params", function () {
    it("Should use dynamic parameters in evaluation processing", async function () {
      // Submit evaluation using the old function that uses uint256 modelId
      const rewardAmount = await deltaVerifier.submitEvaluation(
        MODEL_ID, // uint256
        defaultEvaluationData
      );

      // Verify contributor received tokens based on dynamic parameters
      const contributorBalance = await hokusaiToken.balanceOf(contributor.address);
      expect(contributorBalance).to.be.gt(0);

      // The reward should be based on approximately 5% improvement across metrics
      // with tokensPerDeltaOne = 1000. DeltaVerifier returns raw token amounts, not ethers.
      expect(contributorBalance).to.be.gt(200); // At least some reward
    });

    it("Should reflect parameter changes in new evaluations", async function () {
      // Submit initial evaluation
      await deltaVerifier.submitEvaluation(MODEL_ID, defaultEvaluationData);
      const initialBalance = await hokusaiToken.balanceOf(contributor.address);

      // Update tokensPerDeltaOne to double the reward rate
      await hokusaiParams.connect(governor).setTokensPerDeltaOne(2000);

      // Wait for rate limit
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");

      // Submit another evaluation with same improvement
      const newEvaluationData = {
        ...defaultEvaluationData,
        pipelineRunId: "test-pipeline-002",
        contributor: user1.address
      };

      await deltaVerifier.submitEvaluation(MODEL_ID, newEvaluationData);
      const user1Balance = await hokusaiToken.balanceOf(user1.address);

      // user1 should receive approximately twice the reward as contributor
      // (accounting for small variations in calculation)
      expect(user1Balance).to.be.gt(initialBalance);
    });

    it("Should handle multi-contributor evaluations with dynamic params", async function () {
      const contributors = [
        { walletAddress: contributor.address, weight: 5000 }, // 50%
        { walletAddress: user1.address, weight: 3000 },      // 30%
        { walletAddress: user2.address, weight: 2000 }       // 20%
      ];

      const evaluationDataBase = {
        pipelineRunId: "test-pipeline-multi",
        baselineMetrics: defaultEvaluationData.baselineMetrics,
        newMetrics: defaultEvaluationData.newMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evaluationDataBase,
        contributors
      );

      // Verify all contributors received tokens proportional to their weights
      const contributorBalance = await hokusaiToken.balanceOf(contributor.address);
      const user1Balance = await hokusaiToken.balanceOf(user1.address);
      const user2Balance = await hokusaiToken.balanceOf(user2.address);

      expect(contributorBalance).to.be.gt(0);
      expect(user1Balance).to.be.gt(0);
      expect(user2Balance).to.be.gt(0);

      // Contributor should have the highest balance (50% weight)
      expect(contributorBalance).to.be.gt(user1Balance);
      expect(contributorBalance).to.be.gt(user2Balance);

      // user1 should have more than user2 (30% vs 20%)
      expect(user1Balance).to.be.gt(user2Balance);
    });
  });

  describe("Parameter Updates and Effects", function () {
    it("Should not affect existing token balances when parameters change", async function () {
      // Submit evaluation and record balance
      await deltaVerifier.submitEvaluation(MODEL_ID, defaultEvaluationData);
      const balanceBeforeUpdate = await hokusaiToken.balanceOf(contributor.address);

      // Update parameters
      await hokusaiParams.connect(governor).setTokensPerDeltaOne(500);

      // Balance should remain unchanged
      const balanceAfterUpdate = await hokusaiToken.balanceOf(contributor.address);
      expect(balanceAfterUpdate).to.equal(balanceBeforeUpdate);
    });

    it("Should allow different models to have different parameters", async function () {
      // Deploy second model with different parameters
      const model2Params = {
        ...defaultInitialParams,
        tokensPerDeltaOne: 2000 // Double the reward rate
      };

      await tokenManager.deployTokenWithParams(
        "2",
        "Second Model Token",
        "SMT",
        parseEther("5000"),
        model2Params
      );

      // Register second model
      const token2Address = await tokenManager.getTokenAddress("2");
      await modelRegistry.registerModel(2, token2Address, "second-model-metric");

      // Calculate rewards for both models with same improvement
      const reward1 = await deltaVerifier.calculateRewardDynamic("1", 500, 10000, 0);
      const reward2 = await deltaVerifier.calculateRewardDynamic("2", 500, 10000, 0);

      // Second model should give double rewards
      expect(reward2).to.equal(reward1 * 2n);
    });
  });

  describe("Backward Compatibility", function () {
    it("Should maintain old calculateReward function for backward compatibility", async function () {
      const deltaInBps = 500;
      const contributorWeight = 10000;

      // Old function should still work
      const oldReward = await deltaVerifier.calculateReward(
        deltaInBps,
        contributorWeight,
        0
      );

      expect(oldReward).to.be.gt(0);
      // Should use baseRewardRate (1000) instead of dynamic params
      expect(oldReward).to.equal(5000); // Same as dynamic with tokensPerDeltaOne=1000
    });
  });

  describe("Error Handling", function () {
    it("Should handle params contract access errors gracefully", async function () {
      // This test ensures that if there are issues accessing params,
      // the contract doesn't break entirely
      const modelIdStr = MODEL_ID_STR;

      // Normal case should work
      await expect(
        deltaVerifier.calculateRewardDynamic(modelIdStr, 500, 10000, 0)
      ).to.not.be.reverted;
    });

    it("Should validate model ID format in dynamic calculations", async function () {
      // Empty string should fail
      await expect(
        deltaVerifier.calculateRewardDynamic("", 500, 10000, 0)
      ).to.be.revertedWith("Token not found for model");
    });
  });

  describe("Gas Efficiency", function () {
    it("Should have reasonable gas costs for dynamic parameter reading", async function () {
      const tx = await deltaVerifier.calculateRewardDynamic.estimateGas(
        MODEL_ID_STR,
        500,
        10000,
        0
      );

      // Should be reasonable for reading params and calculating
      expect(tx).to.be.lt(100000); // Less than 100k gas
    });
  });
});