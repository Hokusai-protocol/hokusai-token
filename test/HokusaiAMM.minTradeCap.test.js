const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { deployAMMProxy, bindPool } = require("./helpers/ammDeployment");

// HOK-3300: the per-trade limit is the greater of maxTradeBps of the reserve and
// an absolute minTradeCap floor ($5,000 default), so small pools can take or
// release meaningful liquidity in one trade.
describe("HokusaiAMM absolute trade-size floor", function () {
  const MODEL_ID = "7201";
  const CRR = 200000n;
  const THRESHOLD = parseUnits("25000", 6);
  const FLAT_PRICE = parseUnits("0.01", 6);
  const DEFAULT_CAP = parseUnits("5000", 6);
  const DEADLINE = 9999999999n;

  let owner, treasury, trader, other;

  before(async function () {
    [owner, treasury, trader, other] = await ethers.getSigners();
  });

  async function deployFixture() {
    const modelRegistry = await (await ethers.getContractFactory("ModelRegistry")).deploy();
    const tokenManager = await (await ethers.getContractFactory("TokenManager")).deploy(
      await modelRegistry.getAddress()
    );
    await deployTestToken(tokenManager, MODEL_ID, "Floor Token", "FLR", parseEther("1"), owner.address);
    const token = await ethers.getContractAt("HokusaiToken", await tokenManager.getTokenAddress(MODEL_ID));
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();

    const amm = await deployAMMProxy(await ethers.getContractFactory("HokusaiAMM"),
      await usdc.getAddress(),
      await token.getAddress(),
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      CRR,
      0,
      0,
      THRESHOLD,
      FLAT_PRICE
    );
    await bindPool(tokenManager, await amm.getAddress());

    const ammAddress = await amm.getAddress();
    for (const signer of [owner, trader, other]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
      await usdc.connect(signer).approve(ammAddress, ethers.MaxUint256);
      await token.connect(signer).approve(ammAddress, ethers.MaxUint256);
    }
    return { tokenManager, token, usdc, amm };
  }

  const percentCap = async (amm) => ((await amm.reserveBalance()) * (await amm.maxTradeBps())) / 10000n;

  describe("configuration", function () {
    it("defaults to a $5,000 floor", async function () {
      const { amm } = await deployFixture();
      expect(await amm.minTradeCap()).to.equal(DEFAULT_CAP);
      expect(await amm.DEFAULT_MIN_TRADE_CAP()).to.equal(DEFAULT_CAP);
      expect(await amm.maxTradeSize()).to.equal(DEFAULT_CAP);
    });

    it("lets only the owner update the floor, within bounds, with an event", async function () {
      const { amm } = await deployFixture();
      const max = await amm.MAX_MIN_TRADE_CAP();

      await expect(amm.connect(other).setMinTradeCap(1n)).to.be.revertedWith("Ownable: caller is not the owner");
      await expect(amm.setMinTradeCap(max + 1n)).to.be.revertedWith("Min trade cap too high");

      await expect(amm.setMinTradeCap(max)).to.emit(amm, "MinTradeCapUpdated").withArgs(DEFAULT_CAP, max);
      expect(await amm.minTradeCap()).to.equal(max);
      await expect(amm.setMinTradeCap(0n)).to.emit(amm, "MinTradeCapUpdated").withArgs(max, 0n);
      expect(await amm.minTradeCap()).to.equal(0n);
    });

    it("uses the greater of the floor and the percentage cap", async function () {
      const { amm } = await deployFixture();

      // Below $25k reserve the floor dominates.
      await amm.connect(trader).buy(parseUnits("10000", 6), 0, trader.address, DEADLINE);
      expect(await percentCap(amm)).to.equal(parseUnits("2000", 6));
      expect(await amm.maxTradeSize()).to.equal(DEFAULT_CAP);

      // Above $25k reserve the percentage cap dominates.
      await amm.connect(trader).buy(parseUnits("30000", 6), 0, trader.address, DEADLINE);
      expect(await percentCap(amm)).to.equal(parseUnits("8000", 6));
      expect(await amm.maxTradeSize()).to.equal(parseUnits("8000", 6));
    });
  });

  describe("buys", function () {
    it("lets a graduated pool holding a small reserve take a $5,000 buy", async function () {
      const { amm, token } = await deployFixture();
      await amm.connect(trader).buy(THRESHOLD, 0, trader.address, DEADLINE);
      expect(await amm.hasGraduated()).to.equal(true);

      // Sell 82% of the supply in one trade (temporarily raised floor) to leave
      // a small graduated reserve (below the anchor the price is reserve per
      // token, so this leaves 18% of the reserve; HOK-3317).
      await amm.setMinTradeCap(await amm.MAX_MIN_TRADE_CAP());
      await amm.connect(trader).sell(((await token.balanceOf(trader.address)) * 82n) / 100n, 0, trader.address, DEADLINE);
      await amm.setMinTradeCap(DEFAULT_CAP);
      const reserve = await amm.reserveBalance();
      expect(reserve).to.be.lt(DEFAULT_CAP);
      expect(await percentCap(amm)).to.be.lt(DEFAULT_CAP);

      await amm.connect(other).buy(DEFAULT_CAP, 0, other.address, DEADLINE);
      expect(await amm.reserveBalance()).to.equal(reserve + DEFAULT_CAP);

      await expect(amm.connect(other).buy((await amm.maxTradeSize()) + 1n, 0, other.address, DEADLINE))
        .to.be.revertedWith("Trade exceeds max size limit");
    });

    it("keeps flat-phase buys unlimited", async function () {
      const { amm } = await deployFixture();
      await amm.connect(trader).buy(parseUnits("20000", 6), 0, trader.address, DEADLINE);
      expect(await amm.hasGraduated()).to.equal(false);
    });
  });

  describe("sells", function () {
    it("drains a $25,000 graduated pool in a handful of sells instead of ~45", async function () {
      const { amm, token } = await deployFixture();
      await amm.connect(trader).buy(THRESHOLD, 0, trader.address, DEADLINE);

      let sells = 0;
      while ((await amm.reserveBalance()) > parseUnits("1", 6) && sells < 20) {
        const balance = await token.balanceOf(trader.address);
        if (balance === 0n) break;
        const limit = await amm.maxTradeSize();
        let lo = 0n;
        let hi = balance;
        while (hi - lo > hi / 1000000n + 1n) {
          const mid = (lo + hi) / 2n;
          if ((await amm.getSellQuote(mid)) <= limit) lo = mid;
          else hi = mid;
        }
        await amm.connect(trader).sell(lo, 0, trader.address, DEADLINE);
        sells += 1;
      }

      expect(await amm.reserveBalance()).to.be.lte(parseUnits("1", 6));
      expect(sells).to.be.lte(8);
    });

    it("rejects a sell larger than the reserve with a clear error", async function () {
      const { amm, token, tokenManager } = await deployFixture();
      // Flat phase with a $10 reserve; unbacked tokens (as supplier allocations
      // are) quote at tokens x flat price, which can exceed the reserve.
      await amm.connect(trader).buy(parseUnits("10", 6), 0, trader.address, DEADLINE);
      await tokenManager.mintTokens(MODEL_ID, trader.address, parseEther("5000"));

      const sellIn = parseEther("2000"); // $20 at the flat price
      const quote = await amm.getSellQuote(sellIn);
      expect(quote).to.equal(parseUnits("20", 6));
      expect(quote).to.be.lte(await amm.maxTradeSize());
      expect(quote).to.be.gt(await amm.reserveBalance());

      await expect(amm.connect(trader).sell(sellIn, 0, trader.address, DEADLINE))
        .to.be.revertedWith("Insufficient reserve");

      // Selling exactly the reserve's worth succeeds.
      await amm.connect(trader).sell(parseEther("1000"), 0, trader.address, DEADLINE);
      expect(await amm.reserveBalance()).to.equal(0n);
      expect(await token.balanceOf(await amm.getAddress())).to.equal(0n);
    });

    it("restores pure percentage limits when the floor is 0", async function () {
      const { amm, token } = await deployFixture();
      await amm.connect(trader).buy(THRESHOLD, 0, trader.address, DEADLINE);
      await amm.setMinTradeCap(0n);
      expect(await amm.maxTradeSize()).to.equal(await percentCap(amm));

      const tooBig = (await token.balanceOf(trader.address)) / 2n;
      expect(await amm.getSellQuote(tooBig)).to.be.gt(await percentCap(amm));
      await expect(amm.connect(trader).sell(tooBig, 0, trader.address, DEADLINE))
        .to.be.revertedWith("Trade exceeds max size limit");
    });
  });
});
