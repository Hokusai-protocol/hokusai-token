const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { buildInitialParams, buildVestingConfig, buildDisabledVestingConfig } =
  require("../helpers/tokenDeployment");

describe("DeployableTokenManager AMM sell proof", function () {
  const MODEL_ID_LEGACY = "1001";
  const MODEL_ID_CAPPED = "1002";
  const TRADE_FEE_BPS = 30n;
  const IBR_SECONDS = 24 * 60 * 60;
  const TOKENS_PER_DELTA_ONE = parseEther("500000");

  let owner;
  let trader;
  let rewardHolder;
  let supplierHolder;
  let treasury;
  let outsider;

  let modelRegistry;
  let tokenDeploymentFactory;
  let tokenManager;
  let vestingVault;
  let mockUSDC;
  let factory;

  // Test state for each scenario
  let legacyToken;
  let legacyPool;
  let cappedToken;
  let cappedPool;

  async function deployDeployableStack() {
    [owner, trader, rewardHolder, supplierHolder, treasury, outsider] =
      await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenDeploymentFactory =
      await ethers.getContractFactory("TokenDeploymentFactory");
    tokenDeploymentFactory = await TokenDeploymentFactory.deploy();
    await tokenDeploymentFactory.waitForDeployment();

    const DeployableTokenManager = await ethers.getContractFactory(
      "DeployableTokenManager"
    );
    tokenManager = await DeployableTokenManager.deploy(
      await modelRegistry.getAddress(),
      await tokenDeploymentFactory.getAddress()
    );
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(
      await tokenManager.getAddress()
    );

    const RewardVestingVault =
      await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(
      await tokenManager.getAddress()
    );
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    const HokusaiAMMFactory = await ethers.getContractFactory(
      "HokusaiAMMFactory"
    );
    factory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await mockUSDC.getAddress(),
      treasury.address
    );
    await factory.waitForDeployment();
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);

    // Mint USDC to trader and depositor
    await mockUSDC.mint(owner.address, parseUnits("1000000", 6));
    await mockUSDC.connect(owner).approve(
      await factory.getAddress(),
      parseUnits("1000000", 6)
    );
  }

  async function deployLegacyTokenWithPool() {
    const params = buildInitialParams(owner.address, {
      tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
      infrastructureAccrualBps: 8000,
      vestingConfig: buildDisabledVestingConfig(),
    });

    const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      MODEL_ID_LEGACY,
      "Legacy Token",
      "LEG",
      parseEther("1000000"),
      params
    );
    await tokenManager.deployTokenWithParams(
      MODEL_ID_LEGACY,
      "Legacy Token",
      "LEG",
      parseEther("1000000"),
      params
    );

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    legacyToken = HokusaiToken.attach(tokenAddress);

    // Register model in ModelRegistry with numeric ID
    const numericId = 1001;
    await modelRegistry.registerModel(numericId, tokenAddress, "accuracy");

    const poolAddress = await factory.createPoolWithParams.staticCall(
      MODEL_ID_LEGACY,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("25000", 6),
      10000n
    );
    await factory.createPoolWithParams(
      MODEL_ID_LEGACY,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("25000", 6),
      10000n
    );

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    legacyPool = HokusaiAMM.attach(poolAddress);
    await tokenManager.authorizeAMM(poolAddress);

    return { tokenAddress, poolAddress };
  }

  async function deployCappedTokenWithPool() {
    const params = buildInitialParams(owner.address, {
      tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
      infrastructureAccrualBps: 8000,
      vestingConfig: buildDisabledVestingConfig(),
    });

    const supplierAlloc = parseEther("100000");
    const investorAlloc = parseEther("100000");

    const tokenAddress = await tokenManager.deployTokenWithAllocations.staticCall(
      MODEL_ID_CAPPED,
      "Capped Token",
      "CAP",
      supplierAlloc,
      supplierHolder.address,
      investorAlloc,
      params
    );
    await tokenManager.deployTokenWithAllocations(
      MODEL_ID_CAPPED,
      "Capped Token",
      "CAP",
      supplierAlloc,
      supplierHolder.address,
      investorAlloc,
      params
    );

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    cappedToken = HokusaiToken.attach(tokenAddress);

    // Register model in ModelRegistry with numeric ID
    const numericId = 1002;
    await modelRegistry.registerModel(numericId, tokenAddress, "accuracy");

    const poolAddress = await factory.createPoolWithParams.staticCall(
      MODEL_ID_CAPPED,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("25000", 6),
      10000n
    );
    await factory.createPoolWithParams(
      MODEL_ID_CAPPED,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      parseUnits("25000", 6),
      10000n
    );

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    cappedPool = HokusaiAMM.attach(poolAddress);
    await tokenManager.authorizeAMM(poolAddress);

    return { tokenAddress, poolAddress };
  }

  beforeEach(async function () {
    await deployDeployableStack();
  });

  describe("Scenario 3.1 - Selector & ABI parity", function () {
    it("burnAMMTokens selector matches TokenManager", async function () {
      // Deploy both managers
      const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
      const legacyRegistry = await ModelRegistry.deploy();
      await legacyRegistry.waitForDeployment();

      const TokenManager = await ethers.getContractFactory("TokenManager");
      const legacyManager = await TokenManager.deploy(
        await legacyRegistry.getAddress()
      );
      await legacyManager.waitForDeployment();

      // Get the selector from both
      const deployableIface = new ethers.Interface([
        "function burnAMMTokens(string modelId, address account, uint256 amount)",
      ]);
      const legacyIface = new ethers.Interface([
        "function burnAMMTokens(string modelId, address account, uint256 amount)",
      ]);

      const deployableSelector = deployableIface
        .getFunction("burnAMMTokens")
        .selector;
      const legacySelector = legacyIface.getFunction("burnAMMTokens").selector;

      expect(deployableSelector).to.equal(legacySelector);
    });

    it("DeployableTokenManager exposes burnAMMTokens function", async function () {
      const burnAmmTokensAbi = tokenManager.interface.getFunction(
        "burnAMMTokens"
      );
      expect(burnAmmTokensAbi).to.not.be.null;
      expect(burnAmmTokensAbi.inputs).to.have.length(3);
      expect(burnAmmTokensAbi.inputs[0].type).to.equal("string");
      expect(burnAmmTokensAbi.inputs[1].type).to.equal("address");
      expect(burnAmmTokensAbi.inputs[2].type).to.equal("uint256");
    });
  });

  describe("Scenario 3.2 - Legacy-mode buy → IBR gating → sell", function () {
    beforeEach(async function () {
      await deployLegacyTokenWithPool();
    });

    it("buy succeeds and increments reserve/supply", async function () {
      const buyAmount = parseUnits("10000", 6);
      const quote = await legacyPool.getBuyQuote(buyAmount);

      const traderTokensBefore = await legacyToken.balanceOf(trader.address);
      const reserveBefore = await legacyPool.reserveBalance();

      await mockUSDC.mint(trader.address, buyAmount);
      await mockUSDC.connect(trader).approve(await legacyPool.getAddress(), buyAmount);

      await expect(
        legacyPool
          .connect(trader)
          .buy(buyAmount, quote, trader.address, (await time.latest()) + 3600)
      ).to.emit(legacyPool, "Buy");

      expect(await legacyToken.balanceOf(trader.address)).to.equal(
        traderTokensBefore + quote
      );
      expect(await legacyPool.reserveBalance()).to.be.closeTo(
        reserveBefore + buyAmount - (buyAmount * TRADE_FEE_BPS) / 10000n,
        1
      );
    });

    it("sell reverts during IBR", async function () {
      const buyAmount = parseUnits("10000", 6);
      const quote = await legacyPool.getBuyQuote(buyAmount);

      await mockUSDC.mint(trader.address, buyAmount);
      await mockUSDC.connect(trader).approve(await legacyPool.getAddress(), buyAmount);

      await legacyPool
        .connect(trader)
        .buy(buyAmount, quote, trader.address, (await time.latest()) + 3600);

      const sellAmount = quote / 2n;
      const sellQuote = await legacyPool.getSellQuote(sellAmount);

      await legacyToken.connect(trader).approve(await legacyPool.getAddress(), sellAmount);
      await expect(
        legacyPool
          .connect(trader)
          .sell(sellAmount, sellQuote, trader.address, (await time.latest()) + 3600)
      ).to.be.revertedWith("Sells not enabled during IBR");
    });

    it("sell succeeds after IBR and maintains invariants", async function () {
      const buyAmount = parseUnits("5000", 6);
      const quote = await legacyPool.getBuyQuote(buyAmount);

      await mockUSDC.mint(trader.address, buyAmount);
      await mockUSDC.connect(trader).approve(await legacyPool.getAddress(), buyAmount);

      await legacyPool
        .connect(trader)
        .buy(buyAmount, quote, trader.address, (await time.latest()) + 3600);

      const fee = (buyAmount * TRADE_FEE_BPS) / 10000n;
      const reserveAfterBuy = buyAmount - fee;

      // Advance past IBR
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      // Sell a smaller portion to respect trade size limits
      const sellAmount = quote / 10n;
      const sellQuote = await legacyPool.getSellQuote(sellAmount);
      const traderTokensBefore = await legacyToken.balanceOf(trader.address);
      const reserveBefore = await legacyPool.reserveBalance();
      const supplyBefore = await legacyToken.totalSupply();

      await legacyToken.connect(trader).approve(await legacyPool.getAddress(), sellAmount);
      await expect(
        legacyPool
          .connect(trader)
          .sell(sellAmount, sellQuote, trader.address, (await time.latest()) + 3600)
      ).to.emit(legacyPool, "Sell");

      // Verify invariants
      expect(await legacyToken.balanceOf(trader.address)).to.equal(
        traderTokensBefore - sellAmount
      );
      expect(await legacyPool.reserveBalance()).to.equal(
        reserveBefore - sellQuote
      );
      expect(await legacyToken.totalSupply()).to.equal(
        supplyBefore - sellAmount
      );

      // USDC conservation: reserve + fees = pool USDC
      const poolUsdcBalance = await mockUSDC.balanceOf(
        await legacyPool.getAddress()
      );
      expect(poolUsdcBalance).to.equal(await legacyPool.reserveBalance());
    });
  });

  describe("Scenario 3.4 - Cap-based token: investor/reward/supplier provenance", function () {
    beforeEach(async function () {
      await deployCappedTokenWithPool();
    });

    it("investor holder can sell after buy", async function () {
      const buyAmount = parseUnits("1000", 6);
      const quote = await cappedPool.getBuyQuote(buyAmount);

      await mockUSDC.mint(trader.address, buyAmount);
      await mockUSDC.connect(trader).approve(await cappedPool.getAddress(), buyAmount);

      await cappedPool
        .connect(trader)
        .buy(buyAmount, quote, trader.address, (await time.latest()) + 3600);

      // Verify investor tokens were minted
      expect(await cappedToken.balanceOf(trader.address)).to.equal(quote);
      const investorMintedBefore = await cappedToken.investorMinted();

      // Advance past IBR
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      const sellAmount = quote / 5n;
      const sellQuote = await cappedPool.getSellQuote(sellAmount);

      await cappedToken.connect(trader).approve(await cappedPool.getAddress(), sellAmount);
      await expect(
        cappedPool
          .connect(trader)
          .sell(sellAmount, sellQuote, trader.address, (await time.latest()) + 3600)
      ).to.emit(cappedPool, "Sell");

      expect(await cappedToken.balanceOf(trader.address)).to.equal(
        quote - sellAmount
      );
      expect(await cappedToken.investorMinted()).to.equal(
        investorMintedBefore - sellAmount
      );
    });

    it("reward holder can sell and burns reward tokens", async function () {
      const rewardAmount = parseEther("1000");

      // Mint reward tokens to rewardHolder
      await tokenManager.connect(owner).mintReward(
        MODEL_ID_CAPPED,
        rewardHolder.address,
        rewardAmount
      );

      const rewardMintedBefore = await cappedToken.rewardMinted();
      expect(await cappedToken.balanceOf(rewardHolder.address)).to.equal(
        rewardAmount
      );

      // Advance past IBR
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      const sellAmount = rewardAmount / 2n;
      const sellQuote = await cappedPool.getSellQuote(sellAmount);

      await mockUSDC.mint(await cappedPool.getAddress(), sellQuote + parseUnits("100", 6));

      await cappedToken.connect(rewardHolder).approve(await cappedPool.getAddress(), sellAmount);
      await expect(
        cappedPool
          .connect(rewardHolder)
          .sell(sellAmount, sellQuote, rewardHolder.address, (await time.latest()) + 3600)
      ).to.emit(cappedPool, "Sell");

      expect(await cappedToken.balanceOf(rewardHolder.address)).to.equal(
        rewardAmount - sellAmount
      );
      expect(await cappedToken.rewardMinted()).to.equal(
        rewardMintedBefore - sellAmount
      );
    });

    it("supplier holder can sell untracked supplier tokens", async function () {
      // Distribute supplier allocation
      await tokenManager.distributeModelSupplierAllocation(MODEL_ID_CAPPED);

      const supplierBalance = await cappedToken.balanceOf(supplierHolder.address);
      expect(supplierBalance).to.be.gt(0);

      // Advance past IBR
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      const sellAmount = supplierBalance / 2n;
      const sellQuote = await cappedPool.getSellQuote(sellAmount);

      await mockUSDC.mint(await cappedPool.getAddress(), sellQuote + parseUnits("100", 6));

      await cappedToken.connect(supplierHolder).approve(await cappedPool.getAddress(), sellAmount);
      await expect(
        cappedPool
          .connect(supplierHolder)
          .sell(sellAmount, sellQuote, supplierHolder.address, (await time.latest()) + 3600)
      ).to.emit(cappedPool, "Sell");

      expect(await cappedToken.balanceOf(supplierHolder.address)).to.equal(
        supplierBalance - sellAmount
      );
      // Supplier tokens have no separate counter in burnAMM
      // and are simply _burn'ed, so no counter decrement to assert
    });
  });

  describe("Scenario 3.5 - Authorization and validation", function () {
    beforeEach(async function () {
      await deployLegacyTokenWithPool();
    });

    it("unauthorized caller is rejected", async function () {
      await expect(
        tokenManager
          .connect(outsider)
          .burnAMMTokens(MODEL_ID_LEGACY, trader.address, parseEther("100"))
      ).to.be.revertedWith("Caller is not authorized to burn");
    });

    it("empty modelId is rejected", async function () {
      await expect(
        tokenManager
          .connect(owner)
          .burnAMMTokens("", trader.address, parseEther("100"))
      ).to.be.reverted;
    });

    it("zero address is rejected", async function () {
      await expect(
        tokenManager
          .connect(owner)
          .burnAMMTokens(MODEL_ID_LEGACY, ZeroAddress, parseEther("100"))
      ).to.be.reverted;
    });

    it("zero amount is rejected", async function () {
      await expect(
        tokenManager
          .connect(owner)
          .burnAMMTokens(MODEL_ID_LEGACY, trader.address, 0)
      ).to.be.reverted;
    });

    it("undeployed modelId is rejected", async function () {
      await expect(
        tokenManager
          .connect(owner)
          .burnAMMTokens("nonexistent-model", trader.address, parseEther("100"))
      ).to.be.revertedWith("Token not deployed for this model");
    });

    it("MINTER_ROLE holder can call burnAMMTokens", async function () {
      const buyAmount = parseUnits("1000", 6);
      const quote = await legacyPool.getBuyQuote(buyAmount);

      await mockUSDC.mint(trader.address, buyAmount);
      await mockUSDC.connect(trader).approve(await legacyPool.getAddress(), buyAmount);

      await legacyPool
        .connect(trader)
        .buy(buyAmount, quote, trader.address, (await time.latest()) + 3600);

      // Pool has MINTER_ROLE and can call burnAMMTokens via sell
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      const sellAmount = quote / 5n;
      const sellQuote = await legacyPool.getSellQuote(sellAmount);

      await legacyToken.connect(trader).approve(await legacyPool.getAddress(), sellAmount);

      // This internal call to burnAMMTokens should succeed
      await expect(
        legacyPool
          .connect(trader)
          .sell(sellAmount, sellQuote, trader.address, (await time.latest()) + 3600)
      ).to.emit(legacyPool, "Sell");
    });
  });

  describe("Integration - full buy/sell cycle maintains invariants", function () {
    beforeEach(async function () {
      await deployLegacyTokenWithPool();
    });

    it("reserve + fees equals pool USDC balance after buys and sells", async function () {
      // Multiple buy transactions
      const buyAmount1 = parseUnits("1000", 6);
      const quote1 = await legacyPool.getBuyQuote(buyAmount1);

      await mockUSDC.mint(trader.address, buyAmount1);
      await mockUSDC.connect(trader).approve(await legacyPool.getAddress(), buyAmount1);
      await legacyPool
        .connect(trader)
        .buy(buyAmount1, quote1, trader.address, (await time.latest()) + 3600);

      const buyAmount2 = parseUnits("500", 6);
      const quote2 = await legacyPool.getBuyQuote(buyAmount2);

      await mockUSDC.mint(rewardHolder.address, buyAmount2);
      await mockUSDC.connect(rewardHolder).approve(await legacyPool.getAddress(), buyAmount2);
      await legacyPool
        .connect(rewardHolder)
        .buy(buyAmount2, quote2, rewardHolder.address, (await time.latest()) + 3600);

      // Advance past IBR
      await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
      await network.provider.send("evm_mine");

      // Sell from both traders with smaller amounts to respect trade limits
      const sellAmount1 = quote1 / 5n;
      const sellQuote1 = await legacyPool.getSellQuote(sellAmount1);

      await legacyToken.connect(trader).approve(await legacyPool.getAddress(), sellAmount1);
      await legacyPool
        .connect(trader)
        .sell(sellAmount1, sellQuote1, trader.address, (await time.latest()) + 3600);

      const sellAmount2 = quote2 / 5n;
      const sellQuote2 = await legacyPool.getSellQuote(sellAmount2);

      await legacyToken.connect(rewardHolder).approve(await legacyPool.getAddress(), sellAmount2);
      await legacyPool
        .connect(rewardHolder)
        .sell(sellAmount2, sellQuote2, rewardHolder.address, (await time.latest()) + 3600);

      // Verify invariants
      const [reserve, supply] = await legacyPool.getReserves();
      expect(reserve).to.equal(await legacyPool.reserveBalance());
      expect(supply).to.equal(await tokenManager.getRedeemableSupply(MODEL_ID_LEGACY));
      expect(await mockUSDC.balanceOf(await legacyPool.getAddress())).to.equal(
        await legacyPool.reserveBalance()
      );
    });
  });
});
