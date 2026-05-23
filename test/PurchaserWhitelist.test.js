const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress } = require("ethers");

describe("PurchaserWhitelist", function () {
  let whitelist;
  let owner, other, a1, a2, a3;

  beforeEach(async function () {
    [owner, other, a1, a2, a3] = await ethers.getSigners();
    const PurchaserWhitelist = await ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy();
    await whitelist.waitForDeployment();
  });

  it("isWhitelisted reflects add/remove", async function () {
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(false);
    await whitelist.addToWhitelist(a1.address);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(true);
    await whitelist.removeFromWhitelist(a1.address);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(false);
  });

  it("addToWhitelist emits once and is idempotent", async function () {
    await expect(whitelist.addToWhitelist(a1.address))
      .to.emit(whitelist, "AddressWhitelisted")
      .withArgs(a1.address);

    await expect(whitelist.addToWhitelist(a1.address))
      .to.not.emit(whitelist, "AddressWhitelisted");
  });

  it("addToWhitelist reverts on zero address", async function () {
    await expect(whitelist.addToWhitelist(ZeroAddress))
      .to.be.revertedWithCustomError(whitelist, "ZeroAddress");
  });

  it("removeFromWhitelist emits once and is idempotent", async function () {
    await whitelist.addToWhitelist(a1.address);

    await expect(whitelist.removeFromWhitelist(a1.address))
      .to.emit(whitelist, "AddressRemoved")
      .withArgs(a1.address);

    await expect(whitelist.removeFromWhitelist(a1.address))
      .to.not.emit(whitelist, "AddressRemoved");
  });

  it("addBatch adds multiple and enforces max batch", async function () {
    await whitelist.addBatch([a1.address, a2.address, a3.address]);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(true);
    expect(await whitelist.isWhitelisted(a2.address)).to.equal(true);
    expect(await whitelist.isWhitelisted(a3.address)).to.equal(true);

    const oversized = Array.from({ length: 201 }, () => ethers.Wallet.createRandom().address);
    await expect(whitelist.addBatch(oversized))
      .to.be.revertedWithCustomError(whitelist, "BatchTooLarge")
      .withArgs(201, 200);
  });

  it("addBatch reverts if any entry is zero address", async function () {
    await expect(whitelist.addBatch([a1.address, ZeroAddress, a2.address]))
      .to.be.revertedWithCustomError(whitelist, "ZeroAddress");
  });

  it("removeBatch removes multiple and enforces max batch", async function () {
    await whitelist.addBatch([a1.address, a2.address, a3.address]);
    await whitelist.removeBatch([a1.address, a3.address]);

    expect(await whitelist.isWhitelisted(a1.address)).to.equal(false);
    expect(await whitelist.isWhitelisted(a2.address)).to.equal(true);
    expect(await whitelist.isWhitelisted(a3.address)).to.equal(false);

    const oversized = Array.from({ length: 201 }, () => ethers.Wallet.createRandom().address);
    await expect(whitelist.removeBatch(oversized))
      .to.be.revertedWithCustomError(whitelist, "BatchTooLarge")
      .withArgs(201, 200);
  });

  it("only owner can mutate whitelist", async function () {
    await expect(whitelist.connect(other).addToWhitelist(a1.address))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(whitelist.connect(other).removeFromWhitelist(a1.address))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(whitelist.connect(other).addBatch([a1.address]))
      .to.be.revertedWith("Ownable: caller is not the owner");
    await expect(whitelist.connect(other).removeBatch([a1.address]))
      .to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("ownership transfer updates whitelist authority", async function () {
    await whitelist.transferOwnership(other.address);

    await expect(whitelist.addToWhitelist(a1.address))
      .to.be.revertedWith("Ownable: caller is not the owner");

    await whitelist.connect(other).addToWhitelist(a1.address);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(true);
  });
});
