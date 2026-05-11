const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress } = require("ethers");
const { buildInitialParams, defaultVestingConfig } = require("./helpers/tokenDeployment");

describe("TokenManager - Vesting", function () {
  let TokenManager;
  let tokenManager;
  let ModelRegistry;
  let registry;
  let RewardVestingVault;
  let vault;
  let owner;
  let governor;
  let minter;
  let contributor;
  let user1;

  const MODEL_ID = "test-model-vesting";
  const TOKEN_NAME = "Test Token";
  const TOKEN_SYMBOL = "TEST";
  const INITIAL_SUPPLY = ethers.parseEther("1000000");
  const REWARD_AMOUNT = ethers.parseEther("10000");

  beforeEach(async function () {
    [owner, governor, minter, contributor, user1] = await ethers.getSigners();

    // Deploy ModelRegistry
    ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    registry = await ModelRegistry.deploy();
    await registry.waitForDeployment();

    // Deploy TokenManager
    TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(registry.target);
    await tokenManager.waitForDeployment();

    // Deploy RewardVestingVault
    RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vault = await RewardVestingVault.deploy();
    await vault.waitForDeployment();

    // Setup vault
    await vault.setController(tokenManager.target);
    await tokenManager.setRewardVestingVault(vault.target);
  });

  describe("Vesting Disabled", function () {
    beforeEach(async function () {
      // Deploy token with vesting disabled
      const params = buildInitialParams(governor.address, {
        vestingConfig: {
          enabled: false,
          immediateUnlockBps: 10000,
          vestingDurationSeconds: 0,
          cliffSeconds: 0
        }
      });

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );
    });

    it("Should mint full reward directly to recipient", async function () {
      const tokenAddress = await tokenManager.modelTokens(MODEL_ID);
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

      await expect(
        tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT)
      )
        .to.emit(tokenManager, "TokensMinted")
        .withArgs(MODEL_ID, contributor.address, REWARD_AMOUNT);

      expect(await token.balanceOf(contributor.address)).to.equal(REWARD_AMOUNT);
      expect(await token.balanceOf(vault.target)).to.equal(0);

      // No schedule should be created
      const schedules = await vault.getSchedulesForBeneficiary(contributor.address);
      expect(schedules.length).to.equal(0);
    });
  });

  describe("Vesting Enabled (Default 10%/90%)", function () {
    let tokenAddress;
    let token;

    beforeEach(async function () {
      // Deploy token with default vesting (10% immediate, 90% vested over 365 days)
      const params = buildInitialParams(governor.address);

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      tokenAddress = await tokenManager.modelTokens(MODEL_ID);
      token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    });

    it("Should split reward 10% immediate, 90% vested", async function () {
      const immediateAmount = REWARD_AMOUNT / 10n; // 10%
      const vestedAmount = REWARD_AMOUNT - immediateAmount; // 90%

      await tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT);

      expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
      expect(await token.balanceOf(vault.target)).to.equal(vestedAmount);
    });

    it("Should create vesting schedule with correct parameters", async function () {
      const tx = await tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const schedules = await vault.getSchedulesForBeneficiary(contributor.address);
      expect(schedules.length).to.equal(1);

      const schedule = await vault.getSchedule(schedules[0]);
      expect(schedule.modelId).to.equal(MODEL_ID);
      expect(schedule.token).to.equal(tokenAddress);
      expect(schedule.beneficiary).to.equal(contributor.address);
      expect(schedule.vestedTotal).to.equal(REWARD_AMOUNT * 9n / 10n);
      expect(schedule.claimedAmount).to.equal(0);
      expect(schedule.startTimestamp).to.equal(block.timestamp);
      expect(schedule.cliffEndTimestamp).to.equal(block.timestamp); // No cliff
      expect(schedule.endTimestamp).to.equal(block.timestamp + 365 * 24 * 60 * 60);
    });

    it("Should emit RewardVestingCreated event", async function () {
      const immediateAmount = REWARD_AMOUNT / 10n;
      const vestedAmount = REWARD_AMOUNT - immediateAmount;

      await expect(
        tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT)
      ).to.emit(vault, "RewardVestingCreated");
    });

    it("Should revert if vault not set", async function () {
      // Deploy a new token manager without vault set
      const tokenManager2 = await TokenManager.deploy(registry.target);
      await tokenManager2.waitForDeployment();

      // Deploy token with vesting enabled but no vault
      const params = buildInitialParams(governor.address);
      await tokenManager2.deployTokenWithParams(
        "model-no-vault",
        "No Vault Token",
        "NVT",
        INITIAL_SUPPLY,
        params
      );

      // Try to mint reward without vault set - should revert
      await expect(
        tokenManager2.mintReward("model-no-vault", contributor.address, REWARD_AMOUNT)
      ).to.be.revertedWith("Reward vesting vault not set");
    });
  });

  describe("Custom Vesting Config", function () {
    it("Should handle custom immediate unlock percentage (25%)", async function () {
      const params = buildInitialParams(governor.address, {
        vestingConfig: {
          enabled: true,
          immediateUnlockBps: 2500, // 25%
          vestingDurationSeconds: 365 * 24 * 60 * 60,
          cliffSeconds: 0
        }
      });

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      const tokenAddress = await tokenManager.modelTokens(MODEL_ID);
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

      await tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT);

      const immediateAmount = REWARD_AMOUNT * 25n / 100n;
      const vestedAmount = REWARD_AMOUNT - immediateAmount;

      expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
      expect(await token.balanceOf(vault.target)).to.equal(vestedAmount);
    });

    it("Should handle custom vesting duration (30 days)", async function () {
      const duration = 30 * 24 * 60 * 60;
      const params = buildInitialParams(governor.address, {
        vestingConfig: {
          enabled: true,
          immediateUnlockBps: 1000,
          vestingDurationSeconds: duration,
          cliffSeconds: 0
        }
      });

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      const tx = await tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT);
      const receipt = await tx.wait();
      const block = await ethers.provider.getBlock(receipt.blockNumber);

      const schedules = await vault.getSchedulesForBeneficiary(contributor.address);
      const schedule = await vault.getSchedule(schedules[0]);

      expect(schedule.endTimestamp).to.equal(block.timestamp + duration);
    });

    it("Should mint fully liquid when immediateUnlockBps = 10000", async function () {
      const params = buildInitialParams(governor.address, {
        vestingConfig: {
          enabled: true,
          immediateUnlockBps: 10000, // 100%
          vestingDurationSeconds: 365 * 24 * 60 * 60,
          cliffSeconds: 0
        }
      });

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      const tokenAddress = await tokenManager.modelTokens(MODEL_ID);
      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

      await tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT);

      // All tokens should go to contributor
      expect(await token.balanceOf(contributor.address)).to.equal(REWARD_AMOUNT);
      expect(await token.balanceOf(vault.target)).to.equal(0);

      // No schedule should be created
      const schedules = await vault.getSchedulesForBeneficiary(contributor.address);
      expect(schedules.length).to.equal(0);
    });
  });

  describe("Batch Mint Reward", function () {
    let tokenAddress;
    let token;

    beforeEach(async function () {
      const params = buildInitialParams(governor.address);

      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      tokenAddress = await tokenManager.modelTokens(MODEL_ID);
      token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    });

    it("Should distribute rewards to multiple recipients", async function () {
      const recipients = [contributor.address, user1.address];
      const amounts = [ethers.parseEther("1000"), ethers.parseEther("2000")];

      await tokenManager.batchMintReward(MODEL_ID, recipients, amounts);

      // Each recipient gets 10% immediate
      expect(await token.balanceOf(contributor.address)).to.equal(amounts[0] / 10n);
      expect(await token.balanceOf(user1.address)).to.equal(amounts[1] / 10n);

      // Vault gets 90% of both
      const totalVested = (amounts[0] * 9n / 10n) + (amounts[1] * 9n / 10n);
      expect(await token.balanceOf(vault.target)).to.equal(totalVested);

      // Each recipient has a schedule
      expect((await vault.getSchedulesForBeneficiary(contributor.address)).length).to.equal(1);
      expect((await vault.getSchedulesForBeneficiary(user1.address)).length).to.equal(1);
    });

    it("Should skip zero-amount entries", async function () {
      const recipients = [contributor.address, user1.address];
      const amounts = [ethers.parseEther("1000"), 0];

      await expect(
        tokenManager.batchMintReward(MODEL_ID, recipients, amounts)
      ).to.emit(tokenManager, "ContributorSkipped")
        .withArgs(user1.address, 1);

      // Only contributor should have tokens and schedule
      expect(await token.balanceOf(contributor.address)).to.be.gt(0);
      expect(await token.balanceOf(user1.address)).to.equal(0);

      expect((await vault.getSchedulesForBeneficiary(contributor.address)).length).to.equal(1);
      expect((await vault.getSchedulesForBeneficiary(user1.address)).length).to.equal(0);
    });
  });

  describe("Access Control", function () {
    beforeEach(async function () {
      const params = buildInitialParams(governor.address);
      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );
    });

    it("Should allow owner to mint rewards", async function () {
      await expect(
        tokenManager.connect(owner).mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT)
      ).to.not.be.reverted;
    });

    it("Should reject non-authorized caller", async function () {
      await expect(
        tokenManager.connect(user1).mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT)
      ).to.be.revertedWith("Caller is not authorized to mint");
    });
  });

  describe("Model State", function () {
    beforeEach(async function () {
      const params = buildInitialParams(governor.address);
      await tokenManager.deployTokenWithParams(
        MODEL_ID,
        TOKEN_NAME,
        TOKEN_SYMBOL,
        INITIAL_SUPPLY,
        params
      );

      const tokenAddress = await tokenManager.modelTokens(MODEL_ID);

      // Register model in registry using string registration
      await registry.registerStringModel(MODEL_ID, tokenAddress, "accuracy");
    });

    it("Should reject reward mint for deactivated model", async function () {
      // Deactivate model
      await registry.deactivateStringModel(MODEL_ID);

      await expect(
        tokenManager.mintReward(MODEL_ID, contributor.address, REWARD_AMOUNT)
      ).to.be.revertedWith("Model is deactivated");
    });
  });

  describe("Vault Management", function () {
    it("Should allow owner to set vault", async function () {
      const newVault = await RewardVestingVault.deploy();

      await expect(tokenManager.setRewardVestingVault(newVault.target))
        .to.emit(tokenManager, "RewardVestingVaultUpdated")
        .withArgs(newVault.target);

      expect(await tokenManager.rewardVestingVault()).to.equal(newVault.target);
    });

    it("Should reject zero address vault", async function () {
      await expect(
        tokenManager.setRewardVestingVault(ZeroAddress)
      ).to.be.reverted;
    });

    it("Should reject non-owner setting vault", async function () {
      await expect(
        tokenManager.connect(user1).setRewardVestingVault(vault.target)
      ).to.be.reverted;
    });
  });
});
