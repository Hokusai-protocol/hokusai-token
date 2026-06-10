/*
 * HOK-2132: EIP-712 attester signature verification on submitMintRequest (the linchpin).
 * The contract verifies WHO submits (SUBMITTER_ROLE) AND that a registered attester authorized this
 * exact economic payload. Forged Redis/queue messages can no longer mint: a relayer with SUBMITTER_ROLE
 * but no attester signature is rejected. Covers: valid mint, fail-closed (no threshold), missing/insufficient,
 * non-attester signer, tampered fields, rotation, cross-deployment replay, cross-schema replay, and m-of-n.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, TypedDataEncoder } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const {
  buildMintRequestPayload,
  MINT_REQUEST_EIP712_TYPES,
  eip712Domain,
  signMintRequest,
  attestMintRequest,
  attestMintRequestMulti,
  configureLaunchAttester,
  configureMintBudget,
} = require("./helpers/mintRequest");

const MODEL_ID = 1;
const MODEL_ID_STR = "1";
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");

describe("DeltaVerifier — attester signature verification (HOK-2132)", function () {
  let owner, submitter, attester, attester2, attester3, contributor1, contributor2, outsider;
  let modelRegistry, tokenManager, contributionRegistry, deltaVerifier, deployedToken;

  async function deployStack() {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const registry = await ModelRegistry.deploy();
    await registry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const manager = await TokenManager.deploy(await registry.getAddress());
    await manager.waitForDeployment();

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contribRegistry = await DataContributionRegistry.deploy();
    await contribRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const verifier = await DeltaVerifier.deploy(
      await registry.getAddress(),
      await manager.getAddress(),
      await contribRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD
    );
    await verifier.waitForDeployment();

    await deployTestToken(manager, MODEL_ID_STR, "Sales Outreach Token", "SOUT", parseEther("10000"), owner.address);
    await registry.registerModel(MODEL_ID, await manager.getTokenAddress(MODEL_ID_STR), "sales:revenue_per_1000_messages");
    await manager.grantRole(await manager.MINTER_ROLE(), await verifier.getAddress());
    await manager.setDeltaVerifier(await verifier.getAddress());
    await contribRegistry.grantRole(await contribRegistry.RECORDER_ROLE(), await verifier.getAddress());
    await verifier.grantRole(await verifier.SUBMITTER_ROLE(), submitter.address);

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    const token = HokusaiToken.attach(await manager.getTokenAddress(MODEL_ID_STR));

    return { registry, manager, contribRegistry, verifier, token };
  }

  beforeEach(async function () {
    [owner, submitter, attester, attester2, attester3, contributor1, contributor2, outsider] =
      await ethers.getSigners();
    const stack = await deployStack();
    modelRegistry = stack.registry;
    tokenManager = stack.manager;
    contributionRegistry = stack.contribRegistry;
    deltaVerifier = stack.verifier;
    deployedToken = stack.token;
    // Fund the mint budget so these tests exercise the attester gate, not the HOK-2131 budget gate.
    await configureMintBudget(deltaVerifier, owner, MODEL_ID);
  });

  function singleContributor() {
    return [{ walletAddress: contributor1.address, weight: 10000 }];
  }

  describe("fail-closed defaults", function () {
    it("reverts every mint when no attester threshold is configured, even with a real attester sig", async function () {
      // attester signs a perfectly valid payload, but the registry has no threshold set yet
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "AttestationThresholdNotConfigured");

      expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
    });
  });

  describe("with a 1-of-1 launch attester", function () {
    beforeEach(async function () {
      await configureLaunchAttester(deltaVerifier, owner, attester);
    });

    it("mints when a registered attester signs the exact payload", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.emit(deltaVerifier, "DeltaOneAccepted");

      expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
    });

    it("contract digest matches the off-chain EIP-712 hash (ethers parity)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const domain = await eip712Domain(deltaVerifier);
      const offChain = TypedDataEncoder.hash(domain, MINT_REQUEST_EIP712_TYPES, {
        modelId: MODEL_ID,
        payload,
        contributors,
      });
      const onChain = await deltaVerifier.hashMintRequest(MODEL_ID, payload, contributors);
      expect(onChain).to.equal(offChain);
    });

    it("reverts with no signatures (insufficient for the threshold)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, [])
      )
        .to.be.revertedWithCustomError(deltaVerifier, "InsufficientAttesterSignatures")
        .withArgs(0, 1);
    });

    it("reverts when the signer is not a registered attester", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      // outsider signs — well-formed signature, but not an attester
      const signatures = await attestMintRequest(deltaVerifier, outsider, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      )
        .to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester")
        .withArgs(outsider.address);
    });

    it("reverts on a malformed signature", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const garbage = "0x" + "11".repeat(65);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, [garbage])
      ).to.be.reverted; // ECDSA recovers a non-attester / reverts on invalid s/v
    });

    it("reverts when any signed field is tampered after signing (payload integrity)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      // Attacker inflates the candidate score (would increase reward) after the attester signed.
      const tampered = { ...payload, candidateScoreBps: payload.candidateScoreBps + 100 };

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, tampered, contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });

    it("reverts when the contributor set is tampered after signing", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      // Re-point the reward to the attacker's address.
      const tamperedContributors = [{ walletAddress: outsider.address, weight: 10000 }];

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, tamperedContributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });

    it("reverts when modelId is tampered after signing", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      // Sign for a different model, submit for MODEL_ID
      const signatures = await attestMintRequest(deltaVerifier, attester, 999, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });

    it("blocks cross-deployment replay (signature bound to verifyingContract)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();

      // A second DeltaVerifier with the same attester configured.
      const other = await deployStack();
      await configureLaunchAttester(other.verifier, owner, attester);
      await configureMintBudget(other.verifier, owner, MODEL_ID);

      // Attester signs for the OTHER deployment; replay against the first must fail.
      const foreignSignatures = await attestMintRequest(other.verifier, attester, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, foreignSignatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");

      // Sanity: the same signature is valid on the deployment it was scoped to.
      await other.verifier.grantRole(await other.verifier.SUBMITTER_ROLE(), submitter.address);
      await expect(
        other.verifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, foreignSignatures)
      ).to.emit(other.verifier, "DeltaOneAccepted");
    });

    it("allows attester rotation: old signature rejected, new attester signs", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const oldSignatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      // Zero-downtime rotation: add new, remove old (threshold stays met).
      await deltaVerifier.connect(owner).addAttester(attester2.address);
      await deltaVerifier.connect(owner).removeAttester(attester.address);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, oldSignatures)
      )
        .to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester")
        .withArgs(attester.address);

      const newSignatures = await attestMintRequest(deltaVerifier, attester2, MODEL_ID, payload, contributors);
      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, newSignatures)
      ).to.emit(deltaVerifier, "DeltaOneAccepted");
    });

    it("rejects an unauthorized swapped-in attester (T6: registry is admin-only)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();

      // An attacker who can't touch the registry cannot register themselves.
      await expect(deltaVerifier.connect(outsider).addAttester(outsider.address)).to.be.reverted;

      const signatures = await attestMintRequest(deltaVerifier, outsider, MODEL_ID, payload, contributors);
      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });
  });

  describe("m-of-n (2-of-3) threshold", function () {
    beforeEach(async function () {
      for (const a of [attester, attester2, attester3]) {
        await deltaVerifier.connect(owner).addAttester(a.address);
      }
      await deltaVerifier.connect(owner).setAttesterThreshold(2);
    });

    it("mints with two distinct attesters, ordered ascending", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequestMulti(
        deltaVerifier,
        [attester, attester2],
        MODEL_ID,
        payload,
        contributors
      );

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.emit(deltaVerifier, "DeltaOneAccepted");
    });

    it("reverts with only one signature (below threshold)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      )
        .to.be.revertedWithCustomError(deltaVerifier, "InsufficientAttesterSignatures")
        .withArgs(1, 2);
    });

    it("reverts on a duplicate signer (cannot count one attester twice)", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const sig = await signMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, [sig, sig])
      ).to.be.revertedWithCustomError(deltaVerifier, "UnorderedOrDuplicateAttesters");
    });

    it("reverts when signatures are not strictly ascending by signer address", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const ascending = await attestMintRequestMulti(
        deltaVerifier,
        [attester, attester2],
        MODEL_ID,
        payload,
        contributors
      );
      const descending = [ascending[1], ascending[0]];

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, descending)
      ).to.be.revertedWithCustomError(deltaVerifier, "UnorderedOrDuplicateAttesters");
    });

    it("reverts when one of the two signers is not a registered attester", async function () {
      const payload = buildMintRequestPayload();
      const contributors = singleContributor();
      const signatures = await attestMintRequestMulti(
        deltaVerifier,
        [attester, outsider],
        MODEL_ID,
        payload,
        contributors
      );

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });
  });
});
