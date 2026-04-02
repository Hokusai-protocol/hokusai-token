const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * BondingCurveMath Precision Tests for Expanded CRR Range (50-100%)
 *
 * This test suite validates the BondingCurveMath library's precision for CRR values
 * in the expanded range of 50-100%. As CRR approaches 100%, the bonding curve becomes
 * nearly linear (constant price), making precision critical.
 *
 * Mathematical Context:
 * - When CRR = 100%, exponent = 1/CRR = 1.0, making the power function linear
 * - When CRR = 80%, exponent = 1.25
 * - When CRR = 60%, exponent = 1.667
 * - When CRR = 50%, exponent = 2.0
 *
 * The pow() function must maintain precision across these exponent ranges.
 */
describe("BondingCurveMath - High CRR Precision (50-100%)", function () {
    let bondingCurve;
    const PRECISION = ethers.parseEther("1"); // 1e18
    const PPM = 1000000n;

    // Test ranges
    const MIN_CRR = 500000; // 50%
    const MAX_CRR = 1000000; // 100%

    // Tolerance configurations for different scenarios
    const TOLERANCE = {
        // Standard tolerance for most calculations
        standard: ethers.parseEther("0.01"), // 1% tolerance

        // Tighter tolerance for high CRR (more linear)
        highCRR: ethers.parseEther("0.005"), // 0.5% tolerance

        // Round-trip tolerance (buy then sell)
        roundTrip: 10n, // 10 basis points = 0.1%

        // Price calculation tolerance
        price: ethers.parseEther("0.001") // 0.1% tolerance
    };

    before(async function () {
        const BondingCurveFactory = await ethers.getContractFactory("BondingCurveMathTestHarness");
        const BondingCurve = await BondingCurveFactory.deploy();
        await BondingCurve.waitForDeployment();
        bondingCurve = BondingCurve;
    });

    describe("Mathematical Analysis - Power Function at High CRR", function () {
        it("should correctly calculate exponents for various CRR values", async function () {
            // Verify the exponent relationships mentioned in the issue
            const testCases = [
                { crr: 1000000, expectedExponent: 1.0, description: "100% CRR (linear)" },
                { crr: 800000, expectedExponent: 1.25, description: "80% CRR" },
                { crr: 666667, expectedExponent: 1.5, description: "~66.7% CRR" },
                { crr: 600000, expectedExponent: 1.667, description: "60% CRR" },
                { crr: 500000, expectedExponent: 2.0, description: "50% CRR" }
            ];

            for (const test of testCases) {
                // Calculate exponent: 1/CRR
                const exponentPpm = (PPM * PPM) / BigInt(test.crr);
                const exponent = (exponentPpm * PRECISION) / PPM;

                // Verify it matches expected value (with small tolerance for rounding)
                const expectedExponent = ethers.parseEther(test.expectedExponent.toString());
                expect(exponent).to.be.closeTo(expectedExponent, ethers.parseEther("0.01"));

                console.log(`  ${test.description}: exponent = ${ethers.formatEther(exponent)}`);
            }
        });

        it("should verify linear behavior at CRR = 100%", async function () {
            // At CRR = 100%, (1+x)^1.0 should equal (1+x) very closely
            const testBases = [
                ethers.parseEther("1.01"), // 1% increase
                ethers.parseEther("1.05"), // 5% increase
                ethers.parseEther("1.10"), // 10% increase
                ethers.parseEther("1.20")  // 20% increase
            ];

            for (const base of testBases) {
                const result = await bondingCurve.testPow(base, PRECISION); // exponent = 1.0
                // At exponent 1.0, pow(base, 1.0) should equal base (with small tolerance for Taylor series)
                expect(result).to.be.closeTo(base, ethers.parseEther("0.001")); // 0.1% tolerance
            }
        });

        it("should maintain precision for intermediate CRR values (buy path)", async function () {
            const base = ethers.parseEther("1.1"); // 10% increase

            // Test BUY exponents: w = CRR
            const testPoints = [
                { crr: 500000, name: "50% CRR" },
                { crr: 600000, name: "60% CRR" },
                { crr: 700000, name: "70% CRR" },
                { crr: 800000, name: "80% CRR" },
                { crr: 900000, name: "90% CRR" },
                { crr: 1000000, name: "100% CRR" }
            ];

            for (const point of testPoints) {
                const exponent = (BigInt(point.crr) * PRECISION) / PPM;
                const result = await bondingCurve.testPow(base, exponent);

                // Result should be >= 1.0 and <= base (since exponent <= 1.0)
                expect(result).to.be.gte(PRECISION);
                expect(result).to.be.lte(base);

                console.log(`  ${point.name}: pow(1.1, ${ethers.formatEther(exponent)}) = ${ethers.formatEther(result)}`);
            }
        });

        it("should maintain precision for intermediate CRR values (sell path)", async function () {
            const base = ethers.parseEther("0.95"); // 5% decrease (typical sell scenario)

            // Test SELL exponents: 1/w = 1/CRR (as mentioned in issue description)
            const testPoints = [
                { crr: 1000000, expectedExp: 1.0, name: "100% CRR" },
                { crr: 800000, expectedExp: 1.25, name: "80% CRR" },
                { crr: 666667, expectedExp: 1.5, name: "~66.7% CRR" },
                { crr: 600000, expectedExp: 1.667, name: "60% CRR" },
                { crr: 500000, expectedExp: 2.0, name: "50% CRR" }
            ];

            for (const point of testPoints) {
                // Calculate exponent: 1/w = PPM / CRR
                const exponent = (PPM * PRECISION) / BigInt(point.crr);
                const result = await bondingCurve.testPow(base, exponent);

                // At higher CRR (lower exponent), result should be closer to base
                expect(result).to.be.gt(0);
                expect(result).to.be.lte(PRECISION); // Result < 1.0 since base < 1.0

                console.log(`  ${point.name}: pow(0.95, ${ethers.formatEther(exponent)}) = ${ethers.formatEther(result)}`);
            }
        });
    });

    describe("Fuzz Tests - calculateBuy() with High CRR", function () {
        it("should handle various deposit sizes with CRR 50-100%", async function () {
            const supply = ethers.parseEther("1000000"); // 1M tokens
            const reserve = ethers.parseUnits("100000", 6); // 100k USDC

            // Test multiple CRR values
            const crrValues = [500000, 600000, 700000, 800000, 900000, 1000000];

            // Test multiple deposit sizes (0.1% to 10% of reserve)
            const depositSizes = [
                ethers.parseUnits("100", 6),   // 0.1% of reserve
                ethers.parseUnits("1000", 6),  // 1% of reserve
                ethers.parseUnits("5000", 6),  // 5% of reserve
                ethers.parseUnits("10000", 6)  // 10% of reserve
            ];

            for (const crr of crrValues) {
                for (const deposit of depositSizes) {
                    const tokensOut = await bondingCurve.testCalculateBuy(
                        supply,
                        reserve,
                        deposit,
                        crr
                    );

                    // Sanity checks
                    expect(tokensOut).to.be.gt(0);

                    // At high CRR, token output should be closer to linear
                    // For CRR=100%, deposit/reserve ratio should approximately equal tokensOut/supply ratio
                    if (crr === 1000000) {
                        const depositRatio = (deposit * PRECISION) / reserve;
                        const tokenRatio = (tokensOut * PRECISION) / supply;
                        // Should be very close at CRR=100%
                        expect(tokenRatio).to.be.closeTo(depositRatio, depositRatio / 50n);
                    }
                }
            }
        });

        it("should maintain precision with very large reserves (high CRR)", async function () {
            // Test with large reserves to check for overflow/precision issues
            const supply = ethers.parseEther("100000000"); // 100M tokens
            const reserve = ethers.parseUnits("10000000", 6); // 10M USDC
            const deposit = ethers.parseUnits("100000", 6); // 100k USDC (1% of reserve)

            for (const crr of [500000, 750000, 1000000]) {
                const tokensOut = await bondingCurve.testCalculateBuy(
                    supply,
                    reserve,
                    deposit,
                    crr
                );

                expect(tokensOut).to.be.gt(0);
                expect(tokensOut).to.be.lte(supply); // Can't mint more than current supply

                // Verify the result is reasonable
                const depositPercentage = (deposit * 10000n) / reserve;
                const tokensPercentage = (tokensOut * 10000n) / supply;

                // At high CRR, these percentages should be similar
                if (crr >= 800000) {
                    expect(tokensPercentage).to.be.closeTo(depositPercentage, depositPercentage / 2n);
                }
            }
        });

        it("should handle edge case: very small deposit with CRR approaching 100%", async function () {
            const supply = ethers.parseEther("1000000");
            const reserve = ethers.parseUnits("100000", 6);
            const deposit = ethers.parseUnits("1", 6); // 1 USDC (0.001% of reserve)

            for (const crr of [900000, 950000, 1000000]) {
                const tokensOut = await bondingCurve.testCalculateBuy(
                    supply,
                    reserve,
                    deposit,
                    crr
                );

                expect(tokensOut).to.be.gt(0);

                // Even tiny deposits should yield proportional tokens at high CRR
                const expectedApprox = (supply * deposit) / reserve;
                if (crr === 1000000) {
                    expect(tokensOut).to.be.closeTo(expectedApprox, expectedApprox / 20n);
                }
            }
        });
    });

    describe("Fuzz Tests - calculateSell() with High CRR", function () {
        it("should handle various token amounts with CRR 50-100%", async function () {
            const supply = ethers.parseEther("1000000");
            const reserve = ethers.parseUnits("100000", 6);

            const crrValues = [500000, 600000, 700000, 800000, 900000, 1000000];

            // Test selling 0.1% to 10% of supply
            const tokenAmounts = [
                ethers.parseEther("1000"),    // 0.1% of supply
                ethers.parseEther("10000"),   // 1% of supply
                ethers.parseEther("50000"),   // 5% of supply
                ethers.parseEther("100000")   // 10% of supply
            ];

            for (const crr of crrValues) {
                for (const tokens of tokenAmounts) {
                    const reserveOut = await bondingCurve.testCalculateSell(
                        supply,
                        reserve,
                        tokens,
                        crr
                    );

                    // Sanity checks
                    expect(reserveOut).to.be.gt(0);
                    expect(reserveOut).to.be.lte(reserve);

                    // At CRR=100%, should be approximately linear
                    if (crr === 1000000) {
                        const tokenRatio = (tokens * PRECISION) / supply;
                        const reserveRatio = (reserveOut * PRECISION) / reserve;
                        expect(reserveRatio).to.be.closeTo(tokenRatio, tokenRatio / 50n);
                    }
                }
            }
        });

        it("should maintain precision with very large reserves (high CRR)", async function () {
            const supply = ethers.parseEther("100000000");
            const reserve = ethers.parseUnits("10000000", 6);
            const tokens = ethers.parseEther("1000000"); // 1% of supply

            for (const crr of [500000, 750000, 1000000]) {
                const reserveOut = await bondingCurve.testCalculateSell(
                    supply,
                    reserve,
                    tokens,
                    crr
                );

                expect(reserveOut).to.be.gt(0);
                expect(reserveOut).to.be.lte(reserve);
            }
        });
    });

    describe("Fuzz Tests - calculateSpotPrice() with High CRR", function () {
        it("should calculate consistent prices across CRR range", async function () {
            const supply = ethers.parseEther("1000000");
            const reserve = ethers.parseUnits("100000", 6);

            const prices = [];
            for (let crr = MIN_CRR; crr <= MAX_CRR; crr += 50000) {
                const price = await bondingCurve.testCalculateSpotPrice(supply, reserve, crr);
                expect(price).to.be.gt(0);
                prices.push({ crr, price });
            }

            // Verify prices decrease as CRR increases (more conservative curve)
            for (let i = 1; i < prices.length; i++) {
                expect(prices[i].price).to.be.lte(prices[i-1].price);
            }
        });

        it("should handle various supply/reserve ratios with high CRR", async function () {
            const testCases = [
                { supply: ethers.parseEther("1000"), reserve: ethers.parseUnits("100", 6) },
                { supply: ethers.parseEther("10000"), reserve: ethers.parseUnits("1000", 6) },
                { supply: ethers.parseEther("100000"), reserve: ethers.parseUnits("10000", 6) },
                { supply: ethers.parseEther("1000000"), reserve: ethers.parseUnits("100000", 6) }
            ];

            for (const test of testCases) {
                for (const crr of [500000, 750000, 1000000]) {
                    const price = await bondingCurve.testCalculateSpotPrice(
                        test.supply,
                        test.reserve,
                        crr
                    );
                    expect(price).to.be.gt(0);
                }
            }
        });
    });

    describe("Round-Trip Accuracy Tests", function () {
        it("should maintain reserve value in buy->sell round trip (CRR 50-100%)", async function () {
            const initialSupply = ethers.parseEther("1000000");
            const initialReserve = ethers.parseUnits("100000", 6);
            const deposit = ethers.parseUnits("10000", 6); // 10k USDC

            for (const crr of [500000, 600000, 700000, 800000, 900000, 1000000]) {
                // Step 1: Buy tokens
                const tokensBought = await bondingCurve.testCalculateBuy(
                    initialSupply,
                    initialReserve,
                    deposit,
                    crr
                );

                expect(tokensBought).to.be.gt(0);

                // Step 2: Sell those tokens back
                const newSupply = initialSupply + tokensBought;
                const newReserve = initialReserve + deposit;
                const reserveReturned = await bondingCurve.testCalculateSell(
                    newSupply,
                    newReserve,
                    tokensBought,
                    crr
                );

                // Step 3: Calculate reserve loss (should be minimal)
                const reserveLoss = deposit - reserveReturned;
                const lossPercentage = (reserveLoss * 10000n) / deposit; // In basis points

                // At high CRR, round-trip loss should be minimal
                // Allow up to 20 bps (0.2%) loss for CRR >= 50%
                expect(lossPercentage).to.be.lte(TOLERANCE.roundTrip * 2n);

                console.log(`  CRR ${crr/10000}%: deposited ${ethers.formatUnits(deposit, 6)}, returned ${ethers.formatUnits(reserveReturned, 6)}, loss ${lossPercentage} bps`);
            }
        });

        it("should have minimal slippage at CRR = 100%", async function () {
            const supply = ethers.parseEther("1000000");
            const reserve = ethers.parseUnits("100000", 6);
            const deposit = ethers.parseUnits("1000", 6);
            const crr = 1000000; // 100% CRR

            // Buy tokens
            const tokensBought = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);

            // Sell them back
            const newSupply = supply + tokensBought;
            const newReserve = reserve + deposit;
            const reserveReturned = await bondingCurve.testCalculateSell(
                newSupply,
                newReserve,
                tokensBought,
                crr
            );

            // At CRR=100%, should be nearly perfect round-trip
            const lossPercentage = ((deposit - reserveReturned) * 10000n) / deposit;
            expect(lossPercentage).to.be.lte(5n); // Max 5 bps (0.05%) loss
        });

        it("should maintain reserve invariant across multiple trades", async function () {
            let supply = ethers.parseEther("1000000");
            let reserve = ethers.parseUnits("100000", 6);
            const crr = 800000; // 80% CRR

            // Perform multiple buy/sell cycles
            for (let i = 0; i < 5; i++) {
                const deposit = ethers.parseUnits("5000", 6);

                // Buy
                const tokensBought = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);
                supply = supply + tokensBought;
                reserve = reserve + deposit;

                // Sell half back
                const tokensToSell = tokensBought / 2n;
                const reserveReturned = await bondingCurve.testCalculateSell(
                    supply,
                    reserve,
                    tokensToSell,
                    crr
                );
                supply = supply - tokensToSell;
                reserve = reserve - reserveReturned;
            }

            // Reserve should still be reasonable (not drained or overflowed)
            expect(reserve).to.be.gt(ethers.parseUnits("50000", 6)); // At least 50k remaining
            expect(reserve).to.be.lt(ethers.parseUnits("150000", 6)); // Less than 150k
        });
    });

    describe("Edge Cases - CRR = 100%", function () {
        it("should behave as constant-product AMM at CRR = 100%", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("1000", 6);
            const crr = 1000000; // 100% CRR

            // At CRR=100%, the curve should be linear: k = R * S (constant product)
            const k = supply * reserve;

            // Buy some tokens
            const deposit = ethers.parseUnits("100", 6);
            const tokensBought = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);

            const newSupply = supply + tokensBought;
            const newReserve = reserve + deposit;

            // New k should be approximately the same (allowing for precision loss)
            const newK = newSupply * newReserve;
            const kRatio = (newK * 1000n) / k;

            // k should increase slightly due to the deposit
            expect(kRatio).to.be.gte(1000n); // At least same or higher
            expect(kRatio).to.be.lte(1250n); // Not more than 25% increase (allowing for Taylor series precision)
        });

        it("should handle extremely large reserve with CRR = 100%", async function () {
            const supply = ethers.parseEther("1000000000"); // 1B tokens
            const reserve = ethers.parseUnits("100000000", 6); // 100M USDC
            const deposit = ethers.parseUnits("1000000", 6); // 1M USDC
            const crr = 1000000;

            const tokensBought = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);

            // Should be approximately linear
            const expectedTokens = (supply * deposit) / reserve;
            expect(tokensBought).to.be.closeTo(expectedTokens, expectedTokens / 20n);
        });
    });

    describe("Graduation Transition with High CRR", function () {
        it("should handle transition from bonding curve to AMM with high CRR", async function () {
            // Simulate a pool approaching graduation with high CRR
            const preGradSupply = ethers.parseEther("10000000"); // 10M tokens
            const preGradReserve = ethers.parseUnits("500000", 6); // 500k USDC
            const crr = 900000; // 90% CRR

            // Calculate spot price before graduation
            const priceBeforeGrad = await bondingCurve.testCalculateSpotPrice(
                preGradSupply,
                preGradReserve,
                crr
            );

            // Simulate final purchase pushing to graduation
            const finalDeposit = ethers.parseUnits("50000", 6); // 50k USDC
            const finalTokens = await bondingCurve.testCalculateBuy(
                preGradSupply,
                preGradReserve,
                finalDeposit,
                crr
            );

            // Calculate post-graduation state
            const postGradSupply = preGradSupply + finalTokens;
            const postGradReserve = preGradReserve + finalDeposit;

            const priceAfterGrad = await bondingCurve.testCalculateSpotPrice(
                postGradSupply,
                postGradReserve,
                crr
            );

            // Price should not change drastically at high CRR
            expect(priceAfterGrad).to.be.closeTo(priceBeforeGrad, priceBeforeGrad / 10n); // Within 10%
        });

        it("should maintain liquidity consistency across graduation", async function () {
            const supply = ethers.parseEther("5000000");
            const reserve = ethers.parseUnits("250000", 6);

            // Test at various high CRR values
            for (const crr of [700000, 800000, 900000, 1000000]) {
                // Small trade before "graduation"
                const smallDeposit = ethers.parseUnits("1000", 6);
                const tokensBeforeGrad = await bondingCurve.testCalculateBuy(
                    supply,
                    reserve,
                    smallDeposit,
                    crr
                );

                // Update state
                const newSupply = supply + tokensBeforeGrad;
                const newReserve = reserve + smallDeposit;

                // Same size trade after "graduation"
                const tokensAfterGrad = await bondingCurve.testCalculateBuy(
                    newSupply,
                    newReserve,
                    smallDeposit,
                    crr
                );

                // Token amounts should be similar at high CRR
                if (crr >= 800000) {
                    expect(tokensAfterGrad).to.be.closeTo(tokensBeforeGrad, tokensBeforeGrad / 10n);
                }
            }
        });
    });

    describe("Precision Regression Tests", function () {
        it("should not lose precision with repeated small operations", async function () {
            let supply = ethers.parseEther("1000000");
            let reserve = ethers.parseUnits("100000", 6);
            const crr = 750000; // 75% CRR

            const initialPrice = await bondingCurve.testCalculateSpotPrice(supply, reserve, crr);

            // Perform 10 small buy operations
            for (let i = 0; i < 10; i++) {
                const smallDeposit = ethers.parseUnits("100", 6);
                const tokens = await bondingCurve.testCalculateBuy(supply, reserve, smallDeposit, crr);
                supply = supply + tokens;
                reserve = reserve + smallDeposit;
            }

            const finalPrice = await bondingCurve.testCalculateSpotPrice(supply, reserve, crr);

            // Price should have increased reasonably
            expect(finalPrice).to.be.gt(initialPrice);
            expect(finalPrice).to.be.lt(initialPrice * 2n); // Should not have doubled
        });

        it("should handle boundary condition: CRR exactly 50%", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("500", 6);
            const deposit = ethers.parseUnits("50", 6);
            const crr = 500000; // Exactly 50%

            // At 50% CRR, exponent = 2.0 (square root behavior)
            const tokens = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);
            expect(tokens).to.be.gt(0);

            // Verify can sell back
            const newSupply = supply + tokens;
            const newReserve = reserve + deposit;
            const reserveOut = await bondingCurve.testCalculateSell(newSupply, newReserve, tokens, crr);
            expect(reserveOut).to.be.gt(0);
            expect(reserveOut).to.be.lte(deposit);
        });

        it("should handle boundary condition: CRR exactly 100%", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("1000", 6);
            const deposit = ethers.parseUnits("100", 6);
            const crr = 1000000; // Exactly 100%

            const tokens = await bondingCurve.testCalculateBuy(supply, reserve, deposit, crr);

            // At 100% CRR, should be linear: tokens/supply = deposit/reserve
            const expectedTokens = (supply * deposit) / reserve;
            expect(tokens).to.be.closeTo(expectedTokens, expectedTokens / 100n); // 1% tolerance
        });
    });
});
