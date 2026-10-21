const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");

// HOK-3270: graduation to bonding-curve pricing is permanent. Once hasGraduated
// is set, getBuyQuote/getSellQuote/spotPrice must keep using the curve even after
// sells take reserves back below FLAT_CURVE_THRESHOLD.
describe("HokusaiAMM permanent graduation pricing", function () {
  const MODEL_ID = "graduation-model";
  const CRR = 200000n; // 20%
  const PPM = 1000000n;
  const IBR_DURATION = 0;
  const THRESHOLD = parseUnits("25000", 6);
  const FLAT_PRICE = parseUnits("0.01", 6);
  const DEADLINE = 9999999999n;

  let owner, treasury, buyer, seller;

  before(async function () {
    [owner, treasury, buyer, seller] = await ethers.getSigners();
  });

  // lockAllInManager: register the TokenManager itself as the vesting vault so
  // its initial-supply balance (and anything sent to it) is excluded from the
  // redeemable supply.
  async function deployFixture({ tradeFee = 0, lockAllInManager = false } = {}) {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    if (lockAllInManager) await tokenManager.setVestingVault(await tokenManager.getAddress());

    await deployTestToken(tokenManager, MODEL_ID, "Graduation Token", "GRAD", parseEther("1"), owner.address);
    const token = await ethers.getContractAt("HokusaiToken", await tokenManager.getTokenAddress(MODEL_ID));

    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await usdc.getAddress(),
      await token.getAddress(),
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      CRR,
      tradeFee,
      IBR_DURATION,
      THRESHOLD,
      FLAT_PRICE
    );
    await tokenManager.authorizeAMM(await amm.getAddress());

    const math = await (await ethers.getContractFactory("BondingCurveMathTestHarness")).deploy();

    const ammAddress = await amm.getAddress();
    for (const signer of [owner, buyer, seller]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
      await usdc.connect(signer).approve(ammAddress, ethers.MaxUint256);
      await token.connect(signer).approve(ammAddress, ethers.MaxUint256);
    }

    return { tokenManager, token, usdc, amm, math, tradeFee: BigInt(tradeFee) };
  }

  const afterFee = (amount, tradeFee) => amount - (amount * tradeFee) / 10000n;
  const flatTokens = (reserveIn, tradeFee) => (afterFee(reserveIn, tradeFee) * 10n ** 18n) / FLAT_PRICE;

  async function state(ctx) {
    return {
      reserve: await ctx.amm.reserveBalance(),
      supply: await ctx.tokenManager.getRedeemableSupply(MODEL_ID),
    };
  }

  async function expectedCurveBuy(ctx, reserveIn) {
    const { reserve, supply } = await state(ctx);
    return ctx.math.testCalculateBuy(supply, reserve, afterFee(reserveIn, ctx.tradeFee), CRR);
  }

  async function expectedCurveSell(ctx, tokensIn) {
    const { reserve, supply } = await state(ctx);
    return ctx.math.testCalculateSell(supply, reserve, tokensIn, CRR);
  }

  async function expectedCurveSpot(ctx) {
    const { reserve, supply } = await state(ctx);
    return (reserve * PPM * 10n ** 18n) / (CRR * supply);
  }

  // Graduate with an exact-threshold buy, then sell on the curve until reserves
  // are below the threshold.
  async function graduateAndDipBelow(ctx) {
    // Smallest gross buy whose after-fee amount reaches the threshold.
    const gross = (THRESHOLD * 10000n + 9999n - ctx.tradeFee) / (10000n - ctx.tradeFee);
    await ctx.amm.connect(seller).buy(gross, 0, seller.address, DEADLINE);
    expect(await ctx.amm.hasGraduated()).to.equal(true);
    await ctx.amm.connect(seller).sell(parseEther("20000"), 0, seller.address, DEADLINE);
    expect(await ctx.amm.reserveBalance()).to.be.lt(THRESHOLD);
  }

  async function expectCurvePricing(ctx) {
    const buyIn = parseUnits("500", 6);
    const sellIn = parseEther("10000");
    expect(await ctx.amm.getBuyQuote(buyIn)).to.equal(await expectedCurveBuy(ctx, buyIn));
    expect(await ctx.amm.getSellQuote(sellIn)).to.equal(await expectedCurveSell(ctx, sellIn));
    expect(await ctx.amm.spotPrice()).to.equal(await expectedCurveSpot(ctx));
    expect(await ctx.amm.spotPrice()).to.not.equal(FLAT_PRICE);
  }

  describe("before graduation", function () {
    it("keeps flat buy, sell, and spot pricing", async function () {
      const ctx = await deployFixture();
      const buyIn = parseUnits("10000", 6);

      expect(await ctx.amm.getBuyQuote(buyIn)).to.equal(flatTokens(buyIn, 0n));
      expect(await ctx.amm.spotPrice()).to.equal(FLAT_PRICE);

      await ctx.amm.connect(buyer).buy(buyIn, 0, buyer.address, DEADLINE);
      expect(await ctx.token.balanceOf(buyer.address)).to.equal(flatTokens(buyIn, 0n));
      expect(await ctx.amm.hasGraduated()).to.equal(false);

      const sellIn = parseEther("1000");
      expect(await ctx.amm.getSellQuote(sellIn)).to.equal((sellIn * FLAT_PRICE) / 10n ** 18n);
      expect(await ctx.amm.spotPrice()).to.equal(FLAT_PRICE);
    });

    it("treats a buy landing exactly on the threshold as flat, then graduates", async function () {
      const ctx = await deployFixture();
      expect(await ctx.amm.getBuyQuote(THRESHOLD)).to.equal(flatTokens(THRESHOLD, 0n));

      await expect(ctx.amm.connect(buyer).buy(THRESHOLD, 0, buyer.address, DEADLINE))
        .to.emit(ctx.amm, "PhaseTransition");
      expect(await ctx.amm.hasGraduated()).to.equal(true);
      expect(await ctx.amm.getCurrentPhase()).to.equal(1);
      expect(await ctx.amm.spotPrice()).to.equal(await expectedCurveSpot(ctx));
    });

    it("keeps hybrid pricing for the initial threshold-crossing buy", async function () {
      const ctx = await deployFixture();
      const buyIn = parseUnits("30000", 6);
      const flatPortion = THRESHOLD;
      const tokensFromFlat = flatTokens(flatPortion, 0n);
      const { supply } = await state(ctx);
      const tokensFromCurve = await ctx.math.testCalculateBuy(
        supply + tokensFromFlat, THRESHOLD, buyIn - flatPortion, CRR
      );

      expect(await ctx.amm.getBuyQuote(buyIn)).to.equal(tokensFromFlat + tokensFromCurve);
      await ctx.amm.connect(buyer).buy(buyIn, 0, buyer.address, DEADLINE);
      expect(await ctx.amm.hasGraduated()).to.equal(true);
    });
  });

  describe("after graduation, below the threshold", function () {
    it("keeps the BONDING_CURVE phase and curve pricing on all three functions", async function () {
      const ctx = await deployFixture();
      await graduateAndDipBelow(ctx);

      expect(await ctx.amm.hasGraduated()).to.equal(true);
      expect(await ctx.amm.getCurrentPhase()).to.equal(1);
      await expectCurvePricing(ctx);
    });

    it("prices a buy that stays below the threshold on the curve and executes at the quote", async function () {
      const ctx = await deployFixture();
      await graduateAndDipBelow(ctx);

      const buyIn = parseUnits("500", 6);
      const before = await state(ctx);
      expect(before.reserve + buyIn).to.be.lt(THRESHOLD);

      const quote = await ctx.amm.getBuyQuote(buyIn);
      expect(quote).to.equal(await expectedCurveBuy(ctx, buyIn));
      expect(quote).to.be.lt(flatTokens(buyIn, 0n));

      await ctx.amm.connect(buyer).buy(buyIn, quote, buyer.address, DEADLINE);
      const after = await state(ctx);
      expect(await ctx.token.balanceOf(buyer.address)).to.equal(quote);
      expect(after.reserve).to.equal(before.reserve + buyIn);
      expect(after.supply).to.equal(before.supply + quote);
    });

    it("prices a buy crossing back above the threshold with no flat portion", async function () {
      const ctx = await deployFixture();
      await graduateAndDipBelow(ctx);

      const { reserve } = await state(ctx);
      const buyIn = THRESHOLD - reserve + parseUnits("1000", 6);
      expect(buyIn).to.be.lte((reserve * 2000n) / 10000n);

      const quote = await ctx.amm.getBuyQuote(buyIn);
      expect(quote).to.equal(await expectedCurveBuy(ctx, buyIn));

      await expect(ctx.amm.connect(buyer).buy(buyIn, quote, buyer.address, DEADLINE))
        .to.not.emit(ctx.amm, "PhaseTransition");
      expect(await ctx.token.balanceOf(buyer.address)).to.equal(quote);
      expect(await ctx.amm.reserveBalance()).to.be.gt(THRESHOLD);
    });

    it("executes a below-threshold sell at the curve quote", async function () {
      const ctx = await deployFixture();
      await graduateAndDipBelow(ctx);

      const sellIn = parseEther("50000");
      const before = await state(ctx);
      const usdcBefore = await ctx.usdc.balanceOf(seller.address);

      const quote = await ctx.amm.getSellQuote(sellIn);
      expect(quote).to.equal(await expectedCurveSell(ctx, sellIn));
      expect(quote).to.be.gt((sellIn * FLAT_PRICE) / 10n ** 18n);

      await ctx.amm.connect(seller).sell(sellIn, quote, seller.address, DEADLINE);
      const after = await state(ctx);
      expect(await ctx.usdc.balanceOf(seller.address)).to.equal(usdcBefore + quote);
      expect(after.reserve).to.equal(before.reserve - quote);
      expect(after.supply).to.equal(before.supply - sellIn);
    });

    it("never restores flat pricing across repeated threshold crossings", async function () {
      const ctx = await deployFixture();
      await graduateAndDipBelow(ctx);

      for (let i = 0; i < 3; i++) {
        const { reserve } = await state(ctx);
        const buyIn = THRESHOLD - reserve + parseUnits("500", 6);
        await expect(ctx.amm.connect(buyer).buy(buyIn, 0, buyer.address, DEADLINE))
          .to.not.emit(ctx.amm, "PhaseTransition");
        expect(await ctx.amm.reserveBalance()).to.be.gte(THRESHOLD);
        await expectCurvePricing(ctx);

        while ((await ctx.amm.reserveBalance()) >= THRESHOLD) {
          await expect(ctx.amm.connect(buyer).sell(parseEther("20000"), 0, buyer.address, DEADLINE))
            .to.not.emit(ctx.amm, "PhaseTransition");
        }
        expect(await ctx.amm.getCurrentPhase()).to.equal(1);
        await expectCurvePricing(ctx);
      }
    });

    it("keeps the trade-size limit and fee handling", async function () {
      const ctx = await deployFixture({ tradeFee: 30 });
      await graduateAndDipBelow(ctx);
      await expectCurvePricing(ctx);

      const tooBig = (await ctx.amm.maxTradeSize()) + 1n;
      await expect(ctx.amm.connect(buyer).buy(tooBig, 0, buyer.address, DEADLINE))
        .to.be.revertedWith("Trade exceeds max size limit");

      const buyIn = parseUnits("1000", 6);
      const quote = await ctx.amm.getBuyQuote(buyIn);
      const treasuryBefore = await ctx.usdc.balanceOf(treasury.address);
      await ctx.amm.connect(buyer).buy(buyIn, quote, buyer.address, DEADLINE);
      expect(await ctx.usdc.balanceOf(treasury.address)).to.equal(treasuryBefore + buyIn * 30n / 10000n);
      expect(await ctx.token.balanceOf(buyer.address)).to.equal(quote);
    });
  });

  describe("graduation via depositFees", function () {
    it("is permanent in the same way", async function () {
      const ctx = await deployFixture();
      await ctx.amm.connect(seller).buy(parseUnits("20000", 6), 0, seller.address, DEADLINE);
      expect(await ctx.amm.hasGraduated()).to.equal(false);

      await ctx.amm.connect(owner).depositFees(parseUnits("5000", 6));
      expect(await ctx.amm.hasGraduated()).to.equal(true);

      await ctx.amm.connect(seller).sell(parseEther("20000"), 0, seller.address, DEADLINE);
      expect(await ctx.amm.reserveBalance()).to.be.lt(THRESHOLD);
      expect(await ctx.amm.getCurrentPhase()).to.equal(1);
      await expectCurvePricing(ctx);
    });
  });

  describe("graduated degenerate state", function () {
    it("prices only the zero-supply bootstrap at the launch price, then returns to the curve", async function () {
      const ctx = await deployFixture({ lockAllInManager: true });
      await graduateAndDipBelow(ctx);

      // Lock every outstanding token so the redeemable supply is zero.
      for (const holder of [owner, seller]) {
        const balance = await ctx.token.balanceOf(holder.address);
        if (balance > 0n) await ctx.token.connect(holder).transfer(await ctx.tokenManager.getAddress(), balance);
      }
      expect(await ctx.tokenManager.getRedeemableSupply(MODEL_ID)).to.equal(0n);
      expect(await ctx.amm.reserveBalance()).to.be.gt(0n);

      // No curve price exists without supply: explicit launch-price bootstrap,
      // nothing to sell against, no division by zero.
      const buyIn = parseUnits("100", 6);
      expect(await ctx.amm.getBuyQuote(buyIn)).to.equal(flatTokens(buyIn, 0n));
      expect(await ctx.amm.getSellQuote(parseEther("1"))).to.equal(0n);
      expect(await ctx.amm.spotPrice()).to.equal(FLAT_PRICE);

      await ctx.amm.connect(buyer).buy(buyIn, 0, buyer.address, DEADLINE);
      expect(await ctx.token.balanceOf(buyer.address)).to.equal(flatTokens(buyIn, 0n));

      // As soon as any redeemable supply exists, pricing is the curve again.
      await expectCurvePricing(ctx);
    });
  });
});
