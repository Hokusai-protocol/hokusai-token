const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("../helpers/tokenDeployment");
const { deployAMMProxy, bindPool } = require("../helpers/ammDeployment");

// HOK-3289 finding AMM-H1: at graduation the curve prices at R/(w·S) ≈ p/w, so
// whoever sells first after graduation is paid out of flat-phase buyers' USDC.
// Reproduced at 2332beb (CRR 20%, victim $16.5k flat): a crossing buy of $8.6k
// then chunked sells nets the attacker +$13.3k and leaves the victim $3.1k;
// without the HOK-3270 latch, repeated cross-and-dip drains the reserve to 0.
// These assert the fixed behaviour and are enabled by HOK-3317.
describe.skip("AMM graduation extraction (HOK-3317)", function () {
  const DEADLINE = 9999999999n;
  const VICTIM_BUY = parseUnits("16500", 6);
  const THRESHOLD = parseUnits("25000", 6);
  const TRADE_FEE = 30n;

  async function deployPool(crr) {
    const [owner, treasury, victim, attacker] = await ethers.getSigners();
    const modelId = "7299";
    const modelRegistry = await ethers.deployContract("ModelRegistry");
    const tokenManager = await ethers.deployContract("TokenManager", [await modelRegistry.getAddress()]);
    await tokenManager.setVestingVault(await tokenManager.getAddress());
    await deployTestToken(tokenManager, modelId, "G", "G", parseEther("1"), owner.address);
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
      Number(TRADE_FEE),
      0,
      THRESHOLD,
      parseUnits("0.01", 6)
    );
    await bindPool(tokenManager, await amm.getAddress());
    for (const signer of [victim, attacker]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
      await usdc.connect(signer).approve(await amm.getAddress(), ethers.MaxUint256);
      await token.connect(signer).approve(await amm.getAddress(), ethers.MaxUint256);
    }
    await amm.connect(victim).buy(VICTIM_BUY, 0, victim.address, DEADLINE);
    return { amm, token, usdc, victim, attacker };
  }

  // Largest sell under both the trade cap and the reserve.
  async function sellChunk(amm, token, seller) {
    let chunk = await token.balanceOf(seller.address);
    while (chunk > 0n) {
      const quote = await amm.getSellQuote(chunk);
      if (quote > 0n && quote <= (await amm.maxTradeSize()) && quote <= (await amm.reserveBalance())) break;
      chunk = (chunk * 9n) / 10n;
    }
    if (chunk > 0n) await amm.connect(seller).sell(chunk, 0, seller.address, DEADLINE);
    return chunk;
  }

  async function sellAll(amm, token, seller) {
    for (let i = 0; i < 100 && (await token.balanceOf(seller.address)) > 0n; i++) {
      if ((await sellChunk(amm, token, seller)) === 0n) break;
    }
  }

  async function expectNoExtraction({ amm, token, usdc, victim, attacker }, start) {
    expect((await usdc.balanceOf(attacker.address)) - start).to.be.lte(0n);
    const victimPaidAfterFees = VICTIM_BUY - (VICTIM_BUY * TRADE_FEE) / 10000n;
    const victimQuote = await amm.getSellQuote(await token.balanceOf(victim.address));
    // Allow the exit fee and rounding.
    expect(victimQuote).to.be.gte(victimPaidAfterFees - (victimPaidAfterFees * TRADE_FEE) / 10000n - 1000n);
    expect(victimQuote).to.be.lte(await amm.reserveBalance());
  }

  for (const crr of [200000, 500000, 1000000]) {
    it(`gives a crossing buyer no profit from selling into the graduation price (CRR ${crr / 10000}%)`, async function () {
      const ctx = await deployPool(crr);
      const start = await ctx.usdc.balanceOf(ctx.attacker.address);

      await ctx.amm.connect(ctx.attacker).buy(parseUnits("8600", 6), 0, ctx.attacker.address, DEADLINE);
      expect(await ctx.amm.hasGraduated()).to.equal(true);
      // Continuous at graduation: spot stays at the flat price (within rounding).
      expect(await ctx.amm.spotPrice()).to.be.closeTo(parseUnits("0.01", 6), 100n);

      await sellAll(ctx.amm, ctx.token, ctx.attacker);
      await expectNoExtraction(ctx, start);
    });

    it(`gives no profit from repeatedly crossing the threshold and selling (CRR ${crr / 10000}%)`, async function () {
      const ctx = await deployPool(crr);
      const start = await ctx.usdc.balanceOf(ctx.attacker.address);

      for (let i = 0; i < 5; i++) {
        const reserve = await ctx.amm.reserveBalance();
        const need = reserve < THRESHOLD ? ((THRESHOLD - reserve) * 10000n) / (10000n - TRADE_FEE) : 0n;
        await ctx.amm.connect(ctx.attacker).buy(need + parseUnits("10", 6), 0, ctx.attacker.address, DEADLINE);
        await sellChunk(ctx.amm, ctx.token, ctx.attacker);
      }
      await sellAll(ctx.amm, ctx.token, ctx.attacker);
      await expectNoExtraction(ctx, start);
    });
  }
});
