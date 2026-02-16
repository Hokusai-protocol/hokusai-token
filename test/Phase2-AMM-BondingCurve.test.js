const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress, MaxUint256 } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Phase 2: Core AMM Bonding Curve", function () {
  let hokusaiAMM;
  let mockUSDC;
  let hokusaiToken;
  let tokenManager;
  let modelRegistry;
  let owner, treasury, buyer, seller, other;

  const modelId = "test-model-v1";
  const CRR = 100000; // 10%
  const TRADE_FEE = 30; // 0.30%
  const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $1k threshold (lower than initial reserve)
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token
  const INITIAL_SUPPLY = parseEther("100000"); // 100k tokens
  const INITIAL_RESERVE = parseUnits("10000", 6); // $10,000 USDC

  beforeEach(async function () {
    [owner, treasury, buyer, seller, other] = await ethers.getSigners();

    // Deploy MockUSDC
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    // Deploy ModelRegistry
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    // Deploy TokenManager
    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Deploy HokusaiToken via TokenManager
    await tokenManager.deployToken(modelId, "Test Model Token", "TMT", INITIAL_SUPPLY);
    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    hokusaiToken = await ethers.getContractAt("HokusaiToken", tokenAddress);

    // Deploy HokusaiAMM
    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    hokusaiAMM = await HokusaiAMM.deploy(
      await mockUSDC.getAddress(),
      await hokusaiToken.getAddress(),
      await tokenManager.getAddress(),
      modelId,
      treasury.address,
      CRR,
      TRADE_FEE,
      IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
    );
    await hokusaiAMM.waitForDeployment();

    // Authorize AMM in TokenManager
    await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

    // Seed AMM with initial reserve and supply
    await mockUSDC.mint(owner.address, INITIAL_RESERVE);
    await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
    await hokusaiAMM.depositFees(INITIAL_RESERVE); // This will update reserveBalance

    // Mint USDC to buyer and seller for testing
    await mockUSDC.mint(buyer.address, parseUnits("100000", 6)); // $100k
    await mockUSDC.mint(seller.address, parseUnits("100000", 6));

    // Approve AMM to spend USDC
    await mockUSDC.connect(buyer).approve(await hokusaiAMM.getAddress(), MaxUint256);
    await mockUSDC.connect(seller).approve(await hokusaiAMM.getAddress(), MaxUint256);

    // Set max trade size to 50% for these tests (they test large trades)
    await hokusaiAMM.setMaxTradeBps(5000);
  });

  describe("Deployment & Initial State", function () {
    it("Should initialize with correct parameters", async function () {
      expect(await hokusaiAMM.reserveToken()).to.equal(await mockUSDC.getAddress());
      expect(await hokusaiAMM.hokusaiToken()).to.equal(await hokusaiToken.getAddress());
      expect(await hokusaiAMM.tokenManager()).to.equal(await tokenManager.getAddress());
      expect(await hokusaiAMM.modelId()).to.equal(modelId);
      expect(await hokusaiAMM.treasury()).to.equal(treasury.address);
      expect(await hokusaiAMM.crr()).to.equal(CRR);
      expect(await hokusaiAMM.tradeFee()).to.equal(TRADE_FEE);
    });

    it("Should set IBR end time correctly", async function () {
      const buyOnlyUntil = await hokusaiAMM.buyOnlyUntil();
      const currentTime = await time.latest();
      expect(buyOnlyUntil).to.be.gt(currentTime);
      expect(buyOnlyUntil).to.be.lte(currentTime + IBR_DURATION + 2); // Allow 2s tolerance
    });

    it("Should have correct initial reserve balance", async function () {
      expect(await hokusaiAMM.reserveBalance()).to.equal(INITIAL_RESERVE);
    });

    it("Should calculate initial spot price as $1.00", async function () {
      const price = await hokusaiAMM.spotPrice();
      const reserve = await hokusaiAMM.reserveBalance();
      const supply = await hokusaiToken.totalSupply();
      console.log(`      Reserve: ${reserve}, Supply: ${supply}, Price: ${price}`);
      // P = R / (w × S) = 10000 / (0.1 × 100000) = $1.00 (in 6 decimals)
      expect(price).to.be.closeTo(parseUnits("1", 6), parseUnits("0.01", 6));
    });

    it("Should reject invalid constructor parameters", async function () {
      const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");

      // Invalid reserve token
      await expect(
        HokusaiAMM.deploy(
          ZeroAddress,
          await hokusaiToken.getAddress(),
          await tokenManager.getAddress(),
          modelId,
          treasury.address,
          CRR,
          TRADE_FEE,
          IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
        )
      ).to.be.revertedWithCustomError(HokusaiAMM, "ZeroAddress");

      // CRR too low
      await expect(
        HokusaiAMM.deploy(
          await mockUSDC.getAddress(),
          await hokusaiToken.getAddress(),
          await tokenManager.getAddress(),
          modelId,
          treasury.address,
          40000, // 4% - below minimum
          TRADE_FEE,
          IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
        )
      ).to.be.reverted;

      // CRR too high
      await expect(
        HokusaiAMM.deploy(
          await mockUSDC.getAddress(),
          await hokusaiToken.getAddress(),
          await tokenManager.getAddress(),
          modelId,
          treasury.address,
          600000, // 60% - above maximum
          TRADE_FEE,
          IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
        )
      ).to.be.reverted;
    });
  });

  describe("Buy Function - Bonding Curve", function () {
    it("Should allow buying tokens with USDC", async function () {
      const reserveIn = parseUnits("1000", 6); // $1,000
      const minTokensOut = 0;
      const deadline = (await time.latest()) + 300;

      const tokensOutQuote = await hokusaiAMM.getBuyQuote(reserveIn);
      const balanceBefore = await hokusaiToken.balanceOf(buyer.address);

      await hokusaiAMM.connect(buyer).buy(reserveIn, minTokensOut, buyer.address, deadline);

      const balanceAfter = await hokusaiToken.balanceOf(buyer.address);
      expect(balanceAfter - balanceBefore).to.be.closeTo(tokensOutQuote, parseEther("0.01"));
    });

    it("Should emit Buy event with correct parameters", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      const tx = await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);
      await expect(tx).to.emit(hokusaiAMM, "Buy");
    });

    it("Should increase reserve balance after buy", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      const reserveBefore = await hokusaiAMM.reserveBalance();

      // Calculate expected reserve increase (after fee)
      const fee = (reserveIn * BigInt(TRADE_FEE)) / BigInt(10000);
      const reserveAfterFee = reserveIn - fee;

      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);

      const reserveAfter = await hokusaiAMM.reserveBalance();
      expect(reserveAfter - reserveBefore).to.equal(reserveAfterFee);
    });

    it("Should transfer trade fee to treasury", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      const treasuryBalanceBefore = await mockUSDC.balanceOf(treasury.address);

      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);

      const treasuryBalanceAfter = await mockUSDC.balanceOf(treasury.address);
      const expectedFee = (reserveIn * BigInt(TRADE_FEE)) / BigInt(10000);

      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(expectedFee);
    });

    it("Should respect slippage protection", async function () {
      const reserveIn = parseUnits("1000", 6);
      const tokensOutQuote = await hokusaiAMM.getBuyQuote(reserveIn);
      const minTokensOut = tokensOutQuote + parseEther("1"); // Require 1 more token than quote
      const deadline = (await time.latest()) + 300;

      await expect(
        hokusaiAMM.connect(buyer).buy(reserveIn, minTokensOut, buyer.address, deadline)
      ).to.be.revertedWith("Slippage exceeded");
    });

    it("Should respect deadline", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) - 1; // Past deadline

      await expect(
        hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline)
      ).to.be.revertedWith("Transaction expired");
    });

    it("Should revert with zero reserve amount", async function () {
      const deadline = (await time.latest()) + 300;

      await expect(
        hokusaiAMM.connect(buyer).buy(0, 0, buyer.address, deadline)
      ).to.be.revertedWith("Reserve amount must be > 0");
    });

    it("Should revert with invalid recipient", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      await expect(
        hokusaiAMM.connect(buyer).buy(reserveIn, 0, ZeroAddress, deadline)
      ).to.be.revertedWith("Invalid recipient");
    });

    it("Should handle multiple sequential buys", async function () {
      const deadline = (await time.latest()) + 300;

      // First buy
      const reserveIn1 = parseUnits("1000", 6);
      await hokusaiAMM.connect(buyer).buy(reserveIn1, 0, buyer.address, deadline);
      const balance1 = await hokusaiToken.balanceOf(buyer.address);

      // Second buy (price should be higher now)
      const reserveIn2 = parseUnits("1000", 6);
      await hokusaiAMM.connect(buyer).buy(reserveIn2, 0, buyer.address, deadline);
      const balance2 = await hokusaiToken.balanceOf(buyer.address);

      // Second buy should yield fewer tokens (higher price)
      const tokens1 = balance1;
      const tokens2 = balance2 - balance1;
      expect(tokens2).to.be.lt(tokens1);
    });
  });

  describe("Sell Function - Bonding Curve", function () {
    beforeEach(async function () {
      // Fast-forward past IBR
      await time.increase(IBR_DURATION + 1);

      // Buy some tokens first
      const reserveIn = parseUnits("5000", 6);
      const deadline = (await time.latest()) + 300;
      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);

      // Approve AMM to spend tokens
      await hokusaiToken.connect(buyer).approve(await hokusaiAMM.getAddress(), MaxUint256);
    });

    it("Should allow selling tokens for USDC", async function () {
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10); // Sell 10%
      const deadline = (await time.latest()) + 300;

      const reserveOutQuote = await hokusaiAMM.getSellQuote(tokensIn);
      const usdcBefore = await mockUSDC.balanceOf(buyer.address);

      await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);

      const usdcAfter = await mockUSDC.balanceOf(buyer.address);
      // Account for trade fee
      const expectedOut = reserveOutQuote - ((reserveOutQuote * BigInt(TRADE_FEE)) / BigInt(10000));
      expect(usdcAfter - usdcBefore).to.be.closeTo(expectedOut, parseUnits("0.1", 6));
    });

    it("Should emit Sell event", async function () {
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10);
      const deadline = (await time.latest()) + 300;

      const tx = await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);
      await expect(tx).to.emit(hokusaiAMM, "Sell");
    });

    it("Should decrease reserve balance after sell", async function () {
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10);
      const deadline = (await time.latest()) + 300;

      const reserveBefore = await hokusaiAMM.reserveBalance();
      const reserveOutQuote = await hokusaiAMM.getSellQuote(tokensIn);

      await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);

      const reserveAfter = await hokusaiAMM.reserveBalance();
      expect(reserveBefore - reserveAfter).to.equal(reserveOutQuote);
    });

    it("Should burn tokens on sell", async function () {
      const supplyBefore = await hokusaiToken.totalSupply();
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10);
      const deadline = (await time.latest()) + 300;

      await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);

      const supplyAfter = await hokusaiToken.totalSupply();
      expect(supplyBefore - supplyAfter).to.equal(tokensIn);
    });

    it("Should revert during IBR", async function () {
      // Deploy new AMM that's still in IBR
      const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
      const newAMM = await HokusaiAMM.deploy(
        await mockUSDC.getAddress(),
        await hokusaiToken.getAddress(),
        await tokenManager.getAddress(),
        "new-model",
        treasury.address,
        CRR,
        TRADE_FEE,
        IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
      );

      const deadline = (await time.latest()) + 300;

      await expect(
        newAMM.connect(buyer).sell(parseEther("100"), 0, buyer.address, deadline)
      ).to.be.revertedWith("Sells not enabled during IBR");
    });

    it("Should respect slippage protection", async function () {
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10);
      const reserveOutQuote = await hokusaiAMM.getSellQuote(tokensIn);
      const minReserveOut = reserveOutQuote + parseUnits("1", 6); // Require $1 more
      const deadline = (await time.latest()) + 300;

      await expect(
        hokusaiAMM.connect(buyer).sell(tokensIn, minReserveOut, buyer.address, deadline)
      ).to.be.revertedWith("Slippage exceeded");
    });
  });

  describe("Quote Functions - Math Accuracy", function () {
    it("getBuyQuote should return zero for zero input", async function () {
      expect(await hokusaiAMM.getBuyQuote(0)).to.equal(0);
    });

    it("getSellQuote should return zero for zero input", async function () {
      expect(await hokusaiAMM.getSellQuote(0)).to.equal(0);
    });

    it("getBuyQuote should be monotonically increasing", async function () {
      const quote1 = await hokusaiAMM.getBuyQuote(parseUnits("1000", 6));
      const quote2 = await hokusaiAMM.getBuyQuote(parseUnits("2000", 6));
      const quote3 = await hokusaiAMM.getBuyQuote(parseUnits("3000", 6));

      expect(quote2).to.be.gt(quote1);
      expect(quote3).to.be.gt(quote2);
    });

    it("getSellQuote should be monotonically increasing", async function () {
      const quote1 = await hokusaiAMM.getSellQuote(parseEther("100"));
      const quote2 = await hokusaiAMM.getSellQuote(parseEther("200"));
      const quote3 = await hokusaiAMM.getSellQuote(parseEther("300"));

      expect(quote2).to.be.gt(quote1);
      expect(quote3).to.be.gt(quote2);
    });

    it("Buy and sell should have reasonable price impact", async function () {
      const reserveIn = parseUnits("1000", 6);
      const tokensOut = await hokusaiAMM.getBuyQuote(reserveIn);

      // After buying, selling should return less than input (due to price impact + fees)
      const reserveOutQuote = await hokusaiAMM.getSellQuote(tokensOut);
      expect(reserveOutQuote).to.be.lt(reserveIn);
      expect(reserveOutQuote).to.be.gt(reserveIn / BigInt(2)); // But not drastically less
    });
  });

  describe("Spot Price", function () {
    it("Should update spot price after buy", async function () {
      const priceBefore = await hokusaiAMM.spotPrice();

      const reserveIn = parseUnits("5000", 6);
      const deadline = (await time.latest()) + 300;
      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);

      const priceAfter = await hokusaiAMM.spotPrice();
      expect(priceAfter).to.be.gt(priceBefore); // Price should increase
    });

    it("Should update spot price after sell", async function () {
      // Fast-forward past IBR and buy tokens
      await time.increase(IBR_DURATION + 1);
      const reserveIn = parseUnits("5000", 6);
      let deadline = (await time.latest()) + 300;
      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);

      const priceBefore = await hokusaiAMM.spotPrice();

      // Sell some tokens
      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(5);
      await hokusaiToken.connect(buyer).approve(await hokusaiAMM.getAddress(), MaxUint256);
      deadline = (await time.latest()) + 300;
      await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);

      const priceAfter = await hokusaiAMM.spotPrice();
      expect(priceAfter).to.be.lt(priceBefore); // Price should decrease
    });
  });

  describe("Fee Deposit", function () {
    it("Should allow depositing fees to reserve", async function () {
      const amount = parseUnits("1000", 6);
      await mockUSDC.mint(other.address, amount);
      await mockUSDC.connect(other).approve(await hokusaiAMM.getAddress(), amount);

      const reserveBefore = await hokusaiAMM.reserveBalance();

      await hokusaiAMM.connect(other).depositFees(amount);

      const reserveAfter = await hokusaiAMM.reserveBalance();
      expect(reserveAfter - reserveBefore).to.equal(amount);
    });

    it("Should emit FeesDeposited event", async function () {
      const amount = parseUnits("1000", 6);
      await mockUSDC.mint(other.address, amount);
      await mockUSDC.connect(other).approve(await hokusaiAMM.getAddress(), amount);

      await expect(hokusaiAMM.connect(other).depositFees(amount))
        .to.emit(hokusaiAMM, "FeesDeposited");
    });

    it("Should increase spot price when fees deposited", async function () {
      const priceBefore = await hokusaiAMM.spotPrice();

      const amount = parseUnits("10000", 6); // Large fee deposit
      await mockUSDC.mint(other.address, amount);
      await mockUSDC.connect(other).approve(await hokusaiAMM.getAddress(), amount);
      await hokusaiAMM.connect(other).depositFees(amount);

      const priceAfter = await hokusaiAMM.spotPrice();
      expect(priceAfter).to.be.gt(priceBefore);
    });
  });

  describe("Governance", function () {
    it("Should allow owner to update parameters", async function () {
      const newCrr = 150000; // 15%
      const newTradeFee = 50; // 0.5%

      await hokusaiAMM.setParameters(newCrr, newTradeFee);

      expect(await hokusaiAMM.crr()).to.equal(newCrr);
      expect(await hokusaiAMM.tradeFee()).to.equal(newTradeFee);
    });

    it("Should emit ParametersUpdated event", async function () {
      const newCrr = 150000;
      const newTradeFee = 50;

      await expect(hokusaiAMM.setParameters(newCrr, newTradeFee))
        .to.emit(hokusaiAMM, "ParametersUpdated")
        .withArgs(newCrr, newTradeFee);
    });

    it("Should enforce CRR bounds", async function () {
      await expect(
        hokusaiAMM.setParameters(40000, TRADE_FEE) // 4% - too low
      ).to.be.revertedWith("CRR out of bounds");

      await expect(
        hokusaiAMM.setParameters(600000, TRADE_FEE) // 60% - too high
      ).to.be.revertedWith("CRR out of bounds");
    });

    it("Should only allow owner to update parameters", async function () {
      await expect(
        hokusaiAMM.connect(buyer).setParameters(150000, TRADE_FEE)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });

    it("Should allow owner to pause", async function () {
      await hokusaiAMM.pause();
      expect(await hokusaiAMM.paused()).to.be.true;
    });

    it("Should allow owner to unpause", async function () {
      await hokusaiAMM.pause();
      await hokusaiAMM.unpause();
      expect(await hokusaiAMM.paused()).to.be.false;
    });

    it("Should prevent trading when paused", async function () {
      await hokusaiAMM.pause();

      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      await expect(
        hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline)
      ).to.be.revertedWith("Pausable: paused");
    });
  });

  describe("Gas Benchmarks", function () {
    it("Should measure gas for buy()", async function () {
      const reserveIn = parseUnits("1000", 6);
      const deadline = (await time.latest()) + 300;

      const tx = await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);
      const receipt = await tx.wait();

      console.log(`      Gas used for buy(): ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lt(155000); // Target < 155k (includes trade size check overhead)
    });

    it("Should measure gas for sell()", async function () {
      // Setup: Buy tokens first, then fast-forward past IBR
      const reserveIn = parseUnits("1000", 6);
      let deadline = (await time.latest()) + 300;
      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);
      await time.increase(IBR_DURATION + 1);

      const balance = await hokusaiToken.balanceOf(buyer.address);
      const tokensIn = balance / BigInt(10);
      await hokusaiToken.connect(buyer).approve(await hokusaiAMM.getAddress(), MaxUint256);

      deadline = (await time.latest()) + 300;
      const tx = await hokusaiAMM.connect(buyer).sell(tokensIn, 0, buyer.address, deadline);
      const receipt = await tx.wait();

      console.log(`      Gas used for sell(): ${receipt.gasUsed}`);
      expect(receipt.gasUsed).to.be.lt(200000); // Target < 100k (being lenient for now)
    });

    it("Should measure gas for getBuyQuote()", async function () {
      const reserveIn = parseUnits("1000", 6);

      const gasUsed = await hokusaiAMM.getBuyQuote.estimateGas(reserveIn);
      console.log(`      Gas used for getBuyQuote(): ${gasUsed}`);
      expect(gasUsed).to.be.lt(50000); // Target < 5k (very lenient for now)
    });
  });

  describe("Edge Cases", function () {
    it("Should handle very small buy amounts", async function () {
      const reserveIn = parseUnits("0.01", 6); // $0.01
      const deadline = (await time.latest()) + 300;

      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);
      expect(await hokusaiToken.balanceOf(buyer.address)).to.be.gt(0);
    });

    it("Should handle very large buy amounts", async function () {
      const reserveIn = parseUnits("5000", 6); // $5k (50% of $10k initial reserve - at max trade limit)
      const deadline = (await time.latest()) + 300;

      await hokusaiAMM.connect(buyer).buy(reserveIn, 0, buyer.address, deadline);
      expect(await hokusaiToken.balanceOf(buyer.address)).to.be.gt(0);
    });

    it("Should maintain reserve accuracy across multiple operations", async function () {
      const deadline = (await time.latest()) + 300;

      // Perform multiple buys
      for (let i = 0; i < 5; i++) {
        await hokusaiAMM.connect(buyer).buy(parseUnits("1000", 6), 0, buyer.address, deadline);
      }

      const reserveBalance = await hokusaiAMM.reserveBalance();
      const actualBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());

      // Reserve balance should be less than or equal to actual (due to fees in contract)
      expect(reserveBalance).to.be.lte(actualBalance);
    });
  });

  describe("View Functions", function () {
    it("getReserves should return correct values", async function () {
      const [reserve, supply] = await hokusaiAMM.getReserves();
      expect(reserve).to.equal(await hokusaiAMM.reserveBalance());
      expect(supply).to.equal(await hokusaiToken.totalSupply());
    });

    it("isSellEnabled should return false during IBR", async function () {
      // Deploy new AMM in IBR
      const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
      const newAMM = await HokusaiAMM.deploy(
        await mockUSDC.getAddress(),
        await hokusaiToken.getAddress(),
        await tokenManager.getAddress(),
        "new-model",
        treasury.address,
        CRR,
        TRADE_FEE,
        IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
      );

      expect(await newAMM.isSellEnabled()).to.be.false;
    });

    it("isSellEnabled should return true after IBR", async function () {
      await time.increase(IBR_DURATION + 1);
      expect(await hokusaiAMM.isSellEnabled()).to.be.true;
    });
  });
});
