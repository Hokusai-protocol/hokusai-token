/*
 * HOK-2126: Safe-governed attester registry (set + threshold) on DeltaVerifier.
 * Provides the on-chain primitives the EIP-712 signature verification (HOK-2132) will read.
 * Runs 1-of-1 at launch; the set/threshold shape supports m-of-n later.
 */
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");

describe("DeltaVerifier — attester registry governance (HOK-2126)", function () {
  let owner, outsider, a1, a2, a3;
  let deltaVerifier;

  beforeEach(async function () {
    [owner, outsider, a1, a2, a3] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
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
      parseEther("1000000")
    );
    await deltaVerifier.waitForDeployment();
  });

  it("defaults: empty registry, zero threshold", async function () {
    expect(await deltaVerifier.attesterCount()).to.equal(0);
    expect(await deltaVerifier.attesterThreshold()).to.equal(0);
    expect(await deltaVerifier.isAttester(a1.address)).to.equal(false);
  });

  describe("addAttester", function () {
    it("only DEFAULT_ADMIN_ROLE can add", async function () {
      await expect(deltaVerifier.connect(outsider).addAttester(a1.address)).to.be.reverted;
      expect(await deltaVerifier.attesterCount()).to.equal(0);
    });

    it("adds, increments count, marks membership, emits", async function () {
      await expect(deltaVerifier.connect(owner).addAttester(a1.address))
        .to.emit(deltaVerifier, "AttesterAdded")
        .withArgs(a1.address, 1);
      expect(await deltaVerifier.isAttester(a1.address)).to.equal(true);
      expect(await deltaVerifier.attesterCount()).to.equal(1);
    });

    it("rejects the zero address", async function () {
      await expect(deltaVerifier.connect(owner).addAttester(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(deltaVerifier, "ZeroAttester");
    });

    it("rejects a duplicate", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address);
      await expect(deltaVerifier.connect(owner).addAttester(a1.address))
        .to.be.revertedWithCustomError(deltaVerifier, "AttesterAlreadyRegistered")
        .withArgs(a1.address);
    });
  });

  describe("setAttesterThreshold", function () {
    it("only DEFAULT_ADMIN_ROLE", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address);
      await expect(deltaVerifier.connect(outsider).setAttesterThreshold(1)).to.be.reverted;
    });

    it("rejects 0 and values above attesterCount", async function () {
      await expect(deltaVerifier.connect(owner).setAttesterThreshold(0))
        .to.be.revertedWithCustomError(deltaVerifier, "InvalidAttesterThreshold");
      // count is 0 → any positive threshold is invalid
      await expect(deltaVerifier.connect(owner).setAttesterThreshold(1))
        .to.be.revertedWithCustomError(deltaVerifier, "InvalidAttesterThreshold")
        .withArgs(1, 0);
    });

    it("sets a valid threshold and emits", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address);
      await expect(deltaVerifier.connect(owner).setAttesterThreshold(1))
        .to.emit(deltaVerifier, "AttesterThresholdUpdated")
        .withArgs(1);
      expect(await deltaVerifier.attesterThreshold()).to.equal(1);
    });
  });

  describe("removeAttester", function () {
    it("only DEFAULT_ADMIN_ROLE", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address);
      await expect(deltaVerifier.connect(outsider).removeAttester(a1.address)).to.be.reverted;
    });

    it("rejects removing an unregistered attester", async function () {
      await expect(deltaVerifier.connect(owner).removeAttester(a1.address))
        .to.be.revertedWithCustomError(deltaVerifier, "AttesterNotRegistered")
        .withArgs(a1.address);
    });

    it("reverts if removal would drop count below the threshold", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address);
      await deltaVerifier.connect(owner).setAttesterThreshold(1);
      // removing the sole attester would make count (0) < threshold (1)
      await expect(deltaVerifier.connect(owner).removeAttester(a1.address))
        .to.be.revertedWithCustomError(deltaVerifier, "AttesterThresholdWouldBeUnmet")
        .withArgs(0, 1);
    });

    it("removes, decrements count, clears membership, emits", async function () {
      await deltaVerifier.connect(owner).addAttester(a1.address); // threshold still 0
      await expect(deltaVerifier.connect(owner).removeAttester(a1.address))
        .to.emit(deltaVerifier, "AttesterRemoved")
        .withArgs(a1.address, 0);
      expect(await deltaVerifier.isAttester(a1.address)).to.equal(false);
      expect(await deltaVerifier.attesterCount()).to.equal(0);
    });
  });

  it("launch sequence (1-of-1): add then setThreshold(1)", async function () {
    await deltaVerifier.connect(owner).addAttester(a1.address);
    await deltaVerifier.connect(owner).setAttesterThreshold(1);
    expect(await deltaVerifier.attesterCount()).to.equal(1);
    expect(await deltaVerifier.attesterThreshold()).to.equal(1);
    expect(await deltaVerifier.isAttester(a1.address)).to.equal(true);
  });

  it("zero-downtime rotation: add-new-then-remove-old keeps the threshold met", async function () {
    await deltaVerifier.connect(owner).addAttester(a1.address);
    await deltaVerifier.connect(owner).setAttesterThreshold(1);
    // add replacement (count 2), then remove old (count 1 >= threshold 1) — OK
    await deltaVerifier.connect(owner).addAttester(a2.address);
    await deltaVerifier.connect(owner).removeAttester(a1.address);
    expect(await deltaVerifier.isAttester(a1.address)).to.equal(false);
    expect(await deltaVerifier.isAttester(a2.address)).to.equal(true);
    expect(await deltaVerifier.attesterCount()).to.equal(1);
    expect(await deltaVerifier.attesterThreshold()).to.equal(1);
  });

  it("m-of-n: threshold enforced as the set shrinks", async function () {
    for (const a of [a1, a2, a3]) await deltaVerifier.connect(owner).addAttester(a.address);
    await deltaVerifier.connect(owner).setAttesterThreshold(2);
    expect(await deltaVerifier.attesterThreshold()).to.equal(2);

    // 3 → 2 is OK (2 >= 2)
    await deltaVerifier.connect(owner).removeAttester(a3.address);
    expect(await deltaVerifier.attesterCount()).to.equal(2);
    // 2 → 1 would break the 2-of-n threshold
    await expect(deltaVerifier.connect(owner).removeAttester(a2.address))
      .to.be.revertedWithCustomError(deltaVerifier, "AttesterThresholdWouldBeUnmet")
      .withArgs(1, 2);
  });
});
