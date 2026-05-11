const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress } = require("ethers");

describe("RewardVestingVault", function () {
  let RewardVestingVault;
  let vault;
  let MockERC20;
  let token;
  let owner;
  let controller;
  let beneficiary;
  let user1;

  const MODEL_ID = "test-model";
  const VESTED_AMOUNT = ethers.parseEther("1000");
  const IMMEDIATE_AMOUNT = ethers.parseEther("100");
  const TOTAL_REWARD = VESTED_AMOUNT + IMMEDIATE_AMOUNT;
  const DURATION_365_DAYS = 365 * 24 * 60 * 60;
  const DURATION_30_DAYS = 30 * 24 * 60 * 60;
  const CLIFF_7_DAYS = 7 * 24 * 60 * 60;

  beforeEach(async function () {
    [owner, controller, beneficiary, user1] = await ethers.getSigners();

    // Deploy mock params (use owner address as a dummy since we don't need params functionality)
    const mockParams = owner.address;

    // Deploy mock ERC20 token
    MockERC20 = await ethers.getContractFactory("HokusaiToken");
    token = await MockERC20.deploy(
      "Test Token",
      "TEST",
      owner.address,
      mockParams,
      ethers.parseEther("1000000"), // Initial supply
      0, // maxSupply (0 = unlimited in legacy mode)
      0,
      ZeroAddress
    );
    await token.waitForDeployment();

    // Deploy RewardVestingVault
    RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vault = await RewardVestingVault.connect(owner).deploy();
    await vault.waitForDeployment();

    // Set controller
    await vault.connect(owner).setController(controller.address);
  });

  describe("Constructor and Setup", function () {

    it("Should set owner correctly", async function () {
      expect(await vault.owner()).to.equal(owner.address);
    });

    it("Should allow owner to set controller", async function () {
      const newController = user1.address;
      await expect(vault.connect(owner).setController(newController))
        .to.emit(vault, "RewardVestingVaultControllerUpdated")
        .withArgs(newController);

      expect(await vault.controller()).to.equal(newController);
    });

    it("Should reject zero address controller", async function () {
      await expect(
        vault.connect(owner).setController(ZeroAddress)
      ).to.be.reverted;
    });

    it("Should prevent non-owner from setting controller", async function () {
      await expect(
        vault.connect(user1).setController(user1.address)
      ).to.be.reverted;
    });
  });

  describe("Create Schedule", function () {
    beforeEach(async function () {
      // Mint tokens to vault
      await token.connect(owner).mint(vault.target, VESTED_AMOUNT);
    });

    it("Should create a vesting schedule", async function () {
      const tx = await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      await expect(tx)
        .to.emit(vault, "RewardVestingCreated")
        .withArgs(
          MODEL_ID,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          block.timestamp,
          block.timestamp + DURATION_365_DAYS
        );
    });

    it("Should store schedule correctly", async function () {
      const tx = await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );

      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const schedule = await vault.getSchedule(0);
      expect(schedule.modelId).to.equal(MODEL_ID);
      expect(schedule.token).to.equal(token.target);
      expect(schedule.beneficiary).to.equal(beneficiary.address);
      expect(schedule.vestedTotal).to.equal(VESTED_AMOUNT);
      expect(schedule.claimedAmount).to.equal(0);
      expect(schedule.startTimestamp).to.equal(block.timestamp);
      expect(schedule.cliffEndTimestamp).to.equal(block.timestamp);
      expect(schedule.endTimestamp).to.equal(block.timestamp + DURATION_365_DAYS);
    });

    it("Should track schedules for beneficiary", async function () {
      await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );

      const schedules = await vault.getSchedulesForBeneficiary(beneficiary.address);
      expect(schedules.length).to.equal(1);
      expect(schedules[0]).to.equal(0);
    });

    it("Should reject creation from non-controller", async function () {
      await expect(
        vault.connect(user1).createSchedule(
          MODEL_ID,
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          DURATION_365_DAYS,
          0
        )
      ).to.be.revertedWith("Only controller can create schedules");
    });

    it("Should reject zero beneficiary", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          token.target,
          ZeroAddress,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          DURATION_365_DAYS,
          0
        )
      ).to.be.reverted;
    });

    it("Should reject zero token", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          ZeroAddress,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          DURATION_365_DAYS,
          0
        )
      ).to.be.reverted;
    });

    it("Should reject zero vested amount", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          0,
          DURATION_365_DAYS,
          0
        )
      ).to.be.revertedWith("Vested amount must be > 0");
    });

    it("Should reject zero duration", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          0,
          0
        )
      ).to.be.revertedWith("Duration must be > 0");
    });

    it("Should reject cliff > duration", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          DURATION_30_DAYS,
          DURATION_365_DAYS
        )
      ).to.be.revertedWith("Cliff must be <= duration");
    });

    it("Should reject empty model ID", async function () {
      await expect(
        vault.connect(controller).createSchedule(
          "",
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          VESTED_AMOUNT,
          DURATION_365_DAYS,
          0
        )
      ).to.be.revertedWith("Model ID cannot be empty");
    });

    it("Should reject oversubscription (insufficient balance)", async function () {
      const excessAmount = VESTED_AMOUNT * 2n;
      await expect(
        vault.connect(controller).createSchedule(
          MODEL_ID,
          token.target,
          beneficiary.address,
          TOTAL_REWARD,
          IMMEDIATE_AMOUNT,
          excessAmount,
          DURATION_365_DAYS,
          0
        )
      ).to.be.revertedWith("Insufficient token balance in vault");
    });

    it("Should handle multiple schedules for same beneficiary", async function () {
      await token.connect(owner).mint(vault.target, VESTED_AMOUNT); // Add more tokens

      await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );

      await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_30_DAYS,
        0
      );

      const schedules = await vault.getSchedulesForBeneficiary(beneficiary.address);
      expect(schedules.length).to.equal(2);
    });
  });

  describe("Vesting Math", function () {
    let scheduleId;

    beforeEach(async function () {
      await token.connect(owner).mint(vault.target, VESTED_AMOUNT);

      const tx = await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );
      scheduleId = 0;
    });

    it("Should return 0 vested at start (t=0)", async function () {
      expect(await vault.vestedAmount(scheduleId)).to.equal(0);
      expect(await vault.unvestedAmount(scheduleId)).to.equal(VESTED_AMOUNT);
      expect(await vault.claimable(scheduleId)).to.equal(0);
    });

    it("Should return ~50% vested at halfway point", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS / 2]);
      await ethers.provider.send("evm_mine");

      const vested = await vault.vestedAmount(scheduleId);
      const expectedVested = VESTED_AMOUNT / 2n;

      // Allow for 1 second rounding error
      expect(vested).to.be.closeTo(expectedVested, ethers.parseEther("0.1"));
      expect(await vault.claimable(scheduleId)).to.equal(vested);
    });

    it("Should return 100% vested at end", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS]);
      await ethers.provider.send("evm_mine");

      expect(await vault.vestedAmount(scheduleId)).to.equal(VESTED_AMOUNT);
      expect(await vault.unvestedAmount(scheduleId)).to.equal(0);
      expect(await vault.claimable(scheduleId)).to.equal(VESTED_AMOUNT);
    });

    it("Should return 100% vested beyond end", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS * 2]);
      await ethers.provider.send("evm_mine");

      expect(await vault.vestedAmount(scheduleId)).to.equal(VESTED_AMOUNT);
      expect(await vault.unvestedAmount(scheduleId)).to.equal(0);
    });
  });

  describe("Cliff", function () {
    let scheduleId;

    beforeEach(async function () {
      await token.connect(owner).mint(vault.target, VESTED_AMOUNT);

      await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_30_DAYS,
        CLIFF_7_DAYS
      );
      scheduleId = 0;
    });

    it("Should return 0 vested before cliff", async function () {
      await ethers.provider.send("evm_increaseTime", [CLIFF_7_DAYS - 1]);
      await ethers.provider.send("evm_mine");

      expect(await vault.vestedAmount(scheduleId)).to.equal(0);
      expect(await vault.claimable(scheduleId)).to.equal(0);
    });

    it("Should return vested amount at cliff end", async function () {
      await ethers.provider.send("evm_increaseTime", [CLIFF_7_DAYS]);
      await ethers.provider.send("evm_mine");

      const vested = await vault.vestedAmount(scheduleId);
      expect(vested).to.be.gt(0);
    });

    it("Should prevent claim before cliff", async function () {
      await ethers.provider.send("evm_increaseTime", [CLIFF_7_DAYS / 2]);
      await ethers.provider.send("evm_mine");

      await expect(
        vault.connect(beneficiary).claim(scheduleId)
      ).to.be.revertedWith("No tokens to claim");
    });
  });

  describe("Claiming", function () {
    let scheduleId;

    beforeEach(async function () {
      await token.connect(owner).mint(vault.target, VESTED_AMOUNT);

      await vault.connect(controller).createSchedule(
        MODEL_ID,
        token.target,
        beneficiary.address,
        TOTAL_REWARD,
        IMMEDIATE_AMOUNT,
        VESTED_AMOUNT,
        DURATION_365_DAYS,
        0
      );
      scheduleId = 0;
    });

    it("Should have negligible claimable at start", async function () {
      // Note: claimable might be > 0 immediately due to block timestamp advancement
      // between schedule creation and this check, but should be negligible
      const claimableAtStart = await vault.claimable(scheduleId);

      // Allow up to 1 second worth of vesting (negligible fraction of 365 days)
      const maxExpectedAtStart = VESTED_AMOUNT / BigInt(DURATION_365_DAYS);
      expect(claimableAtStart).to.be.lte(maxExpectedAtStart);
    });

    it("Should allow partial claim after time passes", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS / 2]);
      await ethers.provider.send("evm_mine");

      const claimableAmount = await vault.claimable(scheduleId);
      expect(claimableAmount).to.be.gt(0);

      const balanceBefore = await token.balanceOf(beneficiary.address);

      // Claim and check event (with rounding tolerance)
      const tx = await vault.connect(beneficiary).claim(scheduleId);
      const receipt = await tx.wait();

      // Get the actual claimed amount from the event
      const event = receipt.logs.find(log => {
        try {
          return vault.interface.parseLog(log).name === "VestedRewardClaimed";
        } catch (e) {
          return false;
        }
      });
      const actualClaimed = vault.interface.parseLog(event).args[2];

      const balanceAfter = await token.balanceOf(beneficiary.address);
      expect(balanceAfter - balanceBefore).to.equal(actualClaimed);

      const schedule = await vault.getSchedule(scheduleId);
      expect(schedule.claimedAmount).to.equal(actualClaimed);

      // Verify it's approximately 50% of the vested amount (with rounding tolerance)
      expect(actualClaimed).to.be.closeTo(VESTED_AMOUNT / 2n, ethers.parseEther("1"));
    });

    it("Should allow second claim after first partial claim", async function () {
      // First claim at 50%
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS / 2]);
      await ethers.provider.send("evm_mine");

      const firstClaim = await vault.claimable(scheduleId);
      await vault.connect(beneficiary).claim(scheduleId);

      // Second claim at 100%
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS / 2]);
      await ethers.provider.send("evm_mine");

      const secondClaim = await vault.claimable(scheduleId);
      expect(secondClaim).to.be.gt(0);

      await vault.connect(beneficiary).claim(scheduleId);

      const schedule = await vault.getSchedule(scheduleId);
      expect(schedule.claimedAmount).to.equal(VESTED_AMOUNT);
      expect(await vault.claimable(scheduleId)).to.equal(0);
    });

    it("Should allow full claim at end", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS]);
      await ethers.provider.send("evm_mine");

      await vault.connect(beneficiary).claim(scheduleId);

      const schedule = await vault.getSchedule(scheduleId);
      expect(schedule.claimedAmount).to.equal(VESTED_AMOUNT);
      expect(await vault.claimable(scheduleId)).to.equal(0);
    });

    it("Should reject over-claim", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS]);
      await ethers.provider.send("evm_mine");

      await vault.connect(beneficiary).claim(scheduleId);

      await expect(
        vault.connect(beneficiary).claim(scheduleId)
      ).to.be.revertedWith("No tokens to claim");
    });

    it("Should allow anyone to call claim (transfer to beneficiary)", async function () {
      await ethers.provider.send("evm_increaseTime", [DURATION_365_DAYS]);
      await ethers.provider.send("evm_mine");

      const balanceBefore = await token.balanceOf(beneficiary.address);

      // user1 calls claim, but tokens go to beneficiary
      await vault.connect(user1).claim(scheduleId);

      const balanceAfter = await token.balanceOf(beneficiary.address);
      expect(balanceAfter - balanceBefore).to.equal(VESTED_AMOUNT);
    });

    it("Should reject claim for non-existent schedule", async function () {
      await expect(
        vault.connect(beneficiary).claim(999)
      ).to.be.revertedWith("Schedule does not exist");
    });
  });

  describe("View Functions", function () {
    it("Should return zero for non-existent schedule", async function () {
      expect(await vault.vestedAmount(999)).to.equal(0);
      expect(await vault.unvestedAmount(999)).to.equal(0);
      expect(await vault.claimable(999)).to.equal(0);
    });

    it("Should return empty array for beneficiary with no schedules", async function () {
      const schedules = await vault.getSchedulesForBeneficiary(user1.address);
      expect(schedules.length).to.equal(0);
    });
  });
});
