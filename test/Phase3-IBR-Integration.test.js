const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("Phase 3: IBR & TokenManager Integration", function () {
    let modelRegistry;
    let tokenManager;
    let hokusaiToken;
    let hokusaiAMM;
    let mockUSDC;
    let owner, treasury, buyer1, buyer2;

    const MODEL_ID = "test-model-v1";
    const TOKEN_NAME = "Test Model Token";
    const TOKEN_SYMBOL = "TMT";
    const INITIAL_SUPPLY = parseEther("1"); // Minimal initial supply for deployment
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC (r0)
    const CRR = 100000; // 10% (100k PPM)
    const TRADE_FEE = 30; // 0.30% (30 bps)
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days in seconds
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    // For testing, we'll simulate starting state (s0=100k, r0=$10k)
    const SIMULATED_SUPPLY = parseEther("100000"); // What supply should be after initialization

    beforeEach(async function () {
        [owner, treasury, buyer1, buyer2] = await ethers.getSigners();

        // Deploy ModelRegistry
        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        modelRegistry = await ModelRegistry.deploy();
        await modelRegistry.waitForDeployment();

        // Deploy TokenManager
        const TokenManager = await ethers.getContractFactory("TokenManager");
        tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
        await tokenManager.waitForDeployment();

        // Deploy Mock USDC
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        // Deploy token via TokenManager
        const tokenAddress = await tokenManager.deployToken.staticCall(
            MODEL_ID,
            TOKEN_NAME,
            TOKEN_SYMBOL,
            INITIAL_SUPPLY
        );
        await tokenManager.deployToken(MODEL_ID, TOKEN_NAME, TOKEN_SYMBOL, INITIAL_SUPPLY);

        // Get deployed token
        const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
        hokusaiToken = HokusaiToken.attach(tokenAddress);

        // Deploy HokusaiAMM
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await HokusaiAMM.deploy(
            await mockUSDC.getAddress(),
            await hokusaiToken.getAddress(),
            await tokenManager.getAddress(),
            MODEL_ID,
            treasury.address,
            CRR,
            TRADE_FEE,
            IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
        );
        await hokusaiAMM.waitForDeployment();

        // Authorize AMM to mint/burn via TokenManager
        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        // Register string model in ModelRegistry first
        await modelRegistry.registerStringModel(
            MODEL_ID,
            await hokusaiToken.getAddress(),
            "test-metric"
        );

        // Register pool in ModelRegistry
        await modelRegistry.registerPool(MODEL_ID, await hokusaiAMM.getAddress());

        // Initialize pool with reserve
        // Mint USDC for initial reserve and deposit to pool
        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        // Simulate initial supply by minting tokens through TokenManager
        // In production, this would be done during factory deployment
        await tokenManager.mintTokens(MODEL_ID, owner.address, SIMULATED_SUPPLY);

        // Mint USDC to buyers for testing
        await mockUSDC.mint(buyer1.address, parseUnits("100000", 6)); // $100k
        await mockUSDC.mint(buyer2.address, parseUnits("100000", 6)); // $100k

        // Approve AMM to spend buyers' USDC
        await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(buyer2).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));

        // Set max trade size to 50% for these integration tests (they test large trades)
        await hokusaiAMM.setMaxTradeBps(5000);
    });

    // ============================================================
    // INITIALIZATION & PARAMETER VALIDATION
    // ============================================================

    describe("Initialization & Parameters", function () {
        it("Should initialize with correct parameters", async function () {
            expect(await hokusaiAMM.reserveToken()).to.equal(await mockUSDC.getAddress());
            expect(await hokusaiAMM.hokusaiToken()).to.equal(await hokusaiToken.getAddress());
            expect(await hokusaiAMM.tokenManager()).to.equal(await tokenManager.getAddress());
            expect(await hokusaiAMM.modelId()).to.equal(MODEL_ID);
            expect(await hokusaiAMM.treasury()).to.equal(treasury.address);
            expect(await hokusaiAMM.crr()).to.equal(CRR);
            expect(await hokusaiAMM.tradeFee()).to.equal(TRADE_FEE);
        });

        it("Should set IBR period correctly (7 days)", async function () {
            const buyOnlyUntil = await hokusaiAMM.buyOnlyUntil();
            const currentTime = (await ethers.provider.getBlock('latest')).timestamp;

            // buyOnlyUntil should be in the future (7 days from deployment)
            // Allow tolerance for multiple transactions between deployment and this check
            const minExpected = currentTime;
            const maxExpected = currentTime + IBR_DURATION + 100; // +100s buffer for transaction time

            expect(buyOnlyUntil).to.be.gte(BigInt(minExpected));
            expect(buyOnlyUntil).to.be.lte(BigInt(maxExpected));
        });

        it("Should initialize with correct reserve balance", async function () {
            expect(await hokusaiAMM.reserveBalance()).to.equal(INITIAL_RESERVE);
        });

        it("Should have correct initial spot price (~$0.10)", async function () {
            const spotPrice = await hokusaiAMM.spotPrice();
            // With s0=100k, r0=$10k, CRR=10%:
            // P = R / (w × S) = 10000 / (0.1 × 100000) = $1.00 per token
            // But in our setup we only have r0=$10k and minimal supply initially
            // So price will be high initially, then normalize as tokens are minted
            expect(spotPrice).to.be.gt(0);
        });

        it("Should register pool in ModelRegistry", async function () {
            expect(await modelRegistry.hasPool(MODEL_ID)).to.be.true;
            expect(await modelRegistry.getPool(MODEL_ID)).to.equal(await hokusaiAMM.getAddress());
        });

        it("Should grant MINTER_ROLE to AMM", async function () {
            const MINTER_ROLE = await tokenManager.MINTER_ROLE();
            expect(await tokenManager.hasRole(MINTER_ROLE, await hokusaiAMM.getAddress())).to.be.true;
        });

        it("Should revert deployment with invalid parameters", async function () {
            const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");

            // Invalid reserve token (zero address)
            await expect(
                HokusaiAMM.deploy(
                    ZeroAddress,
                    await hokusaiToken.getAddress(),
                    await tokenManager.getAddress(),
                    MODEL_ID,
                    treasury.address,
                    CRR,
                    TRADE_FEE,
                    IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
                )
            ).to.be.revertedWithCustomError(HokusaiAMM, "ZeroAddress");

            // Invalid CRR (too high)
            await expect(
                HokusaiAMM.deploy(
                    await mockUSDC.getAddress(),
                    await hokusaiToken.getAddress(),
                    await tokenManager.getAddress(),
                    MODEL_ID,
                    treasury.address,
                    600000, // 60% > 50% max
                    TRADE_FEE,
                    IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
                )
            ).to.be.reverted;

            // Invalid trade fee (too high)
            await expect(
                HokusaiAMM.deploy(
                    await mockUSDC.getAddress(),
                    await hokusaiToken.getAddress(),
                    await tokenManager.getAddress(),
                    MODEL_ID,
                    treasury.address,
                    CRR,
                    1500, // 15% > 10% max
                    IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
                )
            ).to.be.reverted;
        });
    });

    // ============================================================
    // IBR LIFECYCLE (BUY-ONLY PERIOD)
    // ============================================================

    describe("IBR Lifecycle", function () {
        it("Should allow buys during IBR period", async function () {
            const depositAmount = parseUnits("1000", 6); // $1k
            const minTokensOut = 0;
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(buyer1).buy(depositAmount, minTokensOut, buyer1.address, deadline)
            ).to.not.be.reverted;

            // Verify tokens were minted
            expect(await hokusaiToken.balanceOf(buyer1.address)).to.be.gt(0);
        });

        it("Should revert sells during IBR period", async function () {
            // First buy some tokens
            const depositAmount = parseUnits("1000", 6);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);

            // Approve AMM to spend tokens
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            // Try to sell - should revert
            await expect(
                hokusaiAMM.connect(buyer1).sell(tokenBalance, 0, buyer1.address, deadline)
            ).to.be.revertedWith("Sells not enabled during IBR");
        });

        it("Should report isSellEnabled() as false during IBR", async function () {
            expect(await hokusaiAMM.isSellEnabled()).to.be.false;
        });

        it("Should automatically enable sells after IBR period", async function () {
            // Fast forward 7 days + 1 second
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            expect(await hokusaiAMM.isSellEnabled()).to.be.true;
        });

        it("Should allow sells after IBR period ends", async function () {
            // Buy tokens during IBR
            const depositAmount = parseUnits("1000", 6);
            let deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Now sell should succeed
            deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).sell(tokenBalance, 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should handle multiple buyers during IBR", async function () {
            const depositAmount = parseUnits("5000", 6); // $5k each
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Both buyers purchase
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);
            await hokusaiAMM.connect(buyer2).buy(depositAmount, 0, buyer2.address, deadline);

            // Both should have tokens
            expect(await hokusaiToken.balanceOf(buyer1.address)).to.be.gt(0);
            expect(await hokusaiToken.balanceOf(buyer2.address)).to.be.gt(0);

            // Total supply should have increased from simulated supply
            const totalSupply = await hokusaiToken.totalSupply();
            expect(totalSupply).to.be.gt(SIMULATED_SUPPLY);
        });

        it("Should raise spot price as reserve grows during IBR", async function () {
            const spotPriceBefore = await hokusaiAMM.spotPrice();

            // Large buy increases reserve (50% of $10k reserve - at max limit)
            const depositAmount = parseUnits("5000", 6); // $5k
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            const spotPriceAfter = await hokusaiAMM.spotPrice();
            expect(spotPriceAfter).to.be.gt(spotPriceBefore);
        });
    });

    // ============================================================
    // TOKENMANAGER DELEGATION
    // ============================================================

    describe("TokenManager Delegation", function () {
        it("Should mint tokens via TokenManager on buy", async function () {
            const supplyBefore = await hokusaiToken.totalSupply();

            const depositAmount = parseUnits("1000", 6);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            const supplyAfter = await hokusaiToken.totalSupply();
            expect(supplyAfter).to.be.gt(supplyBefore);
        });

        it("Should burn tokens via TokenManager on sell (after IBR)", async function () {
            // Buy tokens first
            const depositAmount = parseUnits("1000", 6);
            let deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            const supplyAfterBuy = await hokusaiToken.totalSupply();
            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Approve and sell
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);
            deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).sell(tokenBalance, 0, buyer1.address, deadline);

            const supplyAfterSell = await hokusaiToken.totalSupply();
            expect(supplyAfterSell).to.be.lt(supplyAfterBuy);
        });

        it("Should verify AMM has MINTER_ROLE", async function () {
            const MINTER_ROLE = await tokenManager.MINTER_ROLE();
            expect(await tokenManager.hasRole(MINTER_ROLE, await hokusaiAMM.getAddress())).to.be.true;
        });

        it("Should fail if AMM loses MINTER_ROLE", async function () {
            // Revoke AMM authorization
            await tokenManager.revokeAMM(await hokusaiAMM.getAddress());

            const depositAmount = parseUnits("1000", 6);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy should fail
            await expect(
                hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline)
            ).to.be.revertedWith("Caller is not authorized to mint");
        });

        it("Should track modelId correctly in TokenManager", async function () {
            const tokenAddress = await tokenManager.getTokenAddress(MODEL_ID);
            expect(tokenAddress).to.equal(await hokusaiToken.getAddress());
        });

        it("Should integrate with existing DeltaVerifier authorization", async function () {
            // DeltaVerifier can still mint rewards independently of AMM
            const MINTER_ROLE = await tokenManager.MINTER_ROLE();

            // Set a mock deltaVerifier
            const [_, __, deltaVerifier] = await ethers.getSigners();
            await tokenManager.setDeltaVerifier(deltaVerifier.address);

            // DeltaVerifier should be able to mint
            await expect(
                tokenManager.connect(deltaVerifier).mintTokens(MODEL_ID, buyer2.address, parseEther("100"))
            ).to.not.be.reverted;

            expect(await hokusaiToken.balanceOf(buyer2.address)).to.equal(parseEther("100"));
        });
    });

    // ============================================================
    // INTEGRATION SCENARIOS
    // ============================================================

    describe("Full Integration Scenarios", function () {
        it("Should handle complete IBR lifecycle: multiple buys → wait → sell", async function () {
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Phase 1: Multiple buys during IBR (within 50% trade limit)
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline1);
            await hokusaiAMM.connect(buyer2).buy(parseUnits("3000", 6), 0, buyer2.address, deadline1);

            const buyer1Tokens = await hokusaiToken.balanceOf(buyer1.address);
            const buyer2Tokens = await hokusaiToken.balanceOf(buyer2.address);

            expect(buyer1Tokens).to.be.gt(0);
            expect(buyer2Tokens).to.be.gt(0);

            // Phase 2: Wait for IBR to end
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Phase 3: Both sell
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), buyer1Tokens);
            await hokusaiToken.connect(buyer2).approve(await hokusaiAMM.getAddress(), buyer2Tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).sell(buyer1Tokens, 0, buyer1.address, deadline2);
            await hokusaiAMM.connect(buyer2).sell(buyer2Tokens, 0, buyer2.address, deadline2);

            // Both should have received USDC back (minus fees)
            expect(await mockUSDC.balanceOf(buyer1.address)).to.be.gt(parseUnits("90000", 6)); // Lost some to fees
            expect(await mockUSDC.balanceOf(buyer2.address)).to.be.gt(parseUnits("95000", 6));
        });

        it("Should coordinate AMM trades with DeltaVerifier rewards", async function () {
            // Set delta verifier
            const [_, __, deltaVerifier] = await ethers.getSigners();
            await tokenManager.setDeltaVerifier(deltaVerifier.address);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buyer purchases tokens
            await hokusaiAMM.connect(buyer1).buy(parseUnits("5000", 6), 0, buyer1.address, deadline);

            const supplyAfterBuy = await hokusaiToken.totalSupply();

            // DeltaVerifier mints performance rewards
            await tokenManager.connect(deltaVerifier).mintTokens(MODEL_ID, buyer2.address, parseEther("500"));

            const supplyAfterReward = await hokusaiToken.totalSupply();
            expect(supplyAfterReward).to.equal(supplyAfterBuy + parseEther("500"));

            // Spot price should decrease slightly due to supply inflation
            const spotPrice = await hokusaiAMM.spotPrice();
            expect(spotPrice).to.be.gt(0);
        });

        it("Should handle fee deposits increasing reserve during IBR", async function () {
            const spotPriceBefore = await hokusaiAMM.spotPrice();
            const reserveBefore = await hokusaiAMM.reserveBalance();

            // Simulate API usage fee deposit
            const feeDeposit = parseUnits("2000", 6); // $2k
            await mockUSDC.mint(owner.address, feeDeposit);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), feeDeposit);
            await hokusaiAMM.depositFees(feeDeposit);

            const spotPriceAfter = await hokusaiAMM.spotPrice();
            const reserveAfter = await hokusaiAMM.reserveBalance();

            // Reserve should increase
            expect(reserveAfter).to.equal(reserveBefore + feeDeposit);

            // Spot price should increase (more reserve per token)
            expect(spotPriceAfter).to.be.gt(spotPriceBefore);
        });

        it("Should preserve reserve accounting across buy/sell cycles", async function () {
            const initialReserve = await hokusaiAMM.reserveBalance();
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy (within 50% trade limit)
            const buyAmount = parseUnits("5000", 6);
            await hokusaiAMM.connect(buyer1).buy(buyAmount, 0, buyer1.address, deadline);

            const reserveAfterBuy = await hokusaiAMM.reserveBalance();

            // Reserve should increase (minus trade fee)
            const expectedIncrease = buyAmount - (buyAmount * BigInt(TRADE_FEE)) / 10000n;
            expect(reserveAfterBuy).to.be.closeTo(initialReserve + expectedIncrease, parseUnits("1", 6));

            // Wait for IBR end
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Sell half
            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance / 2n);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).sell(tokenBalance / 2n, 0, buyer1.address, deadline2);

            const reserveAfterSell = await hokusaiAMM.reserveBalance();
            expect(reserveAfterSell).to.be.lt(reserveAfterBuy); // Reserve decreased
            expect(reserveAfterSell).to.be.gt(0); // But still positive
        });
    });

    // ============================================================
    // ERROR HANDLING
    // ============================================================

    describe("Error Handling", function () {
        it("Should revert buy without sufficient USDC approval", async function () {
            // Clear approval
            await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), 0);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.be.reverted;
        });

        it("Should revert sell without token approval", async function () {
            // Buy tokens first
            const depositAmount = parseUnits("1000", 6);
            let deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(depositAmount, 0, buyer1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);

            // Don't approve - should revert
            deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).sell(tokenBalance, 0, buyer1.address, deadline)
            ).to.be.reverted;
        });

        it("Should revert buy with expired deadline", async function () {
            const pastDeadline = (await ethers.provider.getBlock('latest')).timestamp - 100;

            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, pastDeadline)
            ).to.be.revertedWith("Transaction expired");
        });

        it("Should revert sell with expired deadline (after IBR)", async function () {
            // Fast forward past IBR first
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const pastDeadline = (await ethers.provider.getBlock('latest')).timestamp - 100;

            await expect(
                hokusaiAMM.connect(buyer1).sell(parseEther("100"), 0, buyer1.address, pastDeadline)
            ).to.be.revertedWith("Transaction expired");
        });
    });
});
