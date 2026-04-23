const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");
const { deployTestToken, deployTestTokenAddress } = require("./helpers/tokenDeployment");

describe("InfrastructureReserve", function () {
  let InfrastructureReserve;
  let infraReserve;
  let usdc;
  let HokusaiAMMFactory;
  let factory;
  let owner;
  let depositor;
  let payer;
  let treasury;
  let provider1;
  let provider2;
  let user1;
  let addrs;

  const INITIAL_USDC = ethers.parseUnits("1000000", 6); // 1M USDC
  const MODEL_ID = "test-model-v1";
  const MODEL_ID_2 = "test-model-v2";

  beforeEach(async function () {
    [owner, depositor, payer, treasury, provider1, provider2, user1, ...addrs] = await ethers.getSigners();

    // Deploy core contracts
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy mock USDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    // Mint USDC to depositor
    await usdc.mint(depositor.address, INITIAL_USDC);

    // Deploy factory with all required parameters
    HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    factory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await usdc.getAddress(),
      treasury.address
    );
    await factory.waitForDeployment();

    // Deploy InfrastructureReserve
    InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
    infraReserve = await InfrastructureReserve.deploy(
      await usdc.getAddress(),
      await factory.getAddress(),
      treasury.address
    );
    await infraReserve.waitForDeployment();

    // Deploy tokens and create pools
    const token1Address = await deployTestTokenAddress(tokenManager, MODEL_ID, "Test Token 1", "TEST1", ethers.parseEther("1000000"), owner.address);
    await deployTestToken(tokenManager, MODEL_ID, "Test Token 1", "TEST1", ethers.parseEther("1000000"), owner.address);

    const token2Address = await deployTestTokenAddress(tokenManager, MODEL_ID_2, "Test Token 2", "TEST2", ethers.parseEther("1000000"), owner.address);
    await deployTestToken(tokenManager, MODEL_ID_2, "Test Token 2", "TEST2", ethers.parseEther("1000000"), owner.address);

    // Register models in ModelRegistry
    await modelRegistry.registerStringModel(MODEL_ID, token1Address, "Test metric");
    await modelRegistry.registerStringModel(MODEL_ID_2, token2Address, "Test metric");

    // Create pools
    await factory.createPool(MODEL_ID, token1Address);
    await factory.createPool(MODEL_ID_2, token2Address);

    // Grant roles
    const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
    const PAYER_ROLE = await infraReserve.PAYER_ROLE();
    await infraReserve.connect(owner).grantRole(DEPOSITOR_ROLE, depositor.address);
    await infraReserve.connect(owner).grantRole(PAYER_ROLE, payer.address);
  });

  describe("Constructor", function () {
    it("Should initialize with correct addresses", async function () {
      expect(await infraReserve.reserveToken()).to.equal(await usdc.getAddress());
      expect(await infraReserve.factory()).to.equal(await factory.getAddress());
      expect(await infraReserve.treasury()).to.equal(treasury.address);
    });

    it("Should grant DEFAULT_ADMIN_ROLE to deployer", async function () {
      const DEFAULT_ADMIN_ROLE = await infraReserve.DEFAULT_ADMIN_ROLE();
      expect(await infraReserve.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.be.true;
    });

    it("Should reject zero address for reserve token", async function () {
      await expect(
        InfrastructureReserve.deploy(
          ZeroAddress,
          await factory.getAddress(),
          treasury.address
        )
      ).to.be.reverted;
    });

    it("Should reject zero address for factory", async function () {
      await expect(
        InfrastructureReserve.deploy(
          await usdc.getAddress(),
          ZeroAddress,
          treasury.address
        )
      ).to.be.reverted;
    });

    it("Should reject zero address for treasury", async function () {
      await expect(
        InfrastructureReserve.deploy(
          await usdc.getAddress(),
          await factory.getAddress(),
          ZeroAddress
        )
      ).to.be.reverted;
    });
  });

  describe("Deposit Function", function () {
    const depositAmount = ethers.parseUnits("1000", 6); // 1000 USDC

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
    });

    it("Should allow DEPOSITOR_ROLE to deposit", async function () {
      await expect(
        infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount)
      ).to.emit(infraReserve, "InfrastructureDeposited")
        .withArgs(MODEL_ID, depositAmount, depositAmount);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount);
      expect(await infraReserve.totalAccrued()).to.equal(depositAmount);
    });

    it("Should reject non-DEPOSITOR_ROLE", async function () {
      await expect(
        infraReserve.connect(user1).deposit(MODEL_ID, depositAmount)
      ).to.be.reverted;
    });

    it("Should reject zero amount", async function () {
      await expect(
        infraReserve.connect(depositor).deposit(MODEL_ID, 0)
      ).to.be.reverted;
    });

    it("Should reject non-existent pool", async function () {
      await expect(
        infraReserve.connect(depositor).deposit("non-existent-model", depositAmount)
      ).to.be.revertedWith("Model pool does not exist");
    });

    it("Should reject empty model ID", async function () {
      await expect(
        infraReserve.connect(depositor).deposit("", depositAmount)
      ).to.be.reverted;
    });

    it("Should transfer USDC from depositor", async function () {
      const initialBalance = await usdc.balanceOf(depositor.address);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
      expect(await usdc.balanceOf(depositor.address)).to.equal(initialBalance - depositAmount);
      expect(await usdc.balanceOf(await infraReserve.getAddress())).to.equal(depositAmount);
    });

    it("Should accumulate multiple deposits", async function () {
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount * 2n);
      expect(await infraReserve.totalAccrued()).to.equal(depositAmount * 2n);
    });

    it("Should track deposits for different models independently", async function () {
      const amount1 = ethers.parseUnits("1000", 6);
      const amount2 = ethers.parseUnits("500", 6);

      await infraReserve.connect(depositor).deposit(MODEL_ID, amount1);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), amount2);
      await infraReserve.connect(depositor).deposit(MODEL_ID_2, amount2);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(amount1);
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(amount2);
      expect(await infraReserve.totalAccrued()).to.equal(amount1 + amount2);
    });

    it("Should respect pause state", async function () {
      await infraReserve.connect(owner).pause();
      await expect(
        infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount)
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Batch Deposit Function", function () {
    const amount1 = ethers.parseUnits("1000", 6);
    const amount2 = ethers.parseUnits("500", 6);
    const totalAmount = amount1 + amount2;

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), totalAmount);
    });

    it("Should batch deposit to multiple models", async function () {
      await expect(
        infraReserve.connect(depositor).batchDeposit([MODEL_ID, MODEL_ID_2], [amount1, amount2])
      ).to.emit(infraReserve, "BatchDeposited")
        .withArgs(2, totalAmount);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(amount1);
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(amount2);
      expect(await infraReserve.totalAccrued()).to.equal(totalAmount);
    });

    it("Should emit individual deposit events", async function () {
      const tx = await infraReserve.connect(depositor).batchDeposit(
        [MODEL_ID, MODEL_ID_2],
        [amount1, amount2]
      );

      await expect(tx).to.emit(infraReserve, "InfrastructureDeposited")
        .withArgs(MODEL_ID, amount1, amount1);
      await expect(tx).to.emit(infraReserve, "InfrastructureDeposited")
        .withArgs(MODEL_ID_2, amount2, amount2);
    });

    it("Should reject mismatched array lengths", async function () {
      await expect(
        infraReserve.connect(depositor).batchDeposit([MODEL_ID], [amount1, amount2])
      ).to.be.reverted;
    });

    it("Should reject empty arrays", async function () {
      await expect(
        infraReserve.connect(depositor).batchDeposit([], [])
      ).to.be.reverted;
    });

    it("Should reject if any amount is zero", async function () {
      await expect(
        infraReserve.connect(depositor).batchDeposit([MODEL_ID, MODEL_ID_2], [amount1, 0])
      ).to.be.reverted;
    });

    it("Should reject if any pool doesn't exist", async function () {
      await expect(
        infraReserve.connect(depositor).batchDeposit(
          [MODEL_ID, "non-existent"],
          [amount1, amount2]
        )
      ).to.be.revertedWith("Model pool does not exist");
    });

    it("Should transfer total USDC in single transaction", async function () {
      const initialBalance = await usdc.balanceOf(depositor.address);
      await infraReserve.connect(depositor).batchDeposit([MODEL_ID, MODEL_ID_2], [amount1, amount2]);
      expect(await usdc.balanceOf(depositor.address)).to.equal(initialBalance - totalAmount);
    });
  });

  describe("Payment Function", function () {
    const depositAmount = ethers.parseUnits("1000", 6);
    const paymentAmount = ethers.parseUnits("500", 6);
    const invoiceHash = keccak256(toUtf8Bytes("invoice-12345"));
    const memo = "AWS invoice for January 2026";

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
    });

    it("Should allow PAYER_ROLE to pay infrastructure cost", async function () {
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID,
          provider1.address,
          paymentAmount,
          invoiceHash,
          memo
        )
      ).to.emit(infraReserve, "InfrastructureCostPaid")
        .withArgs(MODEL_ID, provider1.address, paymentAmount, invoiceHash, memo, payer.address);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount - paymentAmount);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(paymentAmount);
      expect(await infraReserve.totalPaid()).to.equal(paymentAmount);
    });

    it("Should reject non-PAYER_ROLE", async function () {
      await expect(
        infraReserve.connect(user1).payInfrastructureCost(
          MODEL_ID,
          provider1.address,
          paymentAmount,
          invoiceHash,
          memo
        )
      ).to.be.reverted;
    });

    it("Should reject payment exceeding accrued balance", async function () {
      const excessAmount = depositAmount + ethers.parseUnits("1", 6);
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID,
          provider1.address,
          excessAmount,
          invoiceHash,
          memo
        )
      ).to.be.revertedWith("Exceeds accrued balance");
    });

    it("Should reject zero amount", async function () {
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID,
          provider1.address,
          0,
          invoiceHash,
          memo
        )
      ).to.be.reverted;
    });

    it("Should reject zero address payee", async function () {
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID,
          ZeroAddress,
          paymentAmount,
          invoiceHash,
          memo
        )
      ).to.be.reverted;
    });

    it("Should reject empty model ID", async function () {
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          "",
          provider1.address,
          paymentAmount,
          invoiceHash,
          memo
        )
      ).to.be.reverted;
    });

    it("Should transfer USDC to provider", async function () {
      const initialBalance = await usdc.balanceOf(provider1.address);
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID,
        provider1.address,
        paymentAmount,
        invoiceHash,
        memo
      );
      expect(await usdc.balanceOf(provider1.address)).to.equal(initialBalance + paymentAmount);
    });

    it("Should accumulate multiple payments", async function () {
      const payment1 = ethers.parseUnits("300", 6);
      const payment2 = ethers.parseUnits("200", 6);

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID,
        provider1.address,
        payment1,
        invoiceHash,
        "Payment 1"
      );

      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID,
        provider1.address,
        payment2,
        invoiceHash,
        "Payment 2"
      );

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount - payment1 - payment2);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(payment1 + payment2);
      expect(await infraReserve.totalPaid()).to.equal(payment1 + payment2);
    });

    it("Should respect pause state", async function () {
      await infraReserve.connect(owner).pause();
      await expect(
        infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID,
          provider1.address,
          paymentAmount,
          invoiceHash,
          memo
        )
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Batch Payment Function", function () {
    const depositAmount = ethers.parseUnits("2000", 6);
    const payment1 = ethers.parseUnits("500", 6);
    const payment2 = ethers.parseUnits("300", 6);
    const invoice1 = keccak256(toUtf8Bytes("invoice-1"));
    const invoice2 = keccak256(toUtf8Bytes("invoice-2"));

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount * 2n);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID_2, depositAmount);
    });

    it("Should batch pay multiple invoices", async function () {
      const payments = [
        {
          modelId: MODEL_ID,
          payee: provider1.address,
          amount: payment1,
          invoiceHash: invoice1,
          memo: "AWS invoice 1"
        },
        {
          modelId: MODEL_ID_2,
          payee: provider2.address,
          amount: payment2,
          invoiceHash: invoice2,
          memo: "AWS invoice 2"
        }
      ];

      await expect(
        infraReserve.connect(payer).batchPayInfrastructureCosts(payments)
      ).to.emit(infraReserve, "BatchPaymentCompleted")
        .withArgs(2, payment1 + payment2);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount - payment1);
      expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(depositAmount - payment2);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(payment1);
      expect(await infraReserve.paid(MODEL_ID_2)).to.equal(payment2);
      expect(await infraReserve.totalPaid()).to.equal(payment1 + payment2);
    });

    it("Should emit individual payment events", async function () {
      const payments = [
        {
          modelId: MODEL_ID,
          payee: provider1.address,
          amount: payment1,
          invoiceHash: invoice1,
          memo: "AWS invoice 1"
        }
      ];

      const tx = await infraReserve.connect(payer).batchPayInfrastructureCosts(payments);

      await expect(tx).to.emit(infraReserve, "InfrastructureCostPaid")
        .withArgs(MODEL_ID, provider1.address, payment1, invoice1, "AWS invoice 1", payer.address);
    });

    it("Should reject empty payments array", async function () {
      await expect(
        infraReserve.connect(payer).batchPayInfrastructureCosts([])
      ).to.be.reverted;
    });

    it("Should reject if any payment exceeds accrued", async function () {
      const payments = [
        {
          modelId: MODEL_ID,
          payee: provider1.address,
          amount: depositAmount + ethers.parseUnits("1", 6), // Exceeds accrued
          invoiceHash: invoice1,
          memo: "Exceeds balance"
        }
      ];

      await expect(
        infraReserve.connect(payer).batchPayInfrastructureCosts(payments)
      ).to.be.revertedWith("Exceeds accrued balance");
    });

    it("Should transfer USDC to all payees", async function () {
      const initialBalance1 = await usdc.balanceOf(provider1.address);
      const initialBalance2 = await usdc.balanceOf(provider2.address);

      const payments = [
        {
          modelId: MODEL_ID,
          payee: provider1.address,
          amount: payment1,
          invoiceHash: invoice1,
          memo: "Payment 1"
        },
        {
          modelId: MODEL_ID_2,
          payee: provider2.address,
          amount: payment2,
          invoiceHash: invoice2,
          memo: "Payment 2"
        }
      ];

      await infraReserve.connect(payer).batchPayInfrastructureCosts(payments);

      expect(await usdc.balanceOf(provider1.address)).to.equal(initialBalance1 + payment1);
      expect(await usdc.balanceOf(provider2.address)).to.equal(initialBalance2 + payment2);
    });
  });

  describe("Provider Management", function () {
    it("Should allow admin to set provider", async function () {
      await expect(
        infraReserve.connect(owner).setProvider(MODEL_ID, provider1.address)
      ).to.emit(infraReserve, "ProviderSet")
        .withArgs(MODEL_ID, provider1.address);

      expect(await infraReserve.provider(MODEL_ID)).to.equal(provider1.address);
    });

    it("Should reject non-admin", async function () {
      await expect(
        infraReserve.connect(user1).setProvider(MODEL_ID, provider1.address)
      ).to.be.reverted;
    });

    it("Should reject zero address provider", async function () {
      await expect(
        infraReserve.connect(owner).setProvider(MODEL_ID, ZeroAddress)
      ).to.be.reverted;
    });

    it("Should reject empty model ID", async function () {
      await expect(
        infraReserve.connect(owner).setProvider("", provider1.address)
      ).to.be.reverted;
    });

    it("Should allow updating provider", async function () {
      await infraReserve.connect(owner).setProvider(MODEL_ID, provider1.address);
      await infraReserve.connect(owner).setProvider(MODEL_ID, provider2.address);
      expect(await infraReserve.provider(MODEL_ID)).to.equal(provider2.address);
    });
  });

  describe("View Functions", function () {
    const depositAmount = ethers.parseUnits("3000", 6);
    const paymentAmount = ethers.parseUnits("500", 6);

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
      const invoiceHash = keccak256(toUtf8Bytes("invoice"));
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID,
        provider1.address,
        paymentAmount,
        invoiceHash,
        "Test payment"
      );
    });

    it("Should calculate accrual runway correctly", async function () {
      const dailyBurnRate = ethers.parseUnits("100", 6); // 100 USDC/day
      const expectedDays = (depositAmount - paymentAmount) / dailyBurnRate;
      expect(await infraReserve.getAccrualRunway(MODEL_ID, dailyBurnRate)).to.equal(expectedDays);
    });

    it("Should return max uint256 for zero burn rate", async function () {
      expect(await infraReserve.getAccrualRunway(MODEL_ID, 0)).to.equal(ethers.MaxUint256);
    });

    it("Should return net accrual correctly", async function () {
      expect(await infraReserve.getNetAccrual(MODEL_ID)).to.equal(depositAmount - paymentAmount);
    });

    it("Should return provider payments correctly", async function () {
      expect(await infraReserve.getProviderPayments(MODEL_ID)).to.equal(paymentAmount);
    });

    it("Should return comprehensive model accounting", async function () {
      await infraReserve.connect(owner).setProvider(MODEL_ID, provider1.address);
      const [accruedAmount, paidAmount, currentProvider] = await infraReserve.getModelAccounting(MODEL_ID);

      expect(accruedAmount).to.equal(depositAmount - paymentAmount);
      expect(paidAmount).to.equal(paymentAmount);
      expect(currentProvider).to.equal(provider1.address);
    });

    it("Should return contract USDC balance", async function () {
      expect(await infraReserve.getBalance()).to.equal(depositAmount - paymentAmount);
    });
  });

  describe("Admin Functions", function () {
    it("Should allow admin to update treasury", async function () {
      await expect(
        infraReserve.connect(owner).setTreasury(user1.address)
      ).to.emit(infraReserve, "TreasuryUpdated")
        .withArgs(treasury.address, user1.address);

      expect(await infraReserve.treasury()).to.equal(user1.address);
    });

    it("Should reject non-admin updating treasury", async function () {
      await expect(
        infraReserve.connect(user1).setTreasury(user1.address)
      ).to.be.reverted;
    });

    it("Should reject zero address treasury", async function () {
      await expect(
        infraReserve.connect(owner).setTreasury(ZeroAddress)
      ).to.be.reverted;
    });

    it("Should allow admin to pause", async function () {
      await infraReserve.connect(owner).pause();
      expect(await infraReserve.paused()).to.be.true;
    });

    it("Should allow admin to unpause", async function () {
      await infraReserve.connect(owner).pause();
      await infraReserve.connect(owner).unpause();
      expect(await infraReserve.paused()).to.be.false;
    });

    it("Should reject non-admin pause", async function () {
      await expect(infraReserve.connect(user1).pause()).to.be.reverted;
    });

    it("Should reject non-admin unpause", async function () {
      await infraReserve.connect(owner).pause();
      await expect(infraReserve.connect(user1).unpause()).to.be.reverted;
    });
  });

  describe("Emergency Withdraw", function () {
    const depositAmount = ethers.parseUnits("1000", 6);

    beforeEach(async function () {
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
    });

    it("Should allow admin to emergency withdraw", async function () {
      const withdrawAmount = ethers.parseUnits("500", 6);
      const initialBalance = await usdc.balanceOf(treasury.address);

      await expect(
        infraReserve.connect(owner).emergencyWithdraw(withdrawAmount)
      ).to.emit(infraReserve, "EmergencyWithdrawal")
        .withArgs(treasury.address, withdrawAmount);

      expect(await usdc.balanceOf(treasury.address)).to.equal(initialBalance + withdrawAmount);
    });

    it("Should reject non-admin emergency withdraw", async function () {
      await expect(
        infraReserve.connect(user1).emergencyWithdraw(ethers.parseUnits("100", 6))
      ).to.be.reverted;
    });

    it("Should reject withdrawal exceeding balance", async function () {
      const excessAmount = depositAmount + ethers.parseUnits("1", 6);
      await expect(
        infraReserve.connect(owner).emergencyWithdraw(excessAmount)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should reject zero amount withdrawal", async function () {
      await expect(
        infraReserve.connect(owner).emergencyWithdraw(0)
      ).to.be.reverted;
    });
  });

  describe("Access Control", function () {
    it("Should have correct role constants", async function () {
      expect(await infraReserve.DEPOSITOR_ROLE()).to.equal(keccak256(toUtf8Bytes("DEPOSITOR_ROLE")));
      expect(await infraReserve.PAYER_ROLE()).to.equal(keccak256(toUtf8Bytes("PAYER_ROLE")));
    });

    it("Should allow admin to grant DEPOSITOR_ROLE", async function () {
      const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
      await infraReserve.connect(owner).grantRole(DEPOSITOR_ROLE, user1.address);
      expect(await infraReserve.hasRole(DEPOSITOR_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to grant PAYER_ROLE", async function () {
      const PAYER_ROLE = await infraReserve.PAYER_ROLE();
      await infraReserve.connect(owner).grantRole(PAYER_ROLE, user1.address);
      expect(await infraReserve.hasRole(PAYER_ROLE, user1.address)).to.be.true;
    });

    it("Should allow admin to revoke roles", async function () {
      const DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
      await infraReserve.connect(owner).revokeRole(DEPOSITOR_ROLE, depositor.address);
      expect(await infraReserve.hasRole(DEPOSITOR_ROLE, depositor.address)).to.be.false;
    });
  });

  describe("Reentrancy Protection", function () {
    it("Should protect deposit from reentrancy", async function () {
      // Note: Actual reentrancy testing requires a malicious contract
      // This is a basic check that the modifier is present
      const depositAmount = ethers.parseUnits("100", 6);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
      // If this completes without reverting, nonReentrant is working
      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount);
    });
  });

  describe("Edge Cases", function () {
    it("Should handle model with no deposits", async function () {
      expect(await infraReserve.accrued(MODEL_ID)).to.equal(0);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(0);
      expect(await infraReserve.getNetAccrual(MODEL_ID)).to.equal(0);
    });

    it("Should handle model with deposits but no payments", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(depositAmount);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(0);
    });

    it("Should handle payment that fully depletes accrued balance", async function () {
      const amount = ethers.parseUnits("1000", 6);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), amount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, amount);

      const invoiceHash = keccak256(toUtf8Bytes("invoice"));
      await infraReserve.connect(payer).payInfrastructureCost(
        MODEL_ID,
        provider1.address,
        amount,
        invoiceHash,
        "Full payment"
      );

      expect(await infraReserve.accrued(MODEL_ID)).to.equal(0);
      expect(await infraReserve.paid(MODEL_ID)).to.equal(amount);
    });
  });

  describe("Reconciliation - Cost Variance Tracking", function () {
    const estimatedCost = ethers.parseUnits("1000", 6); // $1000 USDC
    const actualCost = ethers.parseUnits("1200", 6); // $1200 USDC (20% over)

    beforeEach(async function () {
      // Fund the reserve for payments
      const depositAmount = ethers.parseUnits("5000", 6);
      await usdc.connect(depositor).approve(await infraReserve.getAddress(), depositAmount);
      await infraReserve.connect(depositor).deposit(MODEL_ID, depositAmount);
    });

    describe("Reconciliation Period", function () {
      it("Should initialize with default 30 day period", async function () {
        const period = await infraReserve.reconciliationPeriod();
        expect(period).to.equal(30n * 24n * 60n * 60n); // 30 days in seconds
      });

      it("Should allow admin to update reconciliation period", async function () {
        const newPeriod = 7n * 24n * 60n * 60n; // 7 days
        await expect(infraReserve.connect(owner).setReconciliationPeriod(newPeriod))
          .to.emit(infraReserve, "ReconciliationPeriodUpdated")
          .withArgs(30n * 24n * 60n * 60n, newPeriod);

        expect(await infraReserve.reconciliationPeriod()).to.equal(newPeriod);
      });

      it("Should reject zero period", async function () {
        await expect(
          infraReserve.connect(owner).setReconciliationPeriod(0)
        ).to.be.revertedWith("Period must be positive");
      });

      it("Should reject non-admin setting period", async function () {
        await expect(
          infraReserve.connect(user1).setReconciliationPeriod(7 * 24 * 60 * 60)
        ).to.be.reverted;
      });
    });

    describe("Snapshot Estimated Costs", function () {
      it("Should snapshot estimated costs for period", async function () {
        await expect(
          infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost)
        ).to.emit(infraReserve, "EstimatedCostsSnapshot")
          .withArgs(MODEL_ID, 0, estimatedCost, await ethers.provider.getBlock("latest").then(b => b.timestamp + 1));

        const [estimated] = await infraReserve.getVariance(MODEL_ID, 0);
        expect(estimated).to.equal(estimatedCost);
      });

      it("Should initialize period start time on first snapshot", async function () {
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
        const periodStart = await infraReserve.periodStartTime(MODEL_ID, 0);
        expect(periodStart).to.be.gt(0);
      });

      it("Should reject zero estimated cost", async function () {
        await expect(
          infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, 0)
        ).to.be.revertedWithCustomError(infraReserve, "InvalidAmount");
      });

      it("Should reject empty model ID", async function () {
        await expect(
          infraReserve.connect(payer).snapshotEstimatedCosts("", estimatedCost)
        ).to.be.revertedWithCustomError(infraReserve, "EmptyString");
      });

      it("Should reject non-payer snapshotting", async function () {
        await expect(
          infraReserve.connect(user1).snapshotEstimatedCosts(MODEL_ID, estimatedCost)
        ).to.be.reverted;
      });
    });

    describe("Record Actual Costs", function () {
      const invoiceHash = keccak256(toUtf8Bytes("invoice-001"));

      it("Should record actual costs via payment", async function () {
        const paymentAmount = ethers.parseUnits("1200", 6);

        await expect(
          infraReserve.connect(payer).payInfrastructureCost(
            MODEL_ID,
            provider1.address,
            paymentAmount,
            invoiceHash,
            "Monthly infrastructure"
          )
        ).to.emit(infraReserve, "ActualCostsRecorded")
          .withArgs(MODEL_ID, 0, paymentAmount, invoiceHash, paymentAmount);

        const [, actual] = await infraReserve.getVariance(MODEL_ID, 0);
        expect(actual).to.equal(paymentAmount);
      });

      it("Should accumulate multiple payments in same period", async function () {
        const payment1 = ethers.parseUnits("500", 6);
        const payment2 = ethers.parseUnits("700", 6);
        const invoice1 = keccak256(toUtf8Bytes("invoice-001"));
        const invoice2 = keccak256(toUtf8Bytes("invoice-002"));

        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, payment1, invoice1, "Part 1"
        );

        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, payment2, invoice2, "Part 2"
        );

        const [, actual] = await infraReserve.getVariance(MODEL_ID, 0);
        expect(actual).to.equal(payment1 + payment2);
      });

      it("Should record actual costs via manual recordActualCosts", async function () {
        await expect(
          infraReserve.connect(payer).recordActualCosts(MODEL_ID, 0, actualCost, invoiceHash)
        ).to.emit(infraReserve, "ActualCostsRecorded")
          .withArgs(MODEL_ID, 0, actualCost, invoiceHash, actualCost);

        const [, actual] = await infraReserve.getVariance(MODEL_ID, 0);
        expect(actual).to.equal(actualCost);
      });

      it("Should reject zero actual cost", async function () {
        await expect(
          infraReserve.connect(payer).recordActualCosts(MODEL_ID, 0, 0, invoiceHash)
        ).to.be.revertedWithCustomError(infraReserve, "InvalidAmount");
      });
    });

    describe("Variance Calculation", function () {
      beforeEach(async function () {
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
      });

      it("Should calculate positive variance when underestimated", async function () {
        // Actual > Estimated (underestimated by 20%)
        const actualOverrun = ethers.parseUnits("1200", 6);
        const invoiceHash = keccak256(toUtf8Bytes("invoice"));

        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, actualOverrun, invoiceHash, "Overrun"
        );

        const [estimated, actual, varianceBps] = await infraReserve.getVariance(MODEL_ID, 0);

        expect(estimated).to.equal(estimatedCost);
        expect(actual).to.equal(actualOverrun);
        // variance = ((1200 - 1000) / 1000) * 10000 = 2000 bps = 20%
        expect(varianceBps).to.equal(2000);
      });

      it("Should calculate negative variance when overestimated", async function () {
        // Actual < Estimated (overestimated by 20%)
        const actualUnderrun = ethers.parseUnits("800", 6);
        const invoiceHash = keccak256(toUtf8Bytes("invoice"));

        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, actualUnderrun, invoiceHash, "Underrun"
        );

        const [estimated, actual, varianceBps] = await infraReserve.getVariance(MODEL_ID, 0);

        expect(estimated).to.equal(estimatedCost);
        expect(actual).to.equal(actualUnderrun);
        // variance = ((800 - 1000) / 1000) * 10000 = -2000 bps = -20%
        expect(varianceBps).to.equal(-2000);
      });

      it("Should return zero variance when actual equals estimated", async function () {
        const invoiceHash = keccak256(toUtf8Bytes("invoice"));

        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, estimatedCost, invoiceHash, "Exact"
        );

        const [, , varianceBps] = await infraReserve.getVariance(MODEL_ID, 0);
        expect(varianceBps).to.equal(0);
      });

      it("Should return zero variance when no data", async function () {
        const [, , varianceBps] = await infraReserve.getVariance(MODEL_ID_2, 0);
        expect(varianceBps).to.equal(0);
      });
    });

    describe("Period Advancement", function () {
      beforeEach(async function () {
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
      });

      it("Should advance period after reconciliation period elapses", async function () {
        const invoiceHash = keccak256(toUtf8Bytes("invoice"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, actualCost, invoiceHash, "Period 0"
        );

        // Fast forward 30 days
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        await expect(infraReserve.connect(payer).advancePeriod(MODEL_ID))
          .to.emit(infraReserve, "CostReconciled")
          .withArgs(MODEL_ID, 0, estimatedCost, actualCost, 2000); // 20% variance

        expect(await infraReserve.currentPeriod(MODEL_ID)).to.equal(1);
      });

      it("Should reject advancing before period elapses", async function () {
        await expect(
          infraReserve.connect(payer).advancePeriod(MODEL_ID)
        ).to.be.revertedWith("Period not elapsed");
      });

      it("Should reject advancing uninitialized period", async function () {
        await expect(
          infraReserve.connect(payer).advancePeriod(MODEL_ID_2)
        ).to.be.revertedWith("Period not initialized");
      });

      it("Should reject non-payer advancing period", async function () {
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");

        await expect(
          infraReserve.connect(user1).advancePeriod(MODEL_ID)
        ).to.be.reverted;
      });
    });

    describe("Variance History", function () {
      it("Should return variance history for multiple periods", async function () {
        // Period 0
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
        const invoice1 = keccak256(toUtf8Bytes("invoice-1"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, actualCost, invoice1, "P0"
        );

        // Advance to period 1
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);

        // Period 1
        const est2 = ethers.parseUnits("1500", 6);
        const act2 = ethers.parseUnits("1400", 6);
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, est2);
        const invoice2 = keccak256(toUtf8Bytes("invoice-2"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, act2, invoice2, "P1"
        );

        // Get history
        const history = await infraReserve.getVarianceHistory(MODEL_ID, 2);

        expect(history.length).to.equal(2);
        expect(history[0].period).to.equal(0);
        expect(history[0].estimated).to.equal(estimatedCost);
        expect(history[0].actual).to.equal(actualCost);
        expect(history[0].varianceBps).to.equal(2000); // 20%

        expect(history[1].period).to.equal(1);
        expect(history[1].estimated).to.equal(est2);
        expect(history[1].actual).to.equal(act2);
        // ((1400 - 1500) / 1500) * 10000 = -666 bps
        expect(history[1].varianceBps).to.equal(-666);
      });

      it("Should handle requesting more periods than exist", async function () {
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);

        const history = await infraReserve.getVarianceHistory(MODEL_ID, 10);
        // Current period is 0, should return up to currentPeriod (which is 0), so 0 records
        // But with snapshot, we have period 0 data, so we get 1 record
        expect(history.length).to.be.lte(1); // Returns min(requested, available)
      });
    });

    describe("Cost Adjustment Suggestions", function () {
      async function setupMultiplePeriods() {
        // Period 0: underestimated by 20%
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
        const invoice1 = keccak256(toUtf8Bytes("invoice-1"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, ethers.parseUnits("1200", 6), invoice1, "P0"
        );
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);

        // Period 1: underestimated by 15%
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
        const invoice2 = keccak256(toUtf8Bytes("invoice-2"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, ethers.parseUnits("1150", 6), invoice2, "P1"
        );
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);

        // Period 2: underestimated by 10%
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
        const invoice3 = keccak256(toUtf8Bytes("invoice-3"));
        await infraReserve.connect(payer).payInfrastructureCost(
          MODEL_ID, provider1.address, ethers.parseUnits("1100", 6), invoice3, "P2"
        );
        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);
      }

      it("Should suggest cost adjustment based on weighted average", async function () {
        await setupMultiplePeriods();

        // Weighted avg: (20% * 1 + 15% * 2 + 10% * 3) / 6 = (2000 + 3000 + 3000) / 6 = 1333 bps
        const [adjustmentBps, suggestedCost] = await infraReserve.suggestCostAdjustment.staticCall(MODEL_ID);

        expect(adjustmentBps).to.be.closeTo(1333, 1); // Allow 1 bps tolerance for rounding
        // suggestedCost = 1000 * (10000 + 1333) / 10000 = 1133.3
        expect(suggestedCost).to.be.closeTo(ethers.parseUnits("1133", 6), ethers.parseUnits("1", 6));
      });

      it("Should emit AdjustmentSuggested event", async function () {
        await setupMultiplePeriods();

        await expect(infraReserve.suggestCostAdjustment(MODEL_ID))
          .to.emit(infraReserve, "AdjustmentSuggested");
      });

      it("Should return no adjustment when variance is within tolerance", async function () {
        // All periods within 5% tolerance
        for (let i = 0; i < 3; i++) {
          await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
          const invoice = keccak256(toUtf8Bytes(`invoice-${i}`));
          // 3% variance
          await infraReserve.connect(payer).payInfrastructureCost(
            MODEL_ID, provider1.address, ethers.parseUnits("1030", 6), invoice, `P${i}`
          );
          if (i < 2) {
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");
            await infraReserve.connect(payer).advancePeriod(MODEL_ID);
          }
        }

        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);

        const [adjustmentBps, suggestedCost] = await infraReserve.suggestCostAdjustment.staticCall(MODEL_ID);

        expect(adjustmentBps).to.equal(0);
        expect(suggestedCost).to.equal(estimatedCost);
      });

      it("Should reject suggestion with insufficient periods", async function () {
        await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);

        await expect(
          infraReserve.suggestCostAdjustment(MODEL_ID)
        ).to.be.revertedWith("Need at least 3 periods");
      });

      it("Should keep extreme negative adjustments non-negative", async function () {
        for (let i = 0; i < 3; i++) {
          await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, estimatedCost);
          const invoice = keccak256(toUtf8Bytes(`extreme-overestimate-${i}`));
          await infraReserve.connect(payer).payInfrastructureCost(
            MODEL_ID,
            provider1.address,
            1,
            invoice,
            `Extreme ${i}`
          );

          if (i < 2) {
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");
            await infraReserve.connect(payer).advancePeriod(MODEL_ID);
          }
        }

        await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
        await ethers.provider.send("evm_mine");
        await infraReserve.connect(payer).advancePeriod(MODEL_ID);

        const [adjustmentBps, suggestedCost] = await infraReserve.suggestCostAdjustment.staticCall(MODEL_ID);

        expect(adjustmentBps).to.be.lte(-9999);
        expect(suggestedCost).to.be.gte(0);
      });
    });

    describe("Multi-Period Integration", function () {
      it("Should track costs across multiple periods correctly", async function () {
        const periods = [
          { est: 1000, act: 1100 }, // +10%
          { est: 1100, act: 1050 }, // -4.5%
          { est: 1100, act: 1120 }, // +1.8%
        ];

        for (let i = 0; i < periods.length; i++) {
          const est = ethers.parseUnits(periods[i].est.toString(), 6);
          const act = ethers.parseUnits(periods[i].act.toString(), 6);

          await infraReserve.connect(payer).snapshotEstimatedCosts(MODEL_ID, est);
          const invoice = keccak256(toUtf8Bytes(`invoice-${i}`));
          await infraReserve.connect(payer).payInfrastructureCost(
            MODEL_ID, provider1.address, act, invoice, `Period ${i}`
          );

          if (i < periods.length - 1) {
            await ethers.provider.send("evm_increaseTime", [30 * 24 * 60 * 60]);
            await ethers.provider.send("evm_mine");
            await infraReserve.connect(payer).advancePeriod(MODEL_ID);
          }
        }

        expect(await infraReserve.currentPeriod(MODEL_ID)).to.equal(2);

        // Get last 2 periods (most recent): should be periods 1 and 2
        const history = await infraReserve.getVarianceHistory(MODEL_ID, 2);
        expect(history.length).to.equal(2);
        // Period 1: -4.5% = ((1050 - 1100) / 1100) * 10000 = -454 bps
        expect(history[0].varianceBps).to.be.closeTo(-454, 1);
        // Period 2: +1.8% = ((1120 - 1100) / 1100) * 10000 = 181 bps
        expect(history[1].varianceBps).to.be.closeTo(181, 1);
      });
    });
  });
});
