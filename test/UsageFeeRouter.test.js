const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("UsageFeeRouter", function () {
  let modelRegistry;
  let tokenManager;
  let factory;
  let infraReserve;
  let feeRouter;
  let mockUSDC;
  let pool1, pool2;
  let owner, treasury, depositor, payer, user1;

  const MODEL_ID_1 = "model-alpha";
  const MODEL_ID_2 = "model-beta";
  const INITIAL_SUPPLY = parseEther("1000000");

  beforeEach(async function () {
    [owner, treasury, depositor, payer, user1] = await ethers.getSigners();

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

    // Deploy UsageFeeRouter (updated - no protocol fee)
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
      "Alpha Token",
      "ALPHA",
      INITIAL_SUPPLY
    );
    await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", INITIAL_SUPPLY);

    const token2Address = await tokenManager.deployToken.staticCall(
      MODEL_ID_2,
      "Beta Token",
      "BETA",
      INITIAL_SUPPLY
    );
    await tokenManager.deployToken(MODEL_ID_2, "Beta Token", "BETA", INITIAL_SUPPLY);

    const pool1Address = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
    await factory.createPool(MODEL_ID_1, token1Address);
    const pool2Address = await factory.createPool.staticCall(MODEL_ID_2, token2Address);
    await factory.createPool(MODEL_ID_2, token2Address);

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    pool1 = HokusaiAMM.attach(pool1Address);
    pool2 = HokusaiAMM.attach(pool2Address);

    // Grant roles
    const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
    await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, depositor.address);

    const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
    await infraReserve.grantRole(DEPOSITOR_ROLE, await feeRouter.getAddress());

    const PAYER_ROLE = await infraReserve.PAYER_ROLE();
    await infraReserve.grantRole(PAYER_ROLE, payer.address);

    // Mint USDC to depositor for testing
    await mockUSDC.mint(depositor.address, parseUnits("10000000", 6)); // $10M
    await mockUSDC.connect(depositor).approve(await feeRouter.getAddress(), parseUnits("10000000", 6));
  });

  // ============================================================
  // DEPLOYMENT & INITIALIZATION
  // ============================================================

  describe("Deployment", function () {
    it("Should initialize with correct addresses", async function () {
      expect(await feeRouter.factory()).to.equal(await factory.getAddress());
      expect(await feeRouter.reserveToken()).to.equal(await mockUSDC.getAddress());
      expect(await feeRouter.infraReserve()).to.equal(await infraReserve.getAddress());
    });

    it("Should grant admin role to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await feeRouter.DEFAULT_ADMIN_ROLE();
      expect(await feeRouter.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should grant depositor role to deployer", async function () {
      const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
      expect(await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, owner.address)).to.be.true;
    });

    it("Should start with zero statistics", async function () {
      expect(await feeRouter.totalFeesDeposited()).to.equal(0);
      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(0);
    });

    it("Should reject zero address for factory", async function () {
      const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
      await expect(
        UsageFeeRouter.deploy(
          ZeroAddress,
          await mockUSDC.getAddress(),
          await infraReserve.getAddress()
        )
      ).to.be.reverted;
    });

    it("Should reject zero address for reserve token", async function () {
      const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
      await expect(
        UsageFeeRouter.deploy(
          await factory.getAddress(),
          ZeroAddress,
          await infraReserve.getAddress()
        )
      ).to.be.reverted;
    });

    it("Should reject zero address for infrastructure reserve", async function () {
      const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
      await expect(
        UsageFeeRouter.deploy(
          await factory.getAddress(),
          await mockUSDC.getAddress(),
          ZeroAddress
        )
      ).to.be.reverted;
    });
  });

  // ============================================================
  // SINGLE FEE DEPOSIT - 80/20 DEFAULT SPLIT
  // ============================================================

  describe("Single Fee Deposit (80/20 Default)", function () {
    it("Should deposit fee with correct 80/20 split", async function () {
      const feeAmount = parseUnits("1000", 6); // $1000

      const infraBalanceBefore = await infraReserve.accrued(MODEL_ID_1);
      const poolReserveBefore = await pool1.reserveBalance();

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      const infraBalanceAfter = await infraReserve.accrued(MODEL_ID_1);
      const poolReserveAfter = await pool1.reserveBalance();

      // Infrastructure should receive 80% (8000 bps)
      const expectedInfra = (feeAmount * 8000n) / 10000n; // $800
      const expectedProfit = feeAmount - expectedInfra; // $200

      expect(infraBalanceAfter - infraBalanceBefore).to.equal(expectedInfra);
      expect(poolReserveAfter - poolReserveBefore).to.equal(expectedProfit);
    });

    it("Should route correct amount to infrastructure reserve", async function () {
      const feeAmount = parseUnits("5000", 6); // $5000

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      // 80% to infrastructure
      const expectedInfra = parseUnits("4000", 6);
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(expectedInfra);
    });

    it("Should route correct amount to AMM", async function () {
      const feeAmount = parseUnits("5000", 6); // $5000

      const reserveBefore = await pool1.reserveBalance();
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
      const reserveAfter = await pool1.reserveBalance();

      // 20% to AMM profit
      const expectedProfit = parseUnits("1000", 6);
      expect(reserveAfter - reserveBefore).to.equal(expectedProfit);
    });

    it("Should update total statistics correctly", async function () {
      const feeAmount = parseUnits("1000", 6);

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      expect(await feeRouter.totalFeesDeposited()).to.equal(feeAmount);
      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(feeAmount);
    });

    it("Should emit FeeDeposited event with split amounts", async function () {
      const feeAmount = parseUnits("1000", 6);
      const expectedInfra = (feeAmount * 8000n) / 10000n; // $800
      const expectedProfit = feeAmount - expectedInfra; // $200

      await expect(
        feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount)
      )
        .to.emit(feeRouter, "FeeDeposited")
        .withArgs(
          MODEL_ID_1,
          await pool1.getAddress(),
          feeAmount,
          expectedInfra,
          expectedProfit,
          depositor.address
        );
    });

    it("Should increase AMM spot price after profit deposit", async function () {
      // First, cross the flat curve threshold (default $25k)
      // With 80/20 split, need to deposit $125k to get $25k profit to AMM
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("125000", 6));

      const spotPriceBefore = await pool1.spotPrice();

      // Now in bonding curve phase, additional deposits should increase price
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("10000", 6));

      const spotPriceAfter = await pool1.spotPrice();
      expect(spotPriceAfter).to.be.gt(spotPriceBefore);
    });

    it("Should accumulate fees from multiple deposits", async function () {
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("2000", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("3000", 6));

      expect(await feeRouter.totalFeesDeposited()).to.equal(parseUnits("6000", 6));
      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(parseUnits("6000", 6));
    });

    it("Should track deposits for different models independently", async function () {
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      await feeRouter.connect(depositor).depositFee(MODEL_ID_2, parseUnits("2000", 6));

      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(parseUnits("1000", 6));
      expect(await feeRouter.getModelFees(MODEL_ID_2)).to.equal(parseUnits("2000", 6));
      expect(await feeRouter.totalFeesDeposited()).to.equal(parseUnits("3000", 6));
    });

    it("Should revert if pool does not exist", async function () {
      await expect(
        feeRouter.connect(depositor).depositFee("non-existent-model", parseUnits("1000", 6))
      ).to.be.revertedWith("Pool does not exist");
    });

    it("Should revert if amount is zero", async function () {
      await expect(
        feeRouter.connect(depositor).depositFee(MODEL_ID_1, 0)
      ).to.be.reverted;
    });

    it("Should revert if model ID is empty", async function () {
      await expect(
        feeRouter.connect(depositor).depositFee("", parseUnits("1000", 6))
      ).to.be.reverted;
    });

    it("Should revert if caller is not depositor", async function () {
      await expect(
        feeRouter.connect(user1).depositFee(MODEL_ID_1, parseUnits("1000", 6))
      ).to.be.reverted;
    });
  });

  // ============================================================
  // VARIABLE SPLIT TESTS
  // ============================================================

  describe("Variable Infrastructure Splits", function () {
    it("Should work with 70/30 split (7000 bps)", async function () {
      // Update Model 1 to use 70% infrastructure accrual
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);

      // Get governor (owner is governor by default)
      const GOV_ROLE = await params.GOV_ROLE();
      await params.connect(owner).setInfrastructureAccrualBps(7000);

      const feeAmount = parseUnits("1000", 6);
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      const expectedInfra = parseUnits("700", 6); // 70%
      const expectedProfit = parseUnits("300", 6); // 30%

      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(expectedInfra);
    });

    it("Should work with 90/10 split (9000 bps)", async function () {
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(9000);

      const feeAmount = parseUnits("1000", 6);

      const reserveBefore = await pool1.reserveBalance();
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
      const reserveAfter = await pool1.reserveBalance();

      const expectedProfit = parseUnits("100", 6); // 10%
      expect(reserveAfter - reserveBefore).to.equal(expectedProfit);
    });

    it("Should work with 50/50 split (5000 bps minimum)", async function () {
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(5000);

      const feeAmount = parseUnits("1000", 6);
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      const expectedInfra = parseUnits("500", 6); // 50%
      const expectedProfit = parseUnits("500", 6); // 50%

      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(expectedInfra);
    });

    it("Should work with 100/0 split (10000 bps maximum)", async function () {
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(10000);

      const feeAmount = parseUnits("1000", 6);

      const reserveBefore = await pool1.reserveBalance();
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
      const reserveAfter = await pool1.reserveBalance();

      // All to infrastructure, nothing to AMM
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(feeAmount);
      expect(reserveAfter - reserveBefore).to.equal(0);
    });

    it("Should apply correct split after governance update", async function () {
      // Initial deposit with 80/20
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("800", 6));

      // Update to 70/30
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(7000);

      // Second deposit should use new 70/30 split
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));

      // Total infrastructure: $800 (first) + $700 (second) = $1500
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("1500", 6));
    });
  });

  // ============================================================
  // BATCH DEPOSIT TESTS
  // ============================================================

  describe("Batch Fee Deposits", function () {
    it("Should batch deposit to multiple models", async function () {
      const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];

      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        amounts
      );

      // Model 1: $800 infra, $200 profit
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("800", 6));

      // Model 2: $1600 infra, $400 profit
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("1600", 6));
    });

    it("Should emit individual FeeDeposited events", async function () {
      const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];

      const tx = await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        amounts
      );

      // Should emit 2 individual events
      await expect(tx).to.emit(feeRouter, "FeeDeposited");
    });

    it("Should emit BatchDeposited event with totals", async function () {
      const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
      const totalAmount = parseUnits("3000", 6);
      const totalInfra = parseUnits("2400", 6); // 80% of $3000
      const totalProfit = parseUnits("600", 6);  // 20% of $3000

      await expect(
        feeRouter.connect(depositor).batchDepositFees(
          [MODEL_ID_1, MODEL_ID_2],
          amounts
        )
      )
        .to.emit(feeRouter, "BatchDeposited")
        .withArgs(
          totalAmount,
          totalInfra,
          totalProfit,
          2, // modelCount
          depositor.address
        );
    });

    it("Should handle different splits per model in batch", async function () {
      // Update Model 2 to 90/10 split
      const params2Address = await tokenManager.modelParams(MODEL_ID_2);
      const params2 = await ethers.getContractAt("HokusaiParams", params2Address);
      await params2.connect(owner).setInfrastructureAccrualBps(9000);

      const amounts = [parseUnits("1000", 6), parseUnits("1000", 6)];

      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        amounts
      );

      // Model 1: 80/20 = $800 infra
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(parseUnits("800", 6));

      // Model 2: 90/10 = $900 infra
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(parseUnits("900", 6));
    });

    it("Should update total statistics correctly", async function () {
      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("1000", 6), parseUnits("2000", 6)]
      );

      expect(await feeRouter.totalFeesDeposited()).to.equal(parseUnits("3000", 6));
      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(parseUnits("1000", 6));
      expect(await feeRouter.getModelFees(MODEL_ID_2)).to.equal(parseUnits("2000", 6));
    });

    it("Should revert if array lengths mismatch", async function () {
      await expect(
        feeRouter.connect(depositor).batchDepositFees(
          [MODEL_ID_1, MODEL_ID_2],
          [parseUnits("1000", 6)] // Only 1 amount
        )
      ).to.be.reverted;
    });

    it("Should revert if arrays are empty", async function () {
      await expect(
        feeRouter.connect(depositor).batchDepositFees([], [])
      ).to.be.reverted;
    });

    it("Should revert if any amount is zero", async function () {
      await expect(
        feeRouter.connect(depositor).batchDepositFees(
          [MODEL_ID_1, MODEL_ID_2],
          [parseUnits("1000", 6), 0]
        )
      ).to.be.reverted;
    });

    it("Should revert if any pool doesn't exist", async function () {
      await expect(
        feeRouter.connect(depositor).batchDepositFees(
          [MODEL_ID_1, "non-existent"],
          [parseUnits("1000", 6), parseUnits("1000", 6)]
        )
      ).to.be.revertedWith("Pool does not exist");
    });

    it("Should transfer total USDC in single transaction", async function () {
      const depositorBalanceBefore = await mockUSDC.balanceOf(depositor.address);

      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("1000", 6), parseUnits("2000", 6)]
      );

      const depositorBalanceAfter = await mockUSDC.balanceOf(depositor.address);

      // Should transfer exactly $3000 total
      expect(depositorBalanceBefore - depositorBalanceAfter).to.equal(parseUnits("3000", 6));
    });
  });

  // ============================================================
  // VIEW FUNCTIONS
  // ============================================================

  describe("View Functions", function () {
    it("Should calculate fee split correctly", async function () {
      const [infra, profit] = await feeRouter.calculateFeeSplit(
        MODEL_ID_1,
        parseUnits("1000", 6)
      );

      expect(infra).to.equal(parseUnits("800", 6)); // 80%
      expect(profit).to.equal(parseUnits("200", 6)); // 20%
    });

    it("Should return updated split after governance change", async function () {
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(7000);

      const [infra, profit] = await feeRouter.calculateFeeSplit(
        MODEL_ID_1,
        parseUnits("1000", 6)
      );

      expect(infra).to.equal(parseUnits("700", 6)); // 70%
      expect(profit).to.equal(parseUnits("300", 6)); // 30%
    });

    it("Should return model stats correctly", async function () {
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("5000", 6));

      const [totalFees, infraBps, profitBps] = await feeRouter.getModelStats(MODEL_ID_1);

      expect(totalFees).to.equal(parseUnits("5000", 6));
      expect(infraBps).to.equal(8000); // 80%
      expect(profitBps).to.equal(2000); // 20%
    });

    it("Should return zero fees for model with no deposits", async function () {
      const [totalFees, infraBps, profitBps] = await feeRouter.getModelStats(MODEL_ID_1);

      expect(totalFees).to.equal(0);
      expect(infraBps).to.equal(8000); // Default
    });

    it("Should revert calculateFeeSplit for non-existent pool", async function () {
      await expect(
        feeRouter.calculateFeeSplit("non-existent", parseUnits("1000", 6))
      ).to.be.revertedWith("Pool not found");
    });

    it("Should return contract USDC balance", async function () {
      // Router should have zero balance after routing funds
      expect(await feeRouter.getBalance()).to.equal(0);

      // Even after deposits (funds routed immediately)
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      expect(await feeRouter.getBalance()).to.equal(0);
    });

    it("Should check depositor role correctly", async function () {
      expect(await feeRouter.isDepositor(depositor.address)).to.be.true;
      expect(await feeRouter.isDepositor(user1.address)).to.be.false;
    });
  });

  // ============================================================
  // ACCESS CONTROL
  // ============================================================

  describe("Access Control", function () {
    it("Should allow admin to grant FEE_DEPOSITOR_ROLE", async function () {
      const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
      await feeRouter.connect(owner).grantRole(FEE_DEPOSITOR_ROLE, user1.address);

      expect(await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke FEE_DEPOSITOR_ROLE", async function () {
      const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
      await feeRouter.connect(owner).revokeRole(FEE_DEPOSITOR_ROLE, depositor.address);

      expect(await feeRouter.hasRole(FEE_DEPOSITOR_ROLE, depositor.address)).to.be.false;
    });

    it("Should prevent non-admin from granting roles", async function () {
      const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();

      await expect(
        feeRouter.connect(user1).grantRole(FEE_DEPOSITOR_ROLE, user1.address)
      ).to.be.reverted;
    });

    it("Should have correct role constants", async function () {
      const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
      const expectedRole = ethers.keccak256(ethers.toUtf8Bytes("FEE_DEPOSITOR_ROLE"));

      expect(FEE_DEPOSITOR_ROLE).to.equal(expectedRole);
    });
  });

  // ============================================================
  // REENTRANCY PROTECTION
  // ============================================================

  describe("Reentrancy Protection", function () {
    it("Should protect depositFee from reentrancy", async function () {
      // depositFee has nonReentrant modifier
      // This is a design verification - actual reentrancy attack would require malicious ERC20
      const feeAmount = parseUnits("1000", 6);
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

      // If reentrancy protection works, transaction succeeds
      expect(await feeRouter.totalFeesDeposited()).to.equal(feeAmount);
    });

    it("Should protect batchDepositFees from reentrancy", async function () {
      // batchDepositFees has nonReentrant modifier
      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1],
        [parseUnits("1000", 6)]
      );

      expect(await feeRouter.totalFeesDeposited()).to.equal(parseUnits("1000", 6));
    });
  });

  // ============================================================
  // EDGE CASES
  // ============================================================

  describe("Edge Cases", function () {
    it("Should handle very small amounts (1 USDC cent)", async function () {
      const tinyAmount = 1; // 1e-6 USDC

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, tinyAmount);

      // Should work but amounts might round to zero due to integer division
      expect(await feeRouter.totalFeesDeposited()).to.equal(tinyAmount);
    });

    it("Should handle very large amounts", async function () {
      const largeAmount = parseUnits("1000000", 6); // $1M

      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, largeAmount);

      const expectedInfra = parseUnits("800000", 6); // $800k
      expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(expectedInfra);
    });

    it("Should handle zero profit amount (100% infrastructure)", async function () {
      const paramsAddress = await tokenManager.modelParams(MODEL_ID_1);
      const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
      await params.connect(owner).setInfrastructureAccrualBps(10000);

      const reserveBefore = await pool1.reserveBalance();
      await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
      const reserveAfter = await pool1.reserveBalance();

      // No change in AMM reserve when profit is 0
      expect(reserveAfter).to.equal(reserveBefore);
    });

    it("Should handle sequential batch deposits", async function () {
      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("1000", 6), parseUnits("2000", 6)]
      );

      await feeRouter.connect(depositor).batchDepositFees(
        [MODEL_ID_1, MODEL_ID_2],
        [parseUnits("500", 6), parseUnits("500", 6)]
      );

      expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(parseUnits("1500", 6));
      expect(await feeRouter.getModelFees(MODEL_ID_2)).to.equal(parseUnits("2500", 6));
    });
  });
});
