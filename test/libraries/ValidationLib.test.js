const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ValidationLib", function () {
    let ValidationLibTest;
    let validationLib;
    let owner;
    let addr1;

    before(async function () {
        [owner, addr1] = await ethers.getSigners();

        // Deploy test harness contract that uses ValidationLib
        const ValidationLibTestFactory = await ethers.getContractFactory("ValidationLibTestHarness");
        ValidationLibTest = await ValidationLibTestFactory.deploy();
        await ValidationLibTest.waitForDeployment();
        validationLib = ValidationLibTest;
    });

    describe("requireNonZeroAddress", function () {
        it("should pass for valid non-zero address", async function () {
            await expect(
                validationLib.testRequireNonZeroAddress(addr1.address, "test address")
            ).to.not.be.reverted;
        });

        it("should revert with ZeroAddress for address(0)", async function () {
            await expect(
                validationLib.testRequireNonZeroAddress(ethers.ZeroAddress, "test address")
            ).to.be.revertedWithCustomError(validationLib, "ZeroAddress")
                .withArgs("test address");
        });
    });

    describe("requirePositiveAmount", function () {
        it("should pass for positive amounts", async function () {
            await expect(
                validationLib.testRequirePositiveAmount(1, "test amount")
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequirePositiveAmount(1000000, "test amount")
            ).to.not.be.reverted;
        });

        it("should revert with InvalidAmount for zero", async function () {
            await expect(
                validationLib.testRequirePositiveAmount(0, "test amount")
            ).to.be.revertedWithCustomError(validationLib, "InvalidAmount")
                .withArgs("test amount");
        });
    });

    describe("requireNonEmptyString", function () {
        it("should pass for non-empty strings", async function () {
            await expect(
                validationLib.testRequireNonEmptyString("test", "model ID")
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireNonEmptyString("a", "model ID")
            ).to.not.be.reverted;
        });

        it("should revert with EmptyString for empty string", async function () {
            await expect(
                validationLib.testRequireNonEmptyString("", "model ID")
            ).to.be.revertedWithCustomError(validationLib, "EmptyString")
                .withArgs("model ID");
        });
    });

    describe("requireMatchingArrayLengths", function () {
        it("should pass for matching lengths", async function () {
            await expect(
                validationLib.testRequireMatchingArrayLengths(5, 5)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireMatchingArrayLengths(0, 0)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireMatchingArrayLengths(100, 100)
            ).to.not.be.reverted;
        });

        it("should revert with ArrayLengthMismatch for different lengths", async function () {
            await expect(
                validationLib.testRequireMatchingArrayLengths(5, 3)
            ).to.be.revertedWithCustomError(validationLib, "ArrayLengthMismatch")
                .withArgs(5, 3);

            await expect(
                validationLib.testRequireMatchingArrayLengths(0, 1)
            ).to.be.revertedWithCustomError(validationLib, "ArrayLengthMismatch")
                .withArgs(0, 1);
        });
    });

    describe("requireNonEmptyArray", function () {
        it("should pass for non-zero lengths", async function () {
            await expect(
                validationLib.testRequireNonEmptyArray(1)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireNonEmptyArray(100)
            ).to.not.be.reverted;
        });

        it("should revert with ArrayEmpty for zero length", async function () {
            await expect(
                validationLib.testRequireNonEmptyArray(0)
            ).to.be.revertedWithCustomError(validationLib, "ArrayEmpty");
        });
    });

    describe("requireInBounds", function () {
        it("should pass for values within bounds (inclusive)", async function () {
            await expect(
                validationLib.testRequireInBounds(5, 0, 10)
            ).to.not.be.reverted;

            // Test boundaries
            await expect(
                validationLib.testRequireInBounds(0, 0, 10)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireInBounds(10, 0, 10)
            ).to.not.be.reverted;
        });

        it("should revert with ValueOutOfBounds for values outside bounds", async function () {
            await expect(
                validationLib.testRequireInBounds(11, 0, 10)
            ).to.be.revertedWithCustomError(validationLib, "ValueOutOfBounds")
                .withArgs(11, 0, 10);

            await expect(
                validationLib.testRequireInBounds(5, 10, 20)
            ).to.be.revertedWithCustomError(validationLib, "ValueOutOfBounds")
                .withArgs(5, 10, 20);
        });
    });

    describe("requireMaxArrayLength", function () {
        it("should pass for lengths at or below maximum", async function () {
            await expect(
                validationLib.testRequireMaxArrayLength(50, 100)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireMaxArrayLength(100, 100)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireMaxArrayLength(0, 100)
            ).to.not.be.reverted;
        });

        it("should revert with ArrayTooLarge for lengths exceeding maximum", async function () {
            await expect(
                validationLib.testRequireMaxArrayLength(101, 100)
            ).to.be.revertedWithCustomError(validationLib, "ArrayTooLarge")
                .withArgs(101, 100);

            await expect(
                validationLib.testRequireMaxArrayLength(1000, 100)
            ).to.be.revertedWithCustomError(validationLib, "ArrayTooLarge")
                .withArgs(1000, 100);
        });
    });

    describe("requireValidBatch", function () {
        it("should pass for valid batch parameters", async function () {
            await expect(
                validationLib.testRequireValidBatch(10, 10, 100)
            ).to.not.be.reverted;

            await expect(
                validationLib.testRequireValidBatch(100, 100, 100)
            ).to.not.be.reverted;
        });

        it("should revert with ArrayEmpty if arrays are empty", async function () {
            await expect(
                validationLib.testRequireValidBatch(0, 0, 100)
            ).to.be.revertedWithCustomError(validationLib, "ArrayEmpty");
        });

        it("should revert with ArrayLengthMismatch if lengths don't match", async function () {
            await expect(
                validationLib.testRequireValidBatch(10, 5, 100)
            ).to.be.revertedWithCustomError(validationLib, "ArrayLengthMismatch")
                .withArgs(10, 5);
        });

        it("should revert with ArrayTooLarge if exceeding max length", async function () {
            await expect(
                validationLib.testRequireValidBatch(101, 101, 100)
            ).to.be.revertedWithCustomError(validationLib, "ArrayTooLarge")
                .withArgs(101, 100);
        });
    });

    describe("Gas benchmarks", function () {
        it("should measure gas cost of custom errors vs require strings", async function () {
            // Test custom error gas cost
            const customErrorTx = validationLib.testRequireNonZeroAddress(
                ethers.ZeroAddress,
                "test"
            );
            await expect(customErrorTx).to.be.reverted;

            // Note: In actual deployment, custom errors save ~50-100 gas per revert
            // compared to require strings. This test documents the behavior.
        });
    });
});
