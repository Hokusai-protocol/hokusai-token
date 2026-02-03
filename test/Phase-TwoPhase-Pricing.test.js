const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("Two-Phase Pricing System", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, buyer1, buyer2, seller;

    // AMM Parameters
    const modelId = "two-phase-test-model";
    const INITIAL_SUPPLY = parseUnits("1000000", 18); // 1M tokens
    const CRR = 200000; // 20% reserve ratio
    const TRADE_FEE = 30; // 0.30%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days
    const FLAT_CURVE_THRESHOLD = parseUnits("25000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    beforeEach(async function () {
        [owner, treasury, buyer1, buyer2, seller] = await ethers.getSigners();

        // Deploy mock USDC
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

        // Deploy token
        await tokenManager.deployToken(modelId, "Two Phase Test", "TPT", INITIAL_SUPPLY);
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

        // Authorize AMM
        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        // Fund test accounts with USDC
        await mockUSDC.mint(buyer1.address, parseUnits("100000", 6)); // $100k
        await mockUSDC.mint(buyer2.address, parseUnits("100000", 6)); // $100k
        await mockUSDC.mint(seller.address, parseUnits("100000", 6)); // $100k

        // Approve AMM to spend USDC
        await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(buyer2).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(seller).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
    });

    // ============================================================
    // PHASE DETECTION TESTS
    // ============================================================

    describe("Phase Detection", function () {
        it("Should start in FLAT_PRICE phase with zero reserve", async function () {
            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(0); // FLAT_PRICE = 0
        });

        it("Should return correct phase info at start", async function () {
            const info = await hokusaiAMM.getPhaseInfo();

            expect(info.currentPhase).to.equal(0); // FLAT_PRICE
            expect(info.currentReserve).to.equal(0);
            expect(info.thresholdReserve).to.equal(FLAT_CURVE_THRESHOLD);
            expect(info.flatPrice).to.equal(FLAT_CURVE_PRICE);
            expect(info.percentToThreshold).to.equal(0);
        });

        it("Should show progress toward threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy $5k worth (20% of threshold before fees)
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline);

            const info = await hokusaiAMM.getPhaseInfo();
            // After 0.30% fee: 5000 * 0.997 = 4985, which is 19.94% of 25000
            expect(info.percentToThreshold).to.be.closeTo(20, 1); // Within 1%
        });

        it("Should transition to BONDING_CURVE phase after crossing threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy $30k worth (crosses $25k threshold)
            await hokusaiAMM.connect(buyer1).buy(parseUnits("30000", 6), 0, buyer1.address, deadline);

            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(1); // BONDING_CURVE = 1
        });

        it("Should show 100% progress after crossing threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await hokusaiAMM.connect(buyer1).buy(parseUnits("30000", 6), 0, buyer1.address, deadline);

            const info = await hokusaiAMM.getPhaseInfo();
            expect(info.percentToThreshold).to.equal(100);
        });
    });

    // ============================================================
    // FLAT PRICE PHASE TESTS
    // ============================================================

    describe("Flat Price Phase Behavior", function () {
        it("Should return fixed spot price in flat phase", async function () {
            const spotPrice = await hokusaiAMM.spotPrice();
            expect(spotPrice).to.equal(FLAT_CURVE_PRICE);
        });

        it("Should maintain fixed spot price after trades", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            const spotBefore = await hokusaiAMM.spotPrice();
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline);
            const spotAfter = await hokusaiAMM.spotPrice();

            expect(spotBefore).to.equal(spotAfter);
            expect(spotAfter).to.equal(FLAT_CURVE_PRICE);
        });

        it("Should calculate tokens correctly at fixed price", async function () {
            const usdcAmount = parseUnits("1000", 6); // $1000
            const quote = await hokusaiAMM.getBuyQuote(usdcAmount);

            // After 0.30% fee: $1000 * 0.997 = $997
            // Tokens at $0.01: $997 / $0.01 = 99,700 tokens
            const expectedTokens = parseUnits("99700", 18);

            expect(quote).to.equal(expectedTokens);
        });

        it("Should allow very large trades without overflow", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Try to buy $50k worth (would overflow in bonding curve)
            const largeAmount = parseUnits("20000", 6);
            const quote = await hokusaiAMM.getBuyQuote(largeAmount);

            expect(quote).to.be.gt(0);

            // Should not revert
            await expect(
                hokusaiAMM.connect(buyer1).buy(largeAmount, 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should handle multiple sequential buys at fixed price", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            const amount = parseUnits("1000", 6);

            const quote1 = await hokusaiAMM.getBuyQuote(amount);
            await hokusaiAMM.connect(buyer1).buy(amount, 0, buyer1.address, deadline);

            const quote2 = await hokusaiAMM.getBuyQuote(amount);
            await hokusaiAMM.connect(buyer2).buy(amount, 0, buyer2.address, deadline);

            // Both quotes should be identical (fixed price)
            expect(quote1).to.equal(quote2);
        });

        it("Should handle sells at fixed price (after IBR)", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy tokens
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline);
            const tokensReceived = await hokusaiToken.balanceOf(buyer1.address);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Sell half the tokens
            const tokensToSell = tokensReceived / 2n;
            const sellQuote = await hokusaiAMM.getSellQuote(tokensToSell);

            // Should get approximately half the USDC back (minus fees)
            // Tokens * price = USDC
            const expectedUSDC = (tokensToSell * BigInt(FLAT_CURVE_PRICE)) / parseUnits("1", 18);

            expect(sellQuote).to.be.closeTo(expectedUSDC, parseUnits("1", 6)); // Within $1
        });
    });

    // ============================================================
    // THRESHOLD CROSSING TESTS
    // ============================================================

    describe("Threshold Crossing Behavior", function () {
        it("Should emit PhaseTransition event when crossing threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("30000", 6), 0, buyer1.address, deadline)
            ).to.emit(hokusaiAMM, "PhaseTransition")
             .withArgs(0, 1, parseUnits("29910", 6), await ethers.provider.getBlock('latest').then(b => b.timestamp + 1));
        });

        it("Should calculate hybrid trade correctly when crossing threshold", async function () {
            const tradeAmount = parseUnits("30000", 6); // Crosses $25k threshold
            const quote = await hokusaiAMM.getBuyQuote(tradeAmount);

            // Quote should be non-zero and reasonable
            expect(quote).to.be.gt(0);
            expect(quote).to.be.lt(parseUnits("10000000", 18)); // Sanity check
        });

        it("Should handle trade exactly at threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy exactly to threshold
            const exactAmount = FLAT_CURVE_THRESHOLD;

            await expect(
                hokusaiAMM.connect(buyer1).buy(exactAmount, 0, buyer1.address, deadline)
            ).to.not.be.reverted;

            // Should still be in flat phase (< threshold, not >=)
            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(0);
        });

        it("Should transition with minimum amount over threshold", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Need to account for fees: to get $25,001 in reserve, we need to send more
            // reserveAfterFee = amount * 0.997
            // So amount = threshold / 0.997 + small amount
            const amount = parseUnits("25100", 6); // Enough to cross after fees

            await hokusaiAMM.connect(buyer1).buy(amount, 0, buyer1.address, deadline);

            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(1); // BONDING_CURVE
        });

        it("Should split calculation correctly for crossing trade", async function () {
            // Buy $30k (crosses $25k threshold)
            const tradeAmount = parseUnits("30000", 6);
            const quote = await hokusaiAMM.getBuyQuote(tradeAmount);

            // Calculate expected:
            // Flat portion: $25k at $0.01 = 2.5M tokens (before fee)
            // Curve portion: $5k at bonding curve

            // This is complex, but quote should be > 2.5M tokens
            expect(quote).to.be.gt(parseUnits("2400000", 18)); // At least 2.4M after fees
        });
    });

    // ============================================================
    // BONDING CURVE PHASE TESTS
    // ============================================================

    describe("Bonding Curve Phase Behavior", function () {
        beforeEach(async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Cross threshold to enter bonding curve phase
            await hokusaiAMM.connect(buyer1).buy(parseUnits("30000", 6), 0, buyer1.address, deadline);
        });

        it("Should be in BONDING_CURVE phase", async function () {
            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(1);
        });

        it("Should permanently stay in BONDING_CURVE phase even if reserve drops below threshold", async function () {
            // Verify we're in bonding curve phase
            let phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(1); // BONDING_CURVE

            // Check hasGraduated flag is set
            const hasGraduated = await hokusaiAMM.hasGraduated();
            expect(hasGraduated).to.be.true;

            // Fast forward past IBR to enable sells
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Get buyer's token balance
            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);

            // Approve AMM to spend tokens
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            // Sell tokens in multiple batches to drop reserve below threshold
            // maxTradeBps is 2000 (20%), so max sell is 20% of reserve per tx
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;

            for (let i = 0; i < 10; i++) {
                const reserveBefore = await hokusaiAMM.reserveBalance();
                if (reserveBefore < FLAT_CURVE_THRESHOLD) break; // Stop if we're below threshold

                // Calculate max sell amount (15% of reserve to be safe, limit is 20%)
                const maxReserveOut = (reserveBefore * 1500n) / 10000n; // 15% of reserve

                // Find how many tokens would give us approximately this much USDC
                const sellerBalance = await hokusaiToken.balanceOf(buyer1.address);
                if (sellerBalance === 0n) break; // Stop if seller has no tokens left

                // Use binary search to find the right token amount
                // For simplicity, start with a small percentage
                const tokenSupply = await hokusaiToken.totalSupply();
                const tokensToSell = tokenSupply * 5n / 100n; // Try 5% of supply

                if (tokensToSell > sellerBalance || tokensToSell === 0n) break;

                // Get the actual quote to verify it's within limits
                const quote = await hokusaiAMM.getSellQuote(tokensToSell);
                if (quote > maxReserveOut) {
                    // Quote too large, sell less tokens
                    const adjustedTokens = tokensToSell * maxReserveOut / quote;
                    if (adjustedTokens === 0n) break;
                    await hokusaiAMM.connect(buyer1).sell(adjustedTokens, 0, buyer1.address, deadline);
                } else {
                    await hokusaiAMM.connect(buyer1).sell(tokensToSell, 0, buyer1.address, deadline);
                }
            }

            // Check reserve is now below threshold
            const reserveBalance = await hokusaiAMM.reserveBalance();
            expect(reserveBalance).to.be.lt(FLAT_CURVE_THRESHOLD);

            // CRITICAL TEST: Phase should still be BONDING_CURVE
            phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(1); // Should remain BONDING_CURVE

            // Verify hasGraduated is still true
            const stillGraduated = await hokusaiAMM.hasGraduated();
            expect(stillGraduated).to.be.true;
        });

        it("Should increase spot price with subsequent buys", async function () {
            const spotBefore = await hokusaiAMM.spotPrice();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer2).buy(parseUnits("5000", 6), 0, buyer2.address, deadline);

            const spotAfter = await hokusaiAMM.spotPrice();
            expect(spotAfter).to.be.gt(spotBefore);
        });

        it("Should return different quotes for same amount", async function () {
            const amount = parseUnits("1000", 6);

            const quote1 = await hokusaiAMM.getBuyQuote(amount);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer2).buy(amount, 0, buyer2.address, deadline);

            const quote2 = await hokusaiAMM.getBuyQuote(amount);

            // Second quote should return fewer tokens (price increased)
            expect(quote2).to.be.lt(quote1);
        });

        it("Should enforce trade size limits in bonding curve phase", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Try to buy more than maxTradeBps (20% of reserve by default)
            const reserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (reserve * 2000n) / 10000n; // 20%
            const tooLarge = maxTrade + parseUnits("1", 6);

            await expect(
                hokusaiAMM.connect(buyer2).buy(tooLarge, 0, buyer2.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");
        });
    });

    // ============================================================
    // EDGE CASES
    // ============================================================

    describe("Edge Cases", function () {
        it("Should handle zero reserve properly", async function () {
            const phase = await hokusaiAMM.getCurrentPhase();
            expect(phase).to.equal(0); // FLAT_PRICE

            const spotPrice = await hokusaiAMM.spotPrice();
            expect(spotPrice).to.equal(FLAT_CURVE_PRICE);
        });

        it("Should handle very small trade in flat phase", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            const tinyAmount = parseUnits("0.01", 6); // $0.01
            const quote = await hokusaiAMM.getBuyQuote(tinyAmount);

            expect(quote).to.be.gt(0);

            await expect(
                hokusaiAMM.connect(buyer1).buy(tinyAmount, 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should handle buy that lands exactly on threshold boundary", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // First buy gets us close to threshold
            await hokusaiAMM.connect(buyer1).buy(parseUnits("24000", 6), 0, buyer1.address, deadline);

            // Second buy should cross threshold
            // Need to account for fees: send enough so that after fees we cross
            const reserve = await hokusaiAMM.reserveBalance();
            const remaining = FLAT_CURVE_THRESHOLD - reserve;
            const amountNeeded = (remaining * 10000n) / 9970n + parseUnits("10", 6); // Account for 0.3% fee + extra

            await expect(
                hokusaiAMM.connect(buyer2).buy(amountNeeded, 0, buyer2.address, deadline)
            ).to.emit(hokusaiAMM, "PhaseTransition");
        });

        it("Should handle depositFees that crosses threshold", async function () {
            // Deposit fees that cross threshold
            await mockUSDC.mint(owner.address, parseUnits("30000", 6));
            await mockUSDC.approve(await hokusaiAMM.getAddress(), parseUnits("30000", 6));

            const phaseBefore = await hokusaiAMM.getCurrentPhase();
            await hokusaiAMM.depositFees(parseUnits("30000", 6));
            const phaseAfter = await hokusaiAMM.getCurrentPhase();

            expect(phaseBefore).to.equal(0); // FLAT_PRICE
            expect(phaseAfter).to.equal(1); // BONDING_CURVE
        });
    });

    // ============================================================
    // CONFIGURATION TESTS
    // ============================================================

    describe("Configuration", function () {
        it("Should have correct immutable parameters", async function () {
            expect(await hokusaiAMM.FLAT_CURVE_THRESHOLD()).to.equal(FLAT_CURVE_THRESHOLD);
            expect(await hokusaiAMM.FLAT_CURVE_PRICE()).to.equal(FLAT_CURVE_PRICE);
        });

        it("Should validate threshold > 0 in constructor", async function () {
            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");

            await expect(
                HokusaiAMM.deploy(
                    await mockUSDC.getAddress(),
                    await hokusaiToken.getAddress(),
                    await tokenManager.getAddress(),
                    "invalid-model",
                    treasury.address,
                    CRR,
                    TRADE_FEE,
                    IBR_DURATION,
                    0, // Invalid threshold
                    FLAT_CURVE_PRICE
                )
            ).to.be.revertedWithCustomError(HokusaiAMM, "InvalidAmount");
        });

        it("Should validate price > 0 in constructor", async function () {
            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");

            await expect(
                HokusaiAMM.deploy(
                    await mockUSDC.getAddress(),
                    await hokusaiToken.getAddress(),
                    await tokenManager.getAddress(),
                    "invalid-model",
                    treasury.address,
                    CRR,
                    TRADE_FEE,
                    IBR_DURATION,
                    FLAT_CURVE_THRESHOLD,
                    0 // Invalid price
                )
            ).to.be.revertedWithCustomError(HokusaiAMM, "InvalidAmount");
        });
    });
});
