const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { deployAMMProxy, bindPool } = require("./helpers/ammDeployment");
const { curveModel, poolCurveState, near } = require("./helpers/curveModel");

// HOK-3317: after graduation the reserve backs the supply along one curve
// shape anchored at the graduation supply, so the price is continuous at
// graduation and fees count toward every holder's backing like purchases.
describe("HokusaiAMM continuous graduation (HOK-3317)", function () {
  const DEADLINE = 9999999999n;
  const THRESHOLD = parseUnits("25000", 6);
  const PRICE = parseUnits("0.01", 6);
  const CRR = 200000;

  async function deployPool({ tradeFee = 30, crr = CRR } = {}) {
    const [owner, treasury, alice, bob] = await ethers.getSigners();
    const modelId = "7317";
    const modelRegistry = await ethers.deployContract("ModelRegistry");
    const tokenManager = await ethers.deployContract("TokenManager", [await modelRegistry.getAddress()]);
    // Initial supply sits with TokenManager, which is the vesting vault here,
    // so redeemable supply starts at zero.
    await tokenManager.setVestingVault(await tokenManager.getAddress());
    await deployTestToken(tokenManager, modelId, "C", "C", parseEther("1"), owner.address);
    const token = await ethers.getContractAt("HokusaiToken", await tokenManager.getTokenAddress(modelId));
    const usdc = await ethers.deployContract("MockUSDC");
    const amm = await deployAMMProxy(
      await ethers.getContractFactory("HokusaiAMM"),
      await usdc.getAddress(),
      await token.getAddress(),
      await tokenManager.getAddress(),
      modelId,
      treasury.address,
      crr,
      tradeFee,
      0,
      THRESHOLD,
      PRICE
    );
    await bindPool(tokenManager, await amm.getAddress());
    for (const signer of [owner, alice, bob]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
      await usdc.connect(signer).approve(await amm.getAddress(), ethers.MaxUint256);
      await token.connect(signer).approve(await amm.getAddress(), ethers.MaxUint256);
    }
    return { amm, token, usdc, tokenManager, owner, alice, bob, modelId };
  }

  async function redeemable(ctx) {
    return ctx.tokenManager.getRedeemableSupply(ctx.modelId);
  }

  it("prices at exactly the flat price when a buy lands on the threshold", async function () {
    const ctx = await deployPool({ tradeFee: 0 });
    await ctx.amm.connect(ctx.alice).buy(THRESHOLD, 0, ctx.alice.address, DEADLINE);

    expect(await ctx.amm.hasGraduated()).to.equal(true);
    expect(await ctx.amm.graduationSupply()).to.equal(await redeemable(ctx));
    expect(await ctx.amm.spotPrice()).to.equal(PRICE);
  });

  it("anchors the curve at the crossing point of a graduating buy", async function () {
    const ctx = await deployPool();
    await ctx.amm.connect(ctx.alice).buy(parseUnits("20000", 6), 0, ctx.alice.address, DEADLINE);
    const supplyBefore = await redeemable(ctx);
    const reserveBefore = await ctx.amm.reserveBalance();

    const [quoted, , impactSpot] = await ctx.amm.calculateBuyImpact(parseUnits("10000", 6));
    await ctx.amm.connect(ctx.bob).buy(parseUnits("10000", 6), 0, ctx.bob.address, DEADLINE);

    const flatTokens = ((THRESHOLD - reserveBefore) * parseEther("1")) / PRICE;
    expect(await ctx.amm.graduationSupply()).to.equal(supplyBefore + flatTokens);
    expect(await ctx.token.balanceOf(ctx.bob.address)).to.equal(quoted);
    expect(await ctx.amm.spotPrice()).to.equal(impactSpot);
    // Above the anchor the price follows the CRR curve up from the flat price:
    // p × (1 + curvePortion / (w × threshold))^(1 - w).
    const model = curveModel(CRR);
    const net = Number(parseUnits("10000", 6) - (parseUnits("10000", 6) * 30n) / 10000n);
    const curvePortion = net - Number(THRESHOLD - reserveBefore);
    const expected = Number(PRICE) * Math.pow(1 + curvePortion / (model.w * Number(THRESHOLD)), 1 - model.w);
    expect(await ctx.amm.spotPrice()).to.be.closeTo(...near(expected, 1e-6));
    const { R, S, sg } = await poolCurveState(ctx.amm, ctx.tokenManager, ctx.modelId);
    expect(await ctx.amm.spotPrice()).to.be.closeTo(...near(model.spot(R, S, sg), 1e-9));
  });

  it("dilutes or concentrates every holder evenly when supply changes outside the pool", async function () {
    const ctx = await deployPool();
    await ctx.amm.connect(ctx.alice).buy(parseUnits("20000", 6), 0, ctx.alice.address, DEADLINE);
    await ctx.amm.connect(ctx.bob).buy(parseUnits("15000", 6), 0, ctx.bob.address, DEADLINE);
    const supplyBefore = await redeemable(ctx);
    const spotBefore = await ctx.amm.spotPrice();
    const anchorBefore = await ctx.amm.graduationSupply();
    expect(supplyBefore).to.be.gt(anchorBefore);

    // Sending tokens to the vault (here TokenManager) takes them out of the
    // redeemable supply without a pool trade. The anchor scales with the
    // supply, so the price rises evenly instead of the pool moving down the
    // curve (and an unlock or reward mint would dilute evenly).
    const moved = (await ctx.token.balanceOf(ctx.bob.address)) / 2n;
    await ctx.token.connect(ctx.bob).transfer(await ctx.tokenManager.getAddress(), moved);
    const supplyAfter = await redeemable(ctx);
    expect(supplyAfter).to.equal(supplyBefore - moved);

    expect(await ctx.amm.spotPrice()).to.be.closeTo((spotBefore * supplyBefore) / supplyAfter, 2n);
    const { R, S, sg } = await poolCurveState(ctx.amm, ctx.tokenManager, ctx.modelId);
    expect(sg / S).to.be.closeTo(Number(anchorBefore) / Number(supplyBefore), 1e-12);
    expect(await ctx.amm.getSellQuote(await redeemable(ctx))).to.be.closeTo(await ctx.amm.reserveBalance(), 1n);

    // The next trade records the rescaled anchor against the new supply.
    await ctx.amm.connect(ctx.alice).sell(parseEther("1000"), 0, ctx.alice.address, DEADLINE);
    expect(await ctx.amm.anchorBasisSupply()).to.equal(supplyAfter - parseEther("1000"));
    expect(await ctx.amm.graduationSupply()).to.equal((anchorBefore * supplyAfter) / supplyBefore);
    expect(R).to.be.gt(0);
  });

  it("counts fees deposited before graduation like purchases", async function () {
    const ctx = await deployPool();
    await ctx.amm.connect(ctx.alice).buy(parseUnits("10000", 6), 0, ctx.alice.address, DEADLINE);
    const reserve = await ctx.amm.reserveBalance();
    await ctx.amm.connect(ctx.owner).depositFees(THRESHOLD - reserve);

    expect(await ctx.amm.hasGraduated()).to.equal(true);
    expect(await ctx.amm.graduationSupply()).to.equal(await ctx.token.balanceOf(ctx.alice.address));
    // Alice holds the whole supply, so she can redeem the whole reserve,
    // fees included, at reserve ÷ supply.
    const aliceTokens = await ctx.token.balanceOf(ctx.alice.address);
    expect(await ctx.amm.getSellQuote(aliceTokens)).to.equal(THRESHOLD);
    expect(await ctx.amm.spotPrice()).to.equal((THRESHOLD * parseEther("1")) / aliceTokens);
  });

  it("lets the whole supply redeem the whole reserve after later fee deposits", async function () {
    const ctx = await deployPool();
    await ctx.amm.connect(ctx.alice).buy(parseUnits("20000", 6), 0, ctx.alice.address, DEADLINE);
    await ctx.amm.connect(ctx.bob).buy(parseUnits("15000", 6), 0, ctx.bob.address, DEADLINE);
    await ctx.amm.connect(ctx.owner).depositFees(parseUnits("3000", 6));

    const reserve = await ctx.amm.reserveBalance();
    expect(await ctx.amm.getSellQuote(await redeemable(ctx))).to.be.closeTo(reserve, 1n);

    // Each holder's share of the fees is pro rata to the reserve they back.
    const aliceQuote = await ctx.amm.getSellQuote(await ctx.token.balanceOf(ctx.alice.address));
    expect(aliceQuote).to.be.gt(parseUnits("19940", 6));
  });

  it("returns no more than was paid on a buy then sell after graduation", async function () {
    const ctx = await deployPool({ tradeFee: 0 });
    await ctx.amm.connect(ctx.alice).buy(parseUnits("30000", 6), 0, ctx.alice.address, DEADLINE);

    for (const amount of ["1", "250", "5000"]) {
      const paid = parseUnits(amount, 6);
      const before = await ctx.usdc.balanceOf(ctx.bob.address);
      await ctx.amm.connect(ctx.bob).buy(paid, 0, ctx.bob.address, DEADLINE);
      await ctx.amm.connect(ctx.bob).sell(await ctx.token.balanceOf(ctx.bob.address), 0, ctx.bob.address, DEADLINE);
      const after = await ctx.usdc.balanceOf(ctx.bob.address);
      expect(after).to.be.lte(before);
      expect(before - after).to.be.lte(1n);
    }
  });

  it("prices below the anchor at reserve per token after graduation", async function () {
    const ctx = await deployPool({ tradeFee: 0 });
    await ctx.amm.connect(ctx.alice).buy(parseUnits("30000", 6), 0, ctx.alice.address, DEADLINE);
    const anchor = await ctx.amm.graduationSupply();

    // Sell back below the anchor; the remaining tokens still redeem 1:1 at p.
    const toSell = (await ctx.token.balanceOf(ctx.alice.address)) - anchor / 2n;
    let remaining = toSell;
    while (remaining > 0n) {
      let chunk = remaining;
      while ((await ctx.amm.getSellQuote(chunk)) > (await ctx.amm.maxTradeSize())) chunk /= 2n;
      await ctx.amm.connect(ctx.alice).sell(chunk, 0, ctx.alice.address, DEADLINE);
      remaining -= chunk;
    }

    expect(await redeemable(ctx)).to.equal(anchor / 2n);
    expect(await ctx.amm.spotPrice()).to.be.closeTo(PRICE, 1n);
    expect(await ctx.amm.getSellQuote(anchor / 2n)).to.equal(await ctx.amm.reserveBalance());
  });

  it("anchors at the first buy when fees graduate a pool with no supply", async function () {
    const ctx = await deployPool({ tradeFee: 0 });
    await ctx.amm.connect(ctx.owner).depositFees(THRESHOLD);
    expect(await ctx.amm.hasGraduated()).to.equal(true);
    expect(await ctx.amm.graduationSupply()).to.equal(0n);

    const paid = parseUnits("100", 6);
    await ctx.amm.connect(ctx.alice).buy(paid, 0, ctx.alice.address, DEADLINE);
    const tokens = await ctx.token.balanceOf(ctx.alice.address);
    expect(tokens).to.equal((paid * parseEther("1")) / PRICE);
    expect(await ctx.amm.graduationSupply()).to.equal(tokens);
  });

  it("fixes CRR once the pool has graduated", async function () {
    const ctx = await deployPool();
    await ctx.amm.setParameters(300000, 30);
    await ctx.amm.connect(ctx.alice).buy(parseUnits("30000", 6), 0, ctx.alice.address, DEADLINE);

    await expect(ctx.amm.setParameters(200000, 30)).to.be.revertedWith("CRR fixed after graduation");
    await expect(ctx.amm.setParameters(300000, 50)).to.emit(ctx.amm, "ParametersUpdated");
  });

  it("rejects a sell that pays nothing", async function () {
    const ctx = await deployPool();
    await ctx.amm.connect(ctx.alice).buy(parseUnits("100", 6), 0, ctx.alice.address, DEADLINE);
    await expect(ctx.amm.connect(ctx.alice).sell(1n, 0, ctx.alice.address, DEADLINE)).to.be.revertedWith(
      "Insufficient output"
    );
  });
});
