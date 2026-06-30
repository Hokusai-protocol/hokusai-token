const { expect } = require("chai");
const { ethers } = require("hardhat");

// H-2: `updateModel`/`updateStringModel` re-point a model's token without migrating the
// dependent pool / weight-genesis / external mappings, silently desyncing the registry. Both
// paths are gated by `modelUpdatesEnabled`, which defaults to OFF (mainnet-safe) and is only
// flipped on by governance once a safe migration exists. These tests pin that gate.
describe("ModelRegistry - updateModel gate (H-2)", function () {
  let modelRegistry, owner, nonOwner, tokenA, tokenB;

  beforeEach(async function () {
    [owner, nonOwner] = await ethers.getSigners();
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Registry stores token addresses without calling them, so plain addresses suffice here.
    tokenA = ethers.Wallet.createRandom().address;
    tokenB = ethers.Wallet.createRandom().address;
    await modelRegistry.registerModel(1, tokenA, "accuracy");
  });

  it("defaults to disabled", async function () {
    expect(await modelRegistry.modelUpdatesEnabled()).to.equal(false);
  });

  it("blocks updateModel while disabled", async function () {
    await expect(modelRegistry.updateModel(1, tokenB)).to.be.revertedWith("Model updates disabled");
  });

  it("blocks updateStringModel while disabled", async function () {
    await expect(modelRegistry.updateStringModel("1", tokenB)).to.be.revertedWith("Model updates disabled");
  });

  it("allows updateModel once governance enables the gate", async function () {
    await modelRegistry.setModelUpdatesEnabled(true);
    await modelRegistry.updateModel(1, tokenB);
    expect(await modelRegistry.getTokenAddress(1)).to.equal(tokenB);
  });

  it("re-disabling restores the block (reworkable toggle)", async function () {
    await modelRegistry.setModelUpdatesEnabled(true);
    await modelRegistry.setModelUpdatesEnabled(false);
    await expect(modelRegistry.updateModel(1, tokenB)).to.be.revertedWith("Model updates disabled");
  });

  it("emits ModelUpdatesEnabledSet on toggle", async function () {
    await expect(modelRegistry.setModelUpdatesEnabled(true))
      .to.emit(modelRegistry, "ModelUpdatesEnabledSet")
      .withArgs(true);
  });

  it("only owner can toggle the gate", async function () {
    await expect(
      modelRegistry.connect(nonOwner).setModelUpdatesEnabled(true)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("ownership check still precedes the gate for non-owners", async function () {
    await expect(
      modelRegistry.connect(nonOwner).updateModel(1, tokenB)
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });
});
