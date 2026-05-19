const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits } = require("ethers");
const {
  buildDisabledVestingConfig,
  buildInitialParams,
  buildVestingConfig,
} = require("./helpers/tokenDeployment");

describe("HokusaiAMM redeemable supply pricing", function () {
  let owner;
  let buyer;
  let contributor;
  let treasury;

  const CRR = 100000;
  const TRADE_FEE = 0;
  const IBR_DURATION = 0;
  const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6);
  const FLAT_CURVE_PRICE = parseUnits("1", 6);

  async function deployLegacyCurveFixture(vestingConfig) {
    const MODEL_ID = "redeemable-legacy";
    const INITIAL_SUPPLY = parseEther("1000000");
    const INITIAL_RESERVE = parseUnits("100000", 6);

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    const vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    await tokenManager.deployTokenWithParams(
      MODEL_ID,
      "Redeemable Legacy Token",
      "RLT",
      INITIAL_SUPPLY,
      buildInitialParams(owner.address, { vestingConfig })
    );

    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await usdc.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      CRR,
      TRADE_FEE,
      IBR_DURATION,
      FLAT_CURVE_THRESHOLD,
      FLAT_CURVE_PRICE
    );
    await amm.waitForDeployment();

    await tokenManager.authorizeAMM(await amm.getAddress());
    await amm.setMaxTradeBps(5000);

    await usdc.mint(owner.address, INITIAL_RESERVE);
    await usdc.approve(await amm.getAddress(), INITIAL_RESERVE);
    await amm.depositFees(INITIAL_RESERVE);

    await usdc.mint(buyer.address, parseUnits("100000", 6));
    await usdc.connect(buyer).approve(await amm.getAddress(), parseUnits("100000", 6));

    return { MODEL_ID, tokenManager, vestingVault, token, usdc, amm };
  }

  async function deployCapCurveFixture() {
    const MODEL_ID = "redeemable-cap";
    const SUPPLIER_ALLOCATION = parseEther("250");
    const INVESTOR_ALLOCATION = parseEther("5000");

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    const vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    await tokenManager.deployTokenWithAllocations(
      MODEL_ID,
      "Redeemable Cap Token",
      "RCT",
      SUPPLIER_ALLOCATION,
      owner.address,
      INVESTOR_ALLOCATION,
      buildInitialParams(owner.address, {
        vestingConfig: buildDisabledVestingConfig(),
      })
    );

    const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await usdc.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      CRR,
      TRADE_FEE,
      IBR_DURATION,
      FLAT_CURVE_THRESHOLD,
      FLAT_CURVE_PRICE
    );
    await amm.waitForDeployment();

    await tokenManager.authorizeAMM(await amm.getAddress());
    await amm.setMaxTradeBps(5000);

    await usdc.mint(buyer.address, parseUnits("5000", 6));
    await usdc.connect(buyer).approve(await amm.getAddress(), parseUnits("5000", 6));

    return { MODEL_ID, SUPPLIER_ALLOCATION, tokenManager, token, usdc, amm };
  }

  beforeEach(async function () {
    [owner, buyer, contributor, treasury] = await ethers.getSigners();
  });

  it("keeps spot price and quotes stable across locked reward emissions", async function () {
    const { MODEL_ID, tokenManager, vestingVault, token, amm } = await deployLegacyCurveFixture(
      buildVestingConfig({ immediateUnlockBps: 0, vestingDurationSeconds: 30 * 24 * 60 * 60 })
    );

    const buyQuoteBefore = await amm.getBuyQuote(parseUnits("500", 6));
    const sellQuoteBefore = await amm.getSellQuote(parseEther("100"));
    const spotBefore = await amm.spotPrice();
    const [, curveSupplyBefore] = await amm.getReserves();
    const totalSupplyBefore = await token.totalSupply();

    const rewardAmount = parseEther("250000");
    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(rewardAmount);
    expect(await token.totalSupply()).to.equal(totalSupplyBefore + rewardAmount);
    expect(await tokenManager.getRedeemableSupply(MODEL_ID)).to.equal(curveSupplyBefore);
    expect(await amm.spotPrice()).to.equal(spotBefore);
    expect(await amm.getBuyQuote(parseUnits("500", 6))).to.equal(buyQuoteBefore);
    expect(await amm.getSellQuote(parseEther("100"))).to.equal(sellQuoteBefore);

    const [, curveSupplyAfter] = await amm.getReserves();
    expect(curveSupplyAfter).to.equal(curveSupplyBefore);
  });

  it("moves bonding curve pricing by only the immediate reward portion", async function () {
    const { MODEL_ID, tokenManager, vestingVault, token, amm } = await deployLegacyCurveFixture(
      buildVestingConfig({ immediateUnlockBps: 2500, vestingDurationSeconds: 30 * 24 * 60 * 60 })
    );

    const rewardAmount = parseEther("1000");
    const immediateAmount = parseEther("250");
    const vestedAmount = rewardAmount - immediateAmount;
    const reserve = await amm.reserveBalance();
    const supplyBefore = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotBefore = await amm.spotPrice();

    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    const supplyAfter = await tokenManager.getRedeemableSupply(MODEL_ID);
    const expectedSpot = (reserve * 1000000n * 10n ** 18n) / (BigInt(CRR) * supplyAfter);

    expect(await token.balanceOf(contributor.address)).to.equal(immediateAmount);
    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(vestedAmount);
    expect(supplyAfter).to.equal(supplyBefore + immediateAmount);
    expect(await amm.spotPrice()).to.equal(expectedSpot);
    expect(await amm.spotPrice()).to.be.lt(spotBefore);
  });

  it("adds vested rewards into curve supply when claimed", async function () {
    const duration = 30 * 24 * 60 * 60;
    const { MODEL_ID, tokenManager, vestingVault, token, amm } = await deployLegacyCurveFixture(
      buildVestingConfig({ immediateUnlockBps: 1000, vestingDurationSeconds: duration })
    );

    const rewardAmount = parseEther("1000");
    const immediateAmount = parseEther("100");
    const vestedAmount = rewardAmount - immediateAmount;

    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    const supplyAfterMint = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotAfterMint = await amm.spotPrice();
    const sellQuoteBeforeClaim = await amm.getSellQuote(parseEther("100"));

    await time.increase(duration);
    await vestingVault.connect(contributor).claim(0);

    const supplyAfterClaim = await tokenManager.getRedeemableSupply(MODEL_ID);
    const sellQuoteAfterClaim = await amm.getSellQuote(parseEther("100"));

    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(0);
    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount);
    expect(supplyAfterClaim).to.equal(supplyAfterMint + vestedAmount);
    expect(await amm.spotPrice()).to.be.lt(spotAfterMint);
    expect(sellQuoteAfterClaim).to.be.lt(sellQuoteBeforeClaim);
  });

  it("updates redeemable curve supply on AMM buys and sells", async function () {
    const { MODEL_ID, tokenManager, token, amm } = await deployLegacyCurveFixture(
      buildDisabledVestingConfig()
    );

    const supplyBefore = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotBefore = await amm.spotPrice();
    const reserveIn = parseUnits("1000", 6);
    const tokensOut = await amm.getBuyQuote(reserveIn);

    await amm.connect(buyer).buy(reserveIn, tokensOut, buyer.address, (await time.latest()) + 3600);

    const supplyAfterBuy = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotAfterBuy = await amm.spotPrice();
    expect(supplyAfterBuy).to.equal(supplyBefore + tokensOut);
    expect(spotAfterBuy).to.be.gt(spotBefore);

    const tokensToSell = tokensOut / 2n;
    await token.connect(buyer).approve(await amm.getAddress(), tokensToSell);
    await amm.connect(buyer).sell(tokensToSell, 0, buyer.address, (await time.latest()) + 3600);

    const supplyAfterSell = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotAfterSell = await amm.spotPrice();
    expect(supplyAfterSell).to.equal(supplyAfterBuy - tokensToSell);
    expect(spotAfterSell).to.be.lt(spotAfterBuy);
  });

  it("allows reward token holders to sell unlocked tokens into the AMM", async function () {
    const { MODEL_ID, tokenManager, vestingVault, token, usdc, amm } =
      await deployLegacyCurveFixture(buildDisabledVestingConfig());

    const rewardAmount = parseEther("500");
    await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);

    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount);

    const sellAmount = parseEther("100");
    const minOut = 0n;
    await token.connect(contributor).approve(await amm.getAddress(), sellAmount);
    await expect(
      amm.connect(contributor).sell(sellAmount, minOut, contributor.address, (await time.latest()) + 3600)
    ).to.not.be.reverted;

    expect(await token.balanceOf(contributor.address)).to.equal(rewardAmount - sellAmount);
    expect(await usdc.balanceOf(contributor.address)).to.be.gt(0n);
  });

  it("drops spot price when supplier allocation becomes redeemable", async function () {
    const { MODEL_ID, SUPPLIER_ALLOCATION, tokenManager, amm } = await deployCapCurveFixture();

    await amm.connect(buyer).buy(
      parseUnits("1000", 6),
      parseEther("1000"),
      buyer.address,
      (await time.latest()) + 3600
    );

    const supplyBefore = await tokenManager.getRedeemableSupply(MODEL_ID);
    const spotBefore = await amm.spotPrice();

    await tokenManager.distributeModelSupplierAllocation(MODEL_ID);

    const supplyAfter = await tokenManager.getRedeemableSupply(MODEL_ID);
    expect(supplyAfter).to.equal(supplyBefore + SUPPLIER_ALLOCATION);
    expect(await amm.spotPrice()).to.be.lt(spotBefore);
  });

  it("remains stable across repeated large locked reward emissions", async function () {
    const { MODEL_ID, tokenManager, amm } = await deployLegacyCurveFixture(
      buildVestingConfig({ immediateUnlockBps: 0, vestingDurationSeconds: 30 * 24 * 60 * 60 })
    );

    const spotBefore = await amm.spotPrice();

    for (const rewardAmount of [parseEther("10000"), parseEther("25000"), parseEther("50000")]) {
      await tokenManager.mintReward(MODEL_ID, contributor.address, rewardAmount);
      expect(await amm.spotPrice()).to.equal(spotBefore);
    }
  });
});
