/*
 * Covers DeltaVerifier.submitMintRequest edge cases and mint semantics.
 * Legacy submitEvaluation* multi-contributor coverage stays in
 * test/deltaVerifier.multiContributor.test.js.
 * The files are intentionally separate because they exercise different APIs.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { buildMintRequestPayload } = require("./helpers/mintRequest");

describe("DeltaVerifier MintRequest", function () {
  let owner;
  let submitter;
  let contributor1;
  let contributor2;
  let contributor3;
  let outsider;
  let modelRegistry;
  let tokenManager;
  let contributionRegistry;
  let deltaVerifier;
  let deployedToken;
  let hokusaiParams;

  const MODEL_ID = 1;
  const MODEL_ID_STR = "1";
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("1000000");

  async function getToken() {
    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID_STR);
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    return HokusaiToken.attach(tokenAddress);
  }

  async function getParams() {
    const paramsAddress = await tokenManager.modelParams(MODEL_ID_STR);
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    return HokusaiParams.attach(paramsAddress);
  }

  async function expectMissingRole(txPromise, signer, role) {
    await expect(txPromise).to.be.revertedWith(
      `AccessControl: account ${signer.address.toLowerCase()} is missing role ${role}`
    );
  }

  async function submitMintRequestAs(signer, payload, contributors) {
    return deltaVerifier.connect(signer).submitMintRequest(MODEL_ID, payload, contributors);
  }

  async function getContributorBalances(contributors) {
    return Promise.all(contributors.map(({ walletAddress }) => deployedToken.balanceOf(walletAddress)));
  }

  function calculateTotalReward(payload, tokensPerDeltaOne) {
    const deltaInBps = BigInt(Math.max(payload.candidateScoreBps - payload.baselineScoreBps, 0));
    return (deltaInBps * tokensPerDeltaOne) / 100n;
  }

  function calculateRewardSplit(totalReward, contributors) {
    const rewardAmounts = contributors.map(({ weight }) => (totalReward * BigInt(weight)) / 10000n);
    const distributed = rewardAmounts.reduce((sum, amount) => sum + amount, 0n);
    const dust = totalReward - distributed;

    if (rewardAmounts.length > 0) {
      rewardAmounts[0] += dust;
    }

    return { rewardAmounts, dust };
  }

  function buildContributors(overrides = null) {
    if (overrides) {
      return overrides;
    }

    return [
      { walletAddress: contributor1.address, weight: 6000 },
      { walletAddress: contributor2.address, weight: 3000 },
      { walletAddress: contributor3.address, weight: 1000 },
    ];
  }

  beforeEach(async function () {
    [owner, submitter, contributor1, contributor2, contributor3, outsider] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD
    );
    await deltaVerifier.waitForDeployment();

    await deployTestToken(
      tokenManager,
      MODEL_ID_STR,
      "Sales Outreach Token",
      "SOUT",
      parseEther("10000"),
      owner.address
    );

    await modelRegistry.registerModel(MODEL_ID, await tokenManager.getTokenAddress(MODEL_ID_STR), "sales:revenue_per_1000_messages");
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    const recorderRole = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(recorderRole, await deltaVerifier.getAddress());

    const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
    await deltaVerifier.grantRole(submitterRole, submitter.address);

    deployedToken = await getToken();
    hokusaiParams = await getParams();
  });

  it("mints for a single contributor and emits anchors", async function () {
    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const expectedReward = MAX_REWARD;

    await expect(deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors))
      .to.emit(deltaVerifier, "DeltaOneAccepted")
      .withArgs(
        MODEL_ID,
        payload.anchors.idempotencyKey,
        payload.anchors.benchmarkSpecHash,
        payload.anchors.attestationHash,
        payload.anchors.datasetHash,
        payload.anchors.metricName,
        payload.anchors.metricFamily,
        payload.baselineScoreBps,
        payload.candidateScoreBps,
        expectedReward,
        payload.pipelineRunId
      );

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(expectedReward);
  });

  it("splits rewards across contributors and assigns rounding dust to the first contributor", async function () {
    await hokusaiParams.setTokensPerDeltaOne(parseEther("101"));

    const payload = buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 5101,
      anchors: { idempotencyKey: ethers.id("idempotency-dust") },
    });
    const contributors = buildContributors();
    const deltaInBps = BigInt(payload.candidateScoreBps - payload.baselineScoreBps);
    const tokensPerDeltaOne = await hokusaiParams.tokensPerDeltaOne();
    const totalReward = (deltaInBps * tokensPerDeltaOne) / 100n;
    const reward1 = (totalReward * 6000n) / 10000n;
    const reward2 = (totalReward * 3000n) / 10000n;
    const reward3 = (totalReward * 1000n) / 10000n;
    const dust = totalReward - reward1 - reward2 - reward3;

    await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors);

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(reward1 + dust);
    expect(await deployedToken.balanceOf(contributor2.address)).to.equal(reward2);
    expect(await deployedToken.balanceOf(contributor3.address)).to.equal(reward3);
  });

  it("rejects weight-sum below 10000 (9999)", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-weight-under") },
    });

    await expect(
      submitMintRequestAs(submitter, payload, [{ walletAddress: contributor1.address, weight: 9999 }])
    ).to.be.revertedWith("Weights must sum to 100%");

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
  });

  it("rejects weight-sum above 10000 (10001)", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-weight-over") },
    });

    await expect(
      submitMintRequestAs(submitter, payload, [
        { walletAddress: contributor1.address, weight: 5001 },
        { walletAddress: contributor2.address, weight: 5000 },
      ])
    ).to.be.revertedWith("Weights must sum to 100%");

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
  });

  it("rejects three-way duplicate contributor address", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-duplicate-three-way") },
    });

    await expect(
      submitMintRequestAs(submitter, payload, [
        { walletAddress: contributor1.address, weight: 3333 },
        { walletAddress: contributor1.address, weight: 3333 },
        { walletAddress: contributor1.address, weight: 3334 },
      ])
    ).to.be.revertedWith("Duplicate contributor address");

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
  });

  it("accepts two distinct contributors as duplicate-check control", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-distinct-control") },
    });
    const contributors = [
      { walletAddress: contributor1.address, weight: 7000 },
      { walletAddress: contributor2.address, weight: 3000 },
    ];

    await submitMintRequestAs(submitter, payload, contributors);

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal((MAX_REWARD * 7000n) / 10000n);
    expect(await deployedToken.balanceOf(contributor2.address)).to.equal((MAX_REWARD * 3000n) / 10000n);
  });

  it("splits rewards across 4 contributors with dust to first", async function () {
    await hokusaiParams.setTokensPerDeltaOne(parseEther("100") + 1n);

    const payload = buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 5101,
      anchors: { idempotencyKey: ethers.id("idempotency-four-way-dust") },
    });
    const contributors = [
      { walletAddress: contributor1.address, weight: 2501 },
      { walletAddress: contributor2.address, weight: 2499 },
      { walletAddress: contributor3.address, weight: 2500 },
      { walletAddress: owner.address, weight: 2500 },
    ];
    const totalReward = calculateTotalReward(payload, await hokusaiParams.tokensPerDeltaOne());
    const { rewardAmounts, dust } = calculateRewardSplit(totalReward, contributors);

    await submitMintRequestAs(submitter, payload, contributors);

    const balances = await getContributorBalances(contributors);
    const totalDistributed = balances.reduce((sum, amount) => sum + amount, 0n);

    expect(balances[0]).to.equal(rewardAmounts[0]);
    expect(balances[1]).to.equal(rewardAmounts[1]);
    expect(balances[2]).to.equal(rewardAmounts[2]);
    expect(balances[3]).to.equal(rewardAmounts[3]);
    expect(dust).to.be.gt(0n);
    expect(totalDistributed).to.equal(totalReward);
  });

  it("splits rewards across 5 contributors evenly with zero dust", async function () {
    await hokusaiParams.setTokensPerDeltaOne(parseEther("100"));

    const payload = buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 5100,
      anchors: { idempotencyKey: ethers.id("idempotency-five-way-even") },
    });
    const contributors = [
      { walletAddress: contributor1.address, weight: 2000 },
      { walletAddress: contributor2.address, weight: 2000 },
      { walletAddress: contributor3.address, weight: 2000 },
      { walletAddress: owner.address, weight: 2000 },
      { walletAddress: submitter.address, weight: 2000 },
    ];
    const totalSupplyBefore = await deployedToken.totalSupply();
    const totalReward = calculateTotalReward(payload, await hokusaiParams.tokensPerDeltaOne());
    const expectedRewardPerContributor = totalReward / 5n;

    await submitMintRequestAs(submitter, payload, contributors);

    const balances = await getContributorBalances(contributors);
    const totalSupplyAfter = await deployedToken.totalSupply();

    for (const balance of balances) {
      expect(balance).to.equal(expectedRewardPerContributor);
    }
    expect(totalSupplyAfter - totalSupplyBefore).to.equal(totalReward);
  });

  it("rejects replayed idempotency keys", async function () {
    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors)
    ).to.be.revertedWith("Idempotency key already processed");
  });

  it("rejects an empty idempotency key", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.ZeroHash },
    });

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, [{ walletAddress: contributor1.address, weight: 10000 }])
    ).to.be.revertedWith("Idempotency key cannot be empty");
  });

  it("rejects inactive and unregistered models", async function () {
    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(999, payload, contributors)
    ).to.be.revertedWith("Model not registered");

    await modelRegistry.deactivateModel(MODEL_ID);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors)
    ).to.be.revertedWith("Model is deactivated");
  });

  it("consumes idempotency on budget violations and mints nothing", async function () {
    const payload = buildMintRequestPayload({
      maxCostUsdMicro: 100,
      actualCostUsdMicro: 125,
      anchors: { idempotencyKey: ethers.id("idempotency-budget") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    const tx = await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors);
    await expect(tx)
      .to.emit(deltaVerifier, "BudgetConstraintViolated")
      .withArgs(payload.pipelineRunId, MODEL_ID, 100, 125);

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors)
    ).to.be.revertedWith("Idempotency key already processed");
  });

  it("requires a new idempotency key after a budget-blocked submission", async function () {
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const blockedPayload = buildMintRequestPayload({
      maxCostUsdMicro: 100,
      actualCostUsdMicro: 125,
      anchors: { idempotencyKey: ethers.id("idempotency-budget-blocked-retry") },
    });
    const reusedKeyPayload = buildMintRequestPayload({
      maxCostUsdMicro: 200,
      actualCostUsdMicro: 125,
      anchors: { idempotencyKey: blockedPayload.anchors.idempotencyKey },
    });
    const freshKeyPayload = buildMintRequestPayload({
      maxCostUsdMicro: 200,
      actualCostUsdMicro: 125,
      anchors: { idempotencyKey: ethers.id("idempotency-budget-blocked-retry-fresh") },
    });

    await submitMintRequestAs(submitter, blockedPayload, contributors);

    expect(await deltaVerifier.processedIdempotencyKeys(blockedPayload.anchors.idempotencyKey)).to.equal(true);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);

    await expect(
      submitMintRequestAs(submitter, reusedKeyPayload, contributors)
    ).to.be.revertedWith("Idempotency key already processed");

    await submitMintRequestAs(submitter, freshKeyPayload, contributors);

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("reusing a successful key is rejected (control)", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-successful-reuse") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await submitMintRequestAs(submitter, payload, contributors);

    await expect(
      submitMintRequestAs(submitter, payload, contributors)
    ).to.be.revertedWith("Idempotency key already processed");
  });

  it("disables budget enforcement when maxCostUsdMicro == 0 with nonzero actualCost", async function () {
    const payload = buildMintRequestPayload({
      maxCostUsdMicro: 0,
      actualCostUsdMicro: 999999,
      anchors: { idempotencyKey: ethers.id("idempotency-max-cost-zero") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const tx = await submitMintRequestAs(submitter, payload, contributors);

    await expect(tx).to.not.emit(deltaVerifier, "BudgetConstraintViolated");

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("disables budget enforcement when actualCostUsdMicro == 0 with nonzero maxCost", async function () {
    const payload = buildMintRequestPayload({
      maxCostUsdMicro: 50,
      actualCostUsdMicro: 0,
      anchors: { idempotencyKey: ethers.id("idempotency-actual-cost-zero") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const tx = await submitMintRequestAs(submitter, payload, contributors);

    await expect(tx).to.not.emit(deltaVerifier, "BudgetConstraintViolated");

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("enforces budget when both costs are positive and actualCost > maxCost (control)", async function () {
    const payload = buildMintRequestPayload({
      maxCostUsdMicro: 50,
      actualCostUsdMicro: 100,
      anchors: { idempotencyKey: ethers.id("idempotency-budget-positive-control") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const tx = await submitMintRequestAs(submitter, payload, contributors);

    await expect(tx)
      .to.emit(deltaVerifier, "BudgetConstraintViolated")
      .withArgs(payload.pipelineRunId, MODEL_ID, 50, 100);

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);
  });

  it("emits zero-reward acceptance when candidate does not beat baseline", async function () {
    const payload = buildMintRequestPayload({
      candidateScoreBps: 5000,
      anchors: { idempotencyKey: ethers.id("idempotency-no-delta") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await expect(deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors))
      .to.emit(deltaVerifier, "DeltaOneAccepted")
      .withArgs(
        MODEL_ID,
        payload.anchors.idempotencyKey,
        payload.anchors.benchmarkSpecHash,
        payload.anchors.attestationHash,
        payload.anchors.datasetHash,
        payload.anchors.metricName,
        payload.anchors.metricFamily,
        payload.baselineScoreBps,
        payload.candidateScoreBps,
        0n,
        payload.pipelineRunId
      );

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);
  });

  it("zero-delta (candidate == baseline) emits acceptance but mints nothing", async function () {
    const payload = buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 5000,
      anchors: { idempotencyKey: ethers.id("idempotency-zero-delta-no-mint") },
    });
    const contributors = [
      { walletAddress: contributor1.address, weight: 7000 },
      { walletAddress: contributor2.address, weight: 3000 },
    ];
    const totalSupplyBefore = await deployedToken.totalSupply();
    const tx = await submitMintRequestAs(submitter, payload, contributors);

    await expect(tx)
      .to.emit(deltaVerifier, "DeltaOneAccepted")
      .withArgs(
        MODEL_ID,
        payload.anchors.idempotencyKey,
        payload.anchors.benchmarkSpecHash,
        payload.anchors.attestationHash,
        payload.anchors.datasetHash,
        payload.anchors.metricName,
        payload.anchors.metricFamily,
        payload.baselineScoreBps,
        payload.candidateScoreBps,
        0n,
        payload.pipelineRunId
      );
    await expect(tx).to.not.emit(deltaVerifier, "BatchRewardsDistributed");

    expect(await deployedToken.totalSupply()).to.equal(totalSupplyBefore);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);
    expect(await deployedToken.balanceOf(contributor2.address)).to.equal(0);
  });

  it("negative-delta (candidate < baseline) emits acceptance but mints nothing", async function () {
    const payload = buildMintRequestPayload({
      baselineScoreBps: 7500,
      candidateScoreBps: 5000,
      anchors: { idempotencyKey: ethers.id("idempotency-negative-delta-no-mint") },
    });
    const contributors = [
      { walletAddress: contributor1.address, weight: 7000 },
      { walletAddress: contributor2.address, weight: 3000 },
    ];
    const totalSupplyBefore = await deployedToken.totalSupply();
    const tx = await submitMintRequestAs(submitter, payload, contributors);

    await expect(tx)
      .to.emit(deltaVerifier, "DeltaOneAccepted")
      .withArgs(
        MODEL_ID,
        payload.anchors.idempotencyKey,
        payload.anchors.benchmarkSpecHash,
        payload.anchors.attestationHash,
        payload.anchors.datasetHash,
        payload.anchors.metricName,
        payload.anchors.metricFamily,
        payload.baselineScoreBps,
        payload.candidateScoreBps,
        0n,
        payload.pipelineRunId
      );
    await expect(tx).to.not.emit(deltaVerifier, "BatchRewardsDistributed");

    expect(await deployedToken.totalSupply()).to.equal(totalSupplyBefore);
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);
    expect(await deployedToken.balanceOf(contributor2.address)).to.equal(0);
  });

  it("rejects empty pipeline run IDs and metric names", async function () {
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(
        MODEL_ID,
        buildMintRequestPayload({ pipelineRunId: "" }),
        contributors
      )
    ).to.be.revertedWith("Pipeline run ID cannot be empty");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(
        MODEL_ID,
        buildMintRequestPayload({ anchors: { metricName: "" } }),
        contributors
      )
    ).to.be.revertedWith("Metric name cannot be empty");
  });

  it("rejects invalid weights, duplicate contributors, and oversized scores", async function () {
    const payload = buildMintRequestPayload();

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, [
        { walletAddress: contributor1.address, weight: 9000 },
      ])
    ).to.be.revertedWith("Weights must sum to 100%");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, [
        { walletAddress: contributor1.address, weight: 5000 },
        { walletAddress: contributor1.address, weight: 5000 },
      ])
    ).to.be.revertedWith("Duplicate contributor address");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(
        MODEL_ID,
        buildMintRequestPayload({ baselineScoreBps: 10001 }),
        [{ walletAddress: contributor1.address, weight: 10000 }]
      )
    ).to.be.revertedWith("Baseline score exceeds 10000 bps");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(
        MODEL_ID,
        buildMintRequestPayload({ candidateScoreBps: 10001 }),
        [{ walletAddress: contributor1.address, weight: 10000 }]
      )
    ).to.be.revertedWith("Candidate score exceeds 10000 bps");
  });

  it("rejects callers without SUBMITTER_ROLE", async function () {
    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const submitterRole = await deltaVerifier.SUBMITTER_ROLE();

    await expectMissingRole(submitMintRequestAs(outsider, payload, contributors), outsider, submitterRole);
  });

  it("grants submission after SUBMITTER_ROLE is granted", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-granted-submitter") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];
    const submitterRole = await deltaVerifier.SUBMITTER_ROLE();

    await deltaVerifier.grantRole(submitterRole, outsider.address);
    await submitMintRequestAs(outsider, payload, contributors);

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("rejects submission while paused", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-paused-submit") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await deltaVerifier.pause();

    await expect(
      submitMintRequestAs(submitter, payload, contributors)
    ).to.be.revertedWith("Pausable: paused");

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
  });

  it("pause -> unpause round-trip restores submission", async function () {
    const payload = buildMintRequestPayload({
      anchors: { idempotencyKey: ethers.id("idempotency-pause-unpause-round-trip") },
    });
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await deltaVerifier.pause();
    await deltaVerifier.unpause();
    await submitMintRequestAs(submitter, payload, contributors);

    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("rejects pause from non-pauser", async function () {
    const pauserRole = await deltaVerifier.PAUSER_ROLE();

    await expectMissingRole(deltaVerifier.connect(outsider).pause(), outsider, pauserRole);
  });

  it("rejects unpause from non-admin", async function () {
    const defaultAdminRole = await deltaVerifier.DEFAULT_ADMIN_ROLE();

    await deltaVerifier.pause();

    await expectMissingRole(deltaVerifier.connect(outsider).unpause(), outsider, defaultAdminRole);
  });

  it("records zero_inflated_continuous metrics without special-casing", async function () {
    const payload = buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 7500,
      anchors: {
        idempotencyKey: ethers.id("idempotency-zero-inflated"),
        metricName: "sales:revenue_per_1000_messages",
        metricFamily: "zero_inflated_continuous",
      },
    });

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, [{ walletAddress: contributor1.address, weight: 10000 }])
    )
      .to.emit(deltaVerifier, "DeltaOneAccepted")
      .withArgs(
        MODEL_ID,
        payload.anchors.idempotencyKey,
        payload.anchors.benchmarkSpecHash,
        payload.anchors.attestationHash,
        payload.anchors.datasetHash,
        "sales:revenue_per_1000_messages",
        "zero_inflated_continuous",
        5000,
        7500,
        MAX_REWARD,
        payload.pipelineRunId
      );
  });
});
