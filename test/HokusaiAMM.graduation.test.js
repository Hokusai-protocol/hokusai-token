const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { deployAMMProxy, bindPool } = require("./helpers/ammDeployment");
const { poolCurveState } = require("./helpers/curveModel");

// HOK-3270: graduation to bonding-curve pricing is permanent. Once hasGraduated
// is set, getBuyQuote/getSellQuote/spotPrice must keep using the curve even after
// sells take reserves back below FLAT_CURVE_THRESHOLD. HOK-3317: the curve is
// anchored at the graduation supply (see curveModel below).
describe("HokusaiAMM permanent graduation pricing", function () {
  const MODEL_ID = "7206";
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
    const amm = await deployAMMProxy(HokusaiAMM,
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
    await bindPool(tokenManager, await amm.getAddress());

    const ammAddress = await amm.getAddress();
    for (const signer of [owner, buyer, seller]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
      await usdc.connect(signer).approve(ammAddress, ethers.MaxUint256);
      await token.connect(signer).approve(ammAddress, ethers.MaxUint256);
    }

    return { tokenManager, token, usdc, amm, tradeFee: BigInt(tradeFee) };
  }

  const afterFee = (amount, tradeFee) => amount - (amount * tradeFee) / 10000n;
  const flatTokens = (reserveIn, tradeFee) => (afterFee(reserveIn, tradeFee) * 10n ** 18n) / FLAT_PRICE;

  async function state(ctx) {
    return {
      reserve: await ctx.amm.reserveBalance(),
      supply: await ctx.tokenManager.getRedeemableSupply(MODEL_ID),
    };
  }

  // Reference model of the post-graduation curve (HokusaiAMM docs): reserve R
  // backs supply S along f(s) = s up to the anchor S_g and
  // S_g × ((1 - w) + w × (s/S_g)^(1/w)) above it. Floats, so compare with
  // closeTo(REL).
  const W = Number(CRR) / Number(PPM);
  const REL = 1e-9;
  const f = (s, sg) => (s <= sg ? s : sg * (1 - W + W * Math.pow(s / sg, 1 / W)));
  const fInv = (y, sg) => (y <= sg ? y : sg * Math.pow((y / sg - (1 - W)) / W, W));
  const slope = (s, sg) => (s <= sg ? 1 : Math.pow(s / sg, 1 / W - 1));
  const near = (x) => BigInt(Math.floor(Math.max(Math.abs(x) * REL, 2)));

  async function curveState(ctx) {
    return poolCurveState(ctx.amm, ctx.tokenManager, MODEL_ID);
  }

  async function expectedCurveBuy(ctx, reserveIn) {
    const { R, S, sg } = await curveState(ctx);
    const E = Number(afterFee(reserveIn, ctx.tradeFee));
    return fInv((f(S, sg) * (R + E)) / R, sg) - S;
  }

  async function expectedCurveSell(ctx, tokensIn) {
    const { R, S, sg } = await curveState(ctx);
    const T = Number(tokensIn);
    return (R * (f(S, sg) - f(S - T, sg))) / f(S, sg);
  }

  async function expectedCurveSpot(ctx) {
    const { R, S, sg } = await curveState(ctx);
    return (R * slope(S, sg) * 1e18) / f(S, sg);
  }

  const expectNear = (actual, expected) => expect(actual).to.be.closeTo(BigInt(Math.round(expected)), near(expected));

  // Graduate with an exact-threshold buy, then sell on the curve until reserves
  // are below the threshold.
  async function graduateAndDipBelow(ctx) {
    // Smallest gross buy whose after-fee amount reaches the threshold.
    const gross = (THRESHOLD * 10000n + 9999n - ctx.tradeFee) / (10000n - ctx.tradeFee);
    await ctx.amm.connect(seller).buy(gross, 0, seller.address, DEADLINE);
    expect(await ctx.amm.hasGraduated()).to.equal(true);
    await ctx.amm.connect(seller).sell(parseEther("400000"), 0, seller.address, DEADLINE);
    expect(await ctx.amm.reserveBalance()).to.be.lt(THRESHOLD);
  }

  async function expectCurvePricing(ctx) {
    const buyIn = parseUnits("500", 6);
    const sellIn = parseEther("10000");
    expectNear(await ctx.amm.getBuyQuote(buyIn), await expectedCurveBuy(ctx, buyIn));
    expectNear(await ctx.amm.getSellQuote(sellIn), await expectedCurveSell(ctx, sellIn));
    expectNear(await ctx.amm.spotPrice(), await expectedCurveSpot(ctx));
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
      // Continuous: the curve starts at the flat price (the one unbacked
      // initial-supply token shifts it by under one unit).
      expectNear(await ctx.amm.spotPrice(), await expectedCurveSpot(ctx));
      expect(await ctx.amm.spotPrice()).to.be.closeTo(FLAT_PRICE, 1n);
    });

    it("keeps hybrid pricing for the initial threshold-crossing buy", async function () {
      const ctx = await deployFixture();
      const buyIn = parseUnits("30000", 6);
      const flatPortion = THRESHOLD;
      const tokensFromFlat = flatTokens(flatPortion, 0n);
      const { supply } = await state(ctx);
      // Curve part starts at the crossing point: anchor S_g, reserve = threshold.
      const sg = Number(supply + tokensFromFlat);
      const tokensFromCurve =
        fInv((sg * Number(THRESHOLD + buyIn - flatPortion)) / Number(THRESHOLD), sg) - sg;

      expectNear(await ctx.amm.getBuyQuote(buyIn), Number(tokensFromFlat) + tokensFromCurve);
      await ctx.amm.connect(buyer).buy(buyIn, 0, buyer.address, DEADLINE);
      expect(await ctx.amm.hasGraduated()).to.equal(true);
      expect(await ctx.amm.graduationSupply()).to.equal(supply + tokensFromFlat);
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
      expectNear(quote, await expectedCurveBuy(ctx, buyIn));
      // Below the anchor the price is reserve per token, i.e. the flat price
      // here up to the one unbacked initial-supply token.
      expect(quote).to.be.closeTo(flatTokens(buyIn, 0n), flatTokens(buyIn, 0n) / 1000000n);

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
      expect(buyIn).to.be.lte(await ctx.amm.maxTradeSize());

      const quote = await ctx.amm.getBuyQuote(buyIn);
      expectNear(quote, await expectedCurveBuy(ctx, buyIn));

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
      expectNear(quote, await expectedCurveSell(ctx, sellIn));
      const flatQuote = (sellIn * FLAT_PRICE) / 10n ** 18n;
      expect(quote).to.be.closeTo(flatQuote, flatQuote / 1000000n);

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
          await expect(ctx.amm.connect(buyer).sell(parseEther("200000"), 0, buyer.address, DEADLINE))
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

      expect(await ctx.amm.graduationSupply()).to.equal(await ctx.tokenManager.getRedeemableSupply(MODEL_ID));

      await ctx.amm.connect(seller).sell(parseEther("200000"), 0, seller.address, DEADLINE);
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
