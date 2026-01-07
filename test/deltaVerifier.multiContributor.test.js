const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("DeltaVerifier Multi-Contributor Support", function () {
  let deltaVerifier;
  let tokenManager;
  let contributionRegistry;
  let hokusaiToken;
  let hokusaiParams;
  let modelRegistry;
  let owner;
  let contributor1;
  let contributor2;
  let contributor3;
  let treasury;

  // Helper function to get the deployed token
  async function getDeployedToken() {
    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    return HokusaiToken.attach(tokenAddress);
  }

  const MODEL_ID = "1";
  const BASE_REWARD_RATE = 1000; // 10%
  const IMPROVEMENT_MULTIPLIER = 100; // 1x

  beforeEach(async function () {
    [owner, contributor1, contributor2, contributor3, treasury] = await ethers.getSigners();

    // Deploy contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy HokusaiParams first
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = await HokusaiParams.deploy(
      1000, // tokensPerDeltaOne
      500, // infraMarkupBps (5%)
      ethers.ZeroHash,
      "",
      owner.address
    );
    await hokusaiParams.waitForDeployment();

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy("Hokusai Token", "HOKU", owner.address, await hokusaiParams.getAddress(), parseEther("10000"));
    await hokusaiToken.waitForDeployment();

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
      BASE_REWARD_RATE,
      100,  // minImprovementBps
      ethers.parseEther("1000000")  // maxReward
    );
    await deltaVerifier.waitForDeployment();

    // Set up permissions and deploy token
    await hokusaiToken.setController(await tokenManager.getAddress());
    await tokenManager.deployToken(MODEL_ID, "Hokusai Token", "HOKU", parseEther("10000"));
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    // Grant RECORDER_ROLE to DeltaVerifier
    const RECORDER_ROLE = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(RECORDER_ROLE, await deltaVerifier.getAddress());
    // Register model in registry for DeltaVerifier
    await modelRegistry.registerModel(
      MODEL_ID,
      await hokusaiToken.getAddress(),
      "accuracy"
    );
  });

  describe("Single Contributor with Wallet Address", function () {
    it("should parse and mint tokens to single contributor from contributor_info", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_001",
        baselineMetrics: {
          accuracy: 8500, // 85%
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800, // 88%
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        },
        contributorInfo: {
          walletAddress: contributor1.address,
          contributorWeight: 10000, // 100%
          contributedSamples: 5000,
          totalSamples: 55000
        }
      };

      const tx = await deltaVerifier.submitEvaluationWithContributorInfo(
        MODEL_ID,
        evaluationData
      );

      // Check event emission
      await expect(tx)
        .to.emit(deltaVerifier, "EvaluationSubmitted")
        .withArgs("test_run_001", MODEL_ID);

      // Check tokens were minted to correct address
      const deployedToken = await getDeployedToken();
      const balance = await deployedToken.balanceOf(contributor1.address);
      expect(balance).to.be.gt(0);
    });

    it("should validate wallet address format", async function () {
      const invalidData = {
        pipelineRunId: "test_run_002",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        },
        contributorInfo: {
          walletAddress: "0x0000000000000000000000000000000000000000", // Zero address
          contributorWeight: 10000,
          contributedSamples: 5000,
          totalSamples: 55000
        }
      };

      await expect(
        deltaVerifier.submitEvaluationWithContributorInfo(MODEL_ID, invalidData)
      ).to.be.revertedWith("Invalid wallet address");
    });
  });

  describe("Multiple Contributors Support", function () {
    it("should distribute tokens to multiple contributors based on weights", async function () {
      const contributors = [
        {
          walletAddress: contributor1.address,
          weight: 6000 // 60%
        },
        {
          walletAddress: contributor2.address,
          weight: 3000 // 30%
        },
        {
          walletAddress: contributor3.address,
          weight: 1000 // 10%
        }
      ];

      const evaluationData = {
        pipelineRunId: "test_run_003",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evaluationData,
        contributors
      );

      await expect(tx)
        .to.emit(deltaVerifier, "EvaluationSubmitted")
        .withArgs("test_run_003", MODEL_ID);

      // Check token distribution
      const deployedToken = await getDeployedToken();
      const balance1 = await deployedToken.balanceOf(contributor1.address);
      const balance2 = await deployedToken.balanceOf(contributor2.address);
      const balance3 = await deployedToken.balanceOf(contributor3.address);

      // Verify proportional distribution
      expect(balance1).to.be.gt(balance2);
      expect(balance2).to.be.gt(balance3);
      
      // Check approximate ratios (allowing for rounding)
      const totalBalance = balance1 + balance2 + balance3;
      const ratio1 = (balance1 * 10000n) / totalBalance;
      const ratio2 = (balance2 * 10000n) / totalBalance;
      const ratio3 = (balance3 * 10000n) / totalBalance;

      expect(Number(ratio1)).to.be.closeTo(6000, 100); // ~60%
      expect(Number(ratio2)).to.be.closeTo(3000, 100); // ~30%
      expect(Number(ratio3)).to.be.closeTo(1000, 100); // ~10%
    });

    it("should handle edge case with single contributor in array", async function () {
      const contributors = [
        {
          walletAddress: contributor1.address,
          weight: 10000 // 100%
        }
      ];

      const evaluationData = {
        pipelineRunId: "test_run_004",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evaluationData,
        contributors
      );

      await expect(tx).to.not.be.reverted;

      const deployedToken = await getDeployedToken();
      const balance = await deployedToken.balanceOf(contributor1.address);
      expect(balance).to.be.gt(0);
    });

    it("should reject empty contributors array", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_005",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      await expect(
        deltaVerifier.submitEvaluationWithMultipleContributors(
          MODEL_ID,
          evaluationData,
          []
        )
      ).to.be.revertedWith("No contributors provided");
    });

    it("should validate total weights equal 100%", async function () {
      const contributors = [
        {
          walletAddress: contributor1.address,
          weight: 5000 // 50%
        },
        {
          walletAddress: contributor2.address,
          weight: 3000 // 30%
        }
        // Total: 80% - should fail
      ];

      const evaluationData = {
        pipelineRunId: "test_run_006",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      await expect(
        deltaVerifier.submitEvaluationWithMultipleContributors(
          MODEL_ID,
          evaluationData,
          contributors
        )
      ).to.be.revertedWith("Weights must sum to 100%");
    });

    it("should reject duplicate addresses in contributors", async function () {
      const contributors = [
        {
          walletAddress: contributor1.address,
          weight: 5000
        },
        {
          walletAddress: contributor1.address, // Duplicate
          weight: 5000
        }
      ];

      const evaluationData = {
        pipelineRunId: "test_run_007",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      await expect(
        deltaVerifier.submitEvaluationWithMultipleContributors(
          MODEL_ID,
          evaluationData,
          contributors
        )
      ).to.be.revertedWith("Duplicate contributor address");
    });

    it("should handle maximum number of contributors efficiently", async function () {
      // Test with 10 contributors
      const contributors = [];
      const totalWeight = 10000;
      const weightPerContributor = totalWeight / 10;

      const signers = await ethers.getSigners();
      for (let i = 0; i < 10; i++) {
        contributors.push({
          walletAddress: signers[i].address,
          weight: weightPerContributor
        });
      }

      const evaluationData = {
        pipelineRunId: "test_run_008",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evaluationData,
        contributors
      );

      const receipt = await tx.wait();
      console.log("Gas used for 10 contributors:", receipt.gasUsed.toString());

      // Verify all contributors received tokens
      for (let i = 0; i < 10; i++) {
        const deployedToken = await getDeployedToken();
        const balance = await deployedToken.balanceOf(signers[i].address);
        expect(balance).to.be.gt(0);
      }
    });
  });

  describe("Backward Compatibility", function () {
    it("should maintain compatibility with existing single contributor function", async function () {
      const evaluationData = {
        pipelineRunId: "test_run_009",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        },
        contributor: contributor1.address,
        contributorWeight: 10000,
        contributedSamples: 5000,
        totalSamples: 55000
      };

      const tx = await deltaVerifier.submitEvaluation(MODEL_ID, evaluationData);
      await expect(tx).to.not.be.reverted;

      const deployedToken = await getDeployedToken();
      const balance = await deployedToken.balanceOf(contributor1.address);
      expect(balance).to.be.gt(0);
    });
  });

  describe("Gas Optimization Tests", function () {
    it("should compare gas usage between single and batch minting", async function () {
      const evaluationData = {
        pipelineRunId: "gas_test",
        baselineMetrics: {
          accuracy: 8500,
          precision: 8200,
          recall: 8800,
          f1: 8400,
          auroc: 9000
        },
        newMetrics: {
          accuracy: 8800,
          precision: 8500,
          recall: 9100,
          f1: 8900,
          auroc: 9300
        }
      };

      // Test single contributor
      const singleContributorData = {
        ...evaluationData,
        contributorInfo: {
          walletAddress: contributor1.address,
          contributorWeight: 10000,
          contributedSamples: 5000,
          totalSamples: 55000
        }
      };

      const tx1 = await deltaVerifier.submitEvaluationWithContributorInfo(
        MODEL_ID,
        singleContributorData
      );
      const receipt1 = await tx1.wait();
      console.log("Gas for single contributor:", receipt1.gasUsed.toString());

      // Test multiple contributors
      const contributors = [
        { walletAddress: contributor2.address, weight: 5000 },
        { walletAddress: contributor3.address, weight: 5000 }
      ];

      const tx2 = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        { ...evaluationData, pipelineRunId: "gas_test_2" },
        contributors
      );
      const receipt2 = await tx2.wait();
      console.log("Gas for 2 contributors:", receipt2.gasUsed.toString());
    });
  });
});