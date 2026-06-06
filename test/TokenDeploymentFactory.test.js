const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, ZeroAddress } = require("ethers");
const {
  buildInitialParams,
  buildVestingConfig,
  wholeTokens,
} = require("./helpers/tokenDeployment");

describe("TokenDeploymentFactory", function () {
  let factory;
  let owner;
  let controller;
  let governor;
  let modelSupplierRecipient;

  beforeEach(async function () {
    [owner, controller, governor, modelSupplierRecipient] = await ethers.getSigners();

    const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
    factory = await TokenDeploymentFactory.deploy();
    await factory.waitForDeployment();
  });

  async function deployAndExtract(overrides = {}) {
    const params = buildInitialParams(governor.address, overrides.initialParamsOverrides);
    const tx = await factory.deployTokenAndParams(
      overrides.name ?? "Factory Token",
      overrides.symbol ?? "FACT",
      overrides.controller ?? controller.address,
      overrides.initialSupply ?? parseEther("1000"),
      overrides.maxSupply ?? 0,
      overrides.modelSupplierAllocation ?? 0,
      overrides.investorAllocation ?? 0,
      overrides.modelSupplierRecipient ?? ZeroAddress,
      params
    );
    const receipt = await tx.wait();

    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog(log);
        if (parsed && parsed.name === "TokenAndParamsDeployed") {
          return {
            tokenAddress: parsed.args.tokenAddress,
            paramsAddress: parsed.args.paramsAddress,
            initialParams: params,
          };
        }
      } catch {}
    }

    throw new Error("TokenAndParamsDeployed event not found");
  }

  it("deploys HokusaiParams with the supplied vesting config", async function () {
    const vestingConfig = buildVestingConfig({
      immediateUnlockBps: 2500,
      vestingDurationSeconds: 180 * 24 * 60 * 60,
      cliffSeconds: 30 * 24 * 60 * 60,
    });

    const { paramsAddress, initialParams } = await deployAndExtract({
      initialParamsOverrides: {
        tokensPerDeltaOne: wholeTokens(750000),
        infrastructureAccrualBps: 7000,
        initialOraclePricePerThousandUsd: 123456n,
        vestingConfig,
      },
    });

    const params = await ethers.getContractAt("HokusaiParams", paramsAddress);

    expect(await params.tokensPerDeltaOne()).to.equal(initialParams.tokensPerDeltaOne);
    expect(await params.infrastructureAccrualBps()).to.equal(initialParams.infrastructureAccrualBps);
    expect(await params.oraclePricePerThousandUsd()).to.equal(initialParams.initialOraclePricePerThousandUsd);
    expect(await params.vestingEnabled()).to.equal(true);
    expect(await params.immediateUnlockBps()).to.equal(vestingConfig.immediateUnlockBps);
    expect(await params.vestingDurationSeconds()).to.equal(vestingConfig.vestingDurationSeconds);
    expect(await params.cliffSeconds()).to.equal(vestingConfig.cliffSeconds);
  });

  it("deploys HokusaiToken with the correct controller, initial supply, and params reference", async function () {
    const initialSupply = parseEther("42000");
    const { tokenAddress, paramsAddress } = await deployAndExtract({
      name: "Launch Token",
      symbol: "LNCH",
      initialSupply,
    });

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    expect(await token.controller()).to.equal(controller.address);
    expect(await token.params()).to.equal(paramsAddress);
    expect(await token.totalSupply()).to.equal(initialSupply);
    expect(await token.balanceOf(controller.address)).to.equal(initialSupply);
  });

  it("returns non-zero deployed token and params addresses", async function () {
    const { tokenAddress, paramsAddress } = await deployAndExtract();

    expect(tokenAddress).to.not.equal(ZeroAddress);
    expect(paramsAddress).to.not.equal(ZeroAddress);
    expect(await ethers.provider.getCode(tokenAddress)).to.not.equal("0x");
    expect(await ethers.provider.getCode(paramsAddress)).to.not.equal("0x");
  });

  it("reverts when controller is the zero address", async function () {
    await expect(
      factory.deployTokenAndParams(
        "Factory Token",
        "FACT",
        ZeroAddress,
        parseEther("1000"),
        0,
        0,
        0,
        ZeroAddress,
        buildInitialParams(governor.address)
      )
    ).to.be.revertedWithCustomError(factory, "ZeroAddress").withArgs("controller");
  });

  it("uses default vesting values when passed the zeroed sentinel config", async function () {
    const { paramsAddress } = await deployAndExtract({
      initialParamsOverrides: {
        vestingConfig: {
          enabled: false,
          immediateUnlockBps: 0,
          vestingDurationSeconds: 0,
          cliffSeconds: 0,
        },
      },
    });

    const params = await ethers.getContractAt("HokusaiParams", paramsAddress);

    expect(await params.vestingEnabled()).to.equal(true);
    expect(await params.immediateUnlockBps()).to.equal(1000);
    expect(await params.vestingDurationSeconds()).to.equal(365 * 24 * 60 * 60);
    expect(await params.cliffSeconds()).to.equal(0);
  });
});
