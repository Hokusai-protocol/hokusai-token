const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("Phase 9: Edge Cases & Boundary Conditions", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, user1, user2;

    // AMM Parameters
    const modelId = "edge-case-test-model";
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC
    const INITIAL_SUPPLY = parseUnits("100000", 18); // 100k tokens
    const CRR = 100000; // 10% reserve ratio
    const TRADE_FEE = 25; // 0.25%
    const PROTOCOL_FEE = 500; // 5%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days

    beforeEach(async function () {
        [owner, treasury, user1, user2] = await ethers.getSigners();

        // Deploy contracts
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        modelRegistry = await ModelRegistry.deploy();
        await modelRegistry.waitForDeployment();

        const TokenManager = await ethers.getContractFactory("TokenManager");
        tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
        await tokenManager.waitForDeployment();

        await tokenManager.deployToken(modelId, "Edge Case Test", "ECT", INITIAL_SUPPLY);
        const tokenAddress = await tokenManager.getTokenAddress(modelId);
        hokusaiToken = await ethers.getContractAt("HokusaiToken", tokenAddress);

        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await HokusaiAMM.deploy(
            await mockUSDC.getAddress(),
            await hokusaiToken.getAddress(),
            await tokenManager.getAddress(),
            modelId,
            treasury.address,
            CRR,
            TRADE_FEE,
            PROTOCOL_FEE,
            IBR_DURATION
        );
        await hokusaiAMM.waitForDeployment();

        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        await mockUSDC.mint(user1.address, parseUnits("1000000", 6));
        await mockUSDC.mint(user2.address, parseUnits("1000000", 6));

        await mockUSDC.connect(user1).approve(await hokusaiAMM.getAddress(), parseUnits("1000000", 6));
        await mockUSDC.connect(user2).approve(await hokusaiAMM.getAddress(), parseUnits("1000000", 6));
    });

    // ============================================================
    // ZERO VALUE EDGE CASES
    // ============================================================

    describe("Zero Value Edge Cases", function () {
        it("Should revert on zero buy amount", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(user1).buy(0, 0, user1.address, deadline)
            ).to.be.revertedWith("Reserve amount must be > 0");
        });

        it("Should revert on zero sell amount", async function () {
            // Buy some tokens first
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(user1).sell(0, 0, user1.address, deadline2)
            ).to.be.revertedWith("Token amount must be > 0");
        });

        it("Should handle zero address recipient rejection", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, ethers.ZeroAddress, deadline)
            ).to.be.revertedWith("Invalid recipient");
        });

        it("Should provide correct quote for minimum amounts", async function () {
            // 1 wei of USDC
            const quote = await hokusaiAMM.getBuyQuote(1);
            expect(quote).to.be.gt(0); // Should return some tokens

            // Very small amount
            const smallQuote = await hokusaiAMM.getBuyQuote(100);
            expect(smallQuote).to.be.gt(quote);
        });
    });

    // ============================================================
    // DUST AMOUNTS
    // ============================================================

    describe("Dust Amount Handling", function () {
        it("Should handle minimum viable buy (1 USDC cent)", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const oneCent = parseUnits("0.01", 6);

            await expect(
                hokusaiAMM.connect(user1).buy(oneCent, 0, user1.address, deadline)
            ).to.not.be.reverted;

            const tokens = await hokusaiToken.balanceOf(user1.address);
            expect(tokens).to.be.gt(0);
        });

        it("Should handle buying with dust USDC amounts", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const dustAmount = parseUnits("0.000001", 6); // 1 micro USDC

            await expect(
                hokusaiAMM.connect(user1).buy(dustAmount, 0, user1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should accumulate dust fees correctly", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const dustBuy = parseUnits("0.01", 6); // 1 cent

            const initialTreasury = await mockUSDC.balanceOf(treasury.address);

            // Make 100 dust trades
            for (let i = 0; i < 100; i++) {
                await hokusaiAMM.connect(user1).buy(dustBuy, 0, user1.address, deadline);
            }

            const finalTreasury = await mockUSDC.balanceOf(treasury.address);
            const feesCollected = finalTreasury - initialTreasury;

            // Should have collected fees from all trades
            expect(feesCollected).to.be.gt(0);
        });

        it("Should handle selling dust token amounts", async function () {
            // Buy tokens
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            // Fast forward
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Sell very small amount
            const dustTokens = parseUnits("0.000001", 18);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), dustTokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(user1).sell(dustTokens, 0, user1.address, deadline2)
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // FIRST TRADE EDGE CASES
    // ============================================================

    describe("First Trade Scenarios", function () {
        it("Should handle first buy correctly", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("100", 6);

            const initialPrice = await hokusaiAMM.spotPrice();
            const quote = await hokusaiAMM.getBuyQuote(buyAmount);

            await hokusaiAMM.connect(user1).buy(buyAmount, 0, user1.address, deadline);

            const tokens = await hokusaiToken.balanceOf(user1.address);
            expect(tokens).to.equal(quote);

            // Price should have increased
            const newPrice = await hokusaiAMM.spotPrice();
            expect(newPrice).to.be.gt(initialPrice);
        });

        it("Should handle first sell correctly", async function () {
            // Buy first
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline1);
            const tokens = await hokusaiToken.balanceOf(user1.address);

            // Fast forward
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // First sell
            const quote = await hokusaiAMM.getSellQuote(tokens);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);

            const initialUSDC = await mockUSDC.balanceOf(user1.address);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline2);

            const finalUSDC = await mockUSDC.balanceOf(user1.address);
            const usdcReceived = finalUSDC - initialUSDC;

            // Allow 1% tolerance for rounding differences
            expect(usdcReceived).to.be.closeTo(quote, quote / 100n);
        });

        it("Should handle exact IBR boundary correctly", async function () {
            // Fast forward to exactly IBR end
            const buyOnlyUntil = await hokusaiAMM.buyOnlyUntil();
            const currentTime = (await ethers.provider.getBlock('latest')).timestamp;
            const timeToEnd = Number(buyOnlyUntil - BigInt(currentTime));

            await ethers.provider.send("evm_increaseTime", [timeToEnd]);
            await ethers.provider.send("evm_mine");

            // Buy tokens right before IBR ends
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline1);

            // Move 1 second past IBR
            await ethers.provider.send("evm_increaseTime", [1]);
            await ethers.provider.send("evm_mine");

            // Should now allow sell
            const tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline2)
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // MAXIMUM VALUE EDGE CASES
    // ============================================================

    describe("Maximum Value Edge Cases", function () {
        it("Should handle very large buy amounts", async function () {
            // Set max trade to 50%
            await hokusaiAMM.setMaxTradeBps(5000);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxBuy = (currentReserve * 5000n) / 10000n;

            await expect(
                hokusaiAMM.connect(user1).buy(maxBuy, 0, user1.address, deadline)
            ).to.not.be.reverted;

            const tokens = await hokusaiToken.balanceOf(user1.address);
            expect(tokens).to.be.gt(0);
        });

        it("Should handle maximum trade size limit boundary", async function () {
            await hokusaiAMM.setMaxTradeBps(5000);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const currentReserve = await hokusaiAMM.reserveBalance();
            const exactLimit = (currentReserve * 5000n) / 10000n;

            // Exactly at limit should work
            await expect(
                hokusaiAMM.connect(user1).buy(exactLimit, 0, user1.address, deadline)
            ).to.not.be.reverted;

            // After first buy, reserve has increased. Calculate new limit.
            const newReserve = await hokusaiAMM.reserveBalance();
            const newLimit = (newReserve * 5000n) / 10000n;

            // Try to buy more than the new limit
            const overNewLimit = newLimit + parseUnits("1000", 6); // Well over 50% of new reserve
            await expect(
                hokusaiAMM.connect(user1).buy(overNewLimit, 0, user1.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");
        });

        it("Should handle maximum governance parameter values", async function () {
            // CRR at maximum (500000 = 50%)
            await expect(
                hokusaiAMM.setParameters(500000, 25, 500)
            ).to.not.be.reverted;

            // Trade fee at maximum (1000 = 10%)
            await expect(
                hokusaiAMM.setParameters(100000, 1000, 500)
            ).to.not.be.reverted;

            // Protocol fee at maximum (5000 = 50%)
            await expect(
                hokusaiAMM.setParameters(100000, 25, 5000)
            ).to.not.be.reverted;

            // Max trade bps at maximum (5000 = 50%)
            await expect(
                hokusaiAMM.setMaxTradeBps(5000)
            ).to.not.be.reverted;
        });

        it("Should reject parameters beyond maximum", async function () {
            // CRR over max (50%)
            await expect(
                hokusaiAMM.setParameters(500001, 25, 500)
            ).to.be.revertedWith("CRR out of bounds");

            // Trade fee over max (10%)
            await expect(
                hokusaiAMM.setParameters(100000, 1001, 500)
            ).to.be.revertedWith("Trade fee too high");

            // Protocol fee over max (50%)
            await expect(
                hokusaiAMM.setParameters(100000, 25, 5001)
            ).to.be.revertedWith("Protocol fee too high");

            // Max trade bps over max (50%)
            await expect(
                hokusaiAMM.setMaxTradeBps(5001)
            ).to.be.revertedWith("Max trade bps too high");
        });
    });

    // ============================================================
    // DEADLINE EDGE CASES
    // ============================================================

    describe("Deadline Boundary Conditions", function () {
        it("Should accept transaction exactly at deadline", async function () {
            const currentTime = (await ethers.provider.getBlock('latest')).timestamp;
            const deadline = currentTime + 1;

            // Should work if mined in same block
            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("100", 6), 0, user1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should reject expired deadline", async function () {
            const pastDeadline = (await ethers.provider.getBlock('latest')).timestamp - 1;

            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("100", 6), 0, user1.address, pastDeadline)
            ).to.be.revertedWith("Transaction expired");
        });

        it("Should handle far future deadline", async function () {
            const farFuture = (await ethers.provider.getBlock('latest')).timestamp + 365 * 24 * 60 * 60;

            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("100", 6), 0, user1.address, farFuture)
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // SLIPPAGE EDGE CASES
    // ============================================================

    describe("Slippage Boundary Conditions", function () {
        it("Should succeed with exact minTokensOut", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            const quote = await hokusaiAMM.getBuyQuote(buyAmount);

            await expect(
                hokusaiAMM.connect(user1).buy(buyAmount, quote, user1.address, deadline)
            ).to.not.be.reverted;

            const tokens = await hokusaiToken.balanceOf(user1.address);
            expect(tokens).to.equal(quote);
        });

        it("Should fail with minTokensOut one wei above quote", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            const quote = await hokusaiAMM.getBuyQuote(buyAmount);
            const overQuote = quote + 1n;

            await expect(
                hokusaiAMM.connect(user1).buy(buyAmount, overQuote, user1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should handle zero slippage tolerance", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            // minTokensOut = 0 means accept any amount
            await expect(
                hokusaiAMM.connect(user1).buy(buyAmount, 0, user1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should handle maximum slippage tolerance", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            // Set impossibly high minTokensOut
            const maxUint = ethers.MaxUint256;

            await expect(
                hokusaiAMM.connect(user1).buy(buyAmount, maxUint, user1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });
    });

    // ============================================================
    // ROUNDING AND PRECISION
    // ============================================================

    describe("Rounding and Precision Edge Cases", function () {
        it("Should handle trades that result in fractional fees", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            // Amount that results in fractional fee: 3 * 0.0025 = 0.0075 (< 0.01 USDC)
            const weirdAmount = parseUnits("3", 6);

            await expect(
                hokusaiAMM.connect(user1).buy(weirdAmount, 0, user1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should maintain precision across multiple operations", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

            // Make 10 small trades
            for (let i = 0; i < 10; i++) {
                await hokusaiAMM.connect(user1).buy(parseUnits("10", 6), 0, user1.address, deadline);
            }

            // Reserve should be precisely calculated
            const reserve = await hokusaiAMM.reserveBalance();
            expect(reserve).to.be.gt(INITIAL_RESERVE);

            // Total USDC in system should match reserve + fees
            const ammBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());
            expect(ammBalance).to.be.closeTo(reserve, parseUnits("1", 6));
        });

        it("Should handle price calculations near zero supply", async function () {
            // Initial supply is 100k, can't test actual zero
            // But we can test with minimum traded supply
            const price = await hokusaiAMM.spotPrice();
            expect(price).to.be.gt(0);
        });
    });

    // ============================================================
    // SEQUENTIAL OPERATION EDGE CASES
    // ============================================================

    describe("Sequential Operation Edge Cases", function () {
        it("Should handle rapid sequential buys from same user", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const initialBalance = await hokusaiToken.balanceOf(user1.address);

            // 20 rapid buys
            for (let i = 0; i < 20; i++) {
                await hokusaiAMM.connect(user1).buy(parseUnits("50", 6), 0, user1.address, deadline);
            }

            const finalBalance = await hokusaiToken.balanceOf(user1.address);
            expect(finalBalance).to.be.gt(initialBalance);
        });

        it("Should handle alternating buy/sell operations", async function () {
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const initialUSDC = await mockUSDC.balanceOf(user1.address);

            // Buy, sell, buy, sell
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            let tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);
            await hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline);

            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);
            await hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline);

            // Should have lost to fees
            const finalUSDC = await mockUSDC.balanceOf(user1.address);
            expect(finalUSDC).to.be.lt(initialUSDC);
        });

        it("Should handle buy immediately after sell", async function () {
            // Buy first
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            // Fast forward
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Sell
            const tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);
            await hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline2);

            // Buy again immediately
            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline2)
            ).to.not.be.reverted;
        });
    });
});
