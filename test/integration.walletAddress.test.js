const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("Integration: JSON Wallet Address Support", function () {
  let deltaVerifier;
  let tokenManager;
  let hokusaiToken;
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

  // Sample JSON data matching the schema
  const singleContributorJSON = {
    schema_version: "1.0",
    metadata: {
      pipeline_run_id: "zk_run_1234567890",
      timestamp: "2025-01-16T10:30:00.000Z",
      pipeline_version: "e36d904abc123def456789",
      environment: "production",
      dry_run: false
    },
    evaluation_results: {
      baseline_metrics: {
        accuracy: 0.854,
        precision: 0.827,
        recall: 0.887,
        f1: 0.839,
        auroc: 0.904
      },
      new_metrics: {
        accuracy: 0.884,
        precision: 0.854,
        recall: 0.913,
        f1: 0.891,
        auroc: 0.935
      },
      benchmark_metadata: {
        size: 10000,
        type: "hokusai_standard_benchmark_v1"
      }
    },
    delta_computation: {
      delta_one_score: 0.0332,
      computation_method: "weighted_average_delta"
    },
    models: {
      baseline: { model_id: "baseline_v1.0.0" },
      new: { model_id: "enhanced_v1.1.0" }
    },
    contributor_info: {
      wallet_address: "", // Will be filled in tests
      contributor_weights: 1.0,
      contributed_samples: 5000,
      total_samples: 55000
    },
    attestation: {
      hash_tree_root: "9abc567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      proof_ready: true
    }
  };

  const multipleContributorsJSON = {
    schema_version: "1.0",
    metadata: {
      pipeline_run_id: "zk_run_multi_contributors",
      timestamp: "2025-01-16T11:00:00.000Z",
      pipeline_version: "e36d904abc123def456789",
      environment: "production",
      dry_run: false
    },
    evaluation_results: {
      baseline_metrics: {
        accuracy: 0.854,
        precision: 0.827,
        recall: 0.887,
        f1: 0.839,
        auroc: 0.904
      },
      new_metrics: {
        accuracy: 0.884,
        precision: 0.854,
        recall: 0.913,
        f1: 0.891,
        auroc: 0.935
      },
      benchmark_metadata: {
        size: 10000,
        type: "hokusai_standard_benchmark_v1"
      }
    },
    delta_computation: {
      delta_one_score: 0.0332,
      computation_method: "weighted_average_delta"
    },
    models: {
      baseline: { model_id: "baseline_v1.0.0" },
      new: { model_id: "enhanced_v1.1.0" }
    },
    contributors: [], // Will be filled in tests
    attestation: {
      hash_tree_root: "9abc567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
      proof_ready: true
    }
  };

  beforeEach(async function () {
    [owner, contributor1, contributor2, contributor3, treasury] = await ethers.getSigners();

    // Deploy all contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    hokusaiToken = await HokusaiToken.deploy("Hokusai Token", "HOKU", owner.address, parseEther("10000"));
    await hokusaiToken.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      BASE_REWARD_RATE,
      100,  // minImprovementBps
      ethers.parseEther("1000000")  // maxReward
    );
    await deltaVerifier.waitForDeployment();

    // Set up permissions
    await hokusaiToken.setController(await tokenManager.getAddress());
    await tokenManager.deployToken(MODEL_ID, "Hokusai Token", "HOKU", parseEther("10000"));
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    // Register model in registry for DeltaVerifier
    await modelRegistry.registerModel(
      MODEL_ID,
      await hokusaiToken.getAddress(),
      "accuracy"
    );
  });

  describe("End-to-End: Single Contributor JSON", function () {
    it("should process single contributor JSON and mint tokens", async function () {
      // Prepare JSON with wallet address
      const jsonData = {
        ...singleContributorJSON,
        contributor_info: {
          ...singleContributorJSON.contributor_info,
          wallet_address: contributor1.address
        }
      };

      // Simulate off-chain JSON parsing - extract data for contract
      const evaluationData = {
        pipelineRunId: jsonData.metadata.pipeline_run_id,
        baselineMetrics: {
          accuracy: Math.floor(jsonData.evaluation_results.baseline_metrics.accuracy * 10000),
          precision: Math.floor(jsonData.evaluation_results.baseline_metrics.precision * 10000),
          recall: Math.floor(jsonData.evaluation_results.baseline_metrics.recall * 10000),
          f1: Math.floor(jsonData.evaluation_results.baseline_metrics.f1 * 10000),
          auroc: Math.floor(jsonData.evaluation_results.baseline_metrics.auroc * 10000)
        },
        newMetrics: {
          accuracy: Math.floor(jsonData.evaluation_results.new_metrics.accuracy * 10000),
          precision: Math.floor(jsonData.evaluation_results.new_metrics.precision * 10000),
          recall: Math.floor(jsonData.evaluation_results.new_metrics.recall * 10000),
          f1: Math.floor(jsonData.evaluation_results.new_metrics.f1 * 10000),
          auroc: Math.floor(jsonData.evaluation_results.new_metrics.auroc * 10000)
        },
        contributorInfo: {
          walletAddress: jsonData.contributor_info.wallet_address,
          contributorWeight: Math.floor(jsonData.contributor_info.contributor_weights * 10000),
          contributedSamples: jsonData.contributor_info.contributed_samples,
          totalSamples: jsonData.contributor_info.total_samples
        }
      };

      // Submit evaluation
      const tx = await deltaVerifier.submitEvaluationWithContributorInfo(
        MODEL_ID,
        evaluationData
      );

      await expect(tx)
        .to.emit(deltaVerifier, "EvaluationSubmitted")
        .withArgs(jsonData.metadata.pipeline_run_id, MODEL_ID);

      // Verify tokens minted to correct address
      const deployedToken = await getDeployedToken();
      const balance = await deployedToken.balanceOf(contributor1.address);
      expect(balance).to.be.gt(0);

      // Calculate expected reward based on delta
      const deltaScore = Math.floor(jsonData.delta_computation.delta_one_score * 10000);
      console.log("Delta score (bps):", deltaScore);
      console.log("Tokens minted:", ethers.formatEther(balance));
    });
  });

  describe("End-to-End: Multiple Contributors JSON", function () {
    it("should process multiple contributors JSON and distribute tokens", async function () {
      // Prepare JSON with multiple contributors
      const jsonData = {
        ...multipleContributorsJSON,
        contributors: [
          {
            id: "contributor_001",
            wallet_address: contributor1.address,
            weight: 0.6,
            data_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
            data_manifest: {
              data_hash: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
              row_count: 3000,
              column_count: 5
            }
          },
          {
            id: "contributor_002",
            wallet_address: contributor2.address,
            weight: 0.3,
            data_hash: "2345678901bcdef1234567890abcdef1234567890abcdef1234567890abcdef1",
            data_manifest: {
              data_hash: "2345678901bcdef1234567890abcdef1234567890abcdef1234567890abcdef1",
              row_count: 1500,
              column_count: 5
            }
          },
          {
            id: "contributor_003",
            wallet_address: contributor3.address,
            weight: 0.1,
            data_hash: "3456789012cdef1234567890abcdef1234567890abcdef1234567890abcdef12",
            data_manifest: {
              data_hash: "3456789012cdef1234567890abcdef1234567890abcdef1234567890abcdef12",
              row_count: 500,
              column_count: 5
            }
          }
        ]
      };

      // Extract data for contract
      const evaluationData = {
        pipelineRunId: jsonData.metadata.pipeline_run_id,
        baselineMetrics: {
          accuracy: Math.floor(jsonData.evaluation_results.baseline_metrics.accuracy * 10000),
          precision: Math.floor(jsonData.evaluation_results.baseline_metrics.precision * 10000),
          recall: Math.floor(jsonData.evaluation_results.baseline_metrics.recall * 10000),
          f1: Math.floor(jsonData.evaluation_results.baseline_metrics.f1 * 10000),
          auroc: Math.floor(jsonData.evaluation_results.baseline_metrics.auroc * 10000)
        },
        newMetrics: {
          accuracy: Math.floor(jsonData.evaluation_results.new_metrics.accuracy * 10000),
          precision: Math.floor(jsonData.evaluation_results.new_metrics.precision * 10000),
          recall: Math.floor(jsonData.evaluation_results.new_metrics.recall * 10000),
          f1: Math.floor(jsonData.evaluation_results.new_metrics.f1 * 10000),
          auroc: Math.floor(jsonData.evaluation_results.new_metrics.auroc * 10000)
        }
      };

      const contributors = jsonData.contributors.map(c => ({
        walletAddress: c.wallet_address,
        weight: Math.floor(c.weight * 10000)
      }));

      // Submit evaluation with multiple contributors
      const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
        MODEL_ID,
        evaluationData,
        contributors
      );

      await expect(tx)
        .to.emit(deltaVerifier, "EvaluationSubmitted")
        .withArgs(jsonData.metadata.pipeline_run_id, MODEL_ID);

      // Verify token distribution
      const deployedToken = await getDeployedToken();
      const balance1 = await deployedToken.balanceOf(contributor1.address);
      const balance2 = await deployedToken.balanceOf(contributor2.address);
      const balance3 = await deployedToken.balanceOf(contributor3.address);

      console.log("Contributor 1 (60%):", ethers.formatEther(balance1));
      console.log("Contributor 2 (30%):", ethers.formatEther(balance2));
      console.log("Contributor 3 (10%):", ethers.formatEther(balance3));

      // Verify proportional distribution
      const totalBalance = balance1 + balance2 + balance3;
      expect(Number((balance1 * 10000n) / totalBalance)).to.be.closeTo(6000, 100);
      expect(Number((balance2 * 10000n) / totalBalance)).to.be.closeTo(3000, 100);
      expect(Number((balance3 * 10000n) / totalBalance)).to.be.closeTo(1000, 100);
    });

    it("should handle edge case JSON scenarios", async function () {
      // Test with minimal required fields
      const minimalJSON = {
        evaluation_results: {
          baseline_metrics: { accuracy: 0.85 },
          new_metrics: { accuracy: 0.88 }
        },
        contributors: [
          {
            wallet_address: contributor1.address,
            weight: 1.0
          }
        ]
      };

      // This would be handled by off-chain validation and parsing
      // The contract would receive properly formatted data
    });
  });

  describe("JSON Validation Scenarios", function () {
    it("should handle invalid wallet address format", async function () {
      // Test empty address
      const evaluationData = {
        pipelineRunId: "test_invalid_empty",
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
          walletAddress: ethers.ZeroAddress,
          contributorWeight: 10000,
          contributedSamples: 5000,
          totalSamples: 55000
        }
      };

      await expect(
        deltaVerifier.submitEvaluationWithContributorInfo(MODEL_ID, evaluationData)
      ).to.be.revertedWith("Invalid wallet address");
    });

    it("should validate weight ranges", async function () {
      // Weights should be between 0 and 1 in JSON, 0 and 10000 in contract
      const contributors = [
        {
          walletAddress: contributor1.address,
          weight: 15000 // 150% - invalid
        }
      ];

      const evaluationData = {
        pipelineRunId: "test_invalid_weight",
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
      ).to.be.reverted;
    });
  });

  describe("Gas Usage Analysis", function () {
    it("should measure gas for different contributor counts", async function () {
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

      // Test with different numbers of contributors
      const contributorCounts = [1, 2, 5, 10];
      const signers = await ethers.getSigners();

      for (const count of contributorCounts) {
        const contributors = [];
        const weight = Math.floor(10000 / count);
        
        for (let i = 0; i < count; i++) {
          contributors.push({
            walletAddress: signers[i].address,
            weight: i === count - 1 ? 10000 - (weight * (count - 1)) : weight
          });
        }

        const tx = await deltaVerifier.submitEvaluationWithMultipleContributors(
          MODEL_ID,
          { ...evaluationData, pipelineRunId: `gas_test_${count}` },
          contributors
        );
        
        const receipt = await tx.wait();
        console.log(`Gas used for ${count} contributor(s):`, receipt.gasUsed.toString());
      }
    });
  });
});