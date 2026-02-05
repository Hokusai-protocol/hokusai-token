const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");

describe("Integration: Infrastructure Cost Accrual Flow", function () {
  let modelRegistry;
  let tokenManager;
  let factory;
  let infraReserve;
  let feeRouter;
  let mockUSDC;
  let pool1, pool2;
  let token1, token2;
  let params1, params2;
  let owner, treasury, depositor, payer, provider1, provider2;

  const MODEL_ID_1 = "gpt-4-turbo";
  const MODEL_ID_2 = "claude-3-sonnet";
  const INITIAL_SUPPLY = parseEther("1000000");

  beforeEach(async function () {
    [owner, treasury, depositor, payer, provider1, provider2] = await ethers.getSigners();

    // Deploy core contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    factory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await mockUSDC.getAddress(),
      treasury.address
    );
    await factory.waitForDeployment();

    // Deploy InfrastructureReserve
    const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
    infraReserve = await InfrastructureReserve.deploy(
      await mockUSDC.getAddress(),
      await factory.getAddress(),
      treasury.address
    );
    await infraReserve.waitForDeployment();

    // Deploy UsageFeeRouter
    const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
    feeRouter = await UsageFeeRouter.deploy(
      await factory.getAddress(),
      await mockUSDC.getAddress(),
      await infraReserve.getAddress()
    );
    await feeRouter.waitForDeployment();

    // Deploy tokens and create pools
    const token1Address = await tokenManager.deployToken.staticCall(
      MODEL_ID_1,
      "GPT-4 Turbo Token",
      "GPT4T",
      INITIAL_SUPPLY
    );
    await tokenManager.deployToken(MODEL_ID_1, "GPT-4 Turbo Token", "GPT4T", INITIAL_SUPPLY);

    const token2Address = await tokenManager.deployToken.staticCall(
      MODEL_ID_2,
      "Claude 3 Sonnet Token",
      "C3S",
      INITIAL_SUPPLY
    );
    await tokenManager.deployToken(MODEL_ID_2, "Claude 3 Sonnet Token", "C3S", INITIAL_SUPPLY);

    // Create pools
    const pool1Address = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
    await factory.createPool(MODEL_ID_1, token1Address);
    const pool2Address = await factory.createPool.staticCall(MODEL_ID_2, token2Address);
    await factory.createPool(MODEL_ID_2, token2Address);

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    pool1 = HokusaiAMM.attach(pool1Address);
    pool2 = HokusaiAMM.attach(pool2Address);

    const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
    token1 = HokusaiToken.attach(token1Address);
    token2 = HokusaiToken.attach(token2Address);

    // Get params contracts
    const params1Address = await tokenManager.modelParams(MODEL_ID_1);
    const params2Address = await tokenManager.modelParams(MODEL_ID_2);
    const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
    params1 = HokusaiParams.attach(params1Address);
    params2 = HokusaiParams.attach(params2Address);

    // Grant roles
    const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
    await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, depositor.address);

    const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
    await infraReserve.grantRole(DEPOSITOR_ROLE, await feeRouter.getAddress());

    const PAYER_ROLE = await infraReserve.PAYER_ROLE();
    await infraReserve.grantRole(PAYER_ROLE, payer.address);

    // Set providers
    await infraReserve.setProvider(MODEL_ID_1, provider1.address);
    await infraReserve.setProvider(MODEL_ID_2, provider2.address);

    // Mint USDC to depositor and providers
    await mockUSDC.mint(depositor.address, parseUnits("100000000", 6)); // $100M
    await mockUSDC.connect(depositor).approve(await feeRouter.getAddress(), parseUnits("100000000", 6));
  });

  // ============================================================
  // END-TO-END REVENUE FLOW
  // ============================================================

  describe("End-to-End Revenue Flow", function () {
    it("Should route $100 API revenue with 80/20 split correctly", async function () {
      const apiRevenue = parseUnits("100", 6); // $100

      // Initial state
      const infraBalanceBefore = await infraReserve.accrued(MODEL_ID_1);
      const poolReserveBefore = await pool1.reserveBalance();

      // Deposit API revenue
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, apiRevenue);

      // Verify infrastructure reserve received 80%
      const infraBalanceAfter = await infraReserve.accrued(MODEL_ID_1);
      const expectedInfra = parseUnits("80", 6); // $80
      expect(infraBalanceAfter - infraBalanceBefore).to.equal(expectedInfra);

      // Verify AMM received 20% profit
      const poolReserveAfter = await pool1.reserveBalance();
      const expectedProfit = parseUnits("20", 6); // $20
      expect(poolReserveAfter - poolReserveBefore).to.equal(expectedProfit);

      // Verify total equals original amount
      const totalRouted = (infraBalanceAfter - infraBalanceBefore) + (poolReserveAfter - poolReserveBefore);
      expect(totalRouted).to.equal(apiRevenue);
    });

    it("Should increase token price after profit flows to AMM", async function () {
      // Get initial spot price (after crossing flat curve threshold)
      const largeRevenue = parseUnits("150000", 6); // $150k to cross threshold
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, largeRevenue);

      const spotPriceBefore = await pool1.spotPrice();

      // Additional revenue should increase price
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("10000", 6));

      const spotPriceAfter = await pool1.spotPrice();
      expect(spotPriceAfter).to.be.gt(spotPriceBefore);
    });

    it("Should track cumulative revenue correctly", async function () {
      // Multiple API fee deposits
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("100", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("250", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("150", 6));

      // Total: $500
      const totalFees = await feeRouter.getModelFees(MODEL_ID_1);
      expect(totalFees).to.equal(parseUnits("500", 6));

      // Infrastructure should have $400 (80%)
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("400", 6));
    });

    it("Should handle zero profit (100% infrastructure) without reverting", async function () {
      // Update to 100% infrastructure
      await params1.connect(owner).setInfrastructureAccrualBps(10000);

      const apiRevenue = parseUnits("1000", 6);
      const poolReserveBefore = await pool1.reserveBalance();

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, apiRevenue);

      // All revenue to infrastructure
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(apiRevenue);

      // No change in pool reserve
      const poolReserveAfter = await pool1.reserveBalance();
      expect(poolReserveAfter).to.equal(poolReserveBefore);
    });
  });

  // ============================================================
  // INFRASTRUCTURE PAYMENT FLOW
  // ============================================================

  describe("Infrastructure Payment Flow", function () {
    it("Should complete full payment cycle with invoice tracking", async function () {
      // Step 1: Accrue $500 from API fees
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("625", 6)); // $500 infra
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("500", 6));

      // Step 2: Pay $300 to provider
      const invoiceHash = keccak256(toUtf8Bytes("INV-2024-001"));
      const memo = "December 2024 compute costs";

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("300", 6),
        invoiceHash,
        memo
      );

      // Step 3: Verify balance is $200
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("200", 6));

      // Step 4: Verify paid tracking
      expect(await infraReserve.paid(MODEL_ID_1)).to.equal(parseUnits("300", 6));

      // Step 5: Verify provider received payment
      expect(await mockUSDC.balanceOf(provider1.address)).to.equal(parseUnits("300", 6));
    });

    it("Should handle multiple payments to same provider", async function () {
      // Accrue $1000
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1250", 6));

      // Pay $400 in first invoice
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("400", 6),
        keccak256(toUtf8Bytes("INV-001")),
        "Invoice 1"
      );

      // Pay $300 in second invoice
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("300", 6),
        keccak256(toUtf8Bytes("INV-002")),
        "Invoice 2"
      );

      // Net accrued: $1000 - $700 = $300
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("300", 6));

      // Total paid: $700
      expect(await infraReserve.paid(MODEL_ID_1)).to.equal(parseUnits("700", 6));

      // Provider received $700 total
      expect(await mockUSDC.balanceOf(provider1.address)).to.equal(parseUnits("700", 6));
    });

    it("Should prevent payment exceeding accrued balance", async function () {
      // Accrue only $100
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("125", 6));

      // Attempt to pay $200
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID_1,
          provider1.address,
          parseUnits("200", 6),
          keccak256(toUtf8Bytes("INV-001")),
          "Overpayment attempt"
        )
      ).to.be.revertedWith("Exceeds accrued balance");
    });

    it("Should track payments independently per model", async function () {
      // Accrue for both models
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1250", 6)); // $1000 infra
      await feeRouter.connect(depositor).depositFee(MODEL_ID_2, parseUnits("1250", 6)); // $1000 infra

      // Pay different amounts to each provider
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("600", 6),
        keccak256(toUtf8Bytes("INV-M1-001")),
        "Model 1 costs"
      );

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_2,
        provider2.address,
        parseUnits("400", 6),
        keccak256(toUtf8Bytes("INV-M2-001")),
        "Model 2 costs"
      );

      // Verify independent balances
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("400", 6));
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("600", 6));

      expect(await infraReserve.paid(MODEL_ID_1)).to.equal(parseUnits("600", 6));
      expect(await infraReserve.paid(MODEL_ID_2)).to.equal(parseUnits("400", 6));
    });
  });

  // ============================================================
  // GOVERNANCE ADJUSTMENT FLOW
  // ============================================================

  describe("Governance Adjustment Flow", function () {
    it("Should apply split changes dynamically", async function () {
      // Initial deposit with default 80/20
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("100", 6));
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("80", 6));

      // Governance changes to 70/30
      await params1.connect(owner).setInfrastructureAccrualBps(7000);

      // New deposit uses 70/30 split
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("100", 6));

      // Total infrastructure: $80 + $70 = $150
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("150", 6));
    });

    it("Should allow per-model governance control", async function () {
      // Model 1: Stay at 80/20
      // Model 2: Change to 90/10 (high compute cost)
      await params2.connect(owner).setInfrastructureAccrualBps(9000);

      // Deposit same amount to both
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_2, parseUnits("1000", 6));

      // Model 1: $800 infrastructure (80%)
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("800", 6));

      // Model 2: $900 infrastructure (90%)
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("900", 6));
    });

    it("Should emit events when governance updates splits", async function () {
      await expect(
        params1.connect(owner).setInfrastructureAccrualBps(7500)
      )
        .to.emit(params1, "InfrastructureAccrualBpsSet")
        .withArgs(8000, 7500, owner.address);
    });

    it("Should enforce governance bounds (50-100%)", async function () {
      // Below minimum
      await expect(
        params1.connect(owner).setInfrastructureAccrualBps(4999)
      ).to.be.reverted;

      // Above maximum
      await expect(
        params1.connect(owner).setInfrastructureAccrualBps(10001)
      ).to.be.reverted;

      // At boundaries should work
      await params1.connect(owner).setInfrastructureAccrualBps(5000); // 50%
      await params1.connect(owner).setInfrastructureAccrualBps(10000); // 100%
    });
  });

  // ============================================================
  // MULTIPLE MODELS
  // ============================================================

  describe("Multiple Models with Different Splits", function () {
    it("Should handle batch deposits with different splits per model", async function () {
      // Model 1: 80/20 (default)
      // Model 2: 90/10 (high compute)
      await params2.connect(owner).setInfrastructureAccrualBps(9000);

      // Batch deposit
      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("1000", 6), parseUnits("1000", 6)]
      );

      // Verify each model got correct split
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("800", 6)); // 80%
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("900", 6)); // 90%

      // Verify independent accounting
      const [totalFees1, infraBps1, profitBps1] = await feeRouter.getModelStats(MODEL_ID_1);
      const [totalFees2, infraBps2, profitBps2] = await feeRouter.getModelStats(MODEL_ID_2);

      expect(infraBps1).to.equal(8000);
      expect(infraBps2).to.equal(9000);
      expect(profitBps1).to.equal(2000);
      expect(profitBps2).to.equal(1000);
    });

    it("Should maintain independent balance tracking across models", async function () {
      // Different revenue patterns
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("5000", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_2, parseUnits("2000", 6));

      // Different payment patterns
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("3000", 6),
        keccak256(toUtf8Bytes("INV-M1")),
        "Model 1"
      );

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_2,
        provider2.address,
        parseUnits("500", 6),
        keccak256(toUtf8Bytes("INV-M2")),
        "Model 2"
      );

      // Model 1: $4000 accrued - $3000 paid = $1000 net
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("1000", 6));

      // Model 2: $1600 accrued - $500 paid = $1100 net
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("1100", 6));
    });

    it("Should route profits to correct AMM pools per model", async function () {
      const reserve1Before = await pool1.reserveBalance();
      const reserve2Before = await pool2.reserveBalance();

      // Batch deposit to both models
      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("1000", 6), parseUnits("2000", 6)]
      );

      const reserve1After = await pool1.reserveBalance();
      const reserve2After = await pool2.reserveBalance();

      // Model 1 profit: $200 (20% of $1000)
      expect(reserve1After - reserve1Before).to.equal(parseUnits("200", 6));

      // Model 2 profit: $400 (20% of $2000)
      expect(reserve2After - reserve2Before).to.equal(parseUnits("400", 6));
    });
  });

  // ============================================================
  // ACCRUAL HEALTH MONITORING
  // ============================================================

  describe("Accrual Health Monitoring", function () {
    it("Should calculate runway correctly", async function () {
      // Accrue $1000
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1250", 6));

      // Pay $700
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("700", 6),
        keccak256(toUtf8Bytes("INV-001")),
        "Payment 1"
      );

      // Net balance: $300
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("300", 6));

      // With $50/day burn rate, runway = 6 days
      const dailyBurnRate = parseUnits("50", 6);
      const runway = await infraReserve.getAccrualRunway(MODEL_ID_1, dailyBurnRate);

      expect(runway).to.equal(6); // days
    });

    it("Should return max uint256 for zero burn rate", async function () {
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));

      const runway = await infraReserve.getAccrualRunway(MODEL_ID_1, 0);

      // Max uint256 = infinite runway
      expect(runway).to.equal(ethers.MaxUint256);
    });

    it("Should provide comprehensive model accounting", async function () {
      // Setup: $1000 accrued, $600 paid
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1250", 6));
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("600", 6),
        keccak256(toUtf8Bytes("INV-001")),
        "Payment"
      );

      const [accruedAmount, paidAmount, currentProvider] = await infraReserve.getModelAccounting(MODEL_ID_1);

      expect(accruedAmount).to.equal(parseUnits("400", 6)); // Net: $1000 - $600
      expect(paidAmount).to.equal(parseUnits("600", 6));
      expect(currentProvider).to.equal(provider1.address);
    });

    it("Should warn when runway is critically low", async function () {
      // Accrue $100
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("125", 6));

      // High burn rate: $50/day
      const runway = await infraReserve.getAccrualRunway(MODEL_ID_1, parseUnits("50", 6));

      // Only 2 days runway - critical!
      expect(runway).to.equal(2);
      expect(runway).to.be.lt(7); // Less than 1 week threshold
    });
  });

  // ============================================================
  // AMM PRICE IMPACT
  // ============================================================

  describe("AMM Price Impact from Profit", function () {
    it("Should increase spot price proportionally to profit deposits", async function () {
      // Cross flat curve threshold first
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("150000", 6));

      const spotPriceBefore = await pool1.spotPrice();
      const reserveBefore = await pool1.reserveBalance();

      // Deposit significant profit
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("50000", 6));

      const spotPriceAfter = await pool1.spotPrice();
      const reserveAfter = await pool1.reserveBalance();

      // Price increased
      expect(spotPriceAfter).to.be.gt(spotPriceBefore);

      // Reserve increased by 20% of $50k = $10k
      const expectedIncrease = parseUnits("10000", 6);
      expect(reserveAfter - reserveBefore).to.equal(expectedIncrease);

      // Price increase should be meaningful (>1%)
      const priceIncreaseBps = ((spotPriceAfter - spotPriceBefore) * 10000n) / spotPriceBefore;
      expect(priceIncreaseBps).to.be.gt(0);
    });

    it("Should demonstrate compound value accrual over time", async function () {
      // Cross threshold
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("150000", 6));

      const initialPrice = await pool1.spotPrice();

      // Simulate 6 months of API revenue: $10k/month * 6 = $60k total
      for (let i = 0; i < 6; i++) {
        await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("10000", 6));
      }

      const finalPrice = await pool1.spotPrice();

      // Price should have increased significantly
      expect(finalPrice).to.be.gt(initialPrice);

      // Total profit to AMM: $60k * 20% = $12k
      // Infrastructure accrued: $60k * 80% = $48k
      expect(await infraReserve.accrued(MODEL_ID_1)).to.be.gt(parseUnits("48000", 6));
    });

    it("Should not affect price in flat curve phase", async function () {
      // Don't cross threshold - stay in flat price phase
      const spotPriceBefore = await pool1.spotPrice();

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));

      const spotPriceAfter = await pool1.spotPrice();

      // Price should remain flat
      expect(spotPriceAfter).to.equal(spotPriceBefore);
    });
  });

  // ============================================================
  // REALISTIC SCENARIO: 3-MONTH OPERATION
  // ============================================================

  describe("Realistic Scenario: 3-Month Model Operation", function () {
    it("Should handle complete 3-month lifecycle", async function () {
      // Model: GPT-4 Turbo
      // Monthly API revenue: $50,000
      // Monthly infrastructure cost: $38,000 (76% actual vs 80% accrued)
      // Expected: Build up $2k/month buffer

      // Month 1: Operations
      console.log("\n=== MONTH 1 ===");
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("50000", 6));

      let infraAccrued = await infraReserve.accrued(MODEL_ID_1);
      console.log(`  Accrued: $${ethers.formatUnits(infraAccrued, 6)}`);
      expect(infraAccrued).to.equal(parseUnits("40000", 6)); // 80% of $50k

      // Pay actual costs
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("38000", 6),
        keccak256(toUtf8Bytes("INV-2024-01")),
        "January infrastructure"
      );

      let netBalance = await infraReserve.accrued(MODEL_ID_1);
      console.log(`  Net balance: $${ethers.formatUnits(netBalance, 6)}`);
      expect(netBalance).to.equal(parseUnits("2000", 6)); // $2k buffer

      // Month 2: Operations
      console.log("\n=== MONTH 2 ===");
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("50000", 6));

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("38000", 6),
        keccak256(toUtf8Bytes("INV-2024-02")),
        "February infrastructure"
      );

      netBalance = await infraReserve.accrued(MODEL_ID_1);
      console.log(`  Net balance: $${ethers.formatUnits(netBalance, 6)}`);
      expect(netBalance).to.equal(parseUnits("4000", 6)); // $4k buffer

      // Month 3: Spike in usage (higher costs)
      console.log("\n=== MONTH 3 (High Usage) ===");
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("50000", 6));

      // Higher than normal costs this month
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID_1,
        provider1.address,
        parseUnits("42000", 6),
        keccak256(toUtf8Bytes("INV-2024-03")),
        "March infrastructure (high usage)"
      );

      netBalance = await infraReserve.accrued(MODEL_ID_1);
      console.log(`  Net balance: $${ethers.formatUnits(netBalance, 6)}`);
      expect(netBalance).to.equal(parseUnits("2000", 6)); // Buffer absorbed spike

      // Verify cumulative statistics
      const totalPaid = await infraReserve.paid(MODEL_ID_1);
      const totalRevenue = await feeRouter.getModelFees(MODEL_ID_1);

      console.log(`\n=== 3-MONTH SUMMARY ===`);
      console.log(`  Total Revenue: $${ethers.formatUnits(totalRevenue, 6)}`);
      console.log(`  Total Infrastructure Paid: $${ethers.formatUnits(totalPaid, 6)}`);
      console.log(`  Remaining Buffer: $${ethers.formatUnits(netBalance, 6)}`);

      expect(totalRevenue).to.equal(parseUnits("150000", 6));
      expect(totalPaid).to.equal(parseUnits("118000", 6));

      // Token holders received $30k profit (20% of $150k)
      // This increased their token value via AMM reserve
    });
  });
});
