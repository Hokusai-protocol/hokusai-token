const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * ModelRegistry exposes several alias view functions that read the same underlying
 * storage:
 *   - "registered" family: isRegistered(uint256), exists(uint256), and the
 *     auto-generated isModelRegistered(uint256) mapping getter — all return
 *     isModelRegistered[id].
 *   - "active" family: isActive(uint256) and isModelActive(uint256) — both return
 *     isModelRegistered[id] && models[id].active.
 *
 * These aliases are byte-for-byte equivalent today, so callers treat them as
 * interchangeable. This suite pins that equivalence across every model state so a
 * future edit to one alias that forgets its twin fails CI instead of silently
 * diverging on-chain. It also asserts the ONE distinction that is intentional and
 * must NOT collapse: "registered" (exists) vs "active" (exists AND the active flag).
 *
 * See HOK cleanup ticket: dedupe ModelRegistry view aliases + pin canonical API.
 */
describe("ModelRegistry - view alias invariants", function () {
  let modelRegistry;
  let params;
  let owner;
  let token0, token1;
  let token0Addr, token1Addr;

  beforeEach(async function () {
    [owner] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    params = await HokusaiParams.deploy(
      1000, // tokensPerDeltaOne
      8000, // infrastructureAccrualBps
      0, // initialOraclePricePerThousandUsd
      ethers.keccak256(ethers.toUtf8Bytes("test-license")),
      "https://test.license",
      owner.address,
      { enabled: false, immediateUnlockBps: 10000, vestingDurationSeconds: 0, cliffSeconds: 0 }
    );
    await params.waitForDeployment();

    const MockToken = await ethers.getContractFactory("HokusaiToken");
    const registryAddr = await modelRegistry.getAddress();
    const paramsAddr = await params.getAddress();

    token0 = await MockToken.deploy("Token0", "TK0", registryAddr, paramsAddr, 1, 0, 0, 0, ethers.ZeroAddress);
    await token0.waitForDeployment();
    token0Addr = await token0.getAddress();

    token1 = await MockToken.deploy("Token1", "TK1", registryAddr, paramsAddr, 1, 0, 0, 0, ethers.ZeroAddress);
    await token1.waitForDeployment();
    token1Addr = await token1.getAddress();
  });

  // Reads every alias for a model id and returns the two logical groupings.
  async function readAliases(id) {
    const [isRegistered, exists, isModelRegistered, isActive, isModelActive] = await Promise.all([
      modelRegistry.isRegistered(id),
      modelRegistry.exists(id),
      modelRegistry.isModelRegistered(id),
      modelRegistry.isActive(id),
      modelRegistry["isModelActive(uint256)"](id),
    ]);
    return { isRegistered, exists, isModelRegistered, isActive, isModelActive };
  }

  // Asserts every alias inside a family agrees, and returns the family's value.
  function assertFamiliesConsistent(a) {
    // "registered" family must all agree.
    expect(a.exists).to.equal(a.isRegistered);
    expect(a.isModelRegistered).to.equal(a.isRegistered);
    // "active" family must all agree.
    expect(a.isModelActive).to.equal(a.isActive);
    return { registered: a.isRegistered, active: a.isActive };
  }

  it("holds all aliases equivalent across every model state (id 0 and nonzero)", async function () {
    for (const id of [0, 7]) {
      const tokenAddr = id === 0 ? token0Addr : token1Addr;

      // Unregistered: everything false.
      let { registered, active } = assertFamiliesConsistent(await readAliases(id));
      expect(registered).to.be.false;
      expect(active).to.be.false;

      // Registered => registered && active both true.
      await modelRegistry.registerModel(id, tokenAddr, "accuracy");
      ({ registered, active } = assertFamiliesConsistent(await readAliases(id)));
      expect(registered).to.be.true;
      expect(active).to.be.true;

      // Deactivated => THE intentional distinction: still registered, no longer active.
      await modelRegistry.deactivateModel(id);
      ({ registered, active } = assertFamiliesConsistent(await readAliases(id)));
      expect(registered).to.be.true;
      expect(active).to.be.false;

      // Reactivated => both true again.
      await modelRegistry.reactivateModel(id);
      ({ registered, active } = assertFamiliesConsistent(await readAliases(id)));
      expect(registered).to.be.true;
      expect(active).to.be.true;
    }
  });

  it("keeps registered and active distinct (they must never collapse into one flag)", async function () {
    await modelRegistry.registerModel(3, token0Addr, "accuracy");
    await modelRegistry.deactivateModel(3);

    // If a refactor ever makes isRegistered delegate to the active check (or vice
    // versa), this fails: a deactivated model is registered but not active.
    expect(await modelRegistry.isRegistered(3)).to.be.true;
    expect(await modelRegistry.isActive(3)).to.be.false;
  });
});
