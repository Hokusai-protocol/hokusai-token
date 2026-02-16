const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("Phase 5: Fee Collection System", function () {
    let modelRegistry;
    let tokenManager;
    let factory;
    let feeRouter;
    let infraReserve;
    let mockUSDC;
    let pool1, pool2;
    let owner, treasury, depositor, user1;

    const MODEL_ID_1 = "model-alpha";
    const MODEL_ID_2 = "model-beta";
    // Default infrastructureAccrualBps from TokenManager.deployToken() is 8000 (80%)
    const DEFAULT_INFRA_BPS = 8000n;

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

        // Deploy InfrastructureReserve
        const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
        infraReserve = await InfrastructureReserve.deploy(
            await mockUSDC.getAddress(),
            await factory.getAddress(),
            treasury.address
        );
        await infraReserve.waitForDeployment();

        // Deploy UsageFeeRouter (new 3-param constructor)
        const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
        feeRouter = await UsageFeeRouter.deploy(
            await factory.getAddress(),
            await mockUSDC.getAddress(),
            await infraReserve.getAddress()
        );
        await feeRouter.waitForDeployment();

        // Grant depositor role on fee router
        const FEE_DEPOSITOR_ROLE = await feeRouter.FEE_DEPOSITOR_ROLE();
        await feeRouter.grantRole(FEE_DEPOSITOR_ROLE, depositor.address);

        // Grant DEPOSITOR_ROLE on InfrastructureReserve to the fee router
        const INFRA_DEPOSITOR_ROLE = await infraReserve.DEPOSITOR_ROLE();
        await infraReserve.grantRole(INFRA_DEPOSITOR_ROLE, await feeRouter.getAddress());

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
            expect(await feeRouter.infraReserve()).to.equal(await infraReserve.getAddress());
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
            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(0);
        });
    });

    // ============================================================
    // SINGLE FEE DEPOSIT
    // ============================================================

    describe("Single Fee Deposit", function () {
        it("Should deposit fee splitting between infrastructure and AMM", async function () {
            const feeAmount = parseUnits("1000", 6); // $1k

            const reserveBefore = await pool1.reserveBalance();
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);
            const reserveAfter = await pool1.reserveBalance();

            // Pool should receive profit portion (100% - 80% infra = 20%)
            const expectedProfit = feeAmount - (feeAmount * DEFAULT_INFRA_BPS / 10000n);
            expect(reserveAfter - reserveBefore).to.equal(expectedProfit);
        });

        it("Should send infrastructure portion to reserve", async function () {
            const feeAmount = parseUnits("1000", 6); // $1k

            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

            // Infrastructure reserve should receive 80%
            const expectedInfra = (feeAmount * DEFAULT_INFRA_BPS) / 10000n;
            const accrued = await infraReserve.accrued(MODEL_ID_1);
            expect(accrued).to.equal(expectedInfra);
        });

        it("Should update statistics correctly", async function () {
            const feeAmount = parseUnits("1000", 6);

            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount);

            expect(await feeRouter.totalFeesDeposited()).to.equal(feeAmount);
            expect(await feeRouter.getModelFees(MODEL_ID_1)).to.equal(feeAmount);
        });

        it("Should emit FeeDeposited event", async function () {
            const feeAmount = parseUnits("1000", 6);
            const infraAmount = (feeAmount * DEFAULT_INFRA_BPS) / 10000n;
            const profitAmount = feeAmount - infraAmount;

            await expect(
                feeRouter.connect(depositor).depositFee(MODEL_ID_1, feeAmount)
            ).to.emit(feeRouter, "FeeDeposited")
             .withArgs(
                 MODEL_ID_1,
                 await pool1.getAddress(),
                 feeAmount,
                 infraAmount,
                 profitAmount,
                 depositor.address
             );
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

            // Each pool should receive profit portion (20% with default 80% infra)
            const profitBps = 10000n - DEFAULT_INFRA_BPS;
            expect(reserve1After - reserve1Before).to.equal((amounts[0] * profitBps) / 10000n);
            expect(reserve2After - reserve2Before).to.equal((amounts[1] * profitBps) / 10000n);
        });

        it("Should send infrastructure portions to reserve", async function () {
            const amounts = [parseUnits("1000", 6), parseUnits("2000", 6)];
            const modelIds = [MODEL_ID_1, MODEL_ID_2];

            await feeRouter.connect(depositor).batchDepositFees(modelIds, amounts);

            const expectedInfra1 = (amounts[0] * DEFAULT_INFRA_BPS) / 10000n;
            const expectedInfra2 = (amounts[1] * DEFAULT_INFRA_BPS) / 10000n;

            expect(await infraReserve.accrued(MODEL_ID_1)).to.equal(expectedInfra1);
            expect(await infraReserve.accrued(MODEL_ID_2)).to.equal(expectedInfra2);
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
            const totalInfra = (amounts[0] * DEFAULT_INFRA_BPS) / 10000n + (amounts[1] * DEFAULT_INFRA_BPS) / 10000n;
            const totalProfit = totalAmount - totalInfra;

            await expect(
                feeRouter.connect(depositor).batchDepositFees(modelIds, amounts)
            ).to.emit(feeRouter, "BatchDeposited")
             .withArgs(totalAmount, totalInfra, totalProfit, 2, depositor.address);
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
    // FEE SPLIT CALCULATION
    // ============================================================

    describe("Fee Split Calculation", function () {
        it("Should calculate fee split correctly per model", async function () {
            const amount = parseUnits("1000", 6);
            const [infraAmount, profitAmount] = await feeRouter.calculateFeeSplit(MODEL_ID_1, amount);

            const expectedInfra = (amount * DEFAULT_INFRA_BPS) / 10000n;
            expect(infraAmount).to.equal(expectedInfra);
            expect(profitAmount).to.equal(amount - expectedInfra);
            expect(infraAmount + profitAmount).to.equal(amount);
        });

        it("Should return model stats", async function () {
            await feeRouter.connect(depositor).depositFee(MODEL_ID_1, parseUnits("1000", 6));

            const [totalFees, currentInfraBps, currentProfitBps] = await feeRouter.getModelStats(MODEL_ID_1);
            expect(totalFees).to.equal(parseUnits("1000", 6));
            expect(currentInfraBps).to.equal(DEFAULT_INFRA_BPS);
            expect(currentProfitBps).to.equal(10000n - DEFAULT_INFRA_BPS);
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
