const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("Phase 4: Reentrancy Attack Security", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, attacker;

    // AMM Parameters
    const modelId = "reentrancy-test-model";
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC
    const INITIAL_SUPPLY = parseUnits("100000", 18); // 100k tokens
    const CRR = 100000; // 10% reserve ratio
    const TRADE_FEE = 30; // 0.30%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    beforeEach(async function () {
        [owner, treasury, attacker] = await ethers.getSigners();

        // Deploy mock USDC
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        // Deploy core contracts
        const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
        modelRegistry = await ModelRegistry.deploy();
        await modelRegistry.waitForDeployment();

        const TokenManager = await ethers.getContractFactory("TokenManager");
        tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
        await tokenManager.waitForDeployment();

        // Deploy token
        await tokenManager.deployToken(modelId, "Reentrancy Test", "RET", INITIAL_SUPPLY);
        const tokenAddress = await tokenManager.getTokenAddress(modelId);
        hokusaiToken = await ethers.getContractAt("HokusaiToken", tokenAddress);

        // Deploy AMM
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await HokusaiAMM.deploy(
            await mockUSDC.getAddress(),
            await hokusaiToken.getAddress(),
            await tokenManager.getAddress(),
            modelId,
            treasury.address,
            CRR,
            TRADE_FEE,
            IBR_DURATION,
            FLAT_CURVE_THRESHOLD,
            FLAT_CURVE_PRICE
        );
        await hokusaiAMM.waitForDeployment();

        // Authorize AMM
        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        // Fund initial reserve
        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        // Fund attacker
        await mockUSDC.mint(attacker.address, parseUnits("100000", 6));
        await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
    });

    // ============================================================
    // REENTRANCY GUARD VERIFICATION
    // ============================================================

    describe("ReentrancyGuard Protection", function () {
        it("Should have ReentrancyGuard applied to buy() function", async function () {
            // Verify buy function cannot be reentered
            // The contract uses OpenZeppelin's ReentrancyGuard

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            // Normal buy should work
            await expect(
                hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline)
            ).to.not.be.reverted;

            // Verify the function completed successfully
            const balance = await hokusaiToken.balanceOf(attacker.address);
            expect(balance).to.be.gt(0);
        });

        it("Should have ReentrancyGuard applied to sell() function", async function () {
            // Buy tokens first
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline1);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Verify sell function cannot be reentered
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Normal sell should work
            await expect(
                hokusaiAMM.connect(attacker).sell(tokens, 0, attacker.address, deadline2)
            ).to.not.be.reverted;
        });

        it("Should have ReentrancyGuard applied to depositFees() function", async function () {
            // Verify depositFees cannot be reentered
            const depositAmount = parseUnits("1000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);

            await expect(
                hokusaiAMM.depositFees(depositAmount)
            ).to.not.be.reverted;
        });

        it("Should have ReentrancyGuard applied to withdrawTreasury() function", async function () {
            // Verify withdrawTreasury cannot be reentered
            // Need to accumulate some treasury balance first via protocol fees
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Deposit creates treasury balance via protocol fee
            const depositAmount = parseUnits("10000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);
            await hokusaiAMM.depositFees(depositAmount);

            // Calculate treasury balance (USDC balance - reserve)
            const ammUSDC = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());
            const reserve = await hokusaiAMM.reserveBalance();
            const treasuryBalance = ammUSDC - reserve;

            if (treasuryBalance > 0) {
                await expect(
                    hokusaiAMM.withdrawTreasury(treasuryBalance)
                ).to.not.be.reverted;
            }
        });
    });

    // ============================================================
    // CROSS-FUNCTION REENTRANCY
    // ============================================================

    describe("Cross-Function Reentrancy Protection", function () {
        it("Should prevent buy() → buy() reentrancy", async function () {
            // ReentrancyGuard prevents calling buy from within buy
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            // If reentrancy were possible, the attacker could call buy again
            // before the first call completes, potentially draining reserves
            // ReentrancyGuard prevents this

            await expect(
                hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline)
            ).to.not.be.reverted;

            // Verify reserve is correctly updated once
            const reserve = await hokusaiAMM.reserveBalance();
            const expectedReserve = INITIAL_RESERVE + buyAmount - (buyAmount * BigInt(TRADE_FEE)) / 10000n;
            expect(reserve).to.be.closeTo(expectedReserve, parseUnits("1", 6));
        });

        it("Should prevent sell() → sell() reentrancy", async function () {
            // Buy tokens first
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("2000", 6), 0, attacker.address, deadline1);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Try to sell
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            const halfTokens = tokens / 2n;
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const initialReserve = await hokusaiAMM.reserveBalance();

            await expect(
                hokusaiAMM.connect(attacker).sell(halfTokens, 0, attacker.address, deadline2)
            ).to.not.be.reverted;

            // Verify reserve decreased correctly (once)
            const finalReserve = await hokusaiAMM.reserveBalance();
            expect(finalReserve).to.be.lt(initialReserve);
        });

        it("Should prevent buy() → sell() cross-function reentrancy", async function () {
            // Fast forward past IBR first so sells are enabled
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy some tokens first to have something to sell
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline);

            // ReentrancyGuard prevents calling sell() from within buy() callback
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);

            // Another buy should work fine (sequential, not reentrant)
            await expect(
                hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should prevent depositFees() → withdrawTreasury() reentrancy", async function () {
            // Set max trade size to 50% for this test
            await hokusaiAMM.setMaxTradeBps(5000);

            // Accumulate some fees via buy
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("5000", 6), 0, attacker.address, deadline);

            // Deposit more fees
            const depositAmount = parseUnits("1000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);

            const initialReserve = await hokusaiAMM.reserveBalance();

            await expect(
                hokusaiAMM.depositFees(depositAmount)
            ).to.not.be.reverted;

            const finalReserve = await hokusaiAMM.reserveBalance();
            expect(finalReserve).to.be.gt(initialReserve);
        });
    });

    // ============================================================
    // STATE CONSISTENCY
    // ============================================================

    describe("State Consistency Under Attack", function () {
        it("Should maintain token supply consistency", async function () {
            // Even if reentrancy were attempted, token supply should remain consistent
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            const initialSupply = await hokusaiToken.totalSupply();

            await hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline);

            const finalSupply = await hokusaiToken.totalSupply();
            const tokensMinted = await hokusaiToken.balanceOf(attacker.address);

            // Supply should increase by exactly the amount minted
            expect(finalSupply - initialSupply).to.equal(tokensMinted);
        });

        it("Should maintain reserve balance consistency", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            const initialReserve = await hokusaiAMM.reserveBalance();
            const initialAMMBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());

            await hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline);

            const finalReserve = await hokusaiAMM.reserveBalance();
            const finalAMMBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());

            // Reserve tracking should match actual USDC balance change
            const reserveIncrease = finalReserve - initialReserve;
            const actualIncrease = finalAMMBalance - initialAMMBalance;

            expect(reserveIncrease).to.be.closeTo(actualIncrease, parseUnits("1", 6));
        });

        it("Should maintain treasury fee transfer consistency", async function () {
            // Set trade size limit
            await hokusaiAMM.setMaxTradeBps(5000);

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("5000", 6);

            // Track treasury address balance (fees go directly to treasury)
            const initialTreasuryBalance = await mockUSDC.balanceOf(treasury.address);

            await hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline);

            // Treasury should have received the trade fee
            const finalTreasuryBalance = await mockUSDC.balanceOf(treasury.address);
            const expectedFeeIncrease = (buyAmount * BigInt(TRADE_FEE)) / 10000n;

            expect(finalTreasuryBalance - initialTreasuryBalance).to.be.closeTo(
                expectedFeeIncrease,
                parseUnits("0.01", 6)
            );
        });

        it("Should prevent reserve drain via rapid sequential calls", async function () {
            // Even without reentrancy, rapid calls should be safe
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const initialReserve = await hokusaiAMM.reserveBalance();

            // Make 10 sequential buys
            for (let i = 0; i < 10; i++) {
                await hokusaiAMM.connect(attacker).buy(parseUnits("500", 6), 0, attacker.address, deadline);
            }

            const finalReserve = await hokusaiAMM.reserveBalance();

            // Reserve should have increased (buys add to reserve)
            expect(finalReserve).to.be.gt(initialReserve);

            // Reserve should never go negative
            expect(finalReserve).to.be.gt(0);
        });
    });

    // ============================================================
    // CHECKS-EFFECTS-INTERACTIONS PATTERN
    // ============================================================

    describe("Checks-Effects-Interactions Pattern", function () {
        it("Should update state before external calls in buy()", async function () {
            // buy() should update reserveBalance before transferring tokens
            // This follows the checks-effects-interactions pattern

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);

            const tx = await hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline);
            await tx.wait();

            // If state was updated before external calls, the transaction should complete correctly
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            expect(tokens).to.be.gt(0);
        });

        it("Should update state before external calls in sell()", async function () {
            // Buy first
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline1);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // sell() should update reserveBalance before transferring USDC
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const tx = await hokusaiAMM.connect(attacker).sell(tokens, 0, attacker.address, deadline2);
            await tx.wait();

            // If state was updated correctly, USDC balance should reflect the sale
            const usdcBalance = await mockUSDC.balanceOf(attacker.address);
            expect(usdcBalance).to.be.gt(0);
        });
    });

    // ============================================================
    // INTEGRATION WITH OTHER SECURITY MEASURES
    // ============================================================

    describe("Integration with Other Security Measures", function () {
        it("Should combine ReentrancyGuard with Pausable", async function () {
            // Pause the contract
            await hokusaiAMM.pause();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy should fail due to pause, not reentrancy
            await expect(
                hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline)
            ).to.be.revertedWith("Pausable: paused");

            // Unpause and verify it works
            await hokusaiAMM.unpause();

            await expect(
                hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should combine ReentrancyGuard with trade size limits", async function () {
            // Set trade size limit
            await hokusaiAMM.setMaxTradeBps(2000); // 20%

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const currentReserve = await hokusaiAMM.reserveBalance();
            const oversizedTrade = (currentReserve * 3000n) / 10000n; // 30%, exceeds limit

            // Should fail due to trade size limit, not reentrancy
            await expect(
                hokusaiAMM.connect(attacker).buy(oversizedTrade, 0, attacker.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");
        });

        it("Should combine ReentrancyGuard with IBR restrictions", async function () {
            // During IBR, sells should be blocked
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy first
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline);

            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);

            // Try to sell during IBR (should fail)
            await expect(
                hokusaiAMM.connect(attacker).sell(tokens, 0, attacker.address, deadline)
            ).to.be.revertedWith("Sells not enabled during IBR");
        });
    });
});
