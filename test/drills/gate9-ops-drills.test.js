/*
 * HOK-2178 — Gate 9 operational-drill MECHANISM harness.
 *
 * The Gate 9 drills must be executed + timed live on Sepolia; that needs KMS/Safe keys and an
 * operator with a stopwatch (handed off — see scripts/drills/ + the launch-gate runbook). This
 * file is the repeatable contract-level backbone those live drills rely on: it proves, on every
 * CI run, that the kill-switch and the attester-rotation procedures actually behave as the
 * runbooks claim, so the live drill only has to measure wall-clock, not discover surprises.
 *
 * Covers:
 *   Drill 1 (pause kill-switch): pause() halts minting without burning idempotency; unpause()
 *           restores it; a replayed post-pause request settles exactly once.
 *   Drill 3 (attester rotation): zero-downtime add-new / remove-old rotation — new key mints,
 *           removed key reverts; plus the lost-device backup path (pre-registered backup signs
 *           with zero downtime).
 *   Kill-switch authority: who can pause vs unpause (the "designated path" the drill must name).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { deployTestToken } = require("../helpers/tokenDeployment");
const {
  payloadForNextLink,
  attestMintRequest,
  configureMintBudget,
  configureLineageGenesis,
} = require("../helpers/mintRequest");

const MODEL_ID = 1;
const MODEL_ID_STR = "1";
const MAX_REWARD = parseEther("1000000");

describe("HOK-2178 Gate 9 operational drills (mechanism harness)", function () {
  let owner, submitter, contributor, attesterA, attesterB, outsider;
  let deltaVerifier, modelRegistry, token;

  async function submitSignedBy(attester) {
    const payload = await payloadForNextLink(deltaVerifier, MODEL_ID);
    const contributors = [{ walletAddress: contributor.address, weight: 10000 }];
    const sigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);
    const tx = deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, sigs);
    return { tx, payload, contributors, sigs };
  }

  beforeEach(async function () {
    [owner, submitter, contributor, attesterA, attesterB, outsider] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
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
      100,
      MAX_REWARD,
    );
    await deltaVerifier.waitForDeployment();

    await deployTestToken(tokenManager, MODEL_ID_STR, "Drill Token", "DRILL", parseEther("10000"), owner.address);
    const tokenAddr = await tokenManager.getTokenAddress(MODEL_ID_STR);
    token = await ethers.getContractAt("HokusaiToken", tokenAddr);

    await modelRegistry.registerModel(MODEL_ID, tokenAddr, "accuracy");
    await tokenManager.grantRole(await tokenManager.MINTER_ROLE(), await deltaVerifier.getAddress());
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);
    await configureMintBudget(deltaVerifier, owner, MODEL_ID);
    await configureLineageGenesis(modelRegistry, owner, MODEL_ID);

    // Launch posture: single registered attester, threshold 1.
    await deltaVerifier.connect(owner).addAttester(attesterA.address);
    await deltaVerifier.connect(owner).setAttesterThreshold(1);
  });

  describe("Drill 1 — pause kill-switch", function () {
    it("pause() halts minting and does NOT burn the idempotency key", async function () {
      await deltaVerifier.connect(owner).pause();
      const { tx, payload } = await submitSignedBy(attesterA);
      await expect(tx).to.be.revertedWith("Pausable: paused");
      // The blocked request can be retried verbatim after unpause (key not consumed).
      expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
    });

    it("unpause() restores minting and a replayed request settles exactly once", async function () {
      await deltaVerifier.connect(owner).pause();
      await deltaVerifier.connect(owner).unpause();

      const { tx, payload, contributors, sigs } = await submitSignedBy(attesterA);
      await tx;
      expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);

      // Exactly-once: replaying the same request (e.g. a message queued during the pause) is rejected.
      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, sigs),
      ).to.be.revertedWith("Idempotency key already processed");
    });

    it("kill-switch authority: PAUSER_ROLE pauses, DEFAULT_ADMIN_ROLE unpauses, others cannot", async function () {
      await expect(deltaVerifier.connect(outsider).pause()).to.be.reverted;
      await deltaVerifier.connect(owner).pause();
      await expect(deltaVerifier.connect(outsider).unpause()).to.be.reverted;
      await deltaVerifier.connect(owner).unpause();
    });
  });

  describe("Drill 3 — attester rotation", function () {
    it("zero-downtime rotation: add new -> remove old; new key mints, removed key reverts", async function () {
      // Baseline: the launch attester (A) can mint.
      await (await submitSignedBy(attesterA)).tx;

      // Rotate A -> B with threshold held at 1 (add new, then remove old; never below threshold).
      await deltaVerifier.connect(owner).addAttester(attesterB.address);
      expect(await deltaVerifier.attesterCount()).to.equal(2n);
      await deltaVerifier.connect(owner).removeAttester(attesterA.address);
      expect(await deltaVerifier.attesterCount()).to.equal(1n);
      expect(await deltaVerifier.isAttester(attesterB.address)).to.equal(true);
      expect(await deltaVerifier.isAttester(attesterA.address)).to.equal(false);

      // New key mints; removed key is rejected.
      await (await submitSignedBy(attesterB)).tx;
      await expect((await submitSignedBy(attesterA)).tx).to.be.revertedWithCustomError(
        deltaVerifier,
        "SignerNotAttester",
      );
    });

    it("lost-device backup: a pre-registered backup attester signs with zero downtime", async function () {
      // Both primary (A) and backup (B) registered, threshold 1. If A's device is lost, B signs
      // immediately — no governance action, no downtime.
      await deltaVerifier.connect(owner).addAttester(attesterB.address);
      await (await submitSignedBy(attesterB)).tx;
      expect(await token.balanceOf(contributor.address)).to.be.gt(0n);
    });
  });
});
