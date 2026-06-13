/*
 * HOK-2170: attester-signature expiry (deadline). The signed MintRequest carries a `deadline` (unix ts)
 * bound into the EIP-712 digest; submitMintRequest reverts SignatureExpired past it. This bounds the shelf
 * life of a genuine-but-unsubmitted authorization (held in the queue / a compromised relayer). The window
 * is a signer-set value (launch policy: 5 days); the contract only enforces non-expiry. Because `deadline`
 * is NOT part of the idempotency key, an expired-but-unsubmitted request can be re-signed with a fresh
 * deadline over identical content and still mint (key never burned on the expired attempt).
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const {
  buildMintRequestPayload,
  payloadForNextLink,
  attestMintRequest,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
} = require("./helpers/mintRequest");

const MODEL_ID = 1;
const MODEL_ID_STR = "1";
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");
const FIVE_DAYS = 5 * 24 * 60 * 60;

describe("DeltaVerifier — attester signature deadline (HOK-2170)", function () {
  let owner, submitter, attester, contributor1;
  let modelRegistry, tokenManager, deltaVerifier, deployedToken;

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
    return { registry, manager, verifier, token };
  }

  beforeEach(async function () {
    [owner, submitter, attester, contributor1] = await ethers.getSigners();
    const stack = await deployStack();
    modelRegistry = stack.registry;
    tokenManager = stack.manager;
    deltaVerifier = stack.verifier;
    deployedToken = stack.token;
    await configureMintBudget(deltaVerifier, owner, MODEL_ID);
    await configureLineageGenesis(modelRegistry, owner, MODEL_ID);
    await configureLaunchAttester(deltaVerifier, owner, attester);
  });

  function singleContributor() {
    return [{ walletAddress: contributor1.address, weight: 10000 }];
  }

  it("mints when the deadline is in the future (now + 5 days)", async function () {
    const deadline = (await time.latest()) + FIVE_DAYS;
    const payload = buildMintRequestPayload({ deadline });
    const contributors = singleContributor();
    const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
    ).to.emit(deltaVerifier, "DeltaOneAccepted");
    expect(await deployedToken.balanceOf(contributor1.address)).to.equal(MAX_REWARD);
  });

  it("reverts SignatureExpired once the deadline has passed (no key burn)", async function () {
    const deadline = (await time.latest()) + FIVE_DAYS;
    const payload = buildMintRequestPayload({ deadline });
    const contributors = singleContributor();
    const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

    // advance past the deadline
    await time.increaseTo(deadline + 1);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors, signatures)
    ).to.be.revertedWithCustomError(deltaVerifier, "SignatureExpired");

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(false);
  });

  it("accepts exactly at the deadline boundary (block.timestamp == deadline) and rejects one second past", async function () {
    const contributors = singleContributor();

    // deadline-1: reverts. Set deadline to current time so the next block (timestamp+1) is already past.
    const past = await time.latest();
    const expiredPayload = buildMintRequestPayload({ deadline: past });
    const expiredSigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, expiredPayload, contributors);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, expiredPayload, contributors, expiredSigs)
    ).to.be.revertedWithCustomError(deltaVerifier, "SignatureExpired");

    // boundary: set the next block's timestamp exactly equal to the deadline → block.timestamp == deadline passes.
    const boundary = (await time.latest()) + 100;
    const okPayload = await payloadForNextLink(deltaVerifier, MODEL_ID, { deadline: boundary });
    const okSigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, okPayload, contributors);
    await time.setNextBlockTimestamp(boundary);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, okPayload, contributors, okSigs)
    ).to.emit(deltaVerifier, "DeltaOneAccepted");
  });

  it("binds the deadline into the signature: tampering it after signing is rejected", async function () {
    const deadline = (await time.latest()) + FIVE_DAYS;
    const payload = buildMintRequestPayload({ deadline });
    const contributors = singleContributor();
    const signatures = await attestMintRequest(deltaVerifier, attester, MODEL_ID, payload, contributors);

    const tampered = { ...payload, deadline: deadline + FIVE_DAYS };
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, tampered, contributors, signatures)
    ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
  });

  it("an expired-but-unsubmitted request can be re-signed with a fresh deadline (same idempotency key) and mints", async function () {
    const contributors = singleContributor();
    const t0 = await time.latest();
    const base = await payloadForNextLink(deltaVerifier, MODEL_ID, { deadline: t0 + FIVE_DAYS });

    // First attempt expires before submission.
    const expiredSigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, base, contributors);
    await time.increaseTo(t0 + FIVE_DAYS + 1);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, base, contributors, expiredSigs)
    ).to.be.revertedWithCustomError(deltaVerifier, "SignatureExpired");
    expect(await deltaVerifier.processedIdempotencyKeys(base.anchors.idempotencyKey)).to.equal(false);

    // Re-sign identical content (same idempotencyKey + commitments) with a fresh deadline → mints.
    const renewed = { ...base, deadline: (await time.latest()) + FIVE_DAYS };
    const renewedSigs = await attestMintRequest(deltaVerifier, attester, MODEL_ID, renewed, contributors);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, renewed, contributors, renewedSigs)
    ).to.emit(deltaVerifier, "DeltaOneAccepted");
    expect(await deltaVerifier.processedIdempotencyKeys(base.anchors.idempotencyKey)).to.equal(true);
  });
});
