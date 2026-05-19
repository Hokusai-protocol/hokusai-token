const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { parseEther, parseUnits } = require("ethers");
const {
  buildDisabledVestingConfig,
  buildInitialParams,
  buildVestingConfig,
  wholeTokens,
} = require("./helpers/tokenDeployment");
const { buildMintRequestPayload } = require("./helpers/mintRequest");

describe("Allocation accounting separation regression", function () {
  const MODEL_ID_STR = "1101783";
  const MODEL_ID_UINT = 1101783;
  const SUPPLIER_ALLOCATION = parseEther("25");
  const INVESTOR_ALLOCATION = parseEther("100");
  const TOKENS_PER_DELTA_ONE = wholeTokens(100);
  const BASE_REWARD_RATE = parseEther("1000");
  const MIN_IMPROVEMENT_BPS = 100;
  const MAX_REWARD = parseEther("100000");
  const FLAT_CURVE_THRESHOLD = parseUnits("1000000", 6);
  const FLAT_CURVE_PRICE = parseUnits("1", 6);
  const CURVE_THRESHOLD = parseUnits("1000", 6);
  const CURVE_INVESTOR_ALLOCATION = parseEther("5000");
  const CURVE_SUPPLIER_ALLOCATION = parseEther("250");
  const ONE_YEAR = 365 * 24 * 60 * 60;

  async function deploySeparatedAccountingFixture(options = {}) {
    const {
      modelIdStr = MODEL_ID_STR,
      modelIdUint = MODEL_ID_UINT,
      supplierAllocation = SUPPLIER_ALLOCATION,
      investorAllocation = INVESTOR_ALLOCATION,
      tokensPerDeltaOne = TOKENS_PER_DELTA_ONE,
      vestingConfig = buildDisabledVestingConfig(),
      flatCurveThreshold = FLAT_CURVE_THRESHOLD,
      flatCurvePrice = FLAT_CURVE_PRICE,
      buyerUsdc = parseUnits("1000000", 6),
    } = options;

    const [owner, buyer, contributor, treasury, submitter, secondaryContributor] = await ethers.getSigners();

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

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      BASE_REWARD_RATE,
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD
    );
    await deltaVerifier.waitForDeployment();

    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());

    await tokenManager.deployTokenWithAllocations(
      modelIdStr,
      "Allocation Regression Token",
      "ART",
      supplierAllocation,
      owner.address,
      investorAllocation,
      buildInitialParams(owner.address, {
        tokensPerDeltaOne,
        vestingConfig,
      })
    );

    const tokenAddress = await tokenManager.getTokenAddress(modelIdStr);
    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    await modelRegistry.registerModel(modelIdUint, tokenAddress, "accuracy");

    const recorderRole = await contributionRegistry.RECORDER_ROLE();
    await contributionRegistry.grantRole(recorderRole, await deltaVerifier.getAddress());

    const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
    await deltaVerifier.grantRole(submitterRole, submitter.address);

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await usdc.getAddress(),
      tokenAddress,
      await tokenManager.getAddress(),
      modelIdStr,
      treasury.address,
      100000,
      0,
      0,
      flatCurveThreshold,
      flatCurvePrice
    );
    await amm.waitForDeployment();

    await amm.setMaxTradeBps(5000);
    await tokenManager.authorizeAMM(await amm.getAddress());

    await usdc.mint(buyer.address, buyerUsdc);
    await usdc.connect(buyer).approve(await amm.getAddress(), buyerUsdc);

    let mintRequestNonce = 0;

    function buildMintRequest(uniqueLabel, overrides = {}) {
      mintRequestNonce += 1;
      return buildMintRequestPayload({
        pipelineRunId: `${uniqueLabel}-${mintRequestNonce}`,
        baselineScoreBps: 5000,
        candidateScoreBps: 7500,
        ...overrides,
        anchors: {
          benchmarkSpecHash: ethers.id(`benchmark-${uniqueLabel}-${mintRequestNonce}`),
          datasetHash: ethers.id(`dataset-${uniqueLabel}-${mintRequestNonce}`),
          attestationHash: ethers.id(`attestation-${uniqueLabel}-${mintRequestNonce}`),
          idempotencyKey: ethers.id(`idempotency-${uniqueLabel}-${mintRequestNonce}`),
          metricName: "sales:revenue_per_1000_messages",
          metricFamily: "zero_inflated_continuous",
          ...(overrides.anchors || {}),
        },
      });
    }

    async function submitMintRequest(uniqueLabel, payloadOverrides = {}, contributorsOverride) {
      const payload = buildMintRequest(uniqueLabel, payloadOverrides);
      const contributors = contributorsOverride || [{ walletAddress: contributor.address, weight: 10000 }];
      const rewardAmount = await deltaVerifier.connect(submitter).submitMintRequest.staticCall(
        modelIdUint,
        payload,
        contributors
      );
      const tx = await deltaVerifier.connect(submitter).submitMintRequest(modelIdUint, payload, contributors);
      return { payload, contributors, rewardAmount, tx };
    }

    async function exhaustInvestorAllocation() {
      await amm.connect(buyer).buy(
        parseUnits("100", 6),
        investorAllocation,
        buyer.address,
        (await time.latest()) + 3600
      );
    }

    return {
      modelIdStr,
      modelIdUint,
      supplierAllocation,
      investorAllocation,
      owner,
      buyer,
      contributor,
      treasury,
      submitter,
      secondaryContributor,
      tokenManager,
      vestingVault,
      contributionRegistry,
      deltaVerifier,
      token,
      amm,
      buildMintRequest,
      submitMintRequest,
      exhaustInvestorAllocation,
    };
  }

  async function moveToCurvePhase(fixture, reserveIn = parseUnits("1000", 6)) {
    const quote = await fixture.amm.getBuyQuote(reserveIn);
    await fixture.amm.connect(fixture.buyer).buy(
      reserveIn,
      quote,
      fixture.buyer.address,
      (await time.latest()) + 3600
    );
    return quote;
  }

  describe("Investor allocation cap", function () {
    it("mints investor tokens via the AMM up to the investor allocation cap", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.exhaustInvestorAllocation();

      expect(await fixture.token.balanceOf(fixture.buyer.address)).to.equal(fixture.investorAllocation);
      expect(await fixture.token.investorMinted()).to.equal(fixture.investorAllocation);
      expect(await fixture.token.getRemainingInvestorAllocation()).to.equal(0);
      expect(await fixture.token.rewardMinted()).to.equal(0);
    });

    it("reverts the next AMM buy with the investor-cap-specific message", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.exhaustInvestorAllocation();

      await expect(
        fixture.amm.connect(fixture.buyer).buy(
          parseUnits("1", 6),
          0,
          fixture.buyer.address,
          (await time.latest()) + 3600
        )
      ).to.be.revertedWith("Exceeds investor allocation");
    });

    it("rejects further direct authorized-minter investor mints after the cap is exhausted", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.exhaustInvestorAllocation();

      await expect(
        fixture.tokenManager.mintTokens(fixture.modelIdStr, fixture.secondaryContributor.address, 1)
      ).to.be.revertedWith("Exceeds investor allocation");
    });
  });

  describe("DeltaOne rewards bypass investor cap", function () {
    it("mints a reward and records the contribution after investor allocation is exhausted", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.exhaustInvestorAllocation();
      const contributionCountBefore = await fixture.contributionRegistry.getContributorContributionCount(
        fixture.contributor.address
      );
      const { payload, rewardAmount, tx } = await fixture.submitMintRequest("reward-bypass");

      await tx.wait();

      expect(rewardAmount).to.be.gt(0);
      expect(await fixture.token.investorMinted()).to.equal(fixture.investorAllocation);
      expect(await fixture.token.rewardMinted()).to.equal(rewardAmount);
      expect(await fixture.token.balanceOf(fixture.contributor.address)).to.equal(rewardAmount);
      expect(await fixture.token.balanceOf(await fixture.vestingVault.getAddress())).to.equal(0);
      expect(await fixture.contributionRegistry.getContributorContributionCount(fixture.contributor.address)).to.equal(
        contributionCountBefore + 1n
      );

      const contributionIds = await fixture.contributionRegistry.getContributionIdsByContributor(
        fixture.contributor.address,
        contributionCountBefore,
        1
      );
      const record = await fixture.contributionRegistry.getContribution(contributionIds[0]);
      expect(record.modelId).to.equal(fixture.modelIdStr);
      expect(record.contributor).to.equal(fixture.contributor.address);
      expect(record.tokensEarned).to.equal(rewardAmount);
      expect(record.pipelineRunId).to.equal(payload.pipelineRunId);
    });
  });

  describe("Vesting bypasses investor cap", function () {
    it("mints immediate rewards to the contributor and vested rewards to the vault after investor exhaustion", async function () {
      const fixture = await deploySeparatedAccountingFixture({
        vestingConfig: buildVestingConfig({
          immediateUnlockBps: 1000,
          vestingDurationSeconds: ONE_YEAR,
        }),
      });

      await fixture.exhaustInvestorAllocation();
      const scheduleIdsBefore = await fixture.vestingVault.getSchedulesByBeneficiary(fixture.contributor.address);
      const { rewardAmount, tx } = await fixture.submitMintRequest("vesting-bypass");

      await tx.wait();

      const immediateAmount = (rewardAmount * 1000n) / 10000n;
      const vestedAmount = rewardAmount - immediateAmount;
      const scheduleIdsAfter = await fixture.vestingVault.getSchedulesByBeneficiary(fixture.contributor.address);
      const schedule = await fixture.vestingVault.getSchedule(scheduleIdsAfter[scheduleIdsAfter.length - 1]);

      expect(scheduleIdsAfter.length).to.equal(scheduleIdsBefore.length + 1);
      expect(await fixture.token.investorMinted()).to.equal(fixture.investorAllocation);
      expect(await fixture.token.rewardMinted()).to.equal(rewardAmount);
      expect(await fixture.token.balanceOf(fixture.contributor.address)).to.equal(immediateAmount);
      expect(await fixture.token.balanceOf(await fixture.vestingVault.getAddress())).to.equal(vestedAmount);
      expect(schedule.beneficiary).to.equal(fixture.contributor.address);
      expect(schedule.modelId).to.equal(fixture.modelIdStr);
      expect(schedule.totalAmount).to.equal(vestedAmount);
    });
  });

  describe("Supplier allocation is separate", function () {
    it("leaves investor remaining allocation unchanged when supplier allocation is distributed", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.amm.connect(fixture.buyer).buy(
        parseUnits("40", 6),
        parseEther("40"),
        fixture.buyer.address,
        (await time.latest()) + 3600
      );

      const investorMintedBefore = await fixture.token.investorMinted();
      const remainingInvestorBefore = await fixture.token.getRemainingInvestorAllocation();

      await fixture.tokenManager.distributeModelSupplierAllocation(fixture.modelIdStr);

      expect(await fixture.token.balanceOf(fixture.owner.address)).to.equal(fixture.supplierAllocation);
      expect(await fixture.token.modelSupplierDistributed()).to.equal(true);
      expect(await fixture.token.investorMinted()).to.equal(investorMintedBefore);
      expect(await fixture.token.getRemainingInvestorAllocation()).to.equal(remainingInvestorBefore);
    });

    it("does not change AMM reserve after supplier distribution", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      await fixture.amm.connect(fixture.buyer).buy(
        parseUnits("40", 6),
        parseEther("40"),
        fixture.buyer.address,
        (await time.latest()) + 3600
      );

      const reserveBefore = await fixture.amm.reserveBalance();
      await fixture.tokenManager.distributeModelSupplierAllocation(fixture.modelIdStr);

      expect(await fixture.amm.reserveBalance()).to.equal(reserveBefore);
    });
  });

  describe("AMM pricing excludes vested rewards when AMM supply is unchanged", function () {
    it("keeps buy quote and spot price stable when reserves and AMM supply are unchanged", async function () {
      const fixture = await deploySeparatedAccountingFixture({
        supplierAllocation: CURVE_SUPPLIER_ALLOCATION,
        investorAllocation: CURVE_INVESTOR_ALLOCATION,
        vestingConfig: buildVestingConfig({
          immediateUnlockBps: 0,
          vestingDurationSeconds: ONE_YEAR,
        }),
        flatCurveThreshold: CURVE_THRESHOLD,
        buyerUsdc: parseUnits("100000", 6),
      });

      await moveToCurvePhase(fixture);
      const buyQuoteBefore = await fixture.amm.getBuyQuote(parseUnits("100", 6));
      const spotBefore = await fixture.amm.spotPrice();
      const redeemableSupplyBefore = await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr);

      const { rewardAmount, tx } = await fixture.submitMintRequest("locked-reward-stability");
      await tx.wait();

      expect(rewardAmount).to.be.gt(0);
      expect(await fixture.token.balanceOf(await fixture.vestingVault.getAddress())).to.equal(rewardAmount);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(redeemableSupplyBefore);
      expect(await fixture.amm.getBuyQuote(parseUnits("100", 6))).to.equal(buyQuoteBefore);
      expect(await fixture.amm.spotPrice()).to.equal(spotBefore);
    });

    it("does not include undistributed supplier allocation in initial AMM supply", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      expect(await fixture.token.modelSupplierAllocation()).to.equal(fixture.supplierAllocation);
      expect(await fixture.token.modelSupplierDistributed()).to.equal(false);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(0);
      expect(await fixture.amm.getBuyQuote(parseUnits("10", 6))).to.equal(parseEther("10"));
      expect(await fixture.amm.spotPrice()).to.equal(FLAT_CURVE_PRICE);
    });

    it("does move spot price when supplier allocation is distributed", async function () {
      const fixture = await deploySeparatedAccountingFixture({
        supplierAllocation: CURVE_SUPPLIER_ALLOCATION,
        investorAllocation: CURVE_INVESTOR_ALLOCATION,
        flatCurveThreshold: CURVE_THRESHOLD,
        buyerUsdc: parseUnits("100000", 6),
      });

      await moveToCurvePhase(fixture);
      const buyQuoteBefore = await fixture.amm.getBuyQuote(parseUnits("100", 6));
      const spotBefore = await fixture.amm.spotPrice();
      const redeemableSupplyBefore = await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr);

      await fixture.tokenManager.distributeModelSupplierAllocation(fixture.modelIdStr);

      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(
        redeemableSupplyBefore + fixture.supplierAllocation
      );
      expect(await fixture.amm.spotPrice()).to.be.lt(spotBefore);
      expect(await fixture.amm.getBuyQuote(parseUnits("100", 6))).to.not.equal(buyQuoteBefore);
    });

    it("does move spot price by exactly the immediate-unlock portion of a reward mint", async function () {
      const fixture = await deploySeparatedAccountingFixture({
        supplierAllocation: CURVE_SUPPLIER_ALLOCATION,
        investorAllocation: CURVE_INVESTOR_ALLOCATION,
        vestingConfig: buildVestingConfig({
          immediateUnlockBps: 1000,
          vestingDurationSeconds: ONE_YEAR,
        }),
        flatCurveThreshold: CURVE_THRESHOLD,
        buyerUsdc: parseUnits("100000", 6),
      });

      await moveToCurvePhase(fixture);
      const reserve = await fixture.amm.reserveBalance();
      const supplyBefore = await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr);
      const spotBefore = await fixture.amm.spotPrice();

      const { rewardAmount, tx } = await fixture.submitMintRequest("immediate-reward-pricing");
      await tx.wait();

      const immediateAmount = (rewardAmount * 1000n) / 10000n;
      const supplyAfter = await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr);
      const expectedSpot = (reserve * 1000000n * 10n ** 18n) / (100000n * supplyAfter);

      expect(supplyAfter).to.equal(supplyBefore + immediateAmount);
      expect(await fixture.amm.spotPrice()).to.equal(expectedSpot);
      expect(await fixture.amm.spotPrice()).to.be.lt(spotBefore);
    });
  });

  describe("Accounting views", function () {
    it("changes investor, reward, supplier, and AMM supply views only on the intended paths", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      const rewardCap = await fixture.token.getRewardMintingCap();
      expect(await fixture.token.investorMinted()).to.equal(0);
      expect(await fixture.token.getRemainingInvestorAllocation()).to.equal(fixture.investorAllocation);
      expect(await fixture.token.rewardMinted()).to.equal(0);
      expect(await fixture.token.getRemainingRewardAllocation()).to.equal(rewardCap);
      expect(await fixture.token.modelSupplierDistributed()).to.equal(false);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(0);

      await fixture.amm.connect(fixture.buyer).buy(
        parseUnits("10", 6),
        parseEther("10"),
        fixture.buyer.address,
        (await time.latest()) + 3600
      );

      expect(await fixture.token.investorMinted()).to.equal(parseEther("10"));
      expect(await fixture.token.getRemainingInvestorAllocation()).to.equal(fixture.investorAllocation - parseEther("10"));
      expect(await fixture.token.rewardMinted()).to.equal(0);
      expect(await fixture.token.getRemainingRewardAllocation()).to.equal(rewardCap);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(parseEther("10"));

      const { rewardAmount, tx } = await fixture.submitMintRequest("accounting-views");
      await tx.wait();

      expect(await fixture.token.investorMinted()).to.equal(parseEther("10"));
      expect(await fixture.token.getRemainingInvestorAllocation()).to.equal(fixture.investorAllocation - parseEther("10"));
      expect(await fixture.token.rewardMinted()).to.equal(rewardAmount);
      expect(await fixture.token.getRemainingRewardAllocation()).to.equal(rewardCap - rewardAmount);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(parseEther("10") + rewardAmount);

      await fixture.tokenManager.distributeModelSupplierAllocation(fixture.modelIdStr);

      expect(await fixture.token.investorMinted()).to.equal(parseEther("10"));
      expect(await fixture.token.rewardMinted()).to.equal(rewardAmount);
      expect(await fixture.token.modelSupplierDistributed()).to.equal(true);
      expect(await fixture.token.balanceOf(fixture.owner.address)).to.equal(fixture.supplierAllocation);
      expect(await fixture.tokenManager.getRedeemableSupply(fixture.modelIdStr)).to.equal(
        parseEther("10") + rewardAmount + fixture.supplierAllocation
      );
    });

    it("reverts reward mints with the reward-cap-specific message after the reward cap is exhausted", async function () {
      const fixture = await deploySeparatedAccountingFixture();

      const firstReward = await fixture.submitMintRequest("reward-cap-1", {
        baselineScoreBps: 0,
        candidateScoreBps: 9000,
      });
      await firstReward.tx.wait();

      await expect(
        fixture.deltaVerifier.connect(fixture.submitter).submitMintRequest(
          fixture.modelIdUint,
          fixture.buildMintRequest("reward-cap-2", {
            baselineScoreBps: 0,
            candidateScoreBps: 2000,
          }),
          [{ walletAddress: fixture.contributor.address, weight: 10000 }]
        )
      ).to.be.revertedWith("Exceeds reward mint cap");
    });
  });
});
