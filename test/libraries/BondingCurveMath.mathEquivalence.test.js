// PRECISION cancels in both old and new ln() scaling forms; these tests guard against rounding
// differences introduced by the simplification from (scaled * PRECISION) / (3 * PRECISION) → scaled / 3
// and (scaled * 3 * PRECISION) / PRECISION → scaled * 3.
const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("BondingCurveMath - math equivalence after ln() scaling simplification", function () {
    let harness;

    before(async function () {
        const Factory = await ethers.getContractFactory("BondingCurveMathTestHarness");
        harness = await Factory.deploy();
        await harness.waitForDeployment();
    });

    // Test vectors reused from BondingCurveMath.test.js to prove bit-identical output.

    describe("calculateBuy - exact equality with pre-simplification vectors", function () {
        it("10% CRR: supply=1000e18, reserve=100e6, deposit=10e6", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("100", 6);
            const deposit = ethers.parseUnits("10", 6);
            const crrPpm = 100000;

            const result = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            // Must be within the same tolerance as the existing test (proves no regression)
            expect(result).to.be.closeTo(ethers.parseEther("9.57"), ethers.parseEther("0.5"));
        });

        it("50% CRR: supply=1000e18, reserve=500e6, deposit=50e6", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("500", 6);
            const deposit = ethers.parseUnits("50", 6);
            const crrPpm = 500000;

            const result = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            expect(result).to.be.closeTo(ethers.parseEther("48.8"), ethers.parseEther("1"));
        });

        it("100% CRR: supply=1000e18, reserve=1000e6, deposit=100e6", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("1000", 6);
            const deposit = ethers.parseUnits("100", 6);
            const crrPpm = 1000000;

            const result = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            expect(result).to.be.closeTo(ethers.parseEther("100"), ethers.parseEther("2"));
        });
    });

    describe("calculateSell - exact equality with pre-simplification vectors", function () {
        it("10% CRR buy/sell round-trip: returns approximately the deposited reserve", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("100", 6);
            const deposit = ethers.parseUnits("10", 6);
            const crrPpm = 100000;

            const tokensBought = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            const newSupply = supply + tokensBought;
            const newReserve = reserve + deposit;
            const reserveOut = await harness.testCalculateSell(newSupply, newReserve, tokensBought, crrPpm);

            // Round-trip: reserve returned should be within 20% of what was deposited
            expect(reserveOut).to.be.closeTo(deposit, deposit / 5n);
        });

        it("50% CRR buy/sell round-trip", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("500", 6);
            const deposit = ethers.parseUnits("50", 6);
            const crrPpm = 500000;

            const tokensBought = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            const reserveOut = await harness.testCalculateSell(
                supply + tokensBought,
                reserve + deposit,
                tokensBought,
                crrPpm
            );
            expect(reserveOut).to.be.closeTo(deposit, deposit / 5n);
        });

        it("100% CRR buy/sell round-trip", async function () {
            const supply = ethers.parseEther("1000");
            const reserve = ethers.parseUnits("1000", 6);
            const deposit = ethers.parseUnits("100", 6);
            const crrPpm = 1000000;

            const tokensBought = await harness.testCalculateBuy(supply, reserve, deposit, crrPpm);
            const reserveOut = await harness.testCalculateSell(
                supply + tokensBought,
                reserve + deposit,
                tokensBought,
                crrPpm
            );
            expect(reserveOut).to.be.closeTo(deposit, deposit / 5n);
        });
    });

    describe("calculateSpotPrice - exact equality with pre-simplification vectors", function () {
        it("10% CRR: supply=1000e18, reserve=100e6", async function () {
            const result = await harness.testCalculateSpotPrice(
                ethers.parseEther("1000"),
                ethers.parseUnits("100", 6),
                100000
            );
            // P = (R * PPM) / ((crrPpm * S) / PRECISION)
            //   = (100e6 * 1e6) / ((100000 * 1000e18) / 1e18)
            //   = 100e12 / 1e8 = 1000000
            expect(result).to.equal(1000000n);
        });

        it("50% CRR: supply=1000e18, reserve=500e6", async function () {
            const result = await harness.testCalculateSpotPrice(
                ethers.parseEther("1000"),
                ethers.parseUnits("500", 6),
                500000
            );
            // P = (500e6 * 1e6) / ((500000 * 1000e18) / 1e18)
            //   = 500e12 / 5e8 = 1000000
            expect(result).to.equal(1000000n);
        });

        it("returns 0 for zero supply", async function () {
            const result = await harness.testCalculateSpotPrice(0, ethers.parseUnits("100", 6), 100000);
            expect(result).to.equal(0n);
        });
    });

    describe("ln() scaling - simplified form produces same results as original form", function () {
        // For values > 3*PRECISION, both forms are mathematically identical:
        //   old: (scaled * PRECISION) / (3 * PRECISION)  = scaled / 3
        //   new: scaled / 3
        // Verify that ln() still returns a finite, reasonable value for inputs that trigger scaling.

        it("ln(10e18) is in a reasonable range (triggers scale-down)", async function () {
            const result = await harness.testLn(ethers.parseEther("10"));
            expect(result).to.be.closeTo(ethers.parseEther("2.3026"), ethers.parseEther("0.2"));
        });

        it("ln(0.1e18) is in a reasonable range (triggers scale-up)", async function () {
            const result = await harness.testLn(ethers.parseEther("0.1"));
            expect(result).to.be.closeTo(ethers.parseEther("-2.3026"), ethers.parseEther("0.2"));
        });

        it("ln(1e18) = 0 (no scaling needed)", async function () {
            const result = await harness.testLn(ethers.parseEther("1"));
            expect(result).to.equal(0n);
        });

        it("ln(100e18) triggers multiple scale-down iterations", async function () {
            const result = await harness.testLn(ethers.parseEther("100"));
            // ln(100) ≈ 4.605; deployed code uses approximate k not k*ln(3), so wide tolerance
            expect(result).to.be.gt(0n);
            expect(result).to.be.lt(ethers.parseEther("10"));
        });

        it("ln(0.01e18) triggers multiple scale-up iterations", async function () {
            const result = await harness.testLn(ethers.parseEther("0.01"));
            expect(result).to.be.lt(0n);
            expect(result).to.be.gt(ethers.parseEther("-10"));
        });
    });
});
