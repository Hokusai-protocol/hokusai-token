const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { deployTestToken } = require("./helpers/tokenDeployment");
const { bindPool } = require("./helpers/ammDeployment");

// HOK-3281: pools are TransparentUpgradeableProxy instances over a shared
// HokusaiAMM implementation. Upgrading a pool must keep its address and every
// piece of state, and must not touch other pools.
describe("HokusaiAMM upgradeability", function () {
  const MODEL_A = "7204";
  const MODEL_B = "7205";
  const CRR = 200000n;
  const TRADE_FEE = 30n;
  const THRESHOLD = parseUnits("25000", 6);
  const FLAT_PRICE = parseUnits("0.01", 6);
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
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const implementation = await HokusaiAMM.deploy();
    const proxyAdmin = await (await ethers.getContractFactory("ProxyAdmin")).deploy();
    const Proxy = await ethers.getContractFactory("TransparentUpgradeableProxy");

    async function deployPool(modelId, symbol) {
      await deployTestToken(tokenManager, modelId, `${symbol} Token`, symbol, parseEther("1"), owner.address);
      const token = await ethers.getContractAt("HokusaiToken", await tokenManager.getTokenAddress(modelId));
      const initData = HokusaiAMM.interface.encodeFunctionData("initialize", [
        await usdc.getAddress(),
        await token.getAddress(),
        await tokenManager.getAddress(),
        modelId,
        treasury.address,
        CRR,
        TRADE_FEE,
        0,
        THRESHOLD,
        FLAT_PRICE,
      ]);
      const proxy = await Proxy.deploy(await implementation.getAddress(), await proxyAdmin.getAddress(), initData);
      const amm = HokusaiAMM.attach(await proxy.getAddress());
      await bindPool(tokenManager, await amm.getAddress());
      return { amm, token };
    }

    const poolA = await deployPool(MODEL_A, "UPA");
    const poolB = await deployPool(MODEL_B, "UPB");

    for (const signer of [owner, trader, other]) {
      await usdc.mint(signer.address, parseUnits("1000000", 6));
    }
    return { tokenManager, usdc, HokusaiAMM, implementation, proxyAdmin, poolA, poolB };
  }

  // Populate a pool: graduating buy, a fee deposit, a sell, config changes,
  // a whitelist, standing allowances, and finally a pause.
  async function populate({ amm, token }, usdc, allowances) {
    const ammAddress = await amm.getAddress();
    await usdc.connect(trader).approve(ammAddress, ethers.MaxUint256);
    await token.connect(trader).approve(ammAddress, ethers.MaxUint256);
    await amm.connect(trader).buy(THRESHOLD, 0, trader.address, DEADLINE);

    await usdc.connect(owner).approve(ammAddress, parseUnits("1000", 6));
    await amm.depositFees(parseUnits("1000", 6));
    await amm.connect(trader).sell(parseEther("1000"), 0, trader.address, DEADLINE);

    await amm.setParameters(250000, 50);
    await amm.setMaxTradeBps(1500);
    await amm.setMinTradeCap(parseUnits("7500", 6));
    const whitelist = await (await ethers.getContractFactory("PurchaserWhitelist")).deploy(owner.address);
    await whitelist.addToWhitelist(trader.address);
    await amm.setPurchaserWhitelist(await whitelist.getAddress());

    await usdc.connect(other).approve(ammAddress, allowances.usdc);
    await token.connect(trader).approve(ammAddress, allowances.token);
    await amm.pause();
  }

  async function snapshot({ amm, token }, usdc, tokenManager, modelId) {
    const ammAddress = await amm.getAddress();
    return {
      address: ammAddress,
      owner: await amm.owner(),
      reserveToken: await amm.reserveToken(),
      hokusaiToken: await amm.hokusaiToken(),
      tokenManager: await amm.tokenManager(),
      modelId: await amm.modelId(),
      treasury: await amm.treasury(),
      reserveBalance: await amm.reserveBalance(),
      usdcHeld: await usdc.balanceOf(ammAddress),
      crr: await amm.crr(),
      tradeFee: await amm.tradeFee(),
      buyOnlyUntil: await amm.buyOnlyUntil(),
      maxTradeBps: await amm.maxTradeBps(),
      minTradeCap: await amm.minTradeCap(),
      purchaserWhitelist: await amm.purchaserWhitelist(),
      threshold: await amm.FLAT_CURVE_THRESHOLD(),
      flatPrice: await amm.FLAT_CURVE_PRICE(),
      hasGraduated: await amm.hasGraduated(),
      phase: await amm.getCurrentPhase(),
      paused: await amm.paused(),
      spotPrice: await amm.spotPrice(),
      totalSupply: await token.totalSupply(),
      redeemableSupply: await tokenManager.getRedeemableSupply(modelId),
      traderTokens: await token.balanceOf(trader.address),
      usdcAllowance: await usdc.allowance(other.address, ammAddress),
      tokenAllowance: await token.allowance(trader.address, ammAddress),
    };
  }

  it("upgrades a populated pool in place, preserving address and all state, without touching other pools", async function () {
    const { tokenManager, usdc, implementation, proxyAdmin, poolA, poolB } = await deployFixture();
    const allowances = { usdc: parseUnits("123", 6), token: parseEther("456") };
    await populate(poolA, usdc, allowances);
    await usdc.connect(trader).approve(await poolB.amm.getAddress(), ethers.MaxUint256);
    await poolB.amm.connect(trader).buy(parseUnits("100", 6), 0, trader.address, DEADLINE);

    const beforeA = await snapshot(poolA, usdc, tokenManager, MODEL_A);
    const beforeB = await snapshot(poolB, usdc, tokenManager, MODEL_B);
    expect(beforeA.hasGraduated).to.equal(true);
    expect(beforeA.paused).to.equal(true);
    expect(beforeA.usdcAllowance).to.equal(allowances.usdc);

    const v2 = await (await ethers.getContractFactory("HokusaiAMMV2Mock")).deploy();
    await proxyAdmin.upgrade(await poolA.amm.getAddress(), await v2.getAddress());

    expect(await upgrades.erc1967.getImplementationAddress(await poolA.amm.getAddress())).to.equal(
      await v2.getAddress()
    );
    expect(await upgrades.erc1967.getImplementationAddress(await poolB.amm.getAddress())).to.equal(
      await implementation.getAddress()
    );

    const upgradedA = await ethers.getContractAt("HokusaiAMMV2Mock", await poolA.amm.getAddress());
    expect(await upgradedA.version()).to.equal("v2");
    expect(await snapshot({ amm: upgradedA, token: poolA.token }, usdc, tokenManager, MODEL_A)).to.deep.equal(beforeA);
    expect(await snapshot(poolB, usdc, tokenManager, MODEL_B)).to.deep.equal(beforeB);

    // The appended V2 field lives after the gap and starts at zero; the V2
    // reinitializer runs once.
    expect(await upgradedA.v2Marker()).to.equal(0n);
    await upgradedA.initializeV2(7);
    expect(await upgradedA.v2Marker()).to.equal(7n);
    await expect(upgradedA.initializeV2(8)).to.be.revertedWith("Initializable: contract is already initialized");

    // Upgraded pool keeps trading against the preserved reserve.
    await upgradedA.unpause();
    const reserveBefore = await upgradedA.reserveBalance();
    await upgradedA.connect(trader).buy(parseUnits("100", 6), 0, trader.address, DEADLINE);
    expect(await upgradedA.reserveBalance()).to.be.gt(reserveBefore);

    // Pool B still runs the V1 implementation.
    const asV2 = await ethers.getContractAt("HokusaiAMMV2Mock", await poolB.amm.getAddress());
    await expect(asV2.version()).to.be.reverted;
  });

  it("restricts upgrades to the ProxyAdmin owner", async function () {
    const { proxyAdmin, poolA } = await deployFixture();
    const v2 = await (await ethers.getContractFactory("HokusaiAMMV2Mock")).deploy();
    await expect(
      proxyAdmin.connect(other).upgrade(await poolA.amm.getAddress(), await v2.getAddress())
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("rejects reinitialization through the proxy and direct initialization of the implementation", async function () {
    const { usdc, tokenManager, implementation, poolA } = await deployFixture();
    const args = [
      await usdc.getAddress(),
      await poolA.token.getAddress(),
      await tokenManager.getAddress(),
      MODEL_A,
      other.address,
      CRR,
      TRADE_FEE,
      0,
      THRESHOLD,
      FLAT_PRICE,
    ];
    await expect(poolA.amm.connect(other).initialize(...args)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
    await expect(implementation.connect(other).initialize(...args)).to.be.revertedWith(
      "Initializable: contract is already initialized"
    );
    expect(await poolA.amm.owner()).to.equal(owner.address);
  });

  describe("storage-layout validation", function () {
    it("accepts HokusaiAMM as a transparent-proxy implementation", async function () {
      await upgrades.validateImplementation(await ethers.getContractFactory("HokusaiAMM"), { kind: "transparent" });
    });

    it("accepts a layout-compatible V2", async function () {
      await upgrades.validateUpgrade(
        await ethers.getContractFactory("HokusaiAMM"),
        await ethers.getContractFactory("HokusaiAMMV2Mock"),
        { kind: "transparent" }
      );
    });

    it("rejects a V2 that reorders existing storage", async function () {
      await expect(
        upgrades.validateUpgrade(
          await ethers.getContractFactory("HokusaiAMM"),
          await ethers.getContractFactory("HokusaiAMMBadLayoutMock"),
          { kind: "transparent" }
        )
      ).to.be.rejectedWith(/New storage layout is incompatible/);
    });
  });
});
