/*
 * HOK-2133: Model-weight lineage chain (per-model head + parent check).
 * Each paying mint attests a baselineCommitment equal to the model's canonical head and atomically advances
 * the head to its candidateCommitment — a hash-linked chain from the registry genesis to the current head, so
 * a forged mint cannot invent a baseline. Covers: genesis fail-closed, first-mint parents off genesis, chain
 * advance + parent->child events, parent-mismatch / re-base, advance-only-on-paying-mint, admin reset
 * (brick-prevention), the EIP-712 signature now binding the commitments, and registry genesis governance.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const {
  buildMintRequestPayload,
  payloadForNextLink,
  LINEAGE_GENESIS,
  attestMintRequest,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
} = require("./helpers/mintRequest");

const MODEL_ID = 1;
const MODEL_ID_STR = "1";
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");

describe("DeltaVerifier — model-weight lineage chain (HOK-2133)", function () {
  let owner, submitter, attester, contributor1, outsider;
  let modelRegistry, tokenManager, deltaVerifier, deployedToken;

  function single() {
    return [{ walletAddress: contributor1.address, weight: 10000 }];
  }
  async function submit(payload, contributors = single()) {
    const sigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);
    return deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, sigs);
  }

  beforeEach(async function () {
    [owner, submitter, attester, contributor1, outsider] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
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

    await deployTestToken(tokenManager, MODEL_ID_STR, "Sales Outreach Token", "SOUT", parseEther("10000"), owner.address);
    await modelRegistry.registerModel(MODEL_ID, await tokenManager.getTokenAddress(MODEL_ID_STR), "sales:revenue_per_1000_messages");
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    deployedToken = HokusaiToken.attach(await tokenManager.getTokenAddress(MODEL_ID_STR));

    // Attester + budget are required for any mint; genesis is the lineage-specific precondition.
    await configureLaunchAttester(deltaVerifier, owner, attester);
    await configureMintBudget(deltaVerifier, owner, MODEL_ID);
  });

  describe("genesis (registry-seeded, fail-closed)", function () {
    it("reverts every mint until a genesis is seeded (first-mint cannot define history)", async function () {
      const payload = buildMintRequestPayload();
      await expect(submit(payload))
        .to.be.revertedWithCustomError(deltaVerifier, "LineageNotSeeded")
        .withArgs(MODEL_ID);
      expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
    });

    it("currentModelHead returns the registry genesis before any mint", async function () {
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(LINEAGE_GENESIS);
      expect(await modelRegistry.weightGenesis(MODEL_ID)).to.equal(LINEAGE_GENESIS);
    });

    it("setWeightGenesis is owner-only, write-once, non-zero, registered-only", async function () {
      await expect(modelRegistry.connect(outsider).setWeightGenesis(MODEL_ID, LINEAGE_GENESIS)).to.be.reverted;
      await expect(modelRegistry.connect(owner).setWeightGenesis(MODEL_ID, ethers.ZeroHash)).to.be.revertedWith(
        "Genesis cannot be empty"
      );
      await expect(modelRegistry.connect(owner).setWeightGenesis(999, LINEAGE_GENESIS)).to.be.revertedWith(
        "Model not registered"
      );
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
      await expect(modelRegistry.connect(owner).setWeightGenesis(MODEL_ID, ethers.id("other"))).to.be.revertedWith(
        "Genesis already set"
      );
    });
  });

  describe("chain advance", function () {
    beforeEach(async function () {
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
    });

    it("first paying mint parents off genesis and advances the head to its candidate", async function () {
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID); // baseline = genesis
      expect(payload.baselineCommitment).to.equal(LINEAGE_GENESIS);

      await expect(submit(payload))
        .to.emit(deltaVerifier, "ModelLineageAdvanced")
        .withArgs(MODEL_ID, LINEAGE_GENESIS, payload.candidateCommitment);

      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(payload.candidateCommitment);
      expect(await deltaVerifier.modelWeightHead(MODEL_ID)).to.equal(payload.candidateCommitment);
    });

    it("builds a hash-linked chain across three mints (each parents off the prior candidate)", async function () {
      const p1 = await payloadForNextLink(deltaVerifier, MODEL_ID);
      await submit(p1);
      const p2 = await payloadForNextLink(deltaVerifier, MODEL_ID);
      expect(p2.baselineCommitment).to.equal(p1.candidateCommitment);
      await submit(p2);
      const p3 = await payloadForNextLink(deltaVerifier, MODEL_ID);
      expect(p3.baselineCommitment).to.equal(p2.candidateCommitment);

      await expect(submit(p3))
        .to.emit(deltaVerifier, "ModelLineageAdvanced")
        .withArgs(MODEL_ID, p2.candidateCommitment, p3.candidateCommitment);

      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(p3.candidateCommitment);
    });
  });

  describe("parent check / re-base", function () {
    beforeEach(async function () {
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
      await submit(await payloadForNextLink(deltaVerifier, MODEL_ID)); // head now != genesis
    });

    it("reverts a stale baseline (LineageParentMismatch) without burning the idempotency key", async function () {
      const head = await deltaVerifier.currentModelHead(MODEL_ID);
      // Build a payload that still parents off genesis (stale) by overriding baseline.
      const stale = await payloadForNextLink(deltaVerifier, MODEL_ID, { baselineCommitment: LINEAGE_GENESIS });

      await expect(submit(stale))
        .to.be.revertedWithCustomError(deltaVerifier, "LineageParentMismatch")
        .withArgs(MODEL_ID, head, LINEAGE_GENESIS);
      expect(await deltaVerifier.processedIdempotencyKeys(stale.anchors.idempotencyKey)).to.equal(false);
    });

    it("re-base succeeds: the same eval re-parented onto the new head mints", async function () {
      const rebased = await payloadForNextLink(deltaVerifier, MODEL_ID); // baseline = current head
      await expect(submit(rebased)).to.emit(deltaVerifier, "ModelLineageAdvanced");
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(rebased.candidateCommitment);
    });

    it("rejects a zero candidate commitment", async function () {
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID, { candidateCommitment: ethers.ZeroHash });
      await expect(submit(payload)).to.be.revertedWithCustomError(deltaVerifier, "InvalidCandidateCommitment");
    });

    it("the signature binds the commitments: tampering candidate after signing is rejected", async function () {
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID);
      const sigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, single());
      const tampered = { ...payload, candidateCommitment: ethers.id("attacker-candidate") };
      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, tampered, single(), sigs)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });
  });

  describe("advance only on paying mints", function () {
    beforeEach(async function () {
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
    });

    it("does NOT advance the head on a zero-reward (no-delta) acceptance", async function () {
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
        baselineScoreBps: 5000,
        candidateScoreBps: 5000, // no improvement → reward 0
      });
      const tx = await submit(payload);
      await expect(tx).to.emit(deltaVerifier, "DeltaOneAccepted");
      await expect(tx).to.not.emit(deltaVerifier, "ModelLineageAdvanced");
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(LINEAGE_GENESIS);
    });

    it("does NOT advance the head on a cost-violated submission", async function () {
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID, {
        maxCostUsdMicro: 100,
        actualCostUsdMicro: 250,
      });
      const tx = await submit(payload);
      await expect(tx).to.emit(deltaVerifier, "BudgetConstraintViolated");
      await expect(tx).to.not.emit(deltaVerifier, "ModelLineageAdvanced");
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(LINEAGE_GENESIS);
    });

    it("does NOT advance the head when the mint budget reverts (and does not burn the key)", async function () {
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, 1); // far below any reward
      const payload = await payloadForNextLink(deltaVerifier, MODEL_ID);
      await expect(submit(payload)).to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded");
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(LINEAGE_GENESIS);
      expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
    });
  });

  describe("admin reset (brick-prevention)", function () {
    beforeEach(async function () {
      await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
    });

    it("resets a stranded head so mints can resume; emits old->new; is admin-only and non-zero", async function () {
      // Simulate a bad commitment becoming the head.
      const bad = await payloadForNextLink(deltaVerifier, MODEL_ID);
      await submit(bad);
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(bad.candidateCommitment);

      const goodHead = ethers.id("corrected-head");
      await expect(deltaVerifier.connect(outsider).resetModelHead(MODEL_ID, goodHead)).to.be.reverted;
      await expect(deltaVerifier.connect(owner).resetModelHead(MODEL_ID, ethers.ZeroHash)).to.be.revertedWithCustomError(
        deltaVerifier,
        "InvalidHeadReset"
      );

      await expect(deltaVerifier.connect(owner).resetModelHead(MODEL_ID, goodHead))
        .to.emit(deltaVerifier, "ModelLineageHeadReset")
        .withArgs(MODEL_ID, bad.candidateCommitment, goodHead);
      expect(await deltaVerifier.currentModelHead(MODEL_ID)).to.equal(goodHead);

      // A mint re-based onto the corrected head succeeds.
      const resumed = await payloadForNextLink(deltaVerifier, MODEL_ID);
      expect(resumed.baselineCommitment).to.equal(goodHead);
      await expect(submit(resumed)).to.emit(deltaVerifier, "ModelLineageAdvanced");
    });
  });
});
