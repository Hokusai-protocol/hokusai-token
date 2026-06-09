/*
 * HOK-2125: the legacy submitEvaluation* mint entrypoints can be permanently disabled
 * (one-way) so submitMintRequest becomes the only mint path on mainnet — closing the
 * SUBMITTER_ROLE bypass that would otherwise sidestep the upcoming attester verification.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { buildMintRequestPayload } = require("./helpers/mintRequest");

describe("DeltaVerifier — disable legacy mint entrypoints (HOK-2125)", function () {
  let owner, submitter, contributor1, outsider;
  let modelRegistry, tokenManager, contributionRegistry, deltaVerifier;

  const MODEL_ID = 1;
  const MODEL_ID_STR = "1";
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("1000000");

  const zeroMetrics = { accuracy: 0, precision: 0, recall: 0, f1: 0, auroc: 0 };
  const evalData = {
    pipelineRunId: "x",
    baselineMetrics: zeroMetrics,
    newMetrics: zeroMetrics,
    contributor: ethers.ZeroAddress,
    contributorWeight: 0,
    contributedSamples: 0,
    totalSamples: 0,
    maxCostUsd: 0,
    actualCostUsd: 0,
  };
  const evalDataWithInfo = {
    pipelineRunId: "x",
    baselineMetrics: zeroMetrics,
    newMetrics: zeroMetrics,
    contributorInfo: {
      walletAddress: ethers.ZeroAddress,
      contributorWeight: 0,
      contributedSamples: 0,
      totalSamples: 0,
    },
    maxCostUsd: 0,
    actualCostUsd: 0,
  };
  const evalDataBase = {
    pipelineRunId: "x",
    baselineMetrics: zeroMetrics,
    newMetrics: zeroMetrics,
    maxCostUsd: 0,
    actualCostUsd: 0,
    totalSamples: 0,
  };

  beforeEach(async function () {
    [owner, submitter, contributor1, outsider] = await ethers.getSigners();

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

    await modelRegistry.registerModel(
      MODEL_ID,
      await tokenManager.getTokenAddress(MODEL_ID_STR),
      "sales:revenue_per_1000_messages"
    );
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(
      await contributionRegistry.RECORDER_ROLE(),
      await deltaVerifier.getAddress()
    );
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);
  });

  it("legacyMintsDisabled defaults to false (legacy paths active for existing tests/testnet)", async function () {
    expect(await deltaVerifier.legacyMintsDisabled()).to.equal(false);
  });

  it("only DEFAULT_ADMIN_ROLE can disable legacy mints", async function () {
    await expect(deltaVerifier.connect(outsider).disableLegacyMints()).to.be.reverted;
    await expect(deltaVerifier.connect(submitter).disableLegacyMints()).to.be.reverted;
    expect(await deltaVerifier.legacyMintsDisabled()).to.equal(false);
  });

  it("disableLegacyMints sets the flag and emits LegacyMintsDisabled", async function () {
    await expect(deltaVerifier.connect(owner).disableLegacyMints())
      .to.emit(deltaVerifier, "LegacyMintsDisabled")
      .withArgs(owner.address);
    expect(await deltaVerifier.legacyMintsDisabled()).to.equal(true);
  });

  it("all three legacy entrypoints revert with LegacyMintEntrypointDisabled after disable", async function () {
    await deltaVerifier.connect(owner).disableLegacyMints();

    await expect(deltaVerifier.connect(submitter).submitEvaluation(MODEL_ID, evalData))
      .to.be.revertedWithCustomError(deltaVerifier, "LegacyMintEntrypointDisabled");
    await expect(
      deltaVerifier.connect(submitter).submitEvaluationWithContributorInfo(MODEL_ID, evalDataWithInfo)
    ).to.be.revertedWithCustomError(deltaVerifier, "LegacyMintEntrypointDisabled");
    await expect(
      deltaVerifier.connect(submitter).submitEvaluationWithMultipleContributors(MODEL_ID, evalDataBase, [])
    ).to.be.revertedWithCustomError(deltaVerifier, "LegacyMintEntrypointDisabled");
  });

  it("submitMintRequest (canonical path) still mints after legacy is disabled", async function () {
    await deltaVerifier.connect(owner).disableLegacyMints();

    const payload = buildMintRequestPayload();
    const contributors = [{ walletAddress: contributor1.address, weight: 10000 }];

    await expect(deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors))
      .to.emit(deltaVerifier, "DeltaOneAccepted");
  });

  it("disable is one-way: idempotent and no re-enable function exists", async function () {
    await deltaVerifier.connect(owner).disableLegacyMints();
    await deltaVerifier.connect(owner).disableLegacyMints(); // idempotent, no revert
    expect(await deltaVerifier.legacyMintsDisabled()).to.equal(true);
    // there is no enableLegacyMints / setLegacyMintsDisabled escape hatch
    expect(deltaVerifier.enableLegacyMints).to.equal(undefined);
    expect(deltaVerifier.setLegacyMintsDisabled).to.equal(undefined);
  });
});
