/*
 * HOK-2131: Per-model mint budget + Safe top-up (revert-not-truncate).
 * A deterministic per-model loss ceiling on top of the attester check (HOK-2132). A paying mint must fit
 * mintBudgetRemaining[modelId]; if it would exceed, the call REVERTS (never truncates) without burning the
 * idempotency key, so the exact attested request retries verbatim after a Safe top-up and pays in full.
 * budget == 0 blocks paying mints (fail-closed per model). Set/refilled only by the admin Safe.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const {
  buildMintRequestPayload,
  attestMintRequest,
  configureLaunchAttester,
} = require("./helpers/mintRequest");

const MODEL_ID = 1;
const MODEL_ID_STR = "1";
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");

describe("DeltaVerifier — per-model mint budget (HOK-2131)", function () {
  let owner, submitter, attester, contributor1, outsider;
  let modelRegistry, tokenManager, deltaVerifier, deployedToken, hokusaiParams;

  // With tokensPerDeltaOne = 100 tokens and a 100-bps delta, each mint pays exactly 100 tokens.
  const REWARD = parseEther("100");

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
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    hokusaiParams = HokusaiParams.attach(await tokenManager.modelParams(MODEL_ID_STR));
    await hokusaiParams.setTokensPerDeltaOne(parseEther("100"));

    await configureLaunchAttester(deltaVerifier, owner, attester);
  });

  // 100-bps improvement → REWARD tokens for a single contributor.
  function payload(idempotencySuffix = "default") {
    return buildMintRequestPayload({
      baselineScoreBps: 5000,
      candidateScoreBps: 5100,
      anchors: { idempotencyKey: ethers.id(`budget-${idempotencySuffix}`) },
    });
  }
  function contributors() {
    return [{ walletAddress: contributor1.address, weight: 10000 }];
  }
  async function submit(p, c) {
    const sigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, p, c);
    return deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, p, c, sigs);
  }

  it("defaults to a zero budget per model", async function () {
    expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);
    expect(await deltaVerifier.mintBudgetRemaining(999)).to.equal(0);
  });

  describe("fail-closed", function () {
    it("blocks a positive-reward mint when budget is 0 (no key burn)", async function () {
      const p = payload("zero-budget");
      await expect(submit(p, contributors()))
        .to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded")
        .withArgs(MODEL_ID, REWARD, 0);
      expect(await deltaVerifier.processedIdempotencyKeys(p.anchors.idempotencyKey)).to.equal(false);
    });

    it("allows a zero-reward acceptance even with a 0 budget (no payout, no consume)", async function () {
      // candidate == baseline → reward 0; the budget gate must not block a non-paying acceptance.
      const p = buildMintRequestPayload({
        baselineScoreBps: 5000,
        candidateScoreBps: 5000,
        anchors: { idempotencyKey: ethers.id("budget-zero-reward") },
      });
      const tx = await submit(p, contributors());
      await expect(tx).to.emit(deltaVerifier, "DeltaOneAccepted");
      await expect(tx).to.not.emit(deltaVerifier, "MintBudgetConsumed");
      expect(await deltaVerifier.processedIdempotencyKeys(p.anchors.idempotencyKey)).to.equal(true);
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);
    });
  });

  describe("accounting", function () {
    it("decrements the remaining budget by the minted amount and emits MintBudgetConsumed", async function () {
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, parseEther("1000"));
      const p = payload("decrement");

      await expect(submit(p, contributors()))
        .to.emit(deltaVerifier, "MintBudgetConsumed")
        .withArgs(MODEL_ID, REWARD, parseEther("900"));

      expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(parseEther("900"));
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(REWARD);
    });

    it("permits a mint that exactly equals the remaining budget (boundary), leaving 0", async function () {
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, REWARD);
      await submit(payload("exact"), contributors());
      expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(REWARD);
    });

    it("is per-model: funding one model does not fund another", async function () {
      await deltaVerifier.connect(owner).setMintBudget(2, parseEther("5"));
      expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);
      expect(await deltaVerifier.mintBudgetRemaining(2)).to.equal(parseEther("5"));
    });
  });

  describe("revert-not-truncate then top-up", function () {
    it("reverts when the mint exceeds budget, then the SAME request pays in full after a Safe top-up", async function () {
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, parseEther("50")); // < REWARD (100)
      const p = payload("retry");
      const c = contributors();

      // Exceeds budget → revert, no truncation, no key burn.
      await expect(submit(p, c))
        .to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded")
        .withArgs(MODEL_ID, REWARD, parseEther("50"));
      expect(await deltaVerifier.processedIdempotencyKeys(p.anchors.idempotencyKey)).to.equal(false);
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(0);

      // Safe tops up; the identical attested request now succeeds and pays the FULL amount (never haircut).
      await expect(deltaVerifier.connect(owner).topUpMintBudget(MODEL_ID, parseEther("50")))
        .to.emit(deltaVerifier, "MintBudgetToppedUp")
        .withArgs(MODEL_ID, parseEther("50"), parseEther("100"));

      await submit(p, c);
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(REWARD);
      expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);
    });
  });

  describe("maxReward interplay", function () {
    it("gates the maxReward-capped amount: reward caps at maxReward, then the budget must still cover it", async function () {
      // Uncapped reward would be 2M; capped to maxReward (1M).
      await hokusaiParams.setTokensPerDeltaOne(parseEther("2000000"));
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, parseEther("500000")); // < maxReward
      const p = payload("cap");
      const c = contributors();

      await expect(submit(p, c))
        .to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded")
        .withArgs(MODEL_ID, MAX_REWARD, parseEther("500000"));

      // Top up to exactly maxReward; mints the capped amount and drains the budget.
      await deltaVerifier.connect(owner).topUpMintBudget(MODEL_ID, parseEther("500000"));
      await submit(p, c);
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
      expect(await deltaVerifier.mintBudgetRemaining(MODEL_ID)).to.equal(0);
    });
  });

  describe("administration (admin Safe only)", function () {
    it("setMintBudget is DEFAULT_ADMIN_ROLE only and emits with previous + new", async function () {
      await expect(deltaVerifier.connect(outsider).setMintBudget(MODEL_ID, parseEther("1"))).to.be.reverted;
      await expect(deltaVerifier.connect(owner).setMintBudget(MODEL_ID, parseEther("1000")))
        .to.emit(deltaVerifier, "MintBudgetSet")
        .withArgs(MODEL_ID, 0, parseEther("1000"));
    });

    it("topUpMintBudget is DEFAULT_ADMIN_ROLE only and rejects zero", async function () {
      await expect(deltaVerifier.connect(outsider).topUpMintBudget(MODEL_ID, parseEther("1"))).to.be.reverted;
      await expect(deltaVerifier.connect(owner).topUpMintBudget(MODEL_ID, 0)).to.be.reverted;
      await expect(deltaVerifier.connect(owner).topUpMintBudget(MODEL_ID, parseEther("10")))
        .to.emit(deltaVerifier, "MintBudgetToppedUp")
        .withArgs(MODEL_ID, parseEther("10"), parseEther("10"));
    });

    it("setMintBudget can halt a model by setting the budget back to 0", async function () {
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, parseEther("1000"));
      await submit(payload("halt-1"), contributors());
      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(REWARD);

      // Halt: set remaining to 0; the next paying mint is blocked again.
      await deltaVerifier.connect(owner).setMintBudget(MODEL_ID, 0);
      await expect(submit(payload("halt-2"), contributors()))
        .to.be.revertedWithCustomError(deltaVerifier, "MintBudgetExceeded")
        .withArgs(MODEL_ID, REWARD, 0);
    });
  });
});
