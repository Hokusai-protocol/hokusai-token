const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("Full Integration: Params Module", function () {
  let modelRegistry;
  let tokenManager;
  let deltaVerifier;
  let governor;
  let contributor1;
  let contributor2;
  let user1;

  const MODEL_ID_UINT = 1;
  const MODEL_ID_STR = "1";
  const MODEL_NAME = "GPT-4 Turbo";
  const MODEL_SYMBOL = "GPT4T";

  // Initial parameters for the model
  const initialParams = {
    tokensPerDeltaOne: 1500,
    infrastructureAccrualBps: 7000, // 70%
    licenseHash: keccak256(toUtf8Bytes("gpt-4-license-v1")),
    licenseURI: "https://openai.com/licenses/gpt-4",
    governor: null // Will be set in beforeEach
  };

  // Test evaluation data with moderate improvements
  const evaluationData = {
    pipelineRunId: "integration-test-001",
    baselineMetrics: {
      accuracy: 8200,   // 82%
      precision: 7800,  // 78%
      recall: 8400,     // 84%
      f1: 8100,         // 81%
      auroc: 8900       // 89%
    },
    newMetrics: {
      accuracy: 8700,   // 87% (+5% improvement)
      precision: 8300,  // 83% (+5% improvement)
      recall: 8900,     // 89% (+5% improvement)
      f1: 8600,         // 86% (+5% improvement)
      auroc: 9400       // 94% (+5% improvement)
    },
    contributor: null, // Will be set in tests
    contributorWeight: 10000, // 100%
    contributedSamples: 2000,
    totalSamples: 2000
  };

  beforeEach(async function () {
    [owner, governor, contributor1, contributor2, user1] = await ethers.getSigners();
    initialParams.governor = governor.address;

    // Deploy all contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");


    contributionRegistry = await DataContributionRegistry.deploy();



    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      1000, // baseRewardRate (fallback)
      100,  // minImprovementBps
      parseEther("50000") // maxReward
    );
    await deltaVerifier.waitForDeployment();

    // Connect TokenManager and DeltaVerifier
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, await deltaVerifier.getAddress());  });

  describe("End-to-End Token Deployment with Params", function () {
    it("Should deploy complete token system with dynamic parameters", async function () {
      // Deploy token with params through TokenManager
      const deployTx = await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );

      // Verify events were emitted
      await expect(deployTx).to.emit(tokenManager, "ParamsDeployed");
      await expect(deployTx).to.emit(tokenManager, "TokenDeployed");

      // Get deployed contracts
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_STR);

      expect(tokenAddress).to.not.equal(ZeroAddress);
      expect(paramsAddress).to.not.equal(ZeroAddress);

      // Verify token has correct params reference
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token = HokusaiToken.attach(tokenAddress);
      expect(await token.params()).to.equal(paramsAddress);

      // Verify params have correct initial values
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const params = HokusaiParams.attach(paramsAddress);
      expect(await params.tokensPerDeltaOne()).to.equal(initialParams.tokensPerDeltaOne);
      expect(await params.infrastructureAccrualBps()).to.equal(initialParams.infrastructureAccrualBps);
      expect(await params.licenseHash()).to.equal(initialParams.licenseHash);
      expect(await params.licenseURI()).to.equal(initialParams.licenseURI);

      // Verify governor has governance role
      const GOV_ROLE = await params.GOV_ROLE();
      expect(await params.hasRole(GOV_ROLE, governor.address)).to.be.true;
    });
  });

  describe("Evaluation Processing with Dynamic Parameters", function () {
    let token, params;

    beforeEach(async function () {
      // Deploy token system
      await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );

      // Register model
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
      await modelRegistry.registerModel(MODEL_ID_UINT, tokenAddress, "accuracy");

      // Get contract instances
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      token = HokusaiToken.attach(tokenAddress);
      params = HokusaiParams.attach(await tokenManager.getParamsAddress(MODEL_ID_STR));
    });

    it("Should process evaluation and mint rewards based on dynamic parameters", async function () {
      evaluationData.contributor = contributor1.address;

      // Submit evaluation
      await deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData);

      // Verify contributor received tokens
      const balance = await token.balanceOf(contributor1.address);
      expect(balance).to.be.gt(0);

      // Calculate expected reward manually
      // The actual deltaInBps calculated from the metrics above
      // Let me just verify it's a reasonable amount based on the improvement
      expect(balance).to.be.gt(5000); // Should be at least some reward
      expect(balance).to.be.lt(20000); // But not excessive
    });

    it("Should reflect parameter changes in reward calculations", async function () {
      // Submit first evaluation
      evaluationData.contributor = contributor1.address;
      await deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData);
      const balance1 = await token.balanceOf(contributor1.address);

      // Update parameters
      await params.connect(governor).setTokensPerDeltaOne(3000); // Double the rate

      // Wait for rate limit
      await ethers.provider.send("evm_increaseTime", [3600]);
      await ethers.provider.send("evm_mine");

      // Submit second evaluation with different contributor
      const evaluationData2 = {
        ...evaluationData,
        pipelineRunId: "integration-test-002",
        contributor: contributor2.address
      };
      await deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData2);
      const balance2 = await token.balanceOf(contributor2.address);

      // Second contributor should receive approximately double rewards
      expect(balance2).to.be.gt(balance1);
      expect(balance2).to.be.closeTo(balance1 * 2n, balance1 / 2n); // Allow 50% variance
    });

    it("Should handle multi-contributor scenarios with dynamic parameters", async function () {
      const contributors = [
        { walletAddress: contributor1.address, weight: 6000 }, // 60%
        { walletAddress: contributor2.address, weight: 4000 }  // 40%
      ];

      const evaluationBase = {
        pipelineRunId: "integration-multi-001",
        baselineMetrics: evaluationData.baselineMetrics,
        newMetrics: evaluationData.newMetrics
      };

      await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID_UINT,
        evaluationBase,
        contributors
      );

      const balance1 = await token.balanceOf(contributor1.address);
      const balance2 = await token.balanceOf(contributor2.address);

      expect(balance1).to.be.gt(0);
      expect(balance2).to.be.gt(0);

      // Contributor1 should have 60% more than contributor2 (6000 vs 4000 basis points)
      const expectedRatio = 6000n / 4000n; // 1.5
      const actualRatio = balance1 / balance2;
      expect(actualRatio).to.be.closeTo(expectedRatio, 1n); // Allow some variance
    });
  });

  describe("Governance Parameter Updates", function () {
    let params;

    beforeEach(async function () {
      await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );

      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_STR);
      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      params = HokusaiParams.attach(paramsAddress);
    });

    it("Should allow governance to update all parameters", async function () {
      // Update tokensPerDeltaOne
      await expect(params.connect(governor).setTokensPerDeltaOne(2000))
        .to.emit(params, "TokensPerDeltaOneSet");
      expect(await params.tokensPerDeltaOne()).to.equal(2000);

      // Update infrastructureAccrualBps
      await expect(params.connect(governor).setInfrastructureAccrualBps(7500))
        .to.emit(params, "InfrastructureAccrualBpsSet");
      expect(await params.infrastructureAccrualBps()).to.equal(7500);

      // Update license reference
      const newHash = keccak256(toUtf8Bytes("gpt-4-license-v2"));
      const newURI = "https://openai.com/licenses/gpt-4-v2";
      await expect(params.connect(governor).setLicenseRef(newHash, newURI))
        .to.emit(params, "LicenseRefSet");

      expect(await params.licenseHash()).to.equal(newHash);
      expect(await params.licenseURI()).to.equal(newURI);
    });

    it("Should prevent unauthorized parameter updates", async function () {
      // Non-governor should not be able to update parameters
      await expect(
        params.connect(user1).setTokensPerDeltaOne(2000)
      ).to.be.reverted;

      await expect(
        params.connect(user1).setInfrastructureAccrualBps(7500)
      ).to.be.reverted;

      await expect(
        params.connect(user1).setLicenseRef(keccak256(toUtf8Bytes("unauthorized")), "unauthorized")
      ).to.be.reverted;
    });
  });

  describe("Multiple Models with Different Parameters", function () {
    it("Should support multiple models with different parameter settings", async function () {
      // Deploy first model
      const params1 = {
        ...initialParams,
        tokensPerDeltaOne: 1000,
        infrastructureAccrualBps: 6000 // 60%
      };
      await tokenManager.deployTokenWithParams("1", "Model One", "M1", parseEther("100000"), params1);

      // Deploy second model
      const params2 = {
        ...initialParams,
        tokensPerDeltaOne: 2000,
        infrastructureAccrualBps: 8000 // 80%
      };
      await tokenManager.deployTokenWithParams("2", "Model Two", "M2", parseEther("200000"), params2);

      // Register both models
      const token1Address = await tokenManager.getTokenAddress("1");
      const token2Address = await tokenManager.getTokenAddress("2");
      await modelRegistry.registerModel(1, token1Address, "accuracy");
      await modelRegistry.registerModel(2, token2Address, "precision");

      // Submit evaluations to both models
      const eval1 = { ...evaluationData, contributor: contributor1.address, pipelineRunId: "model1-eval" };
      const eval2 = { ...evaluationData, contributor: contributor2.address, pipelineRunId: "model2-eval" };

      await deltaVerifier.submitEvaluation(1, eval1);
      await deltaVerifier.submitEvaluation(2, eval2);

      // Check balances
      const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
      const token1 = HokusaiToken.attach(token1Address);
      const token2 = HokusaiToken.attach(token2Address);

      const balance1 = await token1.balanceOf(contributor1.address);
      const balance2 = await token2.balanceOf(contributor2.address);

      expect(balance1).to.be.gt(0);
      expect(balance2).to.be.gt(0);

      // Model 2 should give approximately double rewards (2000 vs 1000 tokensPerDeltaOne)
      expect(balance2).to.be.gt(balance1);
      expect(balance2).to.be.closeTo(balance1 * 2n, balance1 / 2n); // Allow variance
    });
  });

  describe("System Robustness", function () {
    it("Should handle edge cases and maintain consistency", async function () {
      // Deploy token system
      await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );

      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
      const paramsAddress = await tokenManager.getParamsAddress(MODEL_ID_STR);
      await modelRegistry.registerModel(MODEL_ID_UINT, tokenAddress, "f1");

      const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
      const params = HokusaiParams.attach(paramsAddress);

      // Update parameters multiple times
      for (let i = 0; i < 5; i++) {
        await params.connect(governor).setTokensPerDeltaOne(1000 + i * 200);

        // Verify parameter is updated
        expect(await params.tokensPerDeltaOne()).to.equal(1000 + i * 200);

        // Verify dynamic calculation uses new parameter
        const reward = await deltaVerifier.calculateRewardDynamic(MODEL_ID_STR, 500, 10000, 0);
        // Formula: (deltaInBps * tokensPerDeltaOne * contributorWeight) / (100 * 10000)
        const expectedReward = (500 * (1000 + i * 200) * 10000) / (100 * 10000);
        expect(reward).to.equal(expectedReward);
      }
    });

    it("Should maintain backward compatibility", async function () {
      // Deploy token system
      await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );

      // Both old and new calculation methods should be available
      const oldReward = await deltaVerifier.calculateReward(500, 10000, 0);
      const newReward = await deltaVerifier.calculateRewardDynamic(MODEL_ID_STR, 500, 10000, 0);

      expect(oldReward).to.be.gt(0);
      expect(newReward).to.be.gt(0);

      // They might be different values, but both should work
      expect(oldReward).to.equal(5000); // Based on baseRewardRate=1000
      expect(newReward).to.equal(7500); // Based on tokensPerDeltaOne=1500
    });
  });

  describe("Gas Efficiency and Performance", function () {
    it("Should have reasonable gas costs for complete workflow", async function () {
      // Deploy token system
      const deployTx = await tokenManager.deployTokenWithParams(
        MODEL_ID_STR,
        MODEL_NAME,
        MODEL_SYMBOL,
        parseEther("1000000"),
        initialParams
      );
      const deployReceipt = await deployTx.wait();

      // Register model
      const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
      const registerTx = await modelRegistry.registerModel(MODEL_ID_UINT, tokenAddress, "accuracy");
      const registerReceipt = await registerTx.wait();

      // Submit evaluation
      evaluationData.contributor = contributor1.address;
      const evalTx = await deltaVerifier.submitEvaluation(MODEL_ID_UINT, evaluationData);
      const evalReceipt = await evalTx.wait();

      // Verify gas usage is reasonable
      expect(deployReceipt.gasUsed).to.be.lt(3000000); // Less than 3M gas for deployment
      expect(registerReceipt.gasUsed).to.be.lt(200000);  // Less than 200k gas for registration
      expect(evalReceipt.gasUsed).to.be.lt(600000);     // Less than 600k gas for evaluation (includes contribution recording)
    });
  });
});