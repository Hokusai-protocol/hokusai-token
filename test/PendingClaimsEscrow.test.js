const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("PendingClaimsEscrow", function () {
  let escrow, token, admin, releaser, alice, bob, other;
  let TOKEN;
  const REF = ethers.encodeBytes32String("entitlement-1");
  const REF2 = ethers.encodeBytes32String("entitlement-2");
  const FUND = ethers.parseUnits("1000", 6);

  beforeEach(async function () {
    [admin, releaser, alice, bob, other] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockUSDC");
    token = await Token.deploy();
    TOKEN = await token.getAddress();

    const Escrow = await ethers.getContractFactory("PendingClaimsEscrow");
    escrow = await Escrow.deploy(admin.address);

    await escrow.grantRole(await escrow.RELEASER_ROLE(), releaser.address);
    await token.mint(await escrow.getAddress(), FUND);
  });

  describe("deployment", function () {
    it("grants admin DEFAULT_ADMIN_ROLE and PAUSER_ROLE", async function () {
      expect(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(true);
      expect(await escrow.hasRole(await escrow.PAUSER_ROLE(), admin.address)).to.equal(true);
    });

    it("does not grant RELEASER_ROLE to admin by default", async function () {
      expect(await escrow.hasRole(await escrow.RELEASER_ROLE(), admin.address)).to.equal(false);
    });

    it("reverts on zero admin", async function () {
      const Escrow = await ethers.getContractFactory("PendingClaimsEscrow");
      await expect(Escrow.deploy(ethers.ZeroAddress)).to.be.reverted;
    });
  });

  describe("release", function () {
    it("transfers, tracks totalReleased, and emits Released", async function () {
      const amount = ethers.parseUnits("250", 6);
      await expect(escrow.connect(releaser).release(TOKEN, alice.address, amount, REF))
        .to.emit(escrow, "Released")
        .withArgs(TOKEN, alice.address, amount, REF);

      expect(await token.balanceOf(alice.address)).to.equal(amount);
      expect(await escrow.totalReleased(TOKEN)).to.equal(amount);
      expect(await escrow.tokenBalance(TOKEN)).to.equal(FUND - amount);
    });

    it("reverts when caller lacks RELEASER_ROLE", async function () {
      await expect(
        escrow.connect(other).release(TOKEN, alice.address, 1n, REF)
      ).to.be.reverted;
    });

    it("reverts on zero recipient or zero amount", async function () {
      await expect(
        escrow.connect(releaser).release(TOKEN, ethers.ZeroAddress, 1n, REF)
      ).to.be.reverted;
      await expect(
        escrow.connect(releaser).release(TOKEN, alice.address, 0n, REF)
      ).to.be.reverted;
    });

    it("reverts when paused", async function () {
      await escrow.connect(admin).pause();
      await expect(
        escrow.connect(releaser).release(TOKEN, alice.address, 1n, REF)
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("releaseBatch", function () {
    it("releases multiple tranches of one token", async function () {
      const a = ethers.parseUnits("100", 6);
      const b = ethers.parseUnits("50", 6);
      await escrow
        .connect(releaser)
        .releaseBatch(TOKEN, [alice.address, bob.address], [a, b], [REF, REF2]);

      expect(await token.balanceOf(alice.address)).to.equal(a);
      expect(await token.balanceOf(bob.address)).to.equal(b);
      expect(await escrow.totalReleased(TOKEN)).to.equal(a + b);
    });

    it("reverts on references length mismatch", async function () {
      await expect(
        escrow
          .connect(releaser)
          .releaseBatch(TOKEN, [alice.address, bob.address], [1n, 2n], [REF])
      ).to.be.revertedWith("references length mismatch");
    });

    it("reverts on recipients/amounts length mismatch", async function () {
      await expect(
        escrow.connect(releaser).releaseBatch(TOKEN, [alice.address], [1n, 2n], [REF, REF2])
      ).to.be.reverted;
    });

    it("reverts when caller lacks RELEASER_ROLE", async function () {
      await expect(
        escrow.connect(other).releaseBatch(TOKEN, [alice.address], [1n], [REF])
      ).to.be.reverted;
    });
  });

  describe("pause / unpause", function () {
    it("PAUSER can pause; DEFAULT_ADMIN can unpause", async function () {
      await escrow.connect(admin).pause();
      expect(await escrow.paused()).to.equal(true);
      await escrow.connect(admin).unpause();
      expect(await escrow.paused()).to.equal(false);
    });

    it("non-pauser cannot pause; non-admin cannot unpause", async function () {
      await expect(escrow.connect(other).pause()).to.be.reverted;
      await escrow.connect(admin).pause();
      await expect(escrow.connect(other).unpause()).to.be.reverted;
    });
  });

  describe("rescue", function () {
    it("admin can rescue and it works while paused", async function () {
      await escrow.connect(admin).pause();
      const amount = ethers.parseUnits("10", 6);
      await expect(escrow.connect(admin).rescue(TOKEN, other.address, amount))
        .to.emit(escrow, "Rescued")
        .withArgs(TOKEN, other.address, amount);
      expect(await token.balanceOf(other.address)).to.equal(amount);
    });

    it("non-admin cannot rescue", async function () {
      await expect(
        escrow.connect(releaser).rescue(TOKEN, other.address, 1n)
      ).to.be.reverted;
    });
  });

  describe("claimVested", function () {
    let vault, VAULT;
    const SCHED = 7n;
    const VESTED = ethers.parseUnits("90", 6);

    beforeEach(async function () {
      const Vault = await ethers.getContractFactory("MockVestingVault");
      vault = await Vault.deploy(TOKEN);
      VAULT = await vault.getAddress();
      await token.mint(VAULT, ethers.parseUnits("500", 6));
      await vault.setClaimable(SCHED, VESTED);
    });

    it("pulls vested tokens from the vault into the escrow and emits VestedClaimed", async function () {
      const before = await escrow.tokenBalance(TOKEN);
      await expect(escrow.connect(releaser).claimVested(VAULT, SCHED))
        .to.emit(escrow, "VestedClaimed")
        .withArgs(VAULT, SCHED, VESTED);
      expect(await escrow.tokenBalance(TOKEN)).to.equal(before + VESTED);
    });

    it("claimed tokens are then releasable to a verified wallet", async function () {
      await escrow.connect(releaser).claimVested(VAULT, SCHED);
      await escrow.connect(releaser).release(TOKEN, alice.address, VESTED, REF);
      expect(await token.balanceOf(alice.address)).to.equal(VESTED);
    });

    it("reverts when caller lacks RELEASER_ROLE", async function () {
      await expect(escrow.connect(other).claimVested(VAULT, SCHED)).to.be.reverted;
    });

    it("reverts on zero vault", async function () {
      await expect(escrow.connect(releaser).claimVested(ethers.ZeroAddress, SCHED)).to.be.reverted;
    });

    it("claimVestedBatch claims multiple schedules", async function () {
      await vault.setClaimable(8n, ethers.parseUnits("10", 6));
      const before = await escrow.tokenBalance(TOKEN);
      await escrow.connect(releaser).claimVestedBatch(VAULT, [SCHED, 8n]);
      expect(await escrow.tokenBalance(TOKEN)).to.equal(before + ethers.parseUnits("100", 6));
    });
  });
});
