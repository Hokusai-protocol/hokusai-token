const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("Phase 5: Fee Collection System", function () {
    let modelRegistry;
    let tokenManager;
    let factory;
    let feeRouter;
    let mockUSDC;
    let pool1, pool2;
    let owner, treasury, depositor, user1;

    const MODEL_ID_1 = "model-alpha";
    const MODEL_ID_2 = "model-beta";
    const PROTOCOL_FEE_BPS = 500; // 5%

    beforeEach(async function () {
        [owner, treasury, depositor, user1] = await ethers.getSigners();

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

        // Deploy tokens and pools
        const token1Address = await tokenManager.deployToken.staticCall(
            MODEL_ID_1,
            "Alpha Token",
            "ALPHA",
            parseEther("1")
        );
        await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));

        const token2Address = await tokenManager.deployToken.staticCall(
            MODEL_ID_2,
            "Beta Token",
            "BETA",
            parseEther("1")
        );
        await tokenManager.deployToken(MODEL_ID_2, "Beta Token", "BETA", parseEther("1"));

        const pool1Address = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
        await factory.createPool(MODEL_ID_1, token1Address);
        const pool2Address = await factory.createPool.staticCall(MODEL_ID_2, token2Address);
        await factory.createPool(MODEL_ID_2, token2Address);

        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        pool1 = HokusaiAMM.attach(pool1Address);
        pool2 = HokusaiAMM.attach(pool2Address);

        // Deploy UsageFeeRouter
        const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
        feeRouter = await UsageFeeRouter.deploy(
            await factory.getAddress(),
            await mockUSDC.getAddress(),
            treasury.address,
            PROTOCOL_FEE_BPS
        );
        await feeRouter.waitForDeployment();

        // Grant depositor role
        const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
        await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, depositor.address);

        // Mint USDC to depositor for testing
        await mockUSDC.mint(depositor.address, parseUnits("1000000", 6)); // $1M
        await mockUSDC.connect(depositor).approve(await feeRouter.getAddress(), parseUnits("1000000", 6));
    });

    // ============================================================
    // DEPLOYMENT & INITIALIZATION
    // ============================================================

    describe("Deployment & Initialization", function () {
        it("Should initialize with correct parameters", async function () {
            expect(await feeRouter.factory()).to.equal(await factory.getAddress());
            expect(await feeRouter.reserveToken()).to.equal(await mockUSDC.getAddress());
            expect(await feeRouter.treasury()).to.equal(treasury.address);
            expect(await feeRouter.protocolFeeBps()).to.equal(PROTOCOL_FEE_BPS);
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
            expect(await feeRouter.totalProtocolFees()).to.equal(0);
            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(0);
        });

        it("Should revert deployment with invalid addresses", async function () {
            const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");

            await expect(
                UsageFeeRouter.deploy(
                    ZeroAddress,
                    await mockUSDC.getAddress(),
                    treasury.address,
                    PROTOCOL_FEE_BPS
                )
            ).to.be.revertedWith("Invalid factory");

            await expect(
                UsageFeeRouter.deploy(
                    await factory.getAddress(),
                    ZeroAddress,
                    treasury.address,
                    PROTOCOL_FEE_BPS
                )
            ).to.be.revertedWith("Invalid reserve token");

            await expect(
                UsageFeeRouter.deploy(
                    await factory.getAddress(),
                    await mockUSDC.getAddress(),
                    ZeroAddress,
                    PROTOCOL_FEE_BPS
                )
            ).to.be.revertedWith("Invalid treasury");
        });

        it("Should revert deployment with protocol fee too high", async function () {
            const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");

            await expect(
                UsageFeeRouter.deploy(
                    await factory.getAddress(),
                    await mockUSDC.getAddress(),
                    treasury.address,
                    6000 // 60% > 50% max
                )
            ).to.be.revertedWith("Protocol fee too high");
        });
    });

    // ============================================================
    // SINGLE FEE DEPOSIT
    // ============================================================

    describe("Single Fee Deposit", function () {
        it("Should deposit fee to pool correctly", async function () {
            const feeAmount = parseUnits("1000", 6); // $1k

            const reserveBefore = await pool1.reserveBalance();
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
            const reserveAfter = await pool1.reserveBalance();

            // Pool should receive 95% (after 5% protocol fee)
            const expectedDeposit = (feeAmount * 9500n) / 10000n;
            expect(reserveAfter - reserveBefore).to.equal(expectedDeposit);
        });

        it("Should send protocol fee to treasury", async function () {
            const feeAmount = parseUnits("1000", 6); // $1k

            const treasuryBefore = await mockUSDC.balanceOf(treasury.address);
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
            const treasuryAfter = await mockUSDC.balanceOf(treasury.address);

            // Treasury should receive 5%
            const expectedProtocolFee = (feeAmount * 500n) / 10000n;
            expect(treasuryAfter - treasuryBefore).to.equal(expectedProtocolFee);
        });

        it("Should update statistics correctly", async function () {
            const feeAmount = parseUnits("1000", 6);

            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

            expect(await feeRouter.totalFeesDeposited()).to.equal(feeAmount);
            expect(await feeRouter.totalProtocolFees()).to.equal((feeAmount * 500n) / 10000n);
            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(feeAmount);
        });

        it("Should emit FeeDeposited event", async function () {
            const feeAmount = parseUnits("1000", 6);
            const protocolFee = (feeAmount * 500n) / 10000n;
            const poolDeposit = feeAmount - protocolFee;

            await expect(
                feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount)
            ).to.emit(feeRouter, "FeeDeposited")
             .withArgs(
                 MODEL_ID_1,
                 await pool1.getAddress(),
                 feeAmount,
                 protocolFee,
                 poolDeposit,
                 depositor.address
             );
        });

        it("Should increase spot price after fee deposit", async function () {
            const spotPriceBefore = await pool1.spotPrice();

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

        it("Should revert if pool does not exist", async function () {
            await expect(
                feeRouter.connect(depositor).depositFee("non-existent-model", parseUnits("1000", 6))
            ).to.be.revertedWith("Pool does not exist");
        });

        it("Should revert if amount is zero", async function () {
            await expect(
                feeRouter.connect(depositor).depositFee(MODEL_ID_1, 0)
            ).to.be.revertedWith("Amount must be > 0");
        });

        it("Should revert if caller lacks depositor role", async function () {
            await expect(
                feeRouter.connect(user1).depositFee(MODEL_ID_1, parseUnits("1000", 6))
            ).to.be.reverted; // AccessControl revert
        });

        it("Should revert if insufficient approval", async function () {
            // Clear approval
            await mockUSDC.connect(depositor).approve(await feeRouter.getAddress(), 0);

            await expect(
                feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6))
            ).to.be.reverted; // ERC20 transfer failure
        });
    });

    // ============================================================
    // BATCH FEE DEPOSIT
    // ============================================================

    describe("Batch Fee Deposit", function () {
        it("Should deposit fees to multiple pools", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];

            const reserve1Before = await pool1.reserveBalance();
            const reserve2Before = await pool2.reserveBalance();

            await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);

            const reserve1After = await pool1.reserveBalance();
            const reserve2After = await pool2.reserveBalance();

            // Each pool should receive amount minus protocol fee
            expect(reserve1After - reserve1Before).to.equal((amounts[0] * 9500n) / 10000n);
            expect(reserve2After - reserve2Before).to.equal((amounts[1] * 9500n) / 10000n);
        });

        it("Should send total protocol fees to treasury", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];
            const totalAmount = amounts[0] + amounts[1];
            const expectedProtocolFee = (totalAmount * 500n) / 10000n;

            const treasuryBefore = await mockUSDC.balanceOf(treasury.address);
            await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);
            const treasuryAfter = await mockUSDC.balanceOf(treasury.address);

            expect(treasuryAfter - treasuryBefore).to.equal(expectedProtocolFee);
        });

        it("Should update statistics correctly for batch", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];
            const totalAmount = amounts[0] + amounts[1];

            await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);

            expect(await feeRouter.totalFeesDeposited()).to.equal(totalAmount);
            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(amounts[0]);
            expect(await feeRouter.getModelFees(MODEL_ID_2)).to.equal(amounts[1]);
        });

        it("Should emit BatchDeposited event", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];
            const totalAmount = amounts[0] + amounts[1];
            const totalProtocolFee = (totalAmount * 500n) / 10000n;

            await expect(
                feeRouter.connect(depositor).batchDepositFees(modelIds, amounts)
            ).to.emit(feeRouter, "BatchDeposited")
             .withArgs(totalAmount, totalProtocolFee, 2, depositor.address);
        });

        it("Should emit individual FeeDeposited events", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];

            const tx = await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);
            const receipt = await tx.wait();

            // Should have 2 FeeDeposited events + 1 BatchDeposited event
            const feeDepositedEvents = receipt.logs.filter(
                log => log.fragment && log.fragment.name === "FeeDeposited"
            );
            expect(feeDepositedEvents.length).to.equal(2);
        });

        it("Should handle many pools efficiently", async function () {
            // Create more tokens/pools
            const modelIds = [];
            const amounts = [];

            for (let i = 0; i < 5; i++) {
                const modelId = `model-${i}`;
                const tokenAddress = await tokenManager.deployToken.staticCall(
                    modelId,
                    `Token ${i}`,
                    `TKN${i}`,
                    parseEther("1")
                );
                await tokenManager.deployToken(modelId, `Token ${i}`, `TKN${i}`, parseEther("1"));
                await factory.createPool(modelId, tokenAddress);

                modelIds.push(modelId);
                amounts.push(parseUnits("1000", 6));
            }

            await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);

            expect(await feeRouter.totalFeesDeposited()).to.equal(parseUnits("5000", 6));
        });

        it("Should revert if array lengths mismatch", async function () {
            await expect(
                feeRouter.connect(depositor).batchDepositFees(
                    [MODEL_ID_1, MODEL_ID_2],
                    [parseUnits("1000", 6)] // Only 1 amount
                )
            ).to.be.revertedWith("Array length mismatch");
        });

        it("Should revert if arrays are empty", async function () {
            await expect(
                feeRouter.connect(depositor).batchDepositFees([], [])
            ).to.be.revertedWith("Empty arrays");
        });

        it("Should revert if any amount is zero", async function () {
            await expect(
                feeRouter.connect(depositor).batchDepositFees(
                    [MODEL_ID_1, MODEL_ID_2],
                    [parseUnits("1000", 6), 0]
                )
            ).to.be.revertedWith("Amount must be > 0");
        });

        it("Should revert if any pool does not exist", async function () {
            await expect(
                feeRouter.connect(depositor).batchDepositFees(
                    [MODEL_ID_1, "non-existent"],
                    [parseUnits("1000", 6), parseUnits("1000", 6)]
                )
            ).to.be.revertedWith("Pool does not exist");
        });
    });

    // ============================================================
    // PROTOCOL FEE DISTRIBUTION
    // ============================================================

    describe("Protocol Fee Distribution", function () {
        it("Should calculate fee split correctly", async function () {
            const amount = parseUnits("1000", 6);
            const [protocolFee, poolDeposit] = await feeRouter.calculateFeeSplit(amount);

            expect(protocolFee).to.equal((amount * 500n) / 10000n); // 5%
            expect(poolDeposit).to.equal(amount - protocolFee); // 95%
            expect(protocolFee + poolDeposit).to.equal(amount);
        });

        it("Should handle zero protocol fee", async function () {
            // Deploy new router with 0% protocol fee
            const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
            const zeroFeeRouter = await UsageFeeRouter.deploy(
                await factory.getAddress(),
                await mockUSDC.getAddress(),
                treasury.address,
                0 // 0% protocol fee
            );
            await zeroFeeRouter.waitForDeployment();

            const [protocolFee, poolDeposit] = await zeroFeeRouter.calculateFeeSplit(parseUnits("1000", 6));
            expect(protocolFee).to.equal(0);
            expect(poolDeposit).to.equal(parseUnits("1000", 6));
        });

        it("Should handle maximum protocol fee (50%)", async function () {
            const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
            const maxFeeRouter = await UsageFeeRouter.deploy(
                await factory.getAddress(),
                await mockUSDC.getAddress(),
                treasury.address,
                5000 // 50% protocol fee
            );
            await maxFeeRouter.waitForDeployment();

            const amount = parseUnits("1000", 6);
            const [protocolFee, poolDeposit] = await maxFeeRouter.calculateFeeSplit(amount);
            expect(protocolFee).to.equal(amount / 2n);
            expect(poolDeposit).to.equal(amount / 2n);
        });
    });

    // ============================================================
    // ADMIN FUNCTIONS
    // ============================================================

    describe("Admin Functions", function () {
        it("Should update protocol fee", async function () {
            await feeRouter.setProtocolFee(300); // 3%
            expect(await feeRouter.protocolFeeBps()).to.equal(300);
        });

        it("Should emit ProtocolFeeUpdated event", async function () {
            await expect(feeRouter.setProtocolFee(300))
                .to.emit(feeRouter, "ProtocolFeeUpdated")
                .withArgs(300);
        });

        it("Should update treasury address", async function () {
            await feeRouter.setTreasury(user1.address);
            expect(await feeRouter.treasury()).to.equal(user1.address);
        });

        it("Should emit TreasuryUpdated event", async function () {
            await expect(feeRouter.setTreasury(user1.address))
                .to.emit(feeRouter, "TreasuryUpdated")
                .withArgs(user1.address);
        });

        it("Should allow emergency withdraw", async function () {
            // Deposit some fees
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));

            // Router might have dust from rounding, withdraw any balance
            const balance = await feeRouter.getBalance();
            if (balance > 0n) {
                const treasuryBefore = await mockUSDC.balanceOf(treasury.address);
                await feeRouter.emergencyWithdraw(balance);
                const treasuryAfter = await mockUSDC.balanceOf(treasury.address);

                expect(treasuryAfter - treasuryBefore).to.equal(balance);
            }
        });

        it("Should emit ProtocolFeesWithdrawn event", async function () {
            // Mint some USDC directly to router to test withdrawal
            await mockUSDC.mint(await feeRouter.getAddress(), parseUnits("100", 6));
            const balance = await feeRouter.getBalance();

            await expect(feeRouter.emergencyWithdraw(balance))
                .to.emit(feeRouter, "ProtocolFeesWithdrawn")
                .withArgs(treasury.address, balance);
        });

        it("Should revert setProtocolFee if too high", async function () {
            await expect(
                feeRouter.setProtocolFee(6000) // 60%
            ).to.be.revertedWith("Protocol fee too high");
        });

        it("Should revert setTreasury with zero address", async function () {
            await expect(
                feeRouter.setTreasury(ZeroAddress)
            ).to.be.revertedWith("Invalid treasury");
        });

        it("Should revert admin functions if not admin", async function () {
            await expect(
                feeRouter.connect(user1).setProtocolFee(300)
            ).to.be.reverted;

            await expect(
                feeRouter.connect(user1).setTreasury(user1.address)
            ).to.be.reverted;

            await expect(
                feeRouter.connect(user1).emergencyWithdraw(100)
            ).to.be.reverted;
        });
    });

    // ============================================================
    // ACCESS CONTROL
    // ============================================================

    describe("Access Control", function () {
        it("Should grant depositor role", async function () {
            const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
            await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, user1.address);

            expect(await feeRouter.isDepositor(user1.address)).to.be.true;
        });

        it("Should revoke depositor role", async function () {
            const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
            await feeRouter.revokeRole(FEE_DEPOSITOR_ROLE, depositor.address);

            expect(await feeRouter.isDepositor(depositor.address)).to.be.false;

            await expect(
                feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6))
            ).to.be.reverted;
        });

        it("Should check depositor status correctly", async function () {
            expect(await feeRouter.isDepositor(depositor.address)).to.be.true;
            expect(await feeRouter.isDepositor(user1.address)).to.be.false;
        });
    });

    // ============================================================
    // VIEW FUNCTIONS
    // ============================================================

    describe("View Functions", function () {
        it("Should return correct balance", async function () {
            const initialBalance = await feeRouter.getBalance();
            expect(initialBalance).to.equal(0);

            // Mint directly to router
            await mockUSDC.mint(await feeRouter.getAddress(), parseUnits("1000", 6));
            expect(await feeRouter.getBalance()).to.equal(parseUnits("1000", 6));
        });

        it("Should return model fees correctly", async function () {
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));
            await feeRouter.connect(depositor).depositFee(MODEL_ID_2, parseUnits("2000", 6));

            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(parseUnits("1000", 6));
            expect(await feeRouter.getModelFees(MODEL_ID_2)).to.equal(parseUnits("2000", 6));
        });
    });
});
