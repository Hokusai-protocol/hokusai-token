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

  it("rejects callers without SUBMITTER_ROLE and rejects paused submissions", async function () {
    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await expect(
      deltaVerifier.connect(outsider).submitMintRequest(MODEL_ID, payload, contributors)
    ).to.be.reverted;

    await deltaVerifier.pause();

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors)
    ).to.be.revertedWith("Pausable: paused");
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
