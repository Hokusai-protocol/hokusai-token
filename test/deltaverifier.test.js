const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("DeltaVerifier", function () {
  let deltaVerifier;
  let modelRegistry;
  let tokenManager;
  let hokusaiToken;
  let hokusaiParams;
  let contributionRegistry;
  let owner;
  let contributor1;
  let contributor2;
  let admin;

  const MODEL_ID = "1";
  const BASE_REWARD_RATE = ethers.parseEther("1000"); // 1000 tokens per 1% improvement
  const MIN_IMPROVEMENT_BPS = 100; // 1% minimum improvement
  const MAX_REWARD = ethers.parseEther("100000"); // Max reward cap

  // Sample metrics from the JSON spec
  const sampleBaselineMetrics = {
    accuracy: 8540, // 85.4%
    precision: 8270, // 82.7%
    recall: 8870, // 88.7%
    f1: 8390, // 83.9%
    auroc: 9040 // 90.4%
  };

  const sampleNewMetrics = {
    accuracy: 8840, // 88.4%
    precision: 8540, // 85.4%
    recall: 9130, // 91.3%
    f1: 8910, // 89.1%
    auroc: 9350 // 93.5%
  };

  beforeEach(async function () {
    [owner, contributor1, contributor2, admin] = await ethers.getSigners();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();

    // Deploy HokusaiParams
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = await HokusaiParams.deploy(
      1000, // tokensPerDeltaOne
      8000, // infrastructureAccrualBps (80%)
      ethers.ZeroHash,
      "",
      owner.address
    );

    // Deploy HokusaiToken
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy("Hokusai Token", "HOKU", owner.address, hokusaiParams.target, parseEther("10000"));

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(modelRegistry.target);

    // Deploy DataContributionRegistry
    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    contributionRegistry = await DataContributionRegistry.deploy();

    // Deploy DeltaVerifier
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
    await tokenManager.deployToken(MODEL_ID, "Hokusai Token", "HOKU", parseEther("10000"));
    await modelRegistry.registerModel(MODEL_ID, hokusaiToken.target, "accuracy");
    await tokenManager.setDeltaVerifier(deltaVerifier.target);

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, deltaVerifier.target);
  });

  describe("Deployment", function () {
    it("Should set the correct initial parameters", async function () {
      expect(await deltaVerifier.modelRegistry()).to.equal(modelRegistry.target);
      expect(await deltaVerifier.tokenManager()).to.equal(tokenManager.target);
      expect(await deltaVerifier.baseRewardRate()).to.equal(BASE_REWARD_RATE);
      expect(await deltaVerifier.minImprovementBps()).to.equal(MIN_IMPROVEMENT_BPS);
      expect(await deltaVerifier.maxReward()).to.equal(MAX_REWARD);
      expect(await deltaVerifier.owner()).to.equal(owner.address);
    });

    it("Should start unpaused", async function () {
      expect(await deltaVerifier.paused()).to.equal(false);
    });
  });

  describe("DeltaOne Calculation", function () {
    it("Should calculate correct DeltaOne score from sample metrics", async function () {
      const deltaOne = await deltaVerifier.calculateDeltaOne(
        sampleBaselineMetrics,
        sampleNewMetrics
      );
      
      // Let's calculate the expected value:
      // Accuracy: (88.4 - 85.4) / 85.4 = 3.51%
      // Precision: (85.4 - 82.7) / 82.7 = 3.26%
      // Recall: (91.3 - 88.7) / 88.7 = 2.93%
      // F1: (89.1 - 83.9) / 83.9 = 6.20%
      // AUROC: (93.5 - 90.4) / 90.4 = 3.43%
      // Average: (3.51 + 3.26 + 2.93 + 6.20 + 3.43) / 5 = 3.866%
      // Expected: ~3.87% improvement = 387 bps
      expect(deltaOne).to.be.within(385, 389);
    });

    it("Should return 0 for no improvement", async function () {
      const deltaOne = await deltaVerifier.calculateDeltaOne(
        sampleBaselineMetrics,
        sampleBaselineMetrics
      );
      expect(deltaOne).to.equal(0);
    });

    it("Should handle metrics with 0 baseline values", async function () {
      const zeroBaseline = {
        accuracy: 0,
        precision: 0,
        recall: 0,
        f1: 0,
        auroc: 0
      };

      const improvedMetrics = {
        accuracy: 5000,
        precision: 5000,
        recall: 5000,
        f1: 5000,
        auroc: 5000
      };

      // Should not revert, but handle gracefully
      await expect(
        deltaVerifier.calculateDeltaOne(zeroBaseline, improvedMetrics)
      ).to.not.be.reverted;
    });

    it("Should handle negative improvements correctly", async function () {
      const deltaOne = await deltaVerifier.calculateDeltaOne(
        sampleNewMetrics,
        sampleBaselineMetrics
      );
      
      // Should return 0 for negative improvements
      expect(deltaOne).to.equal(0);
    });
  });

  describe("Reward Calculation", function () {
    it("Should calculate correct reward for valid improvement", async function () {
      const deltaInBps = 387; // 3.87% improvement
      const contributorWeight = 9100; // 91% weight (0.091 from spec)
      const contributedSamples = 5000;

      const reward = await deltaVerifier.calculateReward(
        deltaInBps,
        contributorWeight,
        contributedSamples
      );

      // Expected: (387 / 100) * 1000 * 0.91 = 3.87 * 1000 * 0.91 = 3521.7 tokens
      const expectedReward = ethers.parseEther("3521.7");
      expect(reward).to.be.closeTo(expectedReward, ethers.parseEther("1")); // Within 1 token
    });

    it("Should return 0 for improvement below threshold", async function () {
      const deltaInBps = 50; // 0.5% improvement (below 1% threshold)
      const contributorWeight = 10000; // 100% weight
      const contributedSamples = 5000;

      const reward = await deltaVerifier.calculateReward(
        deltaInBps,
        contributorWeight,
        contributedSamples
      );

      expect(reward).to.equal(0);
    });

    it("Should cap reward at maximum", async function () {
      const deltaInBps = 50000; // 500% improvement (unrealistic but testing cap)
      const contributorWeight = 10000; // 100% weight
      const contributedSamples = 100000;

      const reward = await deltaVerifier.calculateReward(
        deltaInBps,
        contributorWeight,
        contributedSamples
      );

      expect(reward).to.equal(MAX_REWARD);
    });
  });

  describe("Evaluation Submission", function () {
    it("Should successfully submit valid evaluation", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100, // 91%
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.connect(admin).submitEvaluation(MODEL_ID, evaluationData)
      ).to.emit(deltaVerifier, "EvaluationSubmitted")
        .and.to.emit(deltaVerifier, "RewardCalculated");
    });

    it("Should reject evaluation for unregistered model", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation("999", evaluationData)
      ).to.be.revertedWith("Model not registered");
    });

    it("Should reject evaluation when paused", async function () {
      await deltaVerifier.pause();

      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Validation", function () {
    it("Should reject metrics above 100%", async function () {
      const invalidMetrics = {
        accuracy: 10001, // 100.01%
        precision: 8000,
        recall: 8000,
        f1: 8000,
        auroc: 8000
      };

      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: invalidMetrics,
        contributor: contributor1.address,
        contributorWeight: 10000,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.be.revertedWithCustomError(deltaVerifier, "InvalidAmount");
    });

    it("Should reject invalid contributor weight", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 10001, // > 100%
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.be.revertedWithCustomError(deltaVerifier, "InvalidAmount");
    });

    it("Should reject zero contributor address", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: ethers.ZeroAddress,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.be.revertedWithCustomError(deltaVerifier, "ZeroAddress");
    });
  });

  describe("Access Control", function () {
    it("Should allow owner to update reward parameters", async function () {
      const newRewardRate = ethers.parseEther("2000");
      await deltaVerifier.setBaseRewardRate(newRewardRate);
      expect(await deltaVerifier.baseRewardRate()).to.equal(newRewardRate);
    });

    it("Should prevent non-owner from updating reward parameters", async function () {
      const newRewardRate = ethers.parseEther("2000");
      await expect(
        deltaVerifier.connect(contributor1).setBaseRewardRate(newRewardRate)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should allow owner to pause and unpause", async function () {
      await deltaVerifier.pause();
      expect(await deltaVerifier.paused()).to.equal(true);

      await deltaVerifier.unpause();
      expect(await deltaVerifier.paused()).to.equal(false);
    });
  });

  describe("Rate Limiting", function () {
    it("Should enforce rate limiting per contributor", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      // First submission should succeed
      await deltaVerifier.submitEvaluation(MODEL_ID, evaluationData);

      // Second immediate submission should fail
      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.be.revertedWith("Rate limit exceeded");

      // Advance time and retry
      await ethers.provider.send("evm_increaseTime", [3600]); // 1 hour
      await ethers.provider.send("evm_mine");

      // Should succeed after cooldown
      await expect(
        deltaVerifier.submitEvaluation(MODEL_ID, evaluationData)
      ).to.not.be.reverted;
    });
  });

  describe("Integration with TokenManager", function () {
    it("Should trigger token minting through TokenManager", async function () {
      // Give TokenManager permission to mint
      await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), deltaVerifier.target);

      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      // Get the TokenManager-deployed token
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const deployedToken = HokusaiToken.attach(tokenAddress);

      const initialBalance = await deployedToken.balanceOf(contributor1.address);

      await deltaVerifier.submitEvaluation(MODEL_ID, evaluationData);

      const finalBalance = await deployedToken.balanceOf(contributor1.address);
      expect(finalBalance).to.be.gt(initialBalance);
    });
  });

  describe("Events", function () {
    it("Should emit correct events on evaluation submission", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_123",
        baselineMetrics: sampleBaselineMetrics,
        newMetrics: sampleNewMetrics,
        contributor: contributor1.address,
        contributorWeight: 9100,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      const tx = await deltaVerifier.submitEvaluation(MODEL_ID, evaluationData);
      const receipt = await tx.wait();

      // Check EvaluationSubmitted event
      const evaluationEvent = receipt.logs.find(
        log => log.fragment?.name === "EvaluationSubmitted"
      );
      expect(evaluationEvent).to.not.be.undefined;

      // Check RewardCalculated event
      const rewardEvent = receipt.logs.find(
        log => log.fragment?.name === "RewardCalculated"
      );
      expect(rewardEvent).to.not.be.undefined;
    });
  });
});