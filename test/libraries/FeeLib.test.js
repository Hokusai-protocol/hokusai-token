const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("FeeLib", function () {
    let FeeLibTest;
    let feeLib;

    before(async function () {
        // Deploy test harness contract that uses FeeLib
        const FeeLibTestFactory = await ethers.getContractFactory("FeeLibTestHarness");
        FeeLibTest = await FeeLibTestFactory.deploy();
        await FeeLibTest.waitForDeployment();
        feeLib = FeeLibTest;
    });

    describe("calculateFee", function () {
        it("should calculate 1% fee correctly (100 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 100);
            expect(result).to.equal(10); // 1% of 1000 = 10
        });

        it("should calculate 0.25% fee correctly (25 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 25);
            expect(result).to.equal(2); // 0.25% of 1000 = 2.5, rounds down to 2
        });

        it("should calculate 5% fee correctly (500 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 500);
            expect(result).to.equal(50); // 5% of 1000 = 50
        });

        it("should calculate 10% fee correctly (1000 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 1000);
            expect(result).to.equal(100); // 10% of 1000 = 100
        });

        it("should handle zero fee (0 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 0);
            expect(result).to.equal(0);
        });

        it("should handle 100% fee (10000 bps)", async function () {
            const result = await feeLib.testCalculateFee(1000, 10000);
            expect(result).to.equal(1000); // 100% of 1000 = 1000
        });

        it("should handle large amounts correctly", async function () {
            const largeAmount = ethers.parseEther("1000000"); // 1M tokens
            const result = await feeLib.testCalculateFee(largeAmount, 25); // 0.25%
            const expected = largeAmount * 25n / 10000n;
            expect(result).to.equal(expected);
        });
    });

    describe("applyFee", function () {
        it("should return netAmount + fee = original amount", async function () {
            const amount = 1000;
            const feeBps = 500; // 5%
            const result = await feeLib.testApplyFee(amount, feeBps);

            expect(result.netAmount).to.equal(950); // 1000 - 50
            expect(result.fee).to.equal(50);
            expect(result.netAmount + result.fee).to.equal(amount);
        });

        it("should handle 0.25% trade fee (25 bps)", async function () {
            const amount = 10000;
            const result = await feeLib.testApplyFee(amount, 25);

            expect(result.fee).to.equal(25); // 0.25% of 10000
            expect(result.netAmount).to.equal(9975);
        });

        it("should handle zero fee", async function () {
            const amount = 1000;
            const result = await feeLib.testApplyFee(amount, 0);

            expect(result.fee).to.equal(0);
            expect(result.netAmount).to.equal(amount);
        });

        it("should handle 100% fee edge case", async function () {
            const amount = 1000;
            const result = await feeLib.testApplyFee(amount, 10000);

            expect(result.fee).to.equal(1000);
            expect(result.netAmount).to.equal(0);
        });
    });

    describe("requireValidFee", function () {
        it("should pass for fees within maximum", async function () {
            await expect(
                feeLib.testRequireValidFee(500, 1000)
            ).to.not.be.reverted; // 5% <= 10%

            await expect(
                feeLib.testRequireValidFee(1000, 1000)
            ).to.not.be.reverted; // 10% == 10%
        });

        it("should revert with FeeTooHigh for fees exceeding maximum", async function () {
            await expect(
                feeLib.testRequireValidFee(1500, 1000)
            ).to.be.revertedWithCustomError(feeLib, "FeeTooHigh")
                .withArgs(1500, 1000); // 15% > 10%

            await expect(
                feeLib.testRequireValidFee(10001, 10000)
            ).to.be.revertedWithCustomError(feeLib, "FeeTooHigh")
                .withArgs(10001, 10000);
        });
    });

    describe("percentage", function () {
        it("should calculate 20% correctly (2000 bps)", async function () {
            const result = await feeLib.testPercentage(1000, 2000);
            expect(result).to.equal(200); // 20% of 1000
        });

        it("should work identically to calculateFee", async function () {
            const amount = 5000;
            const bps = 1500;

            const feeResult = await feeLib.testCalculateFee(amount, bps);
            const percentResult = await feeLib.testPercentage(amount, bps);

            expect(feeResult).to.equal(percentResult);
        });
    });

    describe("splitProtocolFee", function () {
        it("should split amount into protocol fee and remaining", async function () {
            const amount = 1000;
            const protocolFeeBps = 500; // 5%
            const result = await feeLib.testSplitProtocolFee(amount, protocolFeeBps);

            expect(result.protocolFee).to.equal(50); // 5% of 1000
            expect(result.remaining).to.equal(950); // 95% of 1000
            expect(result.protocolFee + result.remaining).to.equal(amount);
        });

        it("should handle zero protocol fee", async function () {
            const amount = 1000;
            const result = await feeLib.testSplitProtocolFee(amount, 0);

            expect(result.protocolFee).to.equal(0);
            expect(result.remaining).to.equal(1000);
        });
    });

    describe("applyMultipleFees", function () {
        it("should apply two fees sequentially", async function () {
            const amount = 1000;
            const fee1Bps = 100; // 1%
            const fee2Bps = 50;  // 0.5%
            const result = await feeLib.testApplyMultipleFees(amount, fee1Bps, fee2Bps);

            // First fee: 1% of 1000 = 10, leaves 990
            // Second fee: 0.5% of 990 = 4.95, rounds to 4, leaves 986
            expect(result.fee1).to.equal(10);
            expect(result.fee2).to.equal(4); // Rounds down from 4.95
            expect(result.totalFees).to.equal(14);
            expect(result.netAmount).to.equal(986);
        });

        it("should handle zero fees", async function () {
            const amount = 1000;
            const result = await feeLib.testApplyMultipleFees(amount, 0, 0);

            expect(result.totalFees).to.equal(0);
            expect(result.netAmount).to.equal(amount);
        });
    });

    describe("Integration: Match existing HokusaiAMM calculations", function () {
        it("should match trade fee calculation pattern", async function () {
            // Simulate HokusaiAMM buy with 0.25% trade fee
            const reserveIn = ethers.parseUnits("1000", 6); // 1000 USDC (6 decimals)
            const tradeFee = 25; // 0.25%

            const result = await feeLib.testApplyFee(reserveIn, tradeFee);

            // This should match the old calculation: (reserveIn * tradeFee) / 10000
            const expectedFee = reserveIn * BigInt(tradeFee) / 10000n;
            const expectedNet = reserveIn - expectedFee;

            expect(result.fee).to.equal(expectedFee);
            expect(result.netAmount).to.equal(expectedNet);
        });

        it("should match protocol fee calculation pattern", async function () {
            // Simulate UsageFeeRouter protocol fee split (5%)
            const amount = ethers.parseUnits("1000", 6); // 1000 USDC
            const protocolFeeBps = 500; // 5%

            const result = await feeLib.testSplitProtocolFee(amount, protocolFeeBps);

            // This should match: (amount * protocolFeeBps) / 10000
            const expectedProtocolFee = amount * BigInt(protocolFeeBps) / 10000n;
            const expectedRemaining = amount - expectedProtocolFee;

            expect(result.protocolFee).to.equal(expectedProtocolFee);
            expect(result.remaining).to.equal(expectedRemaining);
        });
    });

    describe("Gas benchmarks", function () {
        it("should measure gas cost of fee calculations", async function () {
            const tx = await feeLib.testCalculateFee(1000, 25);
            // Library functions are inlined, so gas cost is minimal
            // This test documents gas usage for benchmarking
        });
    });
});
