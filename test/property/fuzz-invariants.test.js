const { expect } = require("chai");
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

const { buildInitialParams, buildVestingConfig, deployTestToken } = require("../helpers/tokenDeployment");
const {
  buildMintRequestPayload,
  attestMintRequest,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
  payloadForNextLink,
} = require("../helpers/mintRequest");

const GOLDEN_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/deltaverifier-mint-request.golden.json");

function loadGoldenFixture() {
  return JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, "utf8"));
}

function goldenPayload(golden) {
  return {
    pipelineRunId: golden.pipelineRunId,
    baselineScoreBps: golden.baselineScoreBps,
    candidateScoreBps: golden.candidateScoreBps,
    maxCostUsdMicro: golden.maxCostUsdMicro,
    actualCostUsdMicro: golden.actualCostUsdMicro,
    totalSamples: golden.totalSamples,
    anchors: {
      benchmarkSpecHash: golden.benchmarkSpecHash,
      datasetHash: golden.datasetHash,
      attestationHash: golden.attestationHash,
      idempotencyKey: golden.idempotencyKey,
      metricName: golden.metricName,
      metricFamily: golden.metricFamily,
    },
    baselineCommitment: golden.baselineCommitment,
    candidateCommitment: golden.candidateCommitment,
  };
}

function makeRng(seed) {
  let state = BigInt(seed);
  return {
    next() {
      state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return state;
    },
    int(min, max) {
      const span = BigInt(max - min + 1);
      return min + Number(this.next() % span);
    },
    pick(values) {
      return values[this.int(0, values.length - 1)];
    },
  };
}

function randomWeights(rng, count) {
  if (count === 1) return [10000];

  const cuts = new Set();
  while (cuts.size < count - 1) {
    cuts.add(rng.int(1, 9999));
  }

  const points = [0, ...[...cuts].sort((a, b) => a - b), 10000];
  return points.slice(1).map((point, index) => point - points[index]);
}

function splitReward(totalReward, weights) {
  const rewards = weights.map((weight) => (totalReward * BigInt(weight)) / 10000n);
  const distributed = rewards.reduce((sum, reward) => sum + reward, 0n);
  if (totalReward > distributed) {
    rewards[0] += totalReward - distributed;
  }
  return rewards;
}

async function now() {
  return (await ethers.provider.getBlock("latest")).timestamp;
}

describe("Property fuzz invariants", function () {
  const MODEL_ID = 1;
  const MODEL_ID_STR = "1";
  const TOKENS_PER_DELTA_ONE = parseEther("500000");
  const MAX_REWARD = parseEther("1000000");
  const MIN_IMPROVEMENT_BPS = 100;
  const IMMEDIATE_UNLOCK_BPS = 1000n;
  const TRADE_FEE_BPS = 30n;
  const IBR_SECONDS = 24 * 60 * 60;

  async function deployDeltaVerifierFixture() {
    const signers = await ethers.getSigners();
    const [owner, submitter, outsider] = signers;
    const contributors = signers.slice(3, 11);

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    const vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD,
    );
    await deltaVerifier.waitForDeployment();

    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);

    await configureLaunchAttester(deltaVerifier, owner, owner);
    await configureMintBudget(deltaVerifier, owner, MODEL_ID);

    const params = buildInitialParams(owner.address, {
      tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
      vestingConfig: buildVestingConfig({
        enabled: true,
        immediateUnlockBps: Number(IMMEDIATE_UNLOCK_BPS),
        vestingDurationSeconds: 365 * 24 * 60 * 60,
        cliffSeconds: 0,
      }),
    });

    const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      MODEL_ID_STR,
      "Fuzz Reward Token",
      "FUZR",
      parseEther("1000000"),
      params,
    );
    await tokenManager.deployTokenWithParams(MODEL_ID_STR, "Fuzz Reward Token", "FUZR", parseEther("1000000"), params);

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    await modelRegistry.registerModel(MODEL_ID, tokenAddress, "accuracy");
    await configureLineageGenesis(modelRegistry, owner, MODEL_ID);

    return {
      owner,
      submitter,
      outsider,
      contributors,
      token,
      tokenManager,
      modelRegistry,
      contributionRegistry,
      deltaVerifier,
      vestingVault,
    };
  }

  async function deployAmmFixture() {
    const [owner, treasury, user1, user2, user3, outsider] = await ethers.getSigners();
    const users = [user1, user2, user3];
    const modelId = "1211";

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await deployTestToken(tokenManager, modelId, "Fuzz AMM Token", "FUZA", parseEther("1000000"), owner.address);
    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await mockUSDC.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      modelId,
      treasury.address,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("1000", 6),
      parseUnits("0.01", 6),
    );
    await amm.waitForDeployment();
    await tokenManager.authorizeAMM(await amm.getAddress());
    await amm.setMaxTradeBps(5000);

    await mockUSDC.mint(owner.address, parseUnits("10000", 6));
    await mockUSDC.approve(await amm.getAddress(), parseUnits("10000", 6));
    await amm.depositFees(parseUnits("10000", 6));

    for (const user of users) {
      await mockUSDC.mint(user.address, parseUnits("250000", 6));
      await mockUSDC.connect(user).approve(await amm.getAddress(), parseUnits("250000", 6));
    }

    await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
    await network.provider.send("evm_mine");

    return { amm, token, mockUSDC, tokenManager, users, outsider, treasury, modelId };
  }

  describe("DeltaVerifier reward distribution", function () {
    it("fuzzes contributor splits without over-minting or double-minting", async function () {
      const fixture = await loadFixture(deployDeltaVerifierFixture);
      const { owner, submitter, contributors, token, contributionRegistry, deltaVerifier, vestingVault } = fixture;
      const rng = makeRng(0xdecafbad);

      for (let i = 0; i < 32; i += 1) {
        const contributorCount = rng.int(1, contributors.length);
        const selected = contributors.slice(0, contributorCount);
        const weights = randomWeights(rng, contributorCount);
        const baselineScoreBps = rng.int(1000, 8800);
        const deltaBps = rng.int(0, 1200);
        const candidateScoreBps = Math.min(10000, baselineScoreBps + deltaBps);
        const effectiveDeltaBps = candidateScoreBps - baselineScoreBps;
        const expectedTotalReward = effectiveDeltaBps < MIN_IMPROVEMENT_BPS
          ? 0n
          : ((BigInt(effectiveDeltaBps) * TOKENS_PER_DELTA_ONE) / 100n > MAX_REWARD
              ? MAX_REWARD
              : (BigInt(effectiveDeltaBps) * TOKENS_PER_DELTA_ONE) / 100n);
        const expectedRewards = splitReward(expectedTotalReward, weights);
        const fuzzContributors = selected.map((signer, index) => ({
          walletAddress: signer.address,
          weight: weights[index],
        }));
        const payload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
          pipelineRunId: `fuzz-delta-${i}`,
          baselineScoreBps,
          candidateScoreBps,
          totalSamples: rng.int(1, 1_000_000),
          anchors: { idempotencyKey: ethers.id(`fuzz-delta-${i}`) },
        });

        const balancesBefore = await Promise.all(selected.map((signer) => token.balanceOf(signer.address)));
        const vaultBefore = await token.balanceOf(await vestingVault.getAddress());
        const countsBefore = await Promise.all(
          selected.map((signer) => contributionRegistry.getContributorContributionCount(signer.address)),
        );
        const schedulesBefore = await Promise.all(
          selected.map((signer) => vestingVault.getSchedulesByBeneficiary(signer.address)),
        );

        const sigs = await attestMintRequest(deltaVerifier, owner, MODEL_ID, payload, fuzzContributors);
        const staticReward = await deltaVerifier.connect(submitter).submitMintRequest.staticCall(MODEL_ID, payload, fuzzContributors, sigs);
        expect(staticReward).to.equal(expectedTotalReward);
        await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, fuzzContributors, sigs);

        const balancesAfter = await Promise.all(selected.map((signer) => token.balanceOf(signer.address)));
        const vaultAfter = await token.balanceOf(await vestingVault.getAddress());
        const countsAfter = await Promise.all(
          selected.map((signer) => contributionRegistry.getContributorContributionCount(signer.address)),
        );
        const schedulesAfter = await Promise.all(
          selected.map((signer) => vestingVault.getSchedulesByBeneficiary(signer.address)),
        );

        let totalImmediate = 0n;
        let totalVested = 0n;
        for (let j = 0; j < selected.length; j += 1) {
          const immediate = (expectedRewards[j] * IMMEDIATE_UNLOCK_BPS) / 10000n;
          const vested = expectedRewards[j] - immediate;
          totalImmediate += immediate;
          totalVested += vested;
          expect(balancesAfter[j] - balancesBefore[j]).to.equal(immediate);

          if (expectedTotalReward > 0n) {
            expect(countsAfter[j]).to.equal(countsBefore[j] + 1n);
            expect(schedulesAfter[j].length).to.equal(schedulesBefore[j].length + 1);
            const schedule = await vestingVault.getSchedule(schedulesAfter[j][schedulesAfter[j].length - 1]);
            expect(schedule.totalAmount).to.equal(vested);
          } else {
            expect(countsAfter[j]).to.equal(countsBefore[j]);
            expect(schedulesAfter[j].length).to.equal(schedulesBefore[j].length);
          }
        }

        expect(totalImmediate + totalVested).to.equal(expectedTotalReward);
        expect(vaultAfter - vaultBefore).to.equal(totalVested);
        expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, fuzzContributors, sigs)
        ).to.be.revertedWith("Idempotency key already processed");
      }
    });

    it("fuzzes invalid contributor weights and addresses without minting", async function () {
      const { owner, submitter, contributors, token, deltaVerifier } = await loadFixture(deployDeltaVerifierFixture);
      const rng = makeRng(0xbadc0de);

      for (let i = 0; i < 20; i += 1) {
        const balanceBefore = await token.balanceOf(contributors[0].address);
        const payload = buildMintRequestPayload({
          pipelineRunId: `fuzz-invalid-${i}`,
          anchors: { idempotencyKey: ethers.id(`fuzz-invalid-${i}`) },
        });

        const invalidMode = rng.pick(["low", "high", "zero"]);
        const invalidContributors = invalidMode === "zero"
          ? [{ walletAddress: ZeroAddress, weight: 10000 }]
          : [{ walletAddress: contributors[0].address, weight: invalidMode === "low" ? rng.int(1, 9999) : rng.int(10001, 20000) }];

        const sigs = await attestMintRequest(deltaVerifier, owner, MODEL_ID, payload, invalidContributors);
        const assertion = expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, invalidContributors, sigs)
        );
        if (invalidMode === "zero") {
          await assertion.to.be.revertedWithCustomError(deltaVerifier, "ZeroAddress");
        } else {
          await assertion.to.be.revertedWith("Weights must sum to 100%");
        }
        expect(await token.balanceOf(contributors[0].address)).to.equal(balanceBefore);
      }
    });
  });

  describe("DeltaVerifier guardrails", function () {
    describe("Budget invariant", function () {
      it("covers exact-budget, over-budget, and remaining-budget accounting across random deltas", async function () {
        const fixture = await loadFixture(deployDeltaVerifierFixture);
        const { owner, submitter, deltaVerifier } = fixture;
        const rng = makeRng(0xbadf00d);

        for (let i = 0; i < 10; i += 1) {
          await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, MAX_REWARD);
          const baselineScoreBps = rng.int(1000, 8000);
          const deltaBps = rng.int(MIN_IMPROVEMENT_BPS, 500);
          const payload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
            pipelineRunId: `budget-invariant-${i}`,
            baselineScoreBps,
            candidateScoreBps: baselineScoreBps + deltaBps,
            anchors: { idempotencyKey: ethers.id(`budget-invariant-${i}`) },
          });
          const contributors = [{ walletAddress: owner.address, weight: 10000 }];
          const signatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, payload, contributors);
          const reward = await deltaVerifier.connect(submitter).submitMintRequest.staticCall(
            MODEL_ID,
            payload,
            contributors,
            signatures,
          );

          await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, reward);
          await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures);
          expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);

          const retryPayload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
            pipelineRunId: `budget-retry-${i}`,
            baselineScoreBps,
            candidateScoreBps: baselineScoreBps + deltaBps,
            anchors: { idempotencyKey: ethers.id(`budget-retry-${i}`) },
          });
          const retrySignatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, retryPayload, contributors);
          await expect(
            deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, retryPayload, contributors, retrySignatures)
          )
            .to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded")
            .withArgs(MODEL_ID, reward, 0);
          expect(await deltaVerifier.processedIdempotencyKeys(retryPayload.anchors.idempotencyKey)).to.equal(false);

          await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, reward + parseEther("17"));
          await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, retryPayload, contributors, retrySignatures);
          expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(parseEther("17"));
        }
      });
    });

    describe("Signature invariant", function () {
      it("rejects forged signatures and accepts a valid attestation", async function () {
        const fixture = await loadFixture(deployDeltaVerifierFixture);
        const { owner, submitter, deltaVerifier } = fixture;
        const payload = buildMintRequestPayload({
          anchors: { idempotencyKey: ethers.id("sig-validity") },
        });
        const contributors = [{ walletAddress: owner.address, weight: 10000 }];

        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, ["0x1234"])
        ).to.be.reverted;

        const signatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, payload, contributors);
        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
        ).to.emit(deltaVerifier, "DeltaOneAccepted");
      });

      it("treats one-byte payload and contributor flips as signature-breaking mutations", async function () {
        const fixture = await loadFixture(deployDeltaVerifierFixture);
        const { owner, submitter, deltaVerifier, outsider } = fixture;
        const payload = buildMintRequestPayload({
          anchors: { idempotencyKey: ethers.id("sig-field-flips") },
        });
        const contributors = [{ walletAddress: owner.address, weight: 10000 }];
        const signatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, payload, contributors);

        const variants = [
          { ...payload, pipelineRunId: `${payload.pipelineRunId}-x` },
          { ...payload, baselineScoreBps: payload.baselineScoreBps + 1 },
          { ...payload, candidateScoreBps: payload.candidateScoreBps - 1 },
          { ...payload, maxCostUsdMicro: payload.maxCostUsdMicro + 1 },
          { ...payload, actualCostUsdMicro: payload.actualCostUsdMicro + 1 },
          { ...payload, totalSamples: payload.totalSamples + 1 },
          { ...payload, anchors: { ...payload.anchors, benchmarkSpecHash: ethers.id("mut-bench") } },
          { ...payload, anchors: { ...payload.anchors, datasetHash: ethers.id("mut-dataset") } },
          { ...payload, anchors: { ...payload.anchors, attestationHash: ethers.id("mut-attestation") } },
          { ...payload, anchors: { ...payload.anchors, idempotencyKey: ethers.id("mut-idem") } },
          { ...payload, anchors: { ...payload.anchors, metricName: `${payload.anchors.metricName}-x` } },
          { ...payload, anchors: { ...payload.anchors, metricFamily: `${payload.anchors.metricFamily}-x` } },
          { ...payload, baselineCommitment: ethers.id("mut-baseline") },
          { ...payload, candidateCommitment: ethers.id("mut-candidate") },
        ];

        for (const variant of variants) {
          await expect(
            deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, variant, contributors, signatures)
          ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
        }

        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(
            MODEL_ID,
            payload,
            [{ walletAddress: outsider.address, weight: 10000 }],
            signatures,
          )
        ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
      });
    });

    describe("Lineage invariant", function () {
      it("rejects stale parents, rejects zero candidates, blocks unseeded models, and advances chained heads", async function () {
        const fixture = await loadFixture(deployDeltaVerifierFixture);
        const { owner, submitter, deltaVerifier, contributors } = fixture;
        const contributorSet = [{ walletAddress: contributors[0].address, weight: 10000 }];

        const firstPayload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
          pipelineRunId: "lineage-first",
          anchors: { idempotencyKey: ethers.id("lineage-first") },
        });
        const firstSignatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, firstPayload, contributorSet);
        await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, firstPayload, contributorSet, firstSignatures);
        expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(firstPayload.candidateCommitment);

        const stalePayload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
          pipelineRunId: "lineage-stale",
          baselineCommitment: firstPayload.baselineCommitment,
          anchors: { idempotencyKey: ethers.id("lineage-stale") },
        });
        const staleSignatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, stalePayload, contributorSet);
        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, stalePayload, contributorSet, staleSignatures)
        ).to.be.revertedWithCustomError(deltaVerifier, "LineageParentMismatch");

        const zeroCandidatePayload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
          pipelineRunId: "lineage-zero-candidate",
          candidateCommitment: ethers.ZeroHash,
          anchors: { idempotencyKey: ethers.id("lineage-zero-candidate") },
        });
        const zeroCandidateSignatures = await attestMintRequest(
          deltaVerifier,
          owner,
          MODEL_ID,
          zeroCandidatePayload,
          contributorSet,
        );
        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(
            MODEL_ID,
            zeroCandidatePayload,
            contributorSet,
            zeroCandidateSignatures,
          )
        ).to.be.revertedWithCustomError(deltaVerifier, "InvalidCandidateCommitment");

        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        const unseededRegistry = await ModelRegistry.deploy();
        await unseededRegistry.waitForDeployment();
        const TokenManager = await ethers.getContractFactory("TokenManager");
        const unseededManager = await TokenManager.deploy(await unseededRegistry.getAddress());
        await unseededManager.waitForDeployment();
        const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
        const unseededContributionRegistry = await DataContributionRegistry.deploy();
        await unseededContributionRegistry.waitForDeployment();
        const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
        const unseededVerifier = await DeltaVerifier.deploy(
          await unseededRegistry.getAddress(),
          await unseededManager.getAddress(),
          await unseededContributionRegistry.getAddress(),
          parseEther("1000"),
          MIN_IMPROVEMENT_BPS,
          MAX_REWARD,
        );
        await unseededVerifier.waitForDeployment();
        await deployTestToken(unseededManager, MODEL_ID_STR, "Unseeded Token", "UNSD", parseEther("10000"), owner.address);
        await unseededRegistry.registerModel(MODEL_ID, await unseededManager.getTokenAddress(MODEL_ID_STR), "accuracy");
        await unseededManager.setDeltaVerifier(await unseededVerifier.getAddress());
        await unseededContributionRegistry.grantRole(
          await unseededContributionRegistry.RECORDER_ROLE(),
          await unseededVerifier.getAddress(),
        );
        await unseededVerifier.grantRole(await unseededVerifier.SUBMITTER_ROLE(), submitter.address);
        await configureLaunchAttester(unseededVerifier, owner, owner);
        await configureMintBudget(unseededVerifier, owner, MODEL_ID);
        const unseededPayload = buildMintRequestPayload({
          anchors: { idempotencyKey: ethers.id("lineage-unseeded") },
        });
        const unseededSignatures = await attestMintRequest(
          unseededVerifier,
          owner,
          MODEL_ID,
          unseededPayload,
          contributorSet,
        );
        await expect(
          unseededVerifier.connect(submitter).submitMintRequest(
            MODEL_ID,
            unseededPayload,
            contributorSet,
            unseededSignatures,
          )
        ).to.be.revertedWithCustomError(unseededVerifier, "LineageNotSeeded");

        const secondPayload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
          pipelineRunId: "lineage-second",
          anchors: { idempotencyKey: ethers.id("lineage-second") },
        });
        expect(secondPayload.baselineCommitment).to.equal(firstPayload.candidateCommitment);
        const secondSignatures = await attestMintRequest(deltaVerifier, owner, MODEL_ID, secondPayload, contributorSet);
        await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, secondPayload, contributorSet, secondSignatures);
        expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(secondPayload.candidateCommitment);
      });
    });

    describe("Golden fixture parity", function () {
      it("submits the repo golden payload and rejects a tampered variant", async function () {
        const fixture = await loadFixture(deployDeltaVerifierFixture);
        const { owner, submitter, deltaVerifier, tokenManager, modelRegistry } = fixture;
        const golden = loadGoldenFixture();
        const modelId = BigInt(golden.modelId);
        const modelIdStr = golden.modelId;

        await deployTestToken(
          tokenManager,
          modelIdStr,
          "Golden Property Token",
          "GPTK",
          parseEther("10000"),
          owner.address,
        );
        await modelRegistry.registerModel(modelId, await tokenManager.getTokenAddress(modelIdStr), golden.metricName);
        await configureMintBudget(deltaVerifier, owner, modelId);
        await configureLineageGenesis(modelRegistry, owner, modelId, golden.baselineCommitment);

        const payload = goldenPayload(golden);
        const contributors = golden.contributors;
        const signatures = await attestMintRequest(deltaVerifier, owner, modelId, payload, contributors);

        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(
            modelId,
            { ...payload, totalSamples: payload.totalSamples + 1 },
            contributors,
            signatures,
          )
        ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");

        await expect(
          deltaVerifier.connect(submitter).submitMintRequest(modelId, payload, contributors, signatures)
        ).to.emit(deltaVerifier, "DeltaOneAccepted");
      });
    });
  });

  describe("AMM reserve and supply accounting", function () {
    it("fuzzes buy, sell, and fee-deposit sequences while preserving accounting invariants", async function () {
      const { amm, tokenManager, token, mockUSDC, users, modelId } = await loadFixture(deployAmmFixture);
      const rng = makeRng(0xa11ce);

      for (let i = 0; i < 48; i += 1) {
        const action = rng.pick(["buy", "sell", "deposit"]);
        const actor = rng.pick(users);

        if (action === "buy") {
          const reserveBefore = await amm.reserveBalance();
          const amount = parseUnits(rng.int(1, 2500).toString(), 6);
          const maxTrade = (reserveBefore * await amm.maxTradeBps()) / 10000n;
          if (amount > maxTrade) {
            await expect(
              amm.connect(actor).buy(amount, 0, actor.address, (await now()) + 300)
            ).to.be.revertedWith("Trade exceeds max size limit");
          } else {
            const quote = await amm.getBuyQuote(amount);
            await mockUSDC.connect(actor).approve(await amm.getAddress(), amount);
            await amm.connect(actor).buy(amount, quote, actor.address, (await now()) + 300);
            const fee = (amount * TRADE_FEE_BPS) / 10000n;
            expect(await amm.reserveBalance()).to.equal(reserveBefore + amount - fee);
          }
        } else if (action === "sell") {
          const balance = await token.balanceOf(actor.address);
          if (balance > 0n) {
            const tokensIn = balance / BigInt(rng.int(8, 40));
            const quote = await amm.getSellQuote(tokensIn);
            const maxTrade = (await amm.reserveBalance() * await amm.maxTradeBps()) / 10000n;
            if (quote > maxTrade) {
              await token.connect(actor).approve(await amm.getAddress(), tokensIn);
              await expect(
                amm.connect(actor).sell(tokensIn, 0, actor.address, (await now()) + 300)
              ).to.be.revertedWith("Trade exceeds max size limit");
            } else if (tokensIn > 0n && quote > 0n) {
              const reserveBefore = await amm.reserveBalance();
              await token.connect(actor).approve(await amm.getAddress(), tokensIn);
              await amm.connect(actor).sell(tokensIn, quote - 1n, actor.address, (await now()) + 300);
              expect(await amm.reserveBalance()).to.equal(reserveBefore - quote);
            }
          }
        } else {
          const amount = parseUnits(rng.int(1, 500).toString(), 6);
          const reserveBefore = await amm.reserveBalance();
          await mockUSDC.connect(actor).approve(await amm.getAddress(), amount);
          await amm.connect(actor).depositFees(amount);
          expect(await amm.reserveBalance()).to.equal(reserveBefore + amount);
        }

        const reserve = await amm.reserveBalance();
        const ammUsdc = await mockUSDC.balanceOf(await amm.getAddress());
        const [, reportedSupply] = await amm.getReserves();
        expect(reserve).to.be.lte(ammUsdc);
        expect(reportedSupply).to.equal(await tokenManager.getRedeemableSupply(modelId));
        expect(await amm.spotPrice()).to.be.gt(0);
      }
    });

    it("fuzzes access control and pause-state blocking for state-changing methods", async function () {
      const { amm, tokenManager, token, users, outsider, modelId } = await loadFixture(deployAmmFixture);
      const rng = makeRng(0x515ec);

      for (let i = 0; i < 16; i += 1) {
        const unauthorizedAmount = parseEther(rng.int(1, 100).toString());
        await expect(
          tokenManager.connect(outsider).mintTokens(modelId, outsider.address, unauthorizedAmount)
        ).to.be.revertedWith("Caller is not authorized to mint");
        await expect(
          tokenManager.connect(outsider).burnTokens(modelId, users[0].address, unauthorizedAmount)
        ).to.be.revertedWith("Caller is not authorized to burn");
      }

      await amm.pause();
      await expect(
        amm.connect(users[0]).buy(parseUnits("1", 6), 0, users[0].address, (await now()) + 300)
      ).to.be.revertedWith("Pausable: paused");

      const balance = await token.balanceOf(users[0].address);
      if (balance > 0n) {
        await token.connect(users[0]).approve(await amm.getAddress(), balance / 100n);
        await expect(
          amm.connect(users[0]).sell(balance / 100n, 0, users[0].address, (await now()) + 300)
        ).to.be.revertedWith("Pausable: paused");
      }
    });
  });
});
