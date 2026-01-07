const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("DataContributionRegistry - Phase 1: Core Functions", function () {
    let registry;
    let owner, recorder, verifier, contributor1, contributor2, other;
    let RECORDER_ROLE, VERIFIER_ROLE;

    beforeEach(async function () {
        [owner, recorder, verifier, contributor1, contributor2, other] = await ethers.getSigners();

        const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
        registry = await DataContributionRegistry.deploy();
        await registry.waitForDeployment();

        // Get role identifiers
        RECORDER_ROLE = await registry.RECORDER_ROLE();
        VERIFIER_ROLE = await registry.VERIFIER_ROLE();

        // Grant roles
        await registry.grantRole(RECORDER_ROLE, recorder.address);
        await registry.grantRole(VERIFIER_ROLE, verifier.address);
    });

    describe("Deployment", function () {
        it("should set deployer as admin with all roles", async function () {
            const DEFAULT_ADMIN_ROLE = await registry.DEFAULT_ADMIN_ROLE();
            expect(await registry.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
            expect(await registry.hasRole(RECORDER_ROLE, owner.address)).to.be.true;
            expect(await registry.hasRole(VERIFIER_ROLE, owner.address)).to.be.true;
        });

        it("should start with contribution ID at 1", async function () {
            expect(await registry.nextContributionId()).to.equal(1);
        });
    });

    describe("recordContribution", function () {
        const modelId = "chest-xray-v2";
        const contributionHash = ethers.keccak256(ethers.toUtf8Bytes("test-hash"));
        const weightBps = 5000; // 50%
        const contributedSamples = 1000;
        const totalSamples = 2000;
        const tokensEarned = ethers.parseEther("100");
        const pipelineRunId = "run_abc123";

        it("should record a contribution with correct data", async function () {
            const tx = await registry.connect(recorder).recordContribution(
                modelId,
                contributor1.address,
                contributionHash,
                weightBps,
                contributedSamples,
                totalSamples,
                tokensEarned,
                pipelineRunId
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    return registry.interface.parseLog(log).name === "ContributionRecorded";
                } catch {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = registry.interface.parseLog(event);
            expect(parsedEvent.args.contributionId).to.equal(1);
            expect(parsedEvent.args.modelId).to.equal(modelId);
            expect(parsedEvent.args.contributor).to.equal(contributor1.address);
            expect(parsedEvent.args.contributionHash).to.equal(contributionHash);
            expect(parsedEvent.args.weightBps).to.equal(weightBps);
            expect(parsedEvent.args.tokensEarned).to.equal(tokensEarned);
            expect(parsedEvent.args.pipelineRunId).to.equal(pipelineRunId);
        });

        it("should increment contribution ID", async function () {
            await registry.connect(recorder).recordContribution(
                modelId,
                contributor1.address,
                contributionHash,
                weightBps,
                contributedSamples,
                totalSamples,
                tokensEarned,
                pipelineRunId
            );

            expect(await registry.nextContributionId()).to.equal(2);
        });

        it("should update all mappings correctly", async function () {
            await registry.connect(recorder).recordContribution(
                modelId,
                contributor1.address,
                contributionHash,
                weightBps,
                contributedSamples,
                totalSamples,
                tokensEarned,
                pipelineRunId
            );

            // Check primary storage
            expect(await registry.isContributionRegistered(1)).to.be.true;

            // Check hash mapping
            expect(await registry.hashToContribution(contributionHash)).to.equal(1);

            // Check aggregate tracking
            expect(await registry.contributorTotalTokens(modelId, contributor1.address)).to.equal(tokensEarned);
            expect(await registry.contributorGlobalTokens(contributor1.address)).to.equal(tokensEarned);
        });

        it("should store contribution record correctly", async function () {
            await registry.connect(recorder).recordContribution(
                modelId,
                contributor1.address,
                contributionHash,
                weightBps,
                contributedSamples,
                totalSamples,
                tokensEarned,
                pipelineRunId
            );

            const record = await registry.getContribution(1);
            expect(record.modelId).to.equal(modelId);
            expect(record.contributor).to.equal(contributor1.address);
            expect(record.contributionHash).to.equal(contributionHash);
            expect(record.contributorWeightBps).to.equal(weightBps);
            expect(record.contributedSamples).to.equal(contributedSamples);
            expect(record.totalSamples).to.equal(totalSamples);
            expect(record.tokensEarned).to.equal(tokensEarned);
            expect(record.pipelineRunId).to.equal(pipelineRunId);
            expect(record.status).to.equal(0); // Pending
        });

        it("should revert if non-recorder tries to record", async function () {
            await expect(
                registry.connect(other).recordContribution(
                    modelId,
                    contributor1.address,
                    contributionHash,
                    weightBps,
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.reverted;
        });

        it("should revert with invalid contributor address", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    modelId,
                    ethers.ZeroAddress,
                    contributionHash,
                    weightBps,
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.revertedWith("Invalid contributor address");
        });

        it("should revert with empty model ID", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    "",
                    contributor1.address,
                    contributionHash,
                    weightBps,
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.revertedWith("Model ID cannot be empty");
        });

        it("should revert with invalid contribution hash", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    modelId,
                    contributor1.address,
                    ethers.ZeroHash,
                    weightBps,
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.revertedWith("Invalid contribution hash");
        });

        it("should revert if weight exceeds 100%", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    modelId,
                    contributor1.address,
                    contributionHash,
                    10001, // >100%
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.revertedWith("Weight cannot exceed 100%");
        });

        it("should revert if contributed samples exceed total", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    modelId,
                    contributor1.address,
                    contributionHash,
                    weightBps,
                    2001, // > totalSamples
                    totalSamples,
                    tokensEarned,
                    pipelineRunId
                )
            ).to.be.revertedWith("Contributed samples cannot exceed total");
        });

        it("should revert with empty pipeline run ID", async function () {
            await expect(
                registry.connect(recorder).recordContribution(
                    modelId,
                    contributor1.address,
                    contributionHash,
                    weightBps,
                    contributedSamples,
                    totalSamples,
                    tokensEarned,
                    ""
                )
            ).to.be.revertedWith("Pipeline run ID cannot be empty");
        });
    });

    describe("recordContributionBatch", function () {
        const modelId = "chest-xray-v2";
        const pipelineRunId = "run_abc123";
        const totalSamples = 5000;

        it("should record batch contributions efficiently", async function () {
            const contributors = [contributor1.address, contributor2.address];
            const hashes = [
                ethers.keccak256(ethers.toUtf8Bytes("hash1")),
                ethers.keccak256(ethers.toUtf8Bytes("hash2"))
            ];
            const weights = [6000, 4000]; // 60%, 40%
            const samples = [3000, 2000];
            const tokens = [ethers.parseEther("600"), ethers.parseEther("400")];

            const tx = await registry.connect(recorder).recordContributionBatch(
                modelId,
                contributors,
                hashes,
                weights,
                samples,
                totalSamples,
                tokens,
                pipelineRunId
            );

            const receipt = await tx.wait();

            // Check both contributions were recorded
            expect(await registry.isContributionRegistered(1)).to.be.true;
            expect(await registry.isContributionRegistered(2)).to.be.true;

            // Verify first contribution
            const record1 = await registry.getContribution(1);
            expect(record1.contributor).to.equal(contributor1.address);
            expect(record1.contributorWeightBps).to.equal(6000);
            expect(record1.tokensEarned).to.equal(ethers.parseEther("600"));

            // Verify second contribution
            const record2 = await registry.getContribution(2);
            expect(record2.contributor).to.equal(contributor2.address);
            expect(record2.contributorWeightBps).to.equal(4000);
            expect(record2.tokensEarned).to.equal(ethers.parseEther("400"));
        });

        it("should revert with empty contributors array", async function () {
            await expect(
                registry.connect(recorder).recordContributionBatch(
                    modelId,
                    [],
                    [],
                    [],
                    [],
                    totalSamples,
                    [],
                    pipelineRunId
                )
            ).to.be.revertedWith("Empty contributors array");
        });

        it("should revert if batch size exceeds limit", async function () {
            const largeArray = new Array(101).fill(contributor1.address);

            await expect(
                registry.connect(recorder).recordContributionBatch(
                    modelId,
                    largeArray,
                    largeArray.map(() => ethers.keccak256(ethers.toUtf8Bytes("hash"))),
                    largeArray.map(() => 100),
                    largeArray.map(() => 10),
                    totalSamples,
                    largeArray.map(() => ethers.parseEther("1")),
                    pipelineRunId
                )
            ).to.be.revertedWith("Batch size exceeds limit");
        });

        it("should revert with array length mismatch", async function () {
            await expect(
                registry.connect(recorder).recordContributionBatch(
                    modelId,
                    [contributor1.address, contributor2.address],
                    [ethers.keccak256(ethers.toUtf8Bytes("hash1"))], // Only 1 element
                    [6000, 4000],
                    [3000, 2000],
                    totalSamples,
                    [ethers.parseEther("600"), ethers.parseEther("400")],
                    pipelineRunId
                )
            ).to.be.revertedWith("Array length mismatch");
        });
    });

    describe("Verification", function () {
        const modelId = "chest-xray-v2";
        const contributionHash = ethers.keccak256(ethers.toUtf8Bytes("test-hash"));

        beforeEach(async function () {
            await registry.connect(recorder).recordContribution(
                modelId,
                contributor1.address,
                contributionHash,
                5000,
                1000,
                2000,
                ethers.parseEther("100"),
                "run_abc123"
            );
        });

        it("should verify pending contribution", async function () {
            await registry.connect(verifier).verifyContribution(1);

            const record = await registry.getContribution(1);
            expect(record.status).to.equal(1); // Verified
        });

        it("should emit ContributionVerified event", async function () {
            await expect(registry.connect(verifier).verifyContribution(1))
                .to.emit(registry, "ContributionVerified")
                .withArgs(1, verifier.address);
        });

        it("should reject contribution with reason", async function () {
            await registry.connect(verifier).rejectContribution(1, "Invalid data");

            const record = await registry.getContribution(1);
            expect(record.status).to.equal(3); // Rejected
        });

        it("should emit ContributionRejected event", async function () {
            await expect(registry.connect(verifier).rejectContribution(1, "Invalid data"))
                .to.emit(registry, "ContributionRejected")
                .withArgs(1, "Invalid data");
        });

        it("should revert if non-verifier tries to verify", async function () {
            await expect(
                registry.connect(other).verifyContribution(1)
            ).to.be.reverted;
        });

        it("should revert verifying non-existent contribution", async function () {
            await expect(
                registry.connect(verifier).verifyContribution(999)
            ).to.be.revertedWith("Contribution not registered");
        });

        it("should revert verifying already verified contribution", async function () {
            await registry.connect(verifier).verifyContribution(1);

            await expect(
                registry.connect(verifier).verifyContribution(1)
            ).to.be.revertedWith("Contribution not pending");
        });

        it("should revert rejecting with empty reason", async function () {
            await expect(
                registry.connect(verifier).rejectContribution(1, "")
            ).to.be.revertedWith("Reason cannot be empty");
        });
    });

    describe("View Functions", function () {
        beforeEach(async function () {
            // Record multiple contributions
            await registry.connect(recorder).recordContribution(
                "model-1",
                contributor1.address,
                ethers.keccak256(ethers.toUtf8Bytes("hash1")),
                5000,
                1000,
                2000,
                ethers.parseEther("100"),
                "run_1"
            );

            await registry.connect(recorder).recordContribution(
                "model-1",
                contributor2.address,
                ethers.keccak256(ethers.toUtf8Bytes("hash2")),
                5000,
                1000,
                2000,
                ethers.parseEther("100"),
                "run_1"
            );

            await registry.connect(recorder).recordContribution(
                "model-2",
                contributor1.address,
                ethers.keccak256(ethers.toUtf8Bytes("hash3")),
                10000,
                2000,
                2000,
                ethers.parseEther("200"),
                "run_2"
            );
        });

        it("should get contribution counts by model", async function () {
            expect(await registry.getModelContributionCount("model-1")).to.equal(2);
            expect(await registry.getModelContributionCount("model-2")).to.equal(1);
        });

        it("should get contribution counts by contributor", async function () {
            expect(await registry.getContributorContributionCount(contributor1.address)).to.equal(2);
            expect(await registry.getContributorContributionCount(contributor2.address)).to.equal(1);
        });

        it("should verify contribution hash exists", async function () {
            const hash = ethers.keccak256(ethers.toUtf8Bytes("hash1"));
            const [exists, contributionId] = await registry.verifyContributionHash(hash);

            expect(exists).to.be.true;
            expect(contributionId).to.equal(1);
        });

        it("should return false for non-existent hash", async function () {
            const hash = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
            const [exists, contributionId] = await registry.verifyContributionHash(hash);

            expect(exists).to.be.false;
            expect(contributionId).to.equal(0);
        });

        it("should check if contributor has contributed to model", async function () {
            expect(await registry.hasContributedToModel("model-1", contributor1.address)).to.be.true;
            expect(await registry.hasContributedToModel("model-1", contributor2.address)).to.be.true;
            expect(await registry.hasContributedToModel("model-2", contributor1.address)).to.be.true;
            expect(await registry.hasContributedToModel("model-2", contributor2.address)).to.be.false;
        });

        it("should get contributor stats for model", async function () {
            const [totalContributions, totalTokens, totalSamples] =
                await registry.getContributorStatsForModel("model-1", contributor1.address);

            expect(totalContributions).to.equal(1);
            expect(totalTokens).to.equal(ethers.parseEther("100"));
            expect(totalSamples).to.equal(1000);
        });

        it("should get global contributor stats", async function () {
            const [totalContributions, totalTokens, modelsContributedTo] =
                await registry.getContributorGlobalStats(contributor1.address);

            expect(totalContributions).to.equal(2);
            expect(totalTokens).to.equal(ethers.parseEther("300")); // 100 + 200
            expect(modelsContributedTo).to.equal(2); // model-1 and model-2
        });
    });
});
