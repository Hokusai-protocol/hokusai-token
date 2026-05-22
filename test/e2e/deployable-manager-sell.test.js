const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");
const {
  buildDisabledVestingConfig,
  buildInitialParams,
  buildVestingConfig,
} = require("../helpers/tokenDeployment");

describe("DeployableTokenManager sell path", function () {
  const INITIAL_RESERVE = parseUnits("100000", 6);
  const BUYER_USDC = parseUnits("10000", 6);
  const CRR = 100000;
  const TRADE_FEE_BPS = 30n;
  const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6);
  const FLAT_CURVE_PRICE = parseUnits("1", 6);
  const MODEL_SUPPLIER_ALLOCATION = parseEther("250");
  const INVESTOR_ALLOCATION = parseEther("5000");

  let owner;
  let trader;
  let contributor;
  let treasury;
  let outsider;

  function calculateFee(amount) {
    return (amount * TRADE_FEE_BPS) / 10000n;
  }

  async function deployStack({
    modelId,
    tokenMode,
    vestingConfig = buildDisabledVestingConfig(),
    ibrDuration = 0,
    flatCurveThreshold = FLAT_CURVE_THRESHOLD,
    flatCurvePrice = FLAT_CURVE_PRICE,
  }) {
    const [modelRegistry, tokenDeploymentFactory, usdc] = await Promise.all([
      ethers.deployContract("ModelRegistry"),
      ethers.deployContract("TokenDeploymentFactory"),
      ethers.deployContract("MockUSDC"),
    ]);

    await Promise.all([
      modelRegistry.waitForDeployment(),
      tokenDeploymentFactory.waitForDeployment(),
      usdc.waitForDeployment(),
    ]);

    const tokenManager = await ethers.deployContract("DeployableTokenManager", [
      await modelRegistry.getAddress(),
      await tokenDeploymentFactory.getAddress(),
    ]);
    await tokenManager.waitForDeployment();

    const vestingVault = await ethers.deployContract("RewardVestingVault", [
      await tokenManager.getAddress(),
    ]);
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());
    await tokenManager.setDeltaVerifier(owner.address);

    if (tokenMode === "cap") {
      await tokenManager.deployTokenWithAllocations(
        modelId,
        "Cap Token",
        "CAP",
        MODEL_SUPPLIER_ALLOCATION,
        owner.address,
        INVESTOR_ALLOCATION,
        buildInitialParams(owner.address, { vestingConfig })
      );
    } else {
      await tokenManager.deployTokenWithParams(
        modelId,
        "Legacy Token",
        "LEG",
        parseEther("1000000"),
        buildInitialParams(owner.address, { vestingConfig })
      );
    }

    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const amm = await ethers.deployContract("HokusaiAMM", [
      await usdc.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      modelId,
      treasury.address,
      CRR,
      TRADE_FEE_BPS,
      ibrDuration,
      flatCurveThreshold,
      flatCurvePrice,
    ]);
    await amm.waitForDeployment();

    await tokenManager.authorizeAMM(await amm.getAddress());
    await amm.setMaxTradeBps(5000);

    await usdc.mint(owner.address, INITIAL_RESERVE);
    await usdc.approve(await amm.getAddress(), INITIAL_RESERVE);
    await amm.depositFees(INITIAL_RESERVE);

    for (const account of [trader, contributor, outsider]) {
      await usdc.mint(account.address, BUYER_USDC);
      await usdc.connect(account).approve(await amm.getAddress(), BUYER_USDC);
    }

    return { tokenManager, vestingVault, token, usdc, amm };
  }

  async function buyTokens({ amm, usdc, token, buyer, reserveIn }) {
    const deadline = (await time.latest()) + 3600;
    const tokensOut = await amm.getBuyQuote(reserveIn);
    const buyTx = await amm.connect(buyer).buy(reserveIn, tokensOut, buyer.address, deadline);
    await buyTx.wait();

    return {
      buyTx,
      tokensOut,
      balance: await token.balanceOf(buyer.address),
      usdcBalance: await usdc.balanceOf(buyer.address),
    };
  }

  beforeEach(async function () {
    [owner, trader, contributor, treasury, outsider] = await ethers.getSigners();
  });

  it("supports post-IBR AMM sells for cap-based tokens via DeployableTokenManager", async function () {
    const modelId = "deployable-cap-ibr";
    const { tokenManager, token, usdc, amm } = await deployStack({
      modelId,
      tokenMode: "cap",
      ibrDuration: 3600,
    });

    const reserveIn = parseUnits("1000", 6);
    const { tokensOut } = await buyTokens({ amm, usdc, token, buyer: trader, reserveIn });
    const tokensToSell = tokensOut / 100n;

    await token.connect(trader).approve(await amm.getAddress(), tokensOut);
    await expect(
      amm.connect(trader).sell(tokensToSell, 0, trader.address, (await time.latest()) + 3600)
    ).to.be.revertedWith("Sells not enabled during IBR");

    await time.increase(3601);

    const reserveOut = await amm.getSellQuote(tokensToSell);
    const feeAmount = calculateFee(reserveOut);
    const reserveAfterFee = reserveOut - feeAmount;
    const reserveBeforeSell = await amm.reserveBalance();
    const supplyBeforeSell = await token.totalSupply();
    const investorMintedBeforeSell = await token.investorMinted();
    const traderUsdcBeforeSell = await usdc.balanceOf(trader.address);
    const treasuryUsdcBeforeSell = await usdc.balanceOf(treasury.address);

    await expect(
      amm.connect(trader).sell(tokensToSell, 0, trader.address, (await time.latest()) + 3600)
    )
      .to.emit(tokenManager, "TokensBurned")
      .withArgs(modelId, await amm.getAddress(), tokensToSell)
      .and.to.emit(amm, "Sell")
      .withArgs(trader.address, tokensToSell, reserveOut, feeAmount, anyValue);

    expect(await token.totalSupply()).to.equal(supplyBeforeSell - tokensToSell);
    expect(await token.investorMinted()).to.equal(investorMintedBeforeSell - tokensToSell);
    expect(await amm.reserveBalance()).to.equal(reserveBeforeSell - reserveOut);
    expect(await usdc.balanceOf(trader.address)).to.equal(traderUsdcBeforeSell + reserveAfterFee);
    expect(await usdc.balanceOf(treasury.address)).to.equal(treasuryUsdcBeforeSell + feeAmount);
  });

  it("supports AMM sells for legacy-mode tokens via the burnFrom branch", async function () {
    const modelId = "deployable-legacy-sell";
    const { tokenManager, token, usdc, amm } = await deployStack({
      modelId,
      tokenMode: "legacy",
    });

    const reserveIn = parseUnits("750", 6);
    const { tokensOut } = await buyTokens({ amm, usdc, token, buyer: trader, reserveIn });

    const reserveOut = await amm.getSellQuote(tokensOut);
    const reserveBeforeSell = await amm.reserveBalance();
    const supplyBeforeSell = await token.totalSupply();
    const traderUsdcBeforeSell = await usdc.balanceOf(trader.address);

    await token.connect(trader).approve(await amm.getAddress(), tokensOut);

    await expect(
      amm.connect(trader).sell(tokensOut, 0, trader.address, (await time.latest()) + 3600)
    )
      .to.emit(tokenManager, "TokensBurned")
      .withArgs(modelId, await amm.getAddress(), tokensOut)
      .and.to.emit(amm, "Sell")
      .withArgs(trader.address, tokensOut, reserveOut, calculateFee(reserveOut), anyValue);

    expect(await token.totalSupply()).to.equal(supplyBeforeSell - tokensOut);
    expect(await amm.reserveBalance()).to.equal(reserveBeforeSell - reserveOut);
    expect(await usdc.balanceOf(trader.address)).to.be.gt(traderUsdcBeforeSell);
  });

  it("enforces burnAMMTokens authorization and validation in DeployableTokenManager", async function () {
    const modelId = "deployable-burn-auth";
    const { tokenManager, token } = await deployStack({
      modelId,
      tokenMode: "cap",
    });
    const burnAmount = parseEther("25");

    await tokenManager.mintTokens(modelId, owner.address, burnAmount);

    await expect(tokenManager.burnAMMTokens(modelId, owner.address, burnAmount))
      .to.emit(tokenManager, "TokensBurned")
      .withArgs(modelId, owner.address, burnAmount);

    expect(await token.balanceOf(owner.address)).to.equal(0);

    await expect(
      tokenManager.connect(outsider).burnAMMTokens(modelId, owner.address, 1)
    ).to.be.revertedWith("Caller is not authorized to burn");

    await expect(
      tokenManager.burnAMMTokens("", owner.address, 1)
    ).to.be.revertedWithCustomError(tokenManager, "EmptyString").withArgs("model ID");
    await expect(
      tokenManager.burnAMMTokens(modelId, ZeroAddress, 1)
    ).to.be.revertedWithCustomError(tokenManager, "ZeroAddress").withArgs("account");
    await expect(
      tokenManager.burnAMMTokens(modelId, owner.address, 0)
    ).to.be.revertedWithCustomError(tokenManager, "InvalidAmount").withArgs("amount");
    await expect(
      tokenManager.burnAMMTokens("missing-model", owner.address, 1)
    ).to.be.revertedWith("Token not deployed for this model");
  });

  it("lets reward holders sell only the unlocked portion while vested rewards stay unsellable in the vault", async function () {
    const modelId = "deployable-reward-sell";
    const { tokenManager, vestingVault, token, usdc, amm } = await deployStack({
      modelId,
      tokenMode: "cap",
      vestingConfig: buildVestingConfig({
        immediateUnlockBps: 2500,
        vestingDurationSeconds: 30 * 24 * 60 * 60,
      }),
      flatCurveThreshold: parseUnits("200000", 6),
    });

    const rewardAmount = parseEther("100");
    const immediateAmount = parseEther("25");
    const vestedAmount = rewardAmount - immediateAmount;

    await tokenManager.mintReward(modelId, contributor.address, rewardAmount);

    expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);
    expect(await token.rewardMinted()).to.equal(rewardAmount);

    await token.connect(contributor).approve(await amm.getAddress(), rewardAmount);

    // The contributor cannot sell vested rewards because they are held by the vesting vault, not the user.
    await expect(
      amm.connect(contributor).sell(rewardAmount, 0, contributor.address, (await time.latest()) + 3600)
    ).to.be.reverted;

    const reserveOut = await amm.getSellQuote(immediateAmount);
    const rewardMintedBeforeSell = await token.rewardMinted();
    const contributorUsdcBeforeSell = await usdc.balanceOf(contributor.address);

    await expect(
      amm.connect(contributor).sell(immediateAmount, 0, contributor.address, (await time.latest()) + 3600)
    )
      .to.emit(tokenManager, "TokensBurned")
      .withArgs(modelId, await amm.getAddress(), immediateAmount)
      .and.to.emit(amm, "Sell")
      .withArgs(contributor.address, immediateAmount, reserveOut, calculateFee(reserveOut), anyValue);

    expect(await token.rewardMinted()).to.equal(rewardMintedBeforeSell - immediateAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);
    expect(await usdc.balanceOf(contributor.address)).to.be.gt(contributorUsdcBeforeSell);
  });

  it("allows supplier-allocation holders to sell distributed tokens through the AMM", async function () {
    const modelId = "deployable-supplier-sell";
    const { tokenManager, token, usdc, amm } = await deployStack({
      modelId,
      tokenMode: "cap",
    });

    await tokenManager.distributeModelSupplierAllocation(modelId);
    expect(await token.balanceOf(owner.address)).to.equal(MODEL_SUPPLIER_ALLOCATION);

    const sellAmount = parseEther("10");
    const reserveOut = await amm.getSellQuote(sellAmount);
    const reserveBeforeSell = await amm.reserveBalance();
    const totalSupplyBeforeSell = await token.totalSupply();
    const investorMintedBeforeSell = await token.investorMinted();
    const rewardMintedBeforeSell = await token.rewardMinted();
    const ownerUsdcBeforeSell = await usdc.balanceOf(owner.address);

    await token.connect(owner).approve(await amm.getAddress(), sellAmount);

    await expect(
      amm.connect(owner).sell(sellAmount, 0, owner.address, (await time.latest()) + 3600)
    )
      .to.emit(tokenManager, "TokensBurned")
      .withArgs(modelId, await amm.getAddress(), sellAmount)
      .and.to.emit(amm, "Sell")
      .withArgs(owner.address, sellAmount, reserveOut, calculateFee(reserveOut), anyValue);

    expect(await token.balanceOf(owner.address)).to.equal(MODEL_SUPPLIER_ALLOCATION - sellAmount);
    expect(await token.totalSupply()).to.equal(totalSupplyBeforeSell - sellAmount);
    expect(await token.investorMinted()).to.equal(investorMintedBeforeSell);
    expect(await token.rewardMinted()).to.equal(rewardMintedBeforeSell);
    expect(await amm.reserveBalance()).to.equal(reserveBeforeSell - reserveOut);
    expect(await usdc.balanceOf(owner.address)).to.be.gt(ownerUsdcBeforeSell);
  });
});
