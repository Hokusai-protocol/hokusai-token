const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

const { buildInitialParams, buildVestingConfig } = require("../helpers/tokenDeployment");
const { buildMintRequestPayload } = require("../helpers/mintRequest");
const { deployFactoryWithPoolDeployer } = require("../helpers/factoryDeployment");

describe("Local mainnet readiness end-to-end suite", function () {
  const MODEL_ID = 1;
  const MODEL_ID_STR = "1";
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("1000000");
  const TOKENS_PER_DELTA_ONE = parseEther("500000");
  const FLAT_CURVE_THRESHOLD = parseUnits("25000", 6);
  const FLAT_CURVE_PRICE = 10000n;
  const TRADE_FEE_BPS = 30n;
  const IBR_SECONDS = 24 * 60 * 60;

  let owner;
  let submitter;
  let contributor1;
  let contributor2;
  let contributor3;
  let trader;
  let depositor;
  let treasury;
  let outsider;

  let modelRegistry;
  let tokenManager;
  let contributionRegistry;
  let deltaVerifier;
  let vestingVault;
  let mockUSDC;
  let factory;
  let pool;
  let token;
  let infraReserve;
  let costOracle;
  let feeRouter;

  async function deployStack() {
    [owner, submitter, contributor1, contributor2, contributor3, trader, depositor, treasury, outsider] =
      await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
    vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD,
    );
    await deltaVerifier.waitForDeployment();

    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);

    const params = buildInitialParams(owner.address, {
      tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
      infrastructureAccrualBps: 8000,
      vestingConfig: buildVestingConfig({
        enabled: true,
        immediateUnlockBps: 1000,
        vestingDurationSeconds: 365 * 24 * 60 * 60,
        cliffSeconds: 0,
      }),
    });

    const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      MODEL_ID_STR,
      "Readiness Token",
      "READY",
      parseEther("1000000"),
      params,
    );
    await tokenManager.deployTokenWithParams(MODEL_ID_STR, "Readiness Token", "READY", parseEther("1000000"), params);

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    token = HokusaiToken.attach(tokenAddress);

    await modelRegistry.registerModel(MODEL_ID, tokenAddress, "accuracy");

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    ({ factory } = await deployFactoryWithPoolDeployer(
      modelRegistry,
      tokenManager,
      mockUSDC,
      treasury
    ));
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);

    const poolAddress = await factory.createPoolWithParams.staticCall(
      MODEL_ID_STR,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      FLAT_CURVE_THRESHOLD,
      FLAT_CURVE_PRICE,
    );
    await factory.createPoolWithParams(
      MODEL_ID_STR,
      tokenAddress,
      200000,
      TRADE_FEE_BPS,
      IBR_SECONDS,
      FLAT_CURVE_THRESHOLD,
      FLAT_CURVE_PRICE,
    );

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    pool = HokusaiAMM.attach(poolAddress);
    await tokenManager.authorizeAMM(poolAddress);

    const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
    infraReserve = await InfrastructureReserve.deploy(await mockUSDC.getAddress(), await factory.getAddress(), treasury.address);
    await infraReserve.waitForDeployment();

    const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
    costOracle = await InfrastructureCostOracle.deploy(owner.address, 1500);
    await costOracle.waitForDeployment();

    const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
    feeRouter = await UsageFeeRouter.deploy(
      await factory.getAddress(),
      await mockUSDC.getAddress(),
      await infraReserve.getAddress(),
      await costOracle.getAddress(),
    );
    await feeRouter.waitForDeployment();

    await infraReserve.grantRole(await infraReserve.DEPOSITOR_ROLE(), await feeRouter.getAddress());
    await feeRouter.grantRole(await feeRouter.FEE_DEPOSITOR_ROLE(), depositor.address);

    await mockUSDC.mint(trader.address, parseUnits("1000000", 6));
    await mockUSDC.connect(trader).approve(await pool.getAddress(), parseUnits("1000000", 6));
    await mockUSDC.mint(depositor.address, parseUnits("1000000", 6));
    await mockUSDC.connect(depositor).approve(await feeRouter.getAddress(), parseUnits("1000000", 6));
  }

  beforeEach(async function () {
    await deployStack();
  });

  function contributors(overrides) {
    return overrides || [
      { walletAddress: contributor1.address, weight: 5000 },
      { walletAddress: contributor2.address, weight: 3000 },
      { walletAddress: contributor3.address, weight: 2000 },
    ];
  }

  function expectedReward(deltaBps, tokensPerDeltaOne = TOKENS_PER_DELTA_ONE) {
    const raw = (BigInt(deltaBps) * tokensPerDeltaOne) / 100n;
    return raw > MAX_REWARD ? MAX_REWARD : raw;
  }

  async function submitMintRequest(overrides = {}, contributorOverrides) {
    const payload = buildMintRequestPayload({
      pipelineRunId: `run-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
      baselineScoreBps: 7800,
      candidateScoreBps: 7900,
      totalSamples: 10000,
      anchors: { idempotencyKey: ethers.id(`idempotency-${Date.now()}-${Math.random()}`) },
      ...overrides,
    });
    const tx = await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, contributors(contributorOverrides));
    const receipt = await tx.wait();
    return { payload, receipt };
  }

  it("covers DeltaVerifier negative MintRequest paths", async function () {
    const basePayload = buildMintRequestPayload({
      pipelineRunId: "negative-base",
      anchors: { idempotencyKey: ethers.id("negative-base") },
    });

    await deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, basePayload, contributors([{ walletAddress: contributor1.address, weight: 10000 }]));
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, basePayload, contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.be.revertedWith("Idempotency key already processed");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(999, buildMintRequestPayload({
        anchors: { idempotencyKey: ethers.id("unregistered") },
      }), contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.be.revertedWith("Model not registered");

    await modelRegistry.deactivateModel(MODEL_ID);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, buildMintRequestPayload({
        anchors: { idempotencyKey: ethers.id("inactive") },
      }), contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.be.revertedWith("Model is deactivated");
    await modelRegistry.reactivateModel(MODEL_ID);

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, buildMintRequestPayload({
        anchors: { idempotencyKey: ethers.id("bad-weights") },
      }), contributors([{ walletAddress: contributor1.address, weight: 9999 }]))
    ).to.be.revertedWith("Weights must sum to 100%");

    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, buildMintRequestPayload({
        anchors: { idempotencyKey: ethers.id("zero-address") },
      }), contributors([{ walletAddress: ZeroAddress, weight: 10000 }]))
    ).to.be.revertedWithCustomError(deltaVerifier, "ZeroAddress");

    const zeroDeltaPayload = buildMintRequestPayload({
      baselineScoreBps: 7900,
      candidateScoreBps: 7900,
      anchors: { idempotencyKey: ethers.id("zero-delta") },
    });
    const balanceBefore = await token.balanceOf(contributor1.address);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, zeroDeltaPayload, contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.emit(deltaVerifier, "DeltaOneAccepted").withArgs(
      MODEL_ID,
      zeroDeltaPayload.anchors.idempotencyKey,
      zeroDeltaPayload.anchors.benchmarkSpecHash,
      zeroDeltaPayload.anchors.attestationHash,
      zeroDeltaPayload.anchors.datasetHash,
      zeroDeltaPayload.anchors.metricName,
      zeroDeltaPayload.anchors.metricFamily,
      zeroDeltaPayload.baselineScoreBps,
      zeroDeltaPayload.candidateScoreBps,
      0n,
      zeroDeltaPayload.pipelineRunId,
    );
    expect(await token.balanceOf(contributor1.address)).to.equal(balanceBefore);

    const budgetPayload = buildMintRequestPayload({
      maxCostUsdMicro: 100,
      actualCostUsdMicro: 101,
      anchors: { idempotencyKey: ethers.id("budget-blocked") },
    });
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, budgetPayload, contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.emit(deltaVerifier, "BudgetConstraintViolated").withArgs(budgetPayload.pipelineRunId, MODEL_ID, 100, 101);
    expect(await token.balanceOf(contributor1.address)).to.equal(balanceBefore);

    const cappedPayload = buildMintRequestPayload({
      baselineScoreBps: 1000,
      candidateScoreBps: 10000,
      anchors: { idempotencyKey: ethers.id("reward-cap") },
    });
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, cappedPayload, contributors([{ walletAddress: contributor1.address, weight: 10000 }]))
    ).to.emit(deltaVerifier, "DeltaOneAccepted").withArgs(
      MODEL_ID,
      cappedPayload.anchors.idempotencyKey,
      cappedPayload.anchors.benchmarkSpecHash,
      cappedPayload.anchors.attestationHash,
      cappedPayload.anchors.datasetHash,
      cappedPayload.anchors.metricName,
      cappedPayload.anchors.metricFamily,
      cappedPayload.baselineScoreBps,
      cappedPayload.candidateScoreBps,
      MAX_REWARD,
      cappedPayload.pipelineRunId,
    );
  });

  it("covers TokenManager and DeltaVerifier rewards, dust, authorization, and vesting", async function () {
    const payload = buildMintRequestPayload({
      pipelineRunId: "token-manager-delta-verifier",
      baselineScoreBps: 7800,
      candidateScoreBps: 7901,
      anchors: { idempotencyKey: ethers.id("token-manager-delta-verifier") },
    });
    const split = [
      { walletAddress: contributor1.address, weight: 3333 },
      { walletAddress: contributor2.address, weight: 3333 },
      { walletAddress: contributor3.address, weight: 3334 },
    ];

    const totalReward = expectedReward(101);
    const base1 = (totalReward * 3333n) / 10000n;
    const base2 = (totalReward * 3333n) / 10000n;
    const base3 = (totalReward * 3334n) / 10000n;
    const dust = totalReward - base1 - base2 - base3;
    const rewards = [base1 + dust, base2, base3];

    await expect(deltaVerifier.connect(submitter).submitMintRequest(MODEL_ID, payload, split))
      .to.emit(deltaVerifier, "BatchRewardsDistributed");

    for (let i = 0; i < split.length; i += 1) {
      const immediate = (rewards[i] * 1000n) / 10000n;
      const vested = rewards[i] - immediate;
      expect(await token.balanceOf(split[i].walletAddress)).to.equal(immediate);

      const scheduleIds = await vestingVault.getSchedulesByBeneficiary(split[i].walletAddress);
      expect(scheduleIds).to.have.length(1);
      const schedule = await vestingVault.getSchedule(scheduleIds[0]);
      expect(schedule.token).to.equal(await token.getAddress());
      expect(schedule.beneficiary).to.equal(split[i].walletAddress);
      expect(schedule.modelId).to.equal(MODEL_ID_STR);
      expect(schedule.totalAmount).to.equal(vested);
    }

    expect(await token.balanceOf(await vestingVault.getAddress())).to.equal(totalReward - ((totalReward * 1000n) / 10000n));

    await expect(
      tokenManager.connect(outsider).batchMintReward(MODEL_ID_STR, [outsider.address], [1])
    ).to.be.revertedWith("Unauthorized");

    await expect(
      deltaVerifier.connect(outsider).submitMintRequest(MODEL_ID, buildMintRequestPayload({
        anchors: { idempotencyKey: ethers.id("arbitrary-caller") },
      }), contributors([{ walletAddress: outsider.address, weight: 10000 }]))
    ).to.be.reverted;
  });

  it("covers AMM buy/sell, fee routing, max trade limits, pause, and pool-token mismatch protection", async function () {
    const buyAmount = parseUnits("30000", 6);
    const quote = await pool.getBuyQuote(buyAmount);
    const traderUsdcBefore = await mockUSDC.balanceOf(trader.address);
    const treasuryBefore = await mockUSDC.balanceOf(treasury.address);

    await expect(pool.connect(trader).buy(buyAmount, quote, trader.address, (await time()) + 3600))
      .to.emit(pool, "Buy");

    const fee = (buyAmount * TRADE_FEE_BPS) / 10000n;
    expect(await token.balanceOf(trader.address)).to.equal(quote);
    expect(await pool.reserveBalance()).to.equal(buyAmount - fee);
    expect(await mockUSDC.balanceOf(treasury.address) - treasuryBefore).to.equal(fee);
    expect(traderUsdcBefore - await mockUSDC.balanceOf(trader.address)).to.equal(buyAmount);
    expect(await pool.hasGraduated()).to.equal(true);

    const reserveBeforeFee = await pool.reserveBalance();
    const usageFee = parseUnits("1000", 6);
    await feeRouter.connect(depositor).depositFee(MODEL_ID_STR, usageFee, 1000);
    expect(await infraReserve.accrued(MODEL_ID_STR)).to.equal((usageFee * 8000n) / 10000n);
    expect(await pool.reserveBalance()).to.equal(reserveBeforeFee + ((usageFee * 2000n) / 10000n));

    await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
    await network.provider.send("evm_mine");

    const sellTokens = quote / 100n;
    const sellQuote = await pool.getSellQuote(sellTokens);
    const reserveBeforeSell = await pool.reserveBalance();
    await token.connect(trader).approve(await pool.getAddress(), sellTokens);
    await expect(pool.connect(trader).sell(sellTokens, sellQuote - 1n, trader.address, (await time()) + 3600))
      .to.emit(pool, "Sell");
    expect(await pool.reserveBalance()).to.equal(reserveBeforeSell - sellQuote);
    expect(await token.balanceOf(trader.address)).to.equal(quote - sellTokens);

    const [reserve, supply] = await pool.getReserves();
    expect(reserve).to.equal(await pool.reserveBalance());
    expect(supply).to.equal(await tokenManager.getRedeemableSupply(MODEL_ID_STR));
    expect(await mockUSDC.balanceOf(await pool.getAddress())).to.equal(await pool.reserveBalance());

    const maxTradeSize = (await pool.reserveBalance() * await pool.maxTradeBps()) / 10000n;
    await expect(
      pool.connect(trader).buy(maxTradeSize + 1n, 0, trader.address, (await time()) + 3600)
    ).to.be.revertedWith("Trade exceeds max size limit");

    await factory.pausePool(MODEL_ID_STR);
    await expect(
      pool.connect(trader).buy(parseUnits("1", 6), 0, trader.address, (await time()) + 3600)
    ).to.be.revertedWith("Pausable: paused");
    await factory.unpausePool(MODEL_ID_STR);

    await expect(
      factory.createPoolWithParams("999", await token.getAddress(), 200000, 30, IBR_SECONDS, FLAT_CURVE_THRESHOLD, FLAT_CURVE_PRICE)
    ).to.be.revertedWith("Model not registered in ModelRegistry");

    const otherTokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      "2",
      "Other Token",
      "OTHER",
      parseEther("1000000"),
      buildInitialParams(owner.address),
    );
    await tokenManager.deployTokenWithParams("2", "Other Token", "OTHER", parseEther("1000000"), buildInitialParams(owner.address));
    await modelRegistry.registerModel(2, otherTokenAddress, "accuracy");
    await expect(
      factory.createPoolWithParams("2", await token.getAddress(), 200000, 30, IBR_SECONDS, FLAT_CURVE_THRESHOLD, FLAT_CURVE_PRICE)
    ).to.be.revertedWith("Token address mismatch");
  });

  it("covers a fresh cross-contract launch flow and final invariants", async function () {
    const { payload } = await submitMintRequest({
      pipelineRunId: "fresh-cross-contract-flow",
      baselineScoreBps: 7000,
      candidateScoreBps: 7200,
      anchors: { idempotencyKey: ethers.id("fresh-cross-contract-flow") },
    });

    expect(await deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey)).to.equal(true);
    expect(await contributionRegistry.getContributorContributionCount(contributor1.address)).to.equal(1);

    const ids = await contributionRegistry.getContributionIdsByContributor(contributor1.address, 0, 1);
    const contribution = await contributionRegistry.getContribution(ids[0]);
    expect(contribution.modelId).to.equal(MODEL_ID_STR);
    expect(contribution.pipelineRunId).to.equal(payload.pipelineRunId);
    expect(contribution.totalSamples).to.equal(payload.totalSamples);

    const buyQuote = await pool.getBuyQuote(parseUnits("5000", 6));
    await pool.connect(trader).buy(parseUnits("5000", 6), buyQuote, trader.address, (await time()) + 3600);
    await feeRouter.connect(depositor).depositFee(MODEL_ID_STR, parseUnits("250", 6), 1000);

    await network.provider.send("evm_increaseTime", [IBR_SECONDS + 1]);
    await network.provider.send("evm_mine");
    const sellAmount = (await token.balanceOf(trader.address)) / 20n;
    const sellQuote = await pool.getSellQuote(sellAmount);
    await token.connect(trader).approve(await pool.getAddress(), sellAmount);
    await pool.connect(trader).sell(sellAmount, sellQuote - 1n, trader.address, (await time()) + 3600);

    expect(await pool.reserveBalance()).to.be.gt(0);
    expect(await token.totalSupply()).to.be.gt(parseEther("1000000"));
    expect(await mockUSDC.balanceOf(await pool.getAddress())).to.equal(await pool.reserveBalance());
    expect(await infraReserve.accrued(MODEL_ID_STR)).to.equal(parseUnits("200", 6));
  });

  it("allows rewards to mint after the investor allocation is exhausted", async function () {
    const cappedModel = "capped-model";
    const supplierAllocation = parseEther("100");
    const investorAllocation = parseEther("100");
    const params = buildInitialParams(owner.address);
    await tokenManager.deployTokenWithAllocations(
      cappedModel,
      "Capped Token",
      "CAP",
      supplierAllocation,
      owner.address,
      investorAllocation,
      params,
    );
    const cappedAddress = await tokenManager.getTokenAddress(cappedModel);
    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    const cappedToken = HokusaiToken.attach(cappedAddress);

    await tokenManager.mintTokens(cappedModel, trader.address, investorAllocation);
    await tokenManager.distributeModelSupplierAllocation(cappedModel);

    expect(await cappedToken.totalSupply()).to.equal(supplierAllocation + investorAllocation);
    await tokenManager.mintReward(cappedModel, contributor1.address, parseEther("10"));
    expect(await cappedToken.investorMinted()).to.equal(investorAllocation);
    expect(await cappedToken.rewardMinted()).to.equal(parseEther("10"));
    expect(await cappedToken.totalSupply()).to.equal(supplierAllocation + investorAllocation + parseEther("10"));
  });

  async function time() {
    const block = await ethers.provider.getBlock("latest");
    return block.timestamp;
  }
});
