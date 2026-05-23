const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress } = require("ethers");

describe("PurchaserWhitelist", function () {
  let whitelist;
  let owner, other, a1, a2, a3;
  let whitelistAdminRole;

  beforeEach(async function () {
    [owner, other, a1, a2, a3] = await ethers.getSigners();
    const PurchaserWhitelist = await ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy(owner.address);
    await whitelist.waitForDeployment();
    whitelistAdminRole = await whitelist.WHITELIST_ADMIN_ROLE();
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
      .to.emit(whitelist, "WalletWhitelisted")
      .withArgs(a1.address);

    await expect(whitelist.addToWhitelist(a1.address))
      .to.not.emit(whitelist, "WalletWhitelisted");
  });

  it("addToWhitelist reverts on zero address", async function () {
    await expect(whitelist.addToWhitelist(ZeroAddress))
      .to.be.revertedWithCustomError(whitelist, "ZeroAddress");
  });

  it("removeFromWhitelist emits once and is idempotent", async function () {
    await whitelist.addToWhitelist(a1.address);

    await expect(whitelist.removeFromWhitelist(a1.address))
      .to.emit(whitelist, "WalletRemovedFromWhitelist")
      .withArgs(a1.address);

    await expect(whitelist.removeFromWhitelist(a1.address))
      .to.not.emit(whitelist, "WalletRemovedFromWhitelist");
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

  it("addBatch emits WalletWhitelisted for each new entry", async function () {
    const tx = whitelist.addBatch([a1.address, a2.address]);
    await expect(tx).to.emit(whitelist, "WalletWhitelisted").withArgs(a1.address);
    await expect(tx).to.emit(whitelist, "WalletWhitelisted").withArgs(a2.address);
  });

  it("removeBatch emits WalletRemovedFromWhitelist for each removed entry", async function () {
    await whitelist.addBatch([a1.address, a2.address]);
    const tx = whitelist.removeBatch([a1.address, a2.address]);
    await expect(tx).to.emit(whitelist, "WalletRemovedFromWhitelist").withArgs(a1.address);
    await expect(tx).to.emit(whitelist, "WalletRemovedFromWhitelist").withArgs(a2.address);
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

  it("grants admin roles to the configured admin", async function () {
    const defaultAdminRole = await whitelist.DEFAULT_ADMIN_ROLE();

    expect(await whitelist.hasRole(defaultAdminRole, owner.address)).to.equal(true);
    expect(await whitelist.hasRole(whitelistAdminRole, owner.address)).to.equal(true);
    expect(await whitelist.getRoleAdmin(whitelistAdminRole)).to.equal(defaultAdminRole);
  });

  it("rejects a zero admin in the constructor", async function () {
    const PurchaserWhitelist = await ethers.getContractFactory("PurchaserWhitelist");
    await expect(PurchaserWhitelist.deploy(ZeroAddress))
      .to.be.revertedWith("AccessControlBase: admin cannot be zero");
  });

  it("only whitelist admin can mutate whitelist", async function () {
    const missingRoleMessage = `AccessControl: account ${other.address.toLowerCase()} is missing role ${whitelistAdminRole}`;

    await expect(whitelist.connect(other).addToWhitelist(a1.address))
      .to.be.revertedWith(missingRoleMessage);
    await expect(whitelist.connect(other).removeFromWhitelist(a1.address))
      .to.be.revertedWith(missingRoleMessage);
    await expect(whitelist.connect(other).addBatch([a1.address]))
      .to.be.revertedWith(missingRoleMessage);
    await expect(whitelist.connect(other).removeBatch([a1.address]))
      .to.be.revertedWith(missingRoleMessage);
  });

  it("default admin can transfer whitelist authority by grant and revoke", async function () {
    await whitelist.grantRole(whitelistAdminRole, other.address);

    await whitelist.revokeRole(whitelistAdminRole, owner.address);

    const ownerMissingRoleMessage = `AccessControl: account ${owner.address.toLowerCase()} is missing role ${whitelistAdminRole}`;
    await expect(whitelist.addToWhitelist(a1.address))
      .to.be.revertedWith(ownerMissingRoleMessage);

    await whitelist.connect(other).addToWhitelist(a1.address);
    expect(await whitelist.isWhitelisted(a1.address)).to.equal(true);
  });

  it("default admin can grant and revoke whitelist admin role", async function () {
    expect(await whitelist.hasRole(whitelistAdminRole, other.address)).to.equal(false);

    await whitelist.grantRole(whitelistAdminRole, other.address);
    expect(await whitelist.hasRole(whitelistAdminRole, other.address)).to.equal(true);

    await whitelist.revokeRole(whitelistAdminRole, other.address);
    expect(await whitelist.hasRole(whitelistAdminRole, other.address)).to.equal(false);
  });
});
