const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("Phase 4: Factory & Registry Integration", function () {
    let modelRegistry;
    let tokenManager;
    let factory;
    let mockUSDC;
    let owner, treasury, deployer, user1;

    const MODEL_ID_1 = "model-alpha";
    const MODEL_ID_2 = "model-beta";
    const MODEL_ID_3 = "model-gamma";

    beforeEach(async function () {
        [owner, treasury, deployer, user1] = await ethers.getSigners();

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

        // Deploy factory
        const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
        factory = await HokusaiAMMFactory.deploy(
            await modelRegistry.getAddress(),
            await tokenManager.getAddress(),
            await mockUSDC.getAddress(),
            treasury.address
        );
        await factory.waitForDeployment();
    });

    // ============================================================
    // DEPLOYMENT & INITIALIZATION
    // ============================================================

    describe("Deployment & Initialization", function () {
        it("Should initialize with correct addresses", async function () {
            expect(await factory.modelRegistry()).to.equal(await modelRegistry.getAddress());
            expect(await factory.tokenManager()).to.equal(await tokenManager.getAddress());
            expect(await factory.reserveToken()).to.equal(await mockUSDC.getAddress());
            expect(await factory.treasury()).to.equal(treasury.address);
        });

        it("Should set correct default parameters", async function () {
            expect(await factory.defaultCrr()).to.equal(100000); // 10%
            expect(await factory.defaultTradeFee()).to.equal(30); // 0.30%
            expect(await factory.defaultIbrDuration()).to.equal(7 * 24 * 60 * 60); // 7 days
            expect(await factory.defaultFlatCurveThreshold()).to.equal(parseUnits("25000", 6)); // $25k
            expect(await factory.defaultFlatCurvePrice()).to.equal(parseUnits("0.01", 6)); // $0.01
        });

        // Removed: Constructor validation test - covered by ValidationLib.test.js

        it("Should start with zero pools", async function () {
            expect(await factory.poolCount()).to.equal(0);
        });
    });

    // ============================================================
    // POOL CREATION
    // ============================================================

    describe("Pool Creation", function () {
        let token1Address;

        beforeEach(async function () {
            // Deploy token via TokenManager
            token1Address = await tokenManager.deployToken.staticCall(
                MODEL_ID_1,
                "Alpha Token",
                "ALPHA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));
        });

        it("Should create pool with default parameters", async function () {
            const poolAddress = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
            const tx = await factory.createPool(MODEL_ID_1, token1Address);
            const receipt = await tx.wait();

            // Verify event
            const event = receipt.logs.find(
                log => log.fragment && log.fragment.name === "PoolCreated"
            );
            expect(event).to.not.be.undefined;

            // Verify pool tracking
            expect(await factory.hasPool(MODEL_ID_1)).to.be.true;
            expect(await factory.getPool(MODEL_ID_1)).to.equal(poolAddress);
            expect(await factory.poolCount()).to.equal(1);
        });

        it("Should create pool with custom parameters", async function () {
            const customCrr = 150000; // 15%
            const customTradeFee = 50; // 0.5%
            const customIbrDuration = 14 * 24 * 60 * 60; // 14 days
            const customThreshold = parseUnits("50000", 6); // $50k
            const customPrice = parseUnits("0.02", 6); // $0.02

            const poolAddress = await factory.createPoolWithParams.staticCall(
                MODEL_ID_1,
                token1Address,
                customCrr,
                customTradeFee,
                customIbrDuration,
                customThreshold,
                customPrice
            );

            await factory.createPoolWithParams(
                MODEL_ID_1,
                token1Address,
                customCrr,
                customTradeFee,
                customIbrDuration,
                customThreshold,
                customPrice
            );

            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
            const pool = HokusaiAMM.attach(poolAddress);

            expect(await pool.crr()).to.equal(customCrr);
            expect(await pool.tradeFee()).to.equal(customTradeFee);
        });

        it("Should allow manual registration in ModelRegistry", async function () {
            const poolAddress = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
            await factory.createPool(MODEL_ID_1, token1Address);

            // Register model and pool manually (in production, factory owner would do this)
            await modelRegistry.registerStringModel(MODEL_ID_1, token1Address, "test-metric");
            await modelRegistry.registerPool(MODEL_ID_1, poolAddress);

            expect(await modelRegistry.hasPool(MODEL_ID_1)).to.be.true;
            expect(await modelRegistry.getPool(MODEL_ID_1)).to.equal(poolAddress);
        });

        it("Should allow manual authorization with TokenManager", async function () {
            const poolAddress = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
            await factory.createPool(MODEL_ID_1, token1Address);

            // Authorize pool manually (in production, TokenManager owner would do this)
            await tokenManager.authorizeAMM(poolAddress);

            // Pool should have MINTER_ROLE
            const MINTER_ROLE = await tokenManager.MINTER_ROLE();
            expect(await tokenManager.hasRole(MINTER_ROLE, poolAddress)).to.be.true;
        });

        it("Should revert if pool already exists", async function () {
            await factory.createPool(MODEL_ID_1, token1Address);

            await expect(
                factory.createPool(MODEL_ID_1, token1Address)
            ).to.be.revertedWith("Pool already exists");
        });

        // Validation tests removed - covered by ValidationLib.test.js
        // Keeping only integration/business logic tests

        it("Should revert if token not registered with TokenManager", async function () {
            await expect(
                factory.createPool("non-existent-model", token1Address)
            ).to.be.revertedWith("Token not registered with TokenManager");
        });

        // Removed: CRR, trade fee, and IBR duration validation tests
        // These are covered by ValidationLib.test.js and FeeLib.test.js
    });

    // ============================================================
    // MULTIPLE POOL MANAGEMENT
    // ============================================================

    describe("Multiple Pool Management", function () {
        let token1Address, token2Address, token3Address;

        beforeEach(async function () {
            // Deploy multiple tokens
            token1Address = await tokenManager.deployToken.staticCall(
                MODEL_ID_1,
                "Alpha Token",
                "ALPHA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));

            token2Address = await tokenManager.deployToken.staticCall(
                MODEL_ID_2,
                "Beta Token",
                "BETA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_2, "Beta Token", "BETA", parseEther("1"));

            token3Address = await tokenManager.deployToken.staticCall(
                MODEL_ID_3,
                "Gamma Token",
                "GAMMA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_3, "Gamma Token", "GAMMA", parseEther("1"));

            // Create pools
            await factory.createPool(MODEL_ID_1, token1Address);
            await factory.createPool(MODEL_ID_2, token2Address);
            await factory.createPool(MODEL_ID_3, token3Address);
        });

        it("Should track multiple pools correctly", async function () {
            expect(await factory.poolCount()).to.equal(3);
            expect(await factory.hasPool(MODEL_ID_1)).to.be.true;
            expect(await factory.hasPool(MODEL_ID_2)).to.be.true;
            expect(await factory.hasPool(MODEL_ID_3)).to.be.true;
        });

        it("Should allow iteration through all pools", async function () {
            const allPools = await factory.getAllPools();
            expect(allPools.length).to.equal(3);

            // Verify each pool address is valid
            for (let i = 0; i < allPools.length; i++) {
                expect(await factory.isPool(allPools[i])).to.be.true;
            }
        });

        it("Should allow lookup by index", async function () {
            const pool0 = await factory.poolAt(0);
            const pool1 = await factory.poolAt(1);
            const pool2 = await factory.poolAt(2);

            expect(await factory.isPool(pool0)).to.be.true;
            expect(await factory.isPool(pool1)).to.be.true;
            expect(await factory.isPool(pool2)).to.be.true;
        });

        it("Should revert poolAt with invalid index", async function () {
            await expect(factory.poolAt(3)).to.be.revertedWith("Index out of bounds");
            await expect(factory.poolAt(100)).to.be.revertedWith("Index out of bounds");
        });

        it("Should allow reverse lookup (pool → model)", async function () {
            const pool1 = await factory.getPool(MODEL_ID_1);
            const pool2 = await factory.getPool(MODEL_ID_2);

            expect(await factory.getModelId(pool1)).to.equal(MODEL_ID_1);
            expect(await factory.getModelId(pool2)).to.equal(MODEL_ID_2);
        });

        it("Should revert getModelId for non-pool address", async function () {
            await expect(
                factory.getModelId(user1.address)
            ).to.be.revertedWith("Not a valid pool");
        });

        it("Should isolate pools (different parameters)", async function () {
            // Create pool with different parameters
            const token4Address = await tokenManager.deployToken.staticCall(
                "model-delta",
                "Delta Token",
                "DELTA",
                parseEther("1")
            );
            await tokenManager.deployToken("model-delta", "Delta Token", "DELTA", parseEther("1"));

            const customPool = await factory.createPoolWithParams.staticCall(
                "model-delta",
                token4Address,
                200000, // 20% CRR
                50, // 0.5% trade fee
                14 * 24 * 60 * 60,
                parseUnits("10000", 6), // Custom threshold
                parseUnits("0.005", 6) // Custom price
            );
            await factory.createPoolWithParams(
                "model-delta",
                token4Address,
                200000,
                50,
                14 * 24 * 60 * 60,
                parseUnits("10000", 6),
                parseUnits("0.005", 6)
            );

            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
            const pool = HokusaiAMM.attach(customPool);

            // Verify different parameters
            expect(await pool.crr()).to.equal(200000);
            expect(await pool.tradeFee()).to.equal(50);

            // Original pools should have default parameters
            const defaultPool = await factory.getPool(MODEL_ID_1);
            const defaultPoolContract = HokusaiAMM.attach(defaultPool);
            expect(await defaultPoolContract.crr()).to.equal(100000);
            expect(await defaultPoolContract.tradeFee()).to.equal(30);
        });
    });

    // ============================================================
    // CONFIGURATION UPDATES
    // ============================================================

    describe("Configuration Updates", function () {
        it("Should update default parameters", async function () {
            await factory.setDefaults(
                150000, // 15% CRR
                50, // 0.5% trade fee
                14 * 24 * 60 * 60 // 14 days IBR
            );

            expect(await factory.defaultCrr()).to.equal(150000);
            expect(await factory.defaultTradeFee()).to.equal(50);
            expect(await factory.defaultIbrDuration()).to.equal(14 * 24 * 60 * 60);
        });

        it("Should emit DefaultsUpdated event", async function () {
            await expect(
                factory.setDefaults(150000, 50, 14 * 24 * 60 * 60)
            ).to.emit(factory, "DefaultsUpdated")
             .withArgs(150000, 50, 14 * 24 * 60 * 60);
        });

        it("Should update treasury address", async function () {
            const newTreasury = user1.address;
            await factory.setTreasury(newTreasury);
            expect(await factory.treasury()).to.equal(newTreasury);
        });

        it("Should emit TreasuryUpdated event", async function () {
            await expect(
                factory.setTreasury(user1.address)
            ).to.emit(factory, "TreasuryUpdated")
             .withArgs(user1.address);
        });

        // Removed: setTreasury zero address validation test
        // Covered by ValidationLib.test.js

        it("Should only allow owner to update defaults", async function () {
            await expect(
                factory.connect(user1).setDefaults(150000, 50, 14 * 24 * 60 * 60)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should only allow owner to update treasury", async function () {
            await expect(
                factory.connect(user1).setTreasury(user1.address)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should not affect existing pools when defaults change", async function () {
            // Create pool with current defaults
            const tokenAddress = await tokenManager.deployToken.staticCall(
                MODEL_ID_1,
                "Alpha Token",
                "ALPHA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));

            const poolAddress = await factory.createPool.staticCall(MODEL_ID_1, tokenAddress);
            await factory.createPool(MODEL_ID_1, tokenAddress);

            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
            const pool = HokusaiAMM.attach(poolAddress);
            const originalCrr = await pool.crr();

            // Change defaults
            await factory.setDefaults(200000, 100, 10 * 24 * 60 * 60);

            // Existing pool should still have original parameters
            expect(await pool.crr()).to.equal(originalCrr);
        });
    });

    // ============================================================
    // POOL INFO VIEW FUNCTIONS
    // ============================================================

    describe("Pool Info Views", function () {
        let token1Address, pool1Address;

        beforeEach(async function () {
            token1Address = await tokenManager.deployToken.staticCall(
                MODEL_ID_1,
                "Alpha Token",
                "ALPHA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));

            pool1Address = await factory.createPool.staticCall(MODEL_ID_1, token1Address);
            await factory.createPool(MODEL_ID_1, token1Address);
        });

        it("Should return complete pool info", async function () {
            const [poolAddress, tokenAddress, crr, tradeFee, reserveBalance, spotPrice] =
                await factory.getPoolInfo(MODEL_ID_1);

            expect(poolAddress).to.equal(pool1Address);
            expect(tokenAddress).to.equal(token1Address);
            expect(crr).to.equal(100000);
            expect(tradeFee).to.equal(30);
            expect(reserveBalance).to.equal(0); // No reserve yet
            expect(spotPrice).to.be.gt(0);
        });

        it("Should revert getPoolInfo for non-existent pool", async function () {
            await expect(
                factory.getPoolInfo("non-existent-model")
            ).to.be.revertedWith("Pool not found");
        });
    });

    // ============================================================
    // ACCESS CONTROL
    // ============================================================

    describe("Access Control", function () {
        it("Should only allow owner to create pools", async function () {
            const tokenAddress = await tokenManager.deployToken.staticCall(
                MODEL_ID_1,
                "Alpha Token",
                "ALPHA",
                parseEther("1")
            );
            await tokenManager.deployToken(MODEL_ID_1, "Alpha Token", "ALPHA", parseEther("1"));

            await expect(
                factory.connect(user1).createPool(MODEL_ID_1, tokenAddress)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });
    });
});
