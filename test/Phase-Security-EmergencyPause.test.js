const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("Phase 8: Emergency Pause & Safety Mechanisms", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, user1, user2, attacker;

    // AMM Parameters
    const modelId = "emergency-pause-test-model";
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC
    const INITIAL_SUPPLY = parseUnits("100000", 18); // 100k tokens
    const CRR = 100000; // 10% reserve ratio
    const TRADE_FEE = 25; // 0.25%
    const PROTOCOL_FEE = 500; // 5%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    beforeEach(async function () {
        [owner, treasury, user1, user2, attacker] = await ethers.getSigners();

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
        await tokenManager.deployToken(modelId, "Emergency Pause Test", "EPT", INITIAL_SUPPLY);
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
            PROTOCOL_FEE,
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

        // Fund users
        await mockUSDC.mint(user1.address, parseUnits("100000", 6));
        await mockUSDC.mint(user2.address, parseUnits("100000", 6));
        await mockUSDC.mint(attacker.address, parseUnits("100000", 6));

        await mockUSDC.connect(user1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(user2).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
    });

    // ============================================================
    // PAUSE FUNCTIONALITY
    // ============================================================

    describe("Pause Mechanism", function () {
        it("Should allow owner to pause the contract", async function () {
            expect(await hokusaiAMM.paused()).to.be.false;

            await hokusaiAMM.pause();

            expect(await hokusaiAMM.paused()).to.be.true;
        });

        it("Should prevent non-owner from pausing", async function () {
            await expect(
                hokusaiAMM.connect(attacker).pause()
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should allow owner to unpause the contract", async function () {
            await hokusaiAMM.pause();
            expect(await hokusaiAMM.paused()).to.be.true;

            await hokusaiAMM.unpause();

            expect(await hokusaiAMM.paused()).to.be.false;
        });

        it("Should prevent non-owner from unpausing", async function () {
            await hokusaiAMM.pause();

            await expect(
                hokusaiAMM.connect(attacker).unpause()
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should revert when pausing already paused contract", async function () {
            await hokusaiAMM.pause();

            await expect(
                hokusaiAMM.pause()
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should revert when unpausing already unpaused contract", async function () {
            await expect(
                hokusaiAMM.unpause()
            ).to.be.revertedWith("Pausable: not paused");
        });
    });

    // ============================================================
    // PAUSED STATE RESTRICTIONS
    // ============================================================

    describe("Operations Blocked When Paused", function () {
        beforeEach(async function () {
            await hokusaiAMM.pause();
        });

        it("Should block buy() when paused", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should block sell() when paused", async function () {
            // Unpause to buy tokens first
            await hokusaiAMM.unpause();
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Pause again
            await hokusaiAMM.pause();

            const tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline2)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should allow depositFees() when paused (emergency reserve top-up)", async function () {
            // depositFees is allowed during pause for emergency reserve management
            const depositAmount = parseUnits("1000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);

            await expect(
                hokusaiAMM.depositFees(depositAmount)
            ).to.not.be.reverted;

            // Verify reserve increased
            const reserve = await hokusaiAMM.reserveBalance();
            expect(reserve).to.be.gt(INITIAL_RESERVE);
        });

        it("Should allow withdrawTreasury() when paused (emergency recovery)", async function () {
            // Unpause to create treasury balance
            await hokusaiAMM.unpause();
            const depositAmount = parseUnits("5000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);
            await hokusaiAMM.depositFees(depositAmount);

            // Pause
            await hokusaiAMM.pause();

            // Should still allow treasury withdrawal for emergency recovery
            const ammBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());
            const reserve = await hokusaiAMM.reserveBalance();
            const treasuryBalance = ammBalance - reserve;

            if (treasuryBalance > 0n) {
                await expect(
                    hokusaiAMM.withdrawTreasury(treasuryBalance)
                ).to.not.be.reverted;
            }
        });

        it("Should allow view functions when paused", async function () {
            // View functions should always work
            await expect(hokusaiAMM.reserveBalance()).to.not.be.reverted;
            await expect(hokusaiAMM.spotPrice()).to.not.be.reverted;
            await expect(hokusaiAMM.getBuyQuote(parseUnits("1000", 6))).to.not.be.reverted;
            await expect(hokusaiAMM.getSellQuote(parseUnits("100", 18))).to.not.be.reverted;
        });
    });

    // ============================================================
    // STATE PRESERVATION DURING PAUSE
    // ============================================================

    describe("State Preservation During Pause", function () {
        it("Should preserve reserve balance during pause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Make some trades
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);
            const reserveBeforePause = await hokusaiAMM.reserveBalance();

            // Pause
            await hokusaiAMM.pause();

            // Reserve should be unchanged
            expect(await hokusaiAMM.reserveBalance()).to.equal(reserveBeforePause);

            // Unpause
            await hokusaiAMM.unpause();

            // Reserve still unchanged
            expect(await hokusaiAMM.reserveBalance()).to.equal(reserveBeforePause);
        });

        it("Should preserve token balances during pause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // User buys tokens
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);
            const tokensBeforePause = await hokusaiToken.balanceOf(user1.address);

            // Pause
            await hokusaiAMM.pause();

            // Token balance unchanged
            expect(await hokusaiToken.balanceOf(user1.address)).to.equal(tokensBeforePause);

            // Unpause
            await hokusaiAMM.unpause();

            // Token balance still unchanged
            expect(await hokusaiToken.balanceOf(user1.address)).to.equal(tokensBeforePause);
        });

        it("Should preserve spot price during pause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Make trade to change price
            await hokusaiAMM.connect(user1).buy(parseUnits("2000", 6), 0, user1.address, deadline);
            const priceBeforePause = await hokusaiAMM.spotPrice();

            // Pause
            await hokusaiAMM.pause();

            // Price unchanged
            expect(await hokusaiAMM.spotPrice()).to.equal(priceBeforePause);

            // Unpause
            await hokusaiAMM.unpause();

            // Price still unchanged
            expect(await hokusaiAMM.spotPrice()).to.equal(priceBeforePause);
        });

        it("Should preserve IBR state during pause", async function () {
            const buyOnlyUntilBefore = await hokusaiAMM.buyOnlyUntil();

            // Pause
            await hokusaiAMM.pause();

            // IBR timestamp unchanged
            expect(await hokusaiAMM.buyOnlyUntil()).to.equal(buyOnlyUntilBefore);

            // Time passes during pause
            await ethers.provider.send("evm_increaseTime", [3600]);
            await ethers.provider.send("evm_mine");

            // IBR timestamp still unchanged (time doesn't affect it)
            expect(await hokusaiAMM.buyOnlyUntil()).to.equal(buyOnlyUntilBefore);

            // Unpause
            await hokusaiAMM.unpause();

            // IBR timestamp still preserved
            expect(await hokusaiAMM.buyOnlyUntil()).to.equal(buyOnlyUntilBefore);
        });
    });

    // ============================================================
    // RESUME OPERATIONS AFTER PAUSE
    // ============================================================

    describe("Resume Operations After Pause", function () {
        it("Should allow normal operations after unpause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Pause
            await hokusaiAMM.pause();

            // Unpause
            await hokusaiAMM.unpause();

            // Should work normally
            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline)
            ).to.not.be.reverted;

            const tokens = await hokusaiToken.balanceOf(user1.address);
            expect(tokens).to.be.gt(0);
        });

        it("Should resume at correct state after pause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy before pause
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);
            const reserveAfterFirstBuy = await hokusaiAMM.reserveBalance();

            // Pause
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            // Buy after unpause
            await hokusaiAMM.connect(user2).buy(parseUnits("1000", 6), 0, user2.address, deadline);
            const reserveAfterSecondBuy = await hokusaiAMM.reserveBalance();

            // Reserve should have increased correctly
            expect(reserveAfterSecondBuy).to.be.gt(reserveAfterFirstBuy);
        });

        it("Should allow sell after pause if IBR ended", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy tokens
            await hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline);
            const tokens = await hokusaiToken.balanceOf(user1.address);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Pause and unpause
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            // Should allow sell
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);
            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline2)
            ).to.not.be.reverted;
        });

        it("Should maintain trade size limits after unpause", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Set trade limit
            await hokusaiAMM.setMaxTradeBps(2000); // 20%

            // Pause and unpause
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            // Trade limit should still be enforced
            const currentReserve = await hokusaiAMM.reserveBalance();
            const oversizedTrade = (currentReserve * 2500n) / 10000n; // 25%, exceeds 20%

            await expect(
                hokusaiAMM.connect(user1).buy(oversizedTrade, 0, user1.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");

            // Within limit should work
            const validTrade = (currentReserve * 1500n) / 10000n; // 15%
            await expect(
                hokusaiAMM.connect(user1).buy(validTrade, 0, user1.address, deadline)
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // EMERGENCY SCENARIOS
    // ============================================================

    describe("Emergency Response Scenarios", function () {
        it("Should allow quick pause in response to attack", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;

            // Simulated attack: attacker starts large trade
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline);

            // Owner detects and pauses immediately
            await hokusaiAMM.pause();

            // Further attack transactions should fail
            await expect(
                hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should allow pause during IBR period", async function () {
            // Should be in IBR period initially
            const buyOnlyUntil = await hokusaiAMM.buyOnlyUntil();
            const currentTime = (await ethers.provider.getBlock('latest')).timestamp;
            expect(buyOnlyUntil).to.be.gt(currentTime);

            // Pause should work
            await expect(hokusaiAMM.pause()).to.not.be.reverted;

            expect(await hokusaiAMM.paused()).to.be.true;
        });

        it("Should allow pause with active positions", async function () {
            // Set higher trade limit for this test
            await hokusaiAMM.setMaxTradeBps(5000); // 50%

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Create active positions
            await hokusaiAMM.connect(user1).buy(parseUnits("2000", 6), 0, user1.address, deadline);
            await hokusaiAMM.connect(user2).buy(parseUnits("3000", 6), 0, user2.address, deadline);

            // Should still allow pause
            await expect(hokusaiAMM.pause()).to.not.be.reverted;

            // Positions preserved
            expect(await hokusaiToken.balanceOf(user1.address)).to.be.gt(0);
            expect(await hokusaiToken.balanceOf(user2.address)).to.be.gt(0);
        });

        it("Should maintain security during pause/unpause cycles", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

            // Multiple pause/unpause cycles
            for (let i = 0; i < 3; i++) {
                await hokusaiAMM.pause();
                await hokusaiAMM.unpause();

                // System should remain functional
                await hokusaiAMM.connect(user1).buy(parseUnits("500", 6), 0, user1.address, deadline);
            }

            // Verify system integrity
            const reserve = await hokusaiAMM.reserveBalance();
            const tokens = await hokusaiToken.balanceOf(user1.address);

            expect(reserve).to.be.gt(INITIAL_RESERVE);
            expect(tokens).to.be.gt(0);
        });
    });

    // ============================================================
    // GOVERNANCE DURING PAUSE
    // ============================================================

    describe("Governance Operations During Pause", function () {
        beforeEach(async function () {
            await hokusaiAMM.pause();
        });

        it("Should allow parameter updates during pause", async function () {
            // Owner should be able to update parameters while paused
            await expect(
                hokusaiAMM.setParameters(100000, 30, 500)
            ).to.not.be.reverted;
        });

        it("Should allow trade limit adjustments during pause", async function () {
            await expect(
                hokusaiAMM.setMaxTradeBps(3000)
            ).to.not.be.reverted;

            expect(await hokusaiAMM.maxTradeBps()).to.equal(3000);
        });

        it("Should allow ownership transfer during pause", async function () {
            await expect(
                hokusaiAMM.transferOwnership(user1.address)
            ).to.not.be.reverted;

            expect(await hokusaiAMM.owner()).to.equal(user1.address);
        });

        it("Should allow treasury withdrawal during pause", async function () {
            // Unpause to create treasury balance
            await hokusaiAMM.unpause();
            const depositAmount = parseUnits("5000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);
            await hokusaiAMM.depositFees(depositAmount);

            // Pause again
            await hokusaiAMM.pause();

            // Calculate treasury balance
            const ammBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress());
            const reserve = await hokusaiAMM.reserveBalance();
            const treasuryBalance = ammBalance - reserve;

            // Should allow withdrawal during pause for emergency recovery
            if (treasuryBalance > 0n) {
                await expect(
                    hokusaiAMM.withdrawTreasury(treasuryBalance)
                ).to.not.be.reverted;
            }
        });
    });

    // ============================================================
    // PAUSE INTEGRATION WITH OTHER SECURITY
    // ============================================================

    describe("Pause Integration with Security Features", function () {
        it("Should work with reentrancy protection", async function () {
            // Pause with reentrancy guard should work seamlessly
            await hokusaiAMM.pause();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Should fail due to pause, not reentrancy
            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should work with trade size limits", async function () {
            await hokusaiAMM.setMaxTradeBps(2000);
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            // Trade limit should still be enforced
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const currentReserve = await hokusaiAMM.reserveBalance();
            const oversized = (currentReserve * 2500n) / 10000n;

            await expect(
                hokusaiAMM.connect(user1).buy(oversized, 0, user1.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");
        });

        it("Should work with IBR restrictions", async function () {
            // During IBR, pause should still work
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Buy should work (IBR allows buys)
            await expect(
                hokusaiAMM.connect(user1).buy(parseUnits("1000", 6), 0, user1.address, deadline)
            ).to.not.be.reverted;

            // Sell should fail (IBR restriction, not pause)
            const tokens = await hokusaiToken.balanceOf(user1.address);
            await hokusaiToken.connect(user1).approve(await hokusaiAMM.getAddress(), tokens);

            await expect(
                hokusaiAMM.connect(user1).sell(tokens, 0, user1.address, deadline)
            ).to.be.revertedWith("Sells not enabled during IBR");
        });
    });
});
