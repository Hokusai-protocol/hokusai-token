const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, keccak256, toUtf8Bytes } = require("ethers");

const DEFAULT_VESTING_SENTINEL = {
  enabled: false,
  immediateUnlockBps: 0,
  vestingDurationSeconds: 0,
  cliffSeconds: 0,
};

describe("RewardVestingVault", function () {
  let vault;
  let token;
  let owner;
  let beneficiary;
  let otherUser;

  async function deployToken(controller) {
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    const params = await HokusaiParams.deploy(
      parseEther("1000"),
      8000,
      0,
      keccak256(toUtf8Bytes("vault-test-license")),
      "https://hokusai.ai/licenses/vault-test",
      owner.address,
      DEFAULT_VESTING_SENTINEL
    );
    await params.waitForDeployment();

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    const deployedToken = await HokusaiToken.deploy(
      "Vault Test Token",
      "VTT",
      controller,
      await params.getAddress(),
      parseEther("1000"),
      0,
      0,
      ethers.ZeroAddress
    );
    await deployedToken.waitForDeployment();
    return deployedToken;
  }

  beforeEach(async function () {
    [owner, beneficiary, otherUser] = await ethers.getSigners();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vault = await RewardVestingVault.deploy(owner.address);
    await vault.waitForDeployment();

    token = await deployToken(owner.address);
  });

  it("creates schedules only from the configured token manager", async function () {
    await expect(
      vault.connect(otherUser).createSchedule(
        "model-1",
        await token.getAddress(),
        beneficiary.address,
        parseEther("100"),
        0,
        365 * 24 * 60 * 60
      )
    ).to.be.revertedWith("Only TokenManager can create schedules");
  });

  it("supports zero-cliff linear vesting with partial and full claims", async function () {
    const totalAmount = parseEther("225000");
    const duration = 365 * 24 * 60 * 60;

    await token.mint(await vault.getAddress(), totalAmount);
    await vault.createSchedule("model-1", await token.getAddress(), beneficiary.address, totalAmount, 0, duration);

    await time.increase(duration / 2);
    const halfClaimable = (totalAmount * 1n) / 2n;
    const perSecondVesting = totalAmount / BigInt(duration);
    expect(await vault.vestedAmount(0)).to.equal(halfClaimable);
    expect(await vault.claimable(0)).to.equal(halfClaimable);
    expect(await vault.unvestedAmount(0)).to.equal(totalAmount - halfClaimable);

    const claimTx = await vault.connect(beneficiary).claim(0);
    const claimReceipt = await claimTx.wait();
    const claimEvent = claimReceipt.logs
      .map((log) => {
        try {
          return vault.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .find((event) => event && event.name === "VestedRewardClaimed");

    expect(claimEvent.args.amount).to.be.closeTo(halfClaimable, perSecondVesting);

    expect(await token.balanceOf(beneficiary.address)).to.be.closeTo(halfClaimable, perSecondVesting);
    expect(await vault.claimable(0)).to.equal(0);

    await time.increase(duration / 2);
    const remaining = totalAmount - halfClaimable;
    await vault.connect(beneficiary).claim(0);

    expect(await token.balanceOf(beneficiary.address)).to.equal(totalAmount);
    expect(await vault.claimable(0)).to.equal(0);
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0);
    expect(remaining).to.be.gt(0);
    await expect(vault.connect(beneficiary).claim(0)).to.be.revertedWith("No vested rewards available");
  });

  it("enforces the cliff before any rewards become claimable", async function () {
    const totalAmount = parseEther("1000");
    const duration = 30 * 24 * 60 * 60;
    const cliff = 7 * 24 * 60 * 60;

    await token.mint(await vault.getAddress(), totalAmount);
    await vault.createSchedule("model-2", await token.getAddress(), beneficiary.address, totalAmount, cliff, duration);

    await time.increase(cliff - 1);
    expect(await vault.vestedAmount(0)).to.equal(0);
    expect(await vault.claimable(0)).to.equal(0);

    await time.increase(1);
    const vestedAtCliff = (totalAmount * BigInt(cliff)) / BigInt(duration);
    expect(await vault.vestedAmount(0)).to.equal(vestedAtCliff);
  });

  it("tracks schedules by beneficiary", async function () {
    await token.mint(await vault.getAddress(), parseEther("300"));
    await vault.createSchedule("model-a", await token.getAddress(), beneficiary.address, parseEther("100"), 0, 10);
    await vault.createSchedule("model-b", await token.getAddress(), beneficiary.address, parseEther("200"), 0, 20);

    const ids = await vault.getSchedulesByBeneficiary(beneficiary.address);
    expect(ids).to.deep.equal([0n, 1n]);
  });
});
