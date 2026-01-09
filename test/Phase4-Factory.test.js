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
            expect(await factory.defaultTradeFee()).to.equal(25); // 0.25%
            expect(await factory.defaultProtocolFeeBps()).to.equal(500); // 5%
            expect(await factory.defaultIbrDuration()).to.equal(7 * 24 * 60 * 60); // 7 days
        });

        it("Should revert deployment with invalid addresses", async function () {
            const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");

            await expect(
                HokusaiAMMFactory.deploy(
                    ZeroAddress,
                    await tokenManager.getAddress(),
                    await mockUSDC.getAddress(),
                    treasury.address
                )
            ).to.be.revertedWith("Invalid registry");

            await expect(
                HokusaiAMMFactory.deploy(
                    await modelRegistry.getAddress(),
                    ZeroAddress,
                    await mockUSDC.getAddress(),
                    treasury.address
                )
            ).to.be.revertedWith("Invalid token manager");
        });

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
            const customProtocolFee = 300; // 3%
            const customIbrDuration = 14 * 24 * 60 * 60; // 14 days

            const poolAddress = await factory.createPoolWithParams.staticCall(
                MODEL_ID_1,
                token1Address,
                customCrr,
                customTradeFee,
                customProtocolFee,
                customIbrDuration
            );

            await factory.createPoolWithParams(
                MODEL_ID_1,
                token1Address,
                customCrr,
                customTradeFee,
                customProtocolFee,
                customIbrDuration
            );

            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
            const pool = HokusaiAMM.attach(poolAddress);

            expect(await pool.crr()).to.equal(customCrr);
            expect(await pool.tradeFee()).to.equal(customTradeFee);
            expect(await pool.protocolFeeBps()).to.equal(customProtocolFee);
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

        it("Should revert with invalid model ID", async function () {
            await expect(
                factory.createPool("", token1Address)
            ).to.be.revertedWith("Empty model ID");
        });

        it("Should revert with invalid token address", async function () {
            await expect(
                factory.createPool(MODEL_ID_1, ZeroAddress)
            ).to.be.revertedWith("Invalid token address");
        });

        it("Should revert if token not registered with TokenManager", async function () {
            await expect(
                factory.createPool("non-existent-model", token1Address)
            ).to.be.revertedWith("Token not registered with TokenManager");
        });

        it("Should revert with invalid CRR", async function () {
            await expect(
                factory.createPoolWithParams(
                    MODEL_ID_1,
                    token1Address,
                    600000, // 60% > 50% max
                    25,
                    500,
                    7 * 24 * 60 * 60
                )
            ).to.be.revertedWith("CRR out of bounds");

            await expect(
                factory.createPoolWithParams(
                    MODEL_ID_1,
                    token1Address,
                    40000, // 4% < 5% min
                    25,
                    500,
                    7 * 24 * 60 * 60
                )
            ).to.be.revertedWith("CRR out of bounds");
        });

        it("Should revert with invalid trade fee", async function () {
            await expect(
                factory.createPoolWithParams(
                    MODEL_ID_1,
                    token1Address,
                    100000,
                    1500, // 15% > 10% max
                    500,
                    7 * 24 * 60 * 60
                )
            ).to.be.revertedWith("Trade fee too high");
        });

        it("Should revert with invalid IBR duration", async function () {
            await expect(
                factory.createPoolWithParams(
                    MODEL_ID_1,
                    token1Address,
                    100000,
                    25,
                    500,
                    12 * 60 * 60 // 12 hours < 1 day min
                )
            ).to.be.revertedWith("IBR duration out of bounds");

            await expect(
                factory.createPoolWithParams(
                    MODEL_ID_1,
                    token1Address,
                    100000,
                    25,
                    500,
                    35 * 24 * 60 * 60 // 35 days > 30 days max
                )
            ).to.be.revertedWith("IBR duration out of bounds");
        });
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
                300,
                14 * 24 * 60 * 60
            );
            await factory.createPoolWithParams(
                "model-delta",
                token4Address,
                200000,
                50,
                300,
                14 * 24 * 60 * 60
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
            expect(await defaultPoolContract.tradeFee()).to.equal(25);
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
                300, // 3% protocol fee
                14 * 24 * 60 * 60 // 14 days IBR
            );

            expect(await factory.defaultCrr()).to.equal(150000);
            expect(await factory.defaultTradeFee()).to.equal(50);
            expect(await factory.defaultProtocolFeeBps()).to.equal(300);
            expect(await factory.defaultIbrDuration()).to.equal(14 * 24 * 60 * 60);
        });

        it("Should emit DefaultsUpdated event", async function () {
            await expect(
                factory.setDefaults(150000, 50, 300, 14 * 24 * 60 * 60)
            ).to.emit(factory, "DefaultsUpdated")
             .withArgs(150000, 50, 300, 14 * 24 * 60 * 60);
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

        it("Should revert setTreasury with zero address", async function () {
            await expect(
                factory.setTreasury(ZeroAddress)
            ).to.be.revertedWith("Invalid treasury");
        });

        it("Should only allow owner to update defaults", async function () {
            await expect(
                factory.connect(user1).setDefaults(150000, 50, 300, 14 * 24 * 60 * 60)
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
            await factory.setDefaults(200000, 100, 1000, 10 * 24 * 60 * 60);

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
            expect(tradeFee).to.equal(25);
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
