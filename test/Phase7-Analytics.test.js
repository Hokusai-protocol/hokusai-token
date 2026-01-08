const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");

describe("Phase 7: Analytics & View Functions", function () {
    let modelRegistry;
    let tokenManager;
    let hokusaiToken;
    let hokusaiAMM;
    let mockUSDC;
    let owner, treasury, buyer1;

    const MODEL_ID = "test-model-v1";
    const TOKEN_NAME = "Test Model Token";
    const TOKEN_SYMBOL = "TMT";
    const INITIAL_SUPPLY = parseEther("1");
    const INITIAL_RESERVE = parseUnits("10000", 6);
    const CRR = 100000; // 10%
    const TRADE_FEE = 25; // 0.25%
    const PROTOCOL_FEE = 500; // 5%
    const IBR_DURATION = 7 * 24 * 60 * 60;

    beforeEach(async function () {
        [owner, treasury, buyer1] = await ethers.getSigners();

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

        // Deploy token
        const tokenAddress = await tokenManager.deployToken.staticCall(
            MODEL_ID,
            TOKEN_NAME,
            TOKEN_SYMBOL,
            INITIAL_SUPPLY
        );
        await tokenManager.deployToken(MODEL_ID, TOKEN_NAME, TOKEN_SYMBOL, INITIAL_SUPPLY);

        const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
        hokusaiToken = HokusaiToken.attach(tokenAddress);

        // Deploy AMM
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await HokusaiAMM.deploy(
            await mockUSDC.getAddress(),
            await hokusaiToken.getAddress(),
            await tokenManager.getAddress(),
            MODEL_ID,
            treasury.address,
            CRR,
            TRADE_FEE,
            PROTOCOL_FEE,
            IBR_DURATION
        );
        await hokusaiAMM.waitForDeployment();

        // Authorize AMM
        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        // Initialize pool
        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        // Mint initial supply
        await tokenManager.mintTokens(MODEL_ID, owner.address, parseEther("100000"));

        // Setup buyer
        await mockUSDC.mint(buyer1.address, parseUnits("100000", 6));
        await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
    });

    // ============================================================
    // COMPREHENSIVE POOL STATE
    // ============================================================

    describe("getPoolState()", function () {
        it("Should return all pool parameters", async function () {
            const [reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate] =
                await hokusaiAMM.getPoolState();

            expect(reserve).to.equal(INITIAL_RESERVE);
            expect(supply).to.equal(parseEther("100001")); // Initial + deployed
            expect(price).to.be.gt(0);
            expect(reserveRatio).to.equal(CRR);
            expect(tradeFeeRate).to.equal(TRADE_FEE);
            expect(protocolFeeRate).to.equal(PROTOCOL_FEE);
        });

        it("Should update reserve after buy", async function () {
            const [reserveBefore] = await hokusaiAMM.getPoolState();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            const [reserveAfter] = await hokusaiAMM.getPoolState();
            expect(reserveAfter).to.be.gt(reserveBefore);
        });

        it("Should update supply after buy", async function () {
            const [, supplyBefore] = await hokusaiAMM.getPoolState();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            const [, supplyAfter] = await hokusaiAMM.getPoolState();
            expect(supplyAfter).to.be.gt(supplyBefore);
        });

        it("Should update price after buy", async function () {
            const [, , priceBefore] = await hokusaiAMM.getPoolState();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("10000", 6), 0, buyer1.address, deadline);

            const [, , priceAfter] = await hokusaiAMM.getPoolState();
            expect(priceAfter).to.be.gt(priceBefore);
        });

        it("Should reflect parameter updates", async function () {
            await hokusaiAMM.setParameters(150000, 50, 300);

            const [, , , reserveRatio, tradeFeeRate, protocolFeeRate] = await hokusaiAMM.getPoolState();
            expect(reserveRatio).to.equal(150000);
            expect(tradeFeeRate).to.equal(50);
            expect(protocolFeeRate).to.equal(300);
        });

        it("Should be callable by anyone (view function)", async function () {
            await expect(hokusaiAMM.connect(buyer1).getPoolState()).to.not.be.reverted;
        });
    });

    // ============================================================
    // TRADE INFO
    // ============================================================

    describe("getTradeInfo()", function () {
        it("Should return trading status during IBR", async function () {
            const [sellsEnabled, ibrEndTime, isPaused] = await hokusaiAMM.getTradeInfo();

            expect(sellsEnabled).to.be.false;
            expect(ibrEndTime).to.be.gt(0);
            expect(isPaused).to.be.false;
        });

        it("Should show sells enabled after IBR", async function () {
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const [sellsEnabled] = await hokusaiAMM.getTradeInfo();
            expect(sellsEnabled).to.be.true;
        });

        it("Should show paused status", async function () {
            await hokusaiAMM.pause();

            const [, , isPaused] = await hokusaiAMM.getTradeInfo();
            expect(isPaused).to.be.true;
        });

        it("Should show unpaused status", async function () {
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            const [, , isPaused] = await hokusaiAMM.getTradeInfo();
            expect(isPaused).to.be.false;
        });

        it("Should return correct IBR end time", async function () {
            const [, ibrEndTime] = await hokusaiAMM.getTradeInfo();
            const buyOnlyUntil = await hokusaiAMM.buyOnlyUntil();

            expect(ibrEndTime).to.equal(buyOnlyUntil);
        });

        it("Should be callable by anyone (view function)", async function () {
            await expect(hokusaiAMM.connect(buyer1).getTradeInfo()).to.not.be.reverted;
        });
    });

    // ============================================================
    // BUY IMPACT CALCULATION
    // ============================================================

    describe("calculateBuyImpact()", function () {
        it("Should calculate tokens out correctly", async function () {
            const buyAmount = parseUnits("1000", 6);
            const [tokensOut] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // Should match getBuyQuote
            const quote = await hokusaiAMM.getBuyQuote(buyAmount);
            expect(tokensOut).to.equal(quote);
        });

        it("Should calculate price impact for small buy", async function () {
            const buyAmount = parseUnits("100", 6); // $100

            const [, priceImpact] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // Small trade should have minimal impact
            expect(priceImpact).to.be.lt(100); // < 1%
        });

        it("Should calculate price impact for large buy", async function () {
            const buyAmount = parseUnits("50000", 6); // $50k

            const [, priceImpact] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // Large trade should have significant impact
            expect(priceImpact).to.be.gt(100); // > 1%
        });

        it("Should calculate new spot price after buy", async function () {
            const buyAmount = parseUnits("10000", 6);

            const [, , newSpotPrice] = await hokusaiAMM.calculateBuyImpact(buyAmount);
            const currentSpotPrice = await hokusaiAMM.spotPrice();

            // New price should be higher than current
            expect(newSpotPrice).to.be.gt(currentSpotPrice);
        });

        it("Should show increasing impact for larger buys", async function () {
            const [, impact1k] = await hokusaiAMM.calculateBuyImpact(parseUnits("1000", 6));
            const [, impact5k] = await hokusaiAMM.calculateBuyImpact(parseUnits("5000", 6));
            const [, impact10k] = await hokusaiAMM.calculateBuyImpact(parseUnits("10000", 6));

            expect(impact5k).to.be.gt(impact1k);
            expect(impact10k).to.be.gt(impact5k);
        });

        it("Should account for trade fee in calculations", async function () {
            const buyAmount = parseUnits("1000", 6);

            // Change fee and recalculate
            await hokusaiAMM.setParameters(CRR, 100, PROTOCOL_FEE); // 1% fee vs 0.25%

            const [tokensOutHighFee] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // Reset fee
            await hokusaiAMM.setParameters(CRR, TRADE_FEE, PROTOCOL_FEE);
            const [tokensOutLowFee] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // Higher fee = fewer tokens
            expect(tokensOutHighFee).to.be.lt(tokensOutLowFee);
        });

        it("Should revert with zero amount", async function () {
            await expect(
                hokusaiAMM.calculateBuyImpact(0)
            ).to.be.revertedWith("Amount must be > 0");
        });

        it("Should be callable by anyone (view function)", async function () {
            await expect(
                hokusaiAMM.connect(buyer1).calculateBuyImpact(parseUnits("1000", 6))
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // SELL IMPACT CALCULATION
    // ============================================================

    describe("calculateSellImpact()", function () {
        it("Should calculate reserve out correctly", async function () {
            const sellAmount = parseEther("1000");
            const [reserveOut] = await hokusaiAMM.calculateSellImpact(sellAmount);

            // Should match getSellQuote
            const quote = await hokusaiAMM.getSellQuote(sellAmount);
            expect(reserveOut).to.equal(quote);
        });

        it("Should calculate price impact for small sell", async function () {
            const sellAmount = parseEther("100");

            const [, priceImpact] = await hokusaiAMM.calculateSellImpact(sellAmount);

            // Small trade should have minimal impact
            expect(priceImpact).to.be.lt(100); // < 1%
        });

        it("Should calculate price impact for large sell", async function () {
            const sellAmount = parseEther("50000");

            const [, priceImpact] = await hokusaiAMM.calculateSellImpact(sellAmount);

            // Large trade should have significant impact
            expect(priceImpact).to.be.gt(100); // > 1%
        });

        it("Should calculate new spot price after sell", async function () {
            const sellAmount = parseEther("10000");

            const [, , newSpotPrice] = await hokusaiAMM.calculateSellImpact(sellAmount);
            const currentSpotPrice = await hokusaiAMM.spotPrice();

            // New price should be lower than current
            expect(newSpotPrice).to.be.lt(currentSpotPrice);
        });

        it("Should show increasing impact for larger sells", async function () {
            const [, impact1k] = await hokusaiAMM.calculateSellImpact(parseEther("1000"));
            const [, impact5k] = await hokusaiAMM.calculateSellImpact(parseEther("5000"));
            const [, impact10k] = await hokusaiAMM.calculateSellImpact(parseEther("10000"));

            expect(impact5k).to.be.gt(impact1k);
            expect(impact10k).to.be.gt(impact5k);
        });

        it("Should return same quote regardless of fee (fee applied separately)", async function () {
            const sellAmount = parseEther("1000");

            // Get quote with low fee
            const [reserveOut1] = await hokusaiAMM.calculateSellImpact(sellAmount);

            // Change to higher fee and recalculate
            await hokusaiAMM.setParameters(CRR, 100, PROTOCOL_FEE); // 1% fee vs 0.25%
            const [reserveOut2] = await hokusaiAMM.calculateSellImpact(sellAmount);

            // Quote shows raw reserve out (before fee deduction)
            // Fee is deducted in the actual sell() function
            expect(reserveOut2).to.equal(reserveOut1);
        });

        it("Should revert with zero amount", async function () {
            await expect(
                hokusaiAMM.calculateSellImpact(0)
            ).to.be.revertedWith("Amount must be > 0");
        });

        it("Should be callable by anyone (view function)", async function () {
            await expect(
                hokusaiAMM.connect(buyer1).calculateSellImpact(parseEther("1000"))
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // INTEGRATION SCENARIOS
    // ============================================================

    describe("Integration Scenarios", function () {
        it("Should provide complete pool analytics in one call", async function () {
            const [reserve, supply, price, reserveRatio, tradeFeeRate, protocolFeeRate] =
                await hokusaiAMM.getPoolState();

            // All values should be sensible
            expect(reserve).to.be.gt(0);
            expect(supply).to.be.gt(0);
            expect(price).to.be.gt(0);
            expect(reserveRatio).to.be.gte(50000).and.lte(500000);
            expect(tradeFeeRate).to.be.lte(1000);
            expect(protocolFeeRate).to.be.lte(5000);
        });

        it("Should allow frontend to check trade feasibility", async function () {
            const [sellsEnabled, , isPaused] = await hokusaiAMM.getTradeInfo();

            // During IBR, sells should not be allowed
            expect(sellsEnabled).to.be.false;
            expect(isPaused).to.be.false;

            // Can still calculate what a sell would return (for UI display)
            await expect(
                hokusaiAMM.calculateSellImpact(parseEther("1000"))
            ).to.not.be.reverted;
        });

        it("Should help users estimate slippage before trading", async function () {
            const buyAmount = parseUnits("10000", 6);

            // Get current price
            const [, , currentPrice] = await hokusaiAMM.getPoolState();

            // Calculate impact
            const [tokensOut, priceImpact, newPrice] = await hokusaiAMM.calculateBuyImpact(buyAmount);

            // User can see:
            // 1. How many tokens they'll get
            expect(tokensOut).to.be.gt(0);

            // 2. Price impact percentage
            expect(priceImpact).to.be.gt(0);

            // 3. Price before/after
            expect(newPrice).to.be.gt(currentPrice);

            // Frontend can warn if impact > threshold
            const impactPercent = Number(priceImpact) / 100; // Convert bps to %
            if (impactPercent > 5) {
                // Show warning: "Price impact exceeds 5%"
            }
        });

        it("Should provide all data needed for a trade UI", async function () {
            // Pool state for display
            const [reserve, supply, price, crr, fee] = await hokusaiAMM.getPoolState();

            // Trade status for buttons
            const [sellsEnabled, ibrEnd, isPaused] = await hokusaiAMM.getTradeInfo();

            // Impact calculation for user input
            const userInput = parseUnits("5000", 6);
            const [tokensOut, impact, newPrice] = await hokusaiAMM.calculateBuyImpact(userInput);

            // All data available for complete UI
            expect(reserve).to.be.gt(0);
            expect(supply).to.be.gt(0);
            expect(price).to.be.gt(0);
            expect(crr).to.be.gt(0);
            expect(fee).to.be.gte(0);
            expect(ibrEnd).to.be.gt(0);
            expect(tokensOut).to.be.gt(0);
            expect(newPrice).to.be.gt(0);

            // Can conditionally enable/disable buttons
            const buyEnabled = !isPaused;
            const sellEnabled = sellsEnabled && !isPaused;
            expect(buyEnabled).to.be.true;
            expect(sellEnabled).to.be.false; // During IBR
        });

        it("Should track state changes across multiple operations", async function () {
            // Initial state
            const [reserve1, supply1, price1] = await hokusaiAMM.getPoolState();

            // Execute buy
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline);

            // State after buy
            const [reserve2, supply2, price2] = await hokusaiAMM.getPoolState();

            // Verify changes
            expect(reserve2).to.be.gt(reserve1);
            expect(supply2).to.be.gt(supply1);
            expect(price2).to.be.gt(price1);

            // Fee deposit
            await mockUSDC.mint(owner.address, parseUnits("1000", 6));
            await mockUSDC.approve(await hokusaiAMM.getAddress(), parseUnits("1000", 6));
            await hokusaiAMM.depositFees(parseUnits("1000", 6));

            // State after fee deposit
            const [reserve3, supply3, price3] = await hokusaiAMM.getPoolState();

            // Reserve increased, supply unchanged, price increased
            expect(reserve3).to.be.gt(reserve2);
            expect(supply3).to.equal(supply2);
            expect(price3).to.be.gt(price2);
        });
    });

    // ============================================================
    // GAS BENCHMARKS
    // ============================================================

    describe("Gas Benchmarks", function () {
        it("Should consume reasonable gas for getPoolState", async function () {
            const tx = await hokusaiAMM.getPoolState.estimateGas();
            // View functions with external calls use more gas than pure storage reads
            expect(tx).to.be.lt(50000); // Reasonable for multi-value view
            console.log("        getPoolState gas:", tx.toString());
        });

        it("Should consume reasonable gas for getTradeInfo", async function () {
            const tx = await hokusaiAMM.getTradeInfo.estimateGas();
            expect(tx).to.be.lt(30000);
            console.log("        getTradeInfo gas:", tx.toString());
        });

        it("Should consume reasonable gas for calculateBuyImpact", async function () {
            const tx = await hokusaiAMM.calculateBuyImpact.estimateGas(parseUnits("1000", 6));
            expect(tx).to.be.lt(50000); // Price impact calc is more complex
            console.log("        calculateBuyImpact gas:", tx.toString());
        });

        it("Should consume reasonable gas for calculateSellImpact", async function () {
            const tx = await hokusaiAMM.calculateSellImpact.estimateGas(parseEther("1000"));
            expect(tx).to.be.lt(50000);
            console.log("        calculateSellImpact gas:", tx.toString());
        });

        it("Should consume reasonable gas for spotPrice", async function () {
            const tx = await hokusaiAMM.spotPrice.estimateGas();
            expect(tx).to.be.lt(35000);
            console.log("        spotPrice gas:", tx.toString());
        });

        it("Should consume reasonable gas for isSellEnabled", async function () {
            const tx = await hokusaiAMM.isSellEnabled.estimateGas();
            expect(tx).to.be.lt(25000);
            console.log("        isSellEnabled gas:", tx.toString());
        });

        it("Should consume reasonable gas for getReserves", async function () {
            const tx = await hokusaiAMM.getReserves.estimateGas();
            expect(tx).to.be.lt(30000);
            console.log("        getReserves gas:", tx.toString());
        });
    });
});
