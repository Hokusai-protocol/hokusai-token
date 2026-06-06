const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther } = require("ethers");
const {
  buildDisabledVestingConfig,
  buildInitialParams,
  buildVestingConfig,
} = require("./helpers/tokenDeployment");

describe("Supplier allocation vesting", function () {
  const MODEL_SUPPLIER_ALLOCATION = parseEther("250");
  const INVESTOR_ALLOCATION = parseEther("500");
  const ONE_MONTH = 30 * 24 * 60 * 60;
  const ONE_YEAR = 365 * 24 * 60 * 60;

  async function deployTokenManagerStack() {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    return { tokenManager };
  }

  async function deployDeployableManagerStack() {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
    const tokenDeploymentFactory = await TokenDeploymentFactory.deploy();
    await tokenDeploymentFactory.waitForDeployment();

    const DeployableTokenManager = await ethers.getContractFactory("DeployableTokenManager");
    const tokenManager = await DeployableTokenManager.deploy(
      await modelRegistry.getAddress(),
      await tokenDeploymentFactory.getAddress()
    );
    await tokenManager.waitForDeployment();

    return { tokenManager };
  }

  for (const { label, deployManager } of [
    { label: "TokenManager", deployManager: deployTokenManagerStack },
    { label: "DeployableTokenManager", deployManager: deployDeployableManagerStack },
  ]) {
    describe(label, function () {
      let owner;
      let supplier;
      let buyer;
      let outsider;
      let tokenManager;
      let vestingVault;

      async function deployFixture({
        modelId,
        vestingConfig = buildDisabledVestingConfig(),
        withVault = true,
      } = {}) {
        ({ tokenManager } = await deployManager());
        [owner, supplier, buyer, outsider] = await ethers.getSigners();

        if (withVault) {
          const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
          vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
          await vestingVault.waitForDeployment();
          await tokenManager.setVestingVault(await vestingVault.getAddress());
        } else {
          vestingVault = null;
        }

        const resolvedModelId = modelId ?? `${label}-supplier-${Date.now()}-${Math.random()}`;
        await tokenManager.deployTokenWithAllocations(
          resolvedModelId,
          `${label} Supplier Token`,
          "SUP",
          MODEL_SUPPLIER_ALLOCATION,
          supplier.address,
          INVESTOR_ALLOCATION,
          buildInitialParams(owner.address, { vestingConfig })
        );

        const tokenAddress = await tokenManager.getTokenAddress(resolvedModelId);
        const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

        return { modelId: resolvedModelId, token, tokenAddress };
      }

      it("keeps supplier allocation fully liquid when vesting is disabled", async function () {
        const { modelId, token } = await deployFixture({
          modelId: `${label}-disabled`,
          vestingConfig: buildDisabledVestingConfig(),
        });

        await expect(tokenManager.distributeModelSupplierAllocation(modelId))
          .to.emit(tokenManager, "ModelSupplierAllocationDistributed")
          .withArgs(modelId, supplier.address, MODEL_SUPPLIER_ALLOCATION);

        expect(await token.balanceOf(supplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
        expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
        expect(await vestingVault.getSchedulesByBeneficiary(supplier.address)).to.deep.equal([]);
      });

      it("uses the contributor vesting config for partially vested supplier allocation", async function () {
        const vestingConfig = buildVestingConfig({
          immediateUnlockBps: 2000,
          vestingDurationSeconds: ONE_MONTH,
          cliffSeconds: 0,
        });
        const { modelId, token, tokenAddress } = await deployFixture({
          modelId: `${label}-partial`,
          vestingConfig,
        });
        const immediateAmount = parseEther("50");
        const vestedAmount = MODEL_SUPPLIER_ALLOCATION - immediateAmount;

        await expect(tokenManager.distributeModelSupplierAllocation(modelId))
          .to.emit(tokenManager, "ModelSupplierAllocationDistributed")
          .withArgs(modelId, supplier.address, MODEL_SUPPLIER_ALLOCATION)
          .and.to.emit(tokenManager, "SupplierAllocationVested")
          .withArgs(
            modelId,
            supplier.address,
            MODEL_SUPPLIER_ALLOCATION,
            immediateAmount,
            vestedAmount,
            anyValue,
            anyValue
          );

        expect(await token.balanceOf(supplier.address)).to.equal(immediateAmount);
        expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);

        const scheduleIds = await vestingVault.getSchedulesByBeneficiary(supplier.address);
        expect(scheduleIds).to.deep.equal([0n]);
        const schedule = await vestingVault.getSchedule(0);
        expect(schedule.beneficiary).to.equal(supplier.address);
        expect(schedule.token).to.equal(tokenAddress);
        expect(schedule.modelId).to.equal(modelId);
        expect(schedule.totalAmount).to.equal(vestedAmount);
        expect(schedule.cliffSeconds).to.equal(0);
        expect(schedule.duration).to.equal(ONE_MONTH);
      });

      it("skips vault scheduling when immediate unlock is 100%", async function () {
        const { modelId, token } = await deployFixture({
          modelId: `${label}-full-liquid`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 10000,
            vestingDurationSeconds: ONE_MONTH,
          }),
        });

        await expect(tokenManager.distributeModelSupplierAllocation(modelId))
          .to.emit(tokenManager, "ModelSupplierAllocationDistributed")
          .withArgs(modelId, supplier.address, MODEL_SUPPLIER_ALLOCATION);

        expect(await token.balanceOf(supplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
        expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
        expect(await vestingVault.getSchedulesByBeneficiary(supplier.address)).to.deep.equal([]);
      });

      it("fully vests supplier allocation when immediate unlock is 0 and keeps the cliff", async function () {
        const cliffSeconds = 7 * 24 * 60 * 60;
        const { modelId, token } = await deployFixture({
          modelId: `${label}-full-vested`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 0,
            vestingDurationSeconds: ONE_MONTH,
            cliffSeconds,
          }),
        });

        await tokenManager.distributeModelSupplierAllocation(modelId);

        expect(await token.balanceOf(supplier.address)).to.equal(0);
        expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(MODEL_SUPPLIER_ALLOCATION);

        const schedule = await vestingVault.getSchedule(0);
        expect(schedule.totalAmount).to.equal(MODEL_SUPPLIER_ALLOCATION);
        expect(schedule.cliffSeconds).to.equal(cliffSeconds);
        expect(schedule.duration).to.equal(ONE_MONTH);
      });

      it("remains single-use across both vesting-disabled and vested flows", async function () {
        const disabledFixture = await deployFixture({
          modelId: `${label}-single-use-disabled`,
          vestingConfig: buildDisabledVestingConfig(),
        });
        await tokenManager.distributeModelSupplierAllocation(disabledFixture.modelId);
        await expect(
          tokenManager.distributeModelSupplierAllocation(disabledFixture.modelId)
        ).to.be.revertedWith("Model supplier allocation already distributed");

        const vestedFixture = await deployFixture({
          modelId: `${label}-single-use-vested`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 2500,
            vestingDurationSeconds: ONE_MONTH,
          }),
        });
        await tokenManager.distributeModelSupplierAllocation(vestedFixture.modelId);
        await expect(
          tokenManager.distributeModelSupplierAllocation(vestedFixture.modelId)
        ).to.be.revertedWith("Model supplier allocation already distributed");
      });

      it("reverts when vesting is enabled but no vesting vault is configured", async function () {
        const { modelId } = await deployFixture({
          modelId: `${label}-no-vault`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 2000,
            vestingDurationSeconds: ONE_MONTH,
          }),
          withVault: false,
        });

        await expect(
          tokenManager.distributeModelSupplierAllocation(modelId)
        ).to.be.revertedWith("Vesting vault not configured");
      });

      it("keeps supplier vesting separate from investor allocation and reward mint accounting", async function () {
        const { modelId, token } = await deployFixture({
          modelId: `${label}-accounting`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 2000,
            vestingDurationSeconds: ONE_MONTH,
          }),
        });
        const investorMintedBefore = await token.investorMinted();
        const rewardMintedBefore = await token.rewardMinted();
        const remainingInvestorBefore = await token.getRemainingInvestorAllocation();
        const remainingRewardBefore = await token.getRemainingRewardAllocation();

        await tokenManager.distributeModelSupplierAllocation(modelId);

        expect(await token.investorMinted()).to.equal(investorMintedBefore);
        expect(await token.rewardMinted()).to.equal(rewardMintedBefore);
        expect(await token.getRemainingInvestorAllocation()).to.equal(remainingInvestorBefore);
        expect(await token.getRemainingRewardAllocation()).to.equal(remainingRewardBefore);

        await tokenManager.mintTokens(modelId, buyer.address, INVESTOR_ALLOCATION);
        expect(await token.investorMinted()).to.equal(INVESTOR_ALLOCATION);
      });

      it("claims vested supplier tokens without changing reward mint accounting", async function () {
        const { modelId, token } = await deployFixture({
          modelId: `${label}-claim`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 2000,
            vestingDurationSeconds: ONE_MONTH,
          }),
        });
        const immediateAmount = parseEther("50");
        const vestedAmount = MODEL_SUPPLIER_ALLOCATION - immediateAmount;

        await tokenManager.distributeModelSupplierAllocation(modelId);
        await time.increase(ONE_MONTH);

        await vestingVault.connect(supplier).claim(0);

        expect(await token.balanceOf(supplier.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);
        expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
        expect(await token.rewardMinted()).to.equal(0);
        expect(vestedAmount).to.equal(MODEL_SUPPLIER_ALLOCATION - immediateAmount);
      });

      it("excludes unclaimed vested supplier tokens from redeemable supply", async function () {
        const { modelId } = await deployFixture({
          modelId: `${label}-redeemable`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 2000,
            vestingDurationSeconds: ONE_MONTH,
          }),
        });

        await tokenManager.distributeModelSupplierAllocation(modelId);

        expect(await tokenManager.getRedeemableSupply(modelId)).to.equal(parseEther("50"));
      });

      it("respects the supplier cliff before vested tokens become claimable", async function () {
        const cliffSeconds = 7 * 24 * 60 * 60;
        const { modelId } = await deployFixture({
          modelId: `${label}-cliff`,
          vestingConfig: buildVestingConfig({
            immediateUnlockBps: 0,
            vestingDurationSeconds: ONE_YEAR,
            cliffSeconds,
          }),
        });

        await tokenManager.distributeModelSupplierAllocation(modelId);

        expect(await vestingVault.claimable(0)).to.equal(0);
        await time.increase(cliffSeconds + 1);
        expect(await vestingVault.claimable(0)).to.be.gt(0);
      });

      it("only allows the owner to distribute supplier allocation", async function () {
        const { modelId } = await deployFixture({
          modelId: `${label}-auth`,
          vestingConfig: buildDisabledVestingConfig(),
        });

        await expect(
          tokenManager.connect(outsider).distributeModelSupplierAllocation(modelId)
        ).to.be.revertedWith("Ownable: caller is not the owner");
      });
    });
  }
});
