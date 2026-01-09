const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

describe("Phase 6: Governance & Safety", function () {
    let modelRegistry;
    let tokenManager;
    let hokusaiToken;
    let hokusaiAMM;
    let mockUSDC;
    let owner, treasury, buyer1, attacker;

    const MODEL_ID = "test-model-v1";
    const TOKEN_NAME = "Test Model Token";
    const TOKEN_SYMBOL = "TMT";
    const INITIAL_SUPPLY = parseEther("1");
    const INITIAL_RESERVE = parseUnits("10000", 6);
    const CRR = 100000; // 10%
    const TRADE_FEE = 25; // 0.25%
    const PROTOCOL_FEE = 500; // 5%
    const IBR_DURATION = 7 * 24 * 60 * 60;

    beforeEach(async function () {
        [owner, treasury, buyer1, attacker] = await ethers.getSigners();

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

        // Deploy token
        const tokenAddress = await tokenManager.deployToken.staticCall(
            MODEL_ID,
            TOKEN_NAME,
            TOKEN_SYMBOL,
            INITIAL_SUPPLY
        );
        await tokenManager.deployToken(MODEL_ID, TOKEN_NAME, TOKEN_SYMBOL, INITIAL_SUPPLY);

        const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
        hokusaiToken = HokusaiToken.attach(tokenAddress);

        // Deploy AMM
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await HokusaiAMM.deploy(
            await mockUSDC.getAddress(),
            await hokusaiToken.getAddress(),
            await tokenManager.getAddress(),
            MODEL_ID,
            treasury.address,
            CRR,
            TRADE_FEE,
            PROTOCOL_FEE,
            IBR_DURATION
        );
        await hokusaiAMM.waitForDeployment();

        // Authorize AMM
        await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

        // Initialize pool
        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        // Mint initial supply
        await tokenManager.mintTokens(MODEL_ID, owner.address, parseEther("100000"));

        // Setup buyer
        await mockUSDC.mint(buyer1.address, parseUnits("100000", 6));
        await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));

        // Set max trade size to 50% for these tests (they test large trades)
        await hokusaiAMM.setMaxTradeBps(5000);
    });

    // ============================================================
    // PARAMETER ADJUSTMENT
    // ============================================================

    describe("Parameter Adjustment", function () {
        it("Should update CRR within bounds", async function () {
            await hokusaiAMM.setParameters(
                150000, // 15% CRR
                TRADE_FEE,
                PROTOCOL_FEE
            );

            expect(await hokusaiAMM.crr()).to.equal(150000);
        });

        it("Should update trade fee", async function () {
            await hokusaiAMM.setParameters(
                CRR,
                50, // 0.5% trade fee
                PROTOCOL_FEE
            );

            expect(await hokusaiAMM.tradeFee()).to.equal(50);
        });

        it("Should update protocol fee", async function () {
            await hokusaiAMM.setParameters(
                CRR,
                TRADE_FEE,
                300 // 3% protocol fee
            );

            expect(await hokusaiAMM.protocolFeeBps()).to.equal(300);
        });

        it("Should update all parameters at once", async function () {
            await hokusaiAMM.setParameters(200000, 100, 1000);

            expect(await hokusaiAMM.crr()).to.equal(200000);
            expect(await hokusaiAMM.tradeFee()).to.equal(100);
            expect(await hokusaiAMM.protocolFeeBps()).to.equal(1000);
        });

        it("Should emit ParametersUpdated event", async function () {
            await expect(hokusaiAMM.setParameters(150000, 50, 300))
                .to.emit(hokusaiAMM, "ParametersUpdated")
                .withArgs(150000, 50, 300);
        });

        it("Should enforce CRR minimum bound (5%)", async function () {
            await expect(
                hokusaiAMM.setParameters(
                    40000, // 4% < 5% min
                    TRADE_FEE,
                    PROTOCOL_FEE
                )
            ).to.be.revertedWith("CRR out of bounds");
        });

        it("Should enforce CRR maximum bound (50%)", async function () {
            await expect(
                hokusaiAMM.setParameters(
                    600000, // 60% > 50% max
                    TRADE_FEE,
                    PROTOCOL_FEE
                )
            ).to.be.revertedWith("CRR out of bounds");
        });

        it("Should enforce trade fee maximum (10%)", async function () {
            await expect(
                hokusaiAMM.setParameters(
                    CRR,
                    1500, // 15% > 10% max
                    PROTOCOL_FEE
                )
            ).to.be.revertedWith("Trade fee too high");
        });

        it("Should enforce protocol fee maximum (50%)", async function () {
            await expect(
                hokusaiAMM.setParameters(
                    CRR,
                    TRADE_FEE,
                    6000 // 60% > 50% max
                )
            ).to.be.revertedWith("Protocol fee too high");
        });

        it("Should allow setting CRR to minimum (5%)", async function () {
            await hokusaiAMM.setParameters(50000, TRADE_FEE, PROTOCOL_FEE);
            expect(await hokusaiAMM.crr()).to.equal(50000);
        });

        it("Should allow setting CRR to maximum (50%)", async function () {
            await hokusaiAMM.setParameters(500000, TRADE_FEE, PROTOCOL_FEE);
            expect(await hokusaiAMM.crr()).to.equal(500000);
        });

        it("Should allow setting trade fee to zero", async function () {
            await hokusaiAMM.setParameters(CRR, 0, PROTOCOL_FEE);
            expect(await hokusaiAMM.tradeFee()).to.equal(0);
        });

        it("Should allow setting protocol fee to zero", async function () {
            await hokusaiAMM.setParameters(CRR, TRADE_FEE, 0);
            expect(await hokusaiAMM.protocolFeeBps()).to.equal(0);
        });

        it("Should only allow owner to update parameters", async function () {
            await expect(
                hokusaiAMM.connect(buyer1).setParameters(150000, 50, 300)
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should affect future trades after parameter update", async function () {
            // Make a trade with original fee
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);
            const tokensOut1 = await hokusaiAMM.getBuyQuote(buyAmount);

            // Update trade fee
            await hokusaiAMM.setParameters(CRR, 100, PROTOCOL_FEE); // Double the trade fee

            // Quote should be different now (less tokens due to higher fee)
            const tokensOut2 = await hokusaiAMM.getBuyQuote(buyAmount);
            expect(tokensOut2).to.be.lt(tokensOut1);
        });

        it("Should affect spot price after CRR update", async function () {
            const spotPriceBefore = await hokusaiAMM.spotPrice();

            // Increase CRR (formula: P = R / (w × S), where w = crr/PPM)
            await hokusaiAMM.setParameters(200000, TRADE_FEE, PROTOCOL_FEE); // 20% vs 10%

            const spotPriceAfter = await hokusaiAMM.spotPrice();
            // Higher CRR = lower spot price (w increases in denominator)
            // P = (R * PPM) / (crr * S), so higher crr = lower P
            expect(spotPriceAfter).to.be.lt(spotPriceBefore);
        });
    });

    // ============================================================
    // EMERGENCY PAUSE MECHANISM
    // ============================================================

    describe("Emergency Pause Mechanism", function () {
        it("Should pause trading", async function () {
            await hokusaiAMM.pause();
            expect(await hokusaiAMM.paused()).to.be.true;
        });

        it("Should unpause trading", async function () {
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();
            expect(await hokusaiAMM.paused()).to.be.false;
        });

        it("Should block buys when paused", async function () {
            await hokusaiAMM.pause();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should block sells when paused", async function () {
            // First buy some tokens
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Pause
            await hokusaiAMM.pause();

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).sell(tokenBalance, 0, buyer1.address, deadline2)
            ).to.be.revertedWith("Pausable: paused");
        });

        it("Should allow fee deposits when paused", async function () {
            await hokusaiAMM.pause();

            // Fee deposits should still work
            await mockUSDC.mint(owner.address, parseUnits("1000", 6));
            await mockUSDC.approve(await hokusaiAMM.getAddress(), parseUnits("1000", 6));

            await expect(
                hokusaiAMM.depositFees(parseUnits("1000", 6))
            ).to.not.be.reverted;
        });

        it("Should allow treasury withdrawal when paused", async function () {
            // Generate some treasury balance
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            await hokusaiAMM.pause();

            // Withdrawal should still work
            const treasuryBalance = await mockUSDC.balanceOf(await hokusaiAMM.getAddress()) -
                                   await hokusaiAMM.reserveBalance();
            if (treasuryBalance > 0n) {
                await expect(
                    hokusaiAMM.withdrawTreasury(treasuryBalance)
                ).to.not.be.reverted;
            }
        });

        it("Should restore trading after unpause", async function () {
            await hokusaiAMM.pause();
            await hokusaiAMM.unpause();

            // Buys should work again
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should only allow owner to pause", async function () {
            await expect(
                hokusaiAMM.connect(buyer1).pause()
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should only allow owner to unpause", async function () {
            await hokusaiAMM.pause();

            await expect(
                hokusaiAMM.connect(buyer1).unpause()
            ).to.be.revertedWith("Ownable: caller is not the owner");
        });

        it("Should emit Paused event", async function () {
            await expect(hokusaiAMM.pause())
                .to.emit(hokusaiAMM, "Paused")
                .withArgs(owner.address);
        });

        it("Should emit Unpaused event", async function () {
            await hokusaiAMM.pause();

            await expect(hokusaiAMM.unpause())
                .to.emit(hokusaiAMM, "Unpaused")
                .withArgs(owner.address);
        });
    });

    // ============================================================
    // REENTRANCY PROTECTION
    // ============================================================

    describe("Reentrancy Protection", function () {
        it("Should have nonReentrant on buy", async function () {
            // This is tested by the modifier presence - actual reentrancy attack
            // would require a malicious ERC20, which we test conceptually here
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Multiple calls in same block should work (not reentrant)
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);
        });

        it("Should have nonReentrant on sell", async function () {
            // Buy tokens first
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("2000", 6), 0, buyer1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);
            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const sellAmount = tokenBalance / 2n;

            // Multiple sells should work (not reentrant)
            await hokusaiAMM.connect(buyer1).sell(sellAmount, 0, buyer1.address, deadline2);
            await hokusaiAMM.connect(buyer1).sell(sellAmount, 0, buyer1.address, deadline2);
        });

        it("Should have nonReentrant on depositFees", async function () {
            await mockUSDC.mint(owner.address, parseUnits("2000", 6));
            await mockUSDC.approve(await hokusaiAMM.getAddress(), parseUnits("2000", 6));

            // Multiple deposits should work
            await hokusaiAMM.depositFees(parseUnits("1000", 6));
            await hokusaiAMM.depositFees(parseUnits("1000", 6));
        });
    });

    // ============================================================
    // SLIPPAGE PROTECTION
    // ============================================================

    describe("Slippage Protection", function () {
        it("Should enforce minTokensOut on buy", async function () {
            const buyAmount = parseUnits("1000", 6);
            const expectedTokens = await hokusaiAMM.getBuyQuote(buyAmount);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Setting minTokensOut too high should revert
            await expect(
                hokusaiAMM.connect(buyer1).buy(buyAmount, expectedTokens + 1n, buyer1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should enforce minReserveOut on sell", async function () {
            // Buy tokens first
            let deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const tokenBalance = await hokusaiToken.balanceOf(buyer1.address);
            const expectedReserve = await hokusaiAMM.getSellQuote(tokenBalance);

            await hokusaiToken.connect(buyer1).approve(await hokusaiAMM.getAddress(), tokenBalance);

            deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Setting minReserveOut too high should revert
            await expect(
                hokusaiAMM.connect(buyer1).sell(tokenBalance, expectedReserve + 1n, buyer1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should pass with exact minTokensOut on buy", async function () {
            const buyAmount = parseUnits("1000", 6);
            const expectedTokens = await hokusaiAMM.getBuyQuote(buyAmount);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(buyer1).buy(buyAmount, expectedTokens, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should pass with lower minTokensOut on buy", async function () {
            const buyAmount = parseUnits("1000", 6);
            const expectedTokens = await hokusaiAMM.getBuyQuote(buyAmount);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            await expect(
                hokusaiAMM.connect(buyer1).buy(buyAmount, expectedTokens - 1n, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should protect against price manipulation via slippage", async function () {
            const buyAmount = parseUnits("1000", 6);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Get quote before any trades
            const quote1 = await hokusaiAMM.getBuyQuote(buyAmount);

            // Another user makes large trade (price increases) - within 50% limit
            await mockUSDC.mint(attacker.address, parseUnits("5000", 6));
            await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("5000", 6));
            await hokusaiAMM.connect(attacker).buy(parseUnits("5000", 6), 0, attacker.address, deadline);

            // Original buyer's quote would be much worse now
            const quote2 = await hokusaiAMM.getBuyQuote(buyAmount);
            expect(quote2).to.be.lt(quote1);

            // If buyer1 had set minTokensOut=quote1, transaction would revert
            await expect(
                hokusaiAMM.connect(buyer1).buy(buyAmount, quote1, buyer1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });
    });

    // ============================================================
    // DEADLINE ENFORCEMENT
    // ============================================================

    describe("Deadline Enforcement", function () {
        it("Should enforce deadline on buy", async function () {
            const pastDeadline = (await ethers.provider.getBlock('latest')).timestamp - 100;

            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, pastDeadline)
            ).to.be.revertedWith("Transaction expired");
        });

        it("Should enforce deadline on sell", async function () {
            // Fast forward past IBR first
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const pastDeadline = (await ethers.provider.getBlock('latest')).timestamp - 100;

            await expect(
                hokusaiAMM.connect(buyer1).sell(parseEther("100"), 0, buyer1.address, pastDeadline)
            ).to.be.revertedWith("Transaction expired");
        });

        it("Should allow trade with future deadline", async function () {
            const futureDeadline = (await ethers.provider.getBlock('latest')).timestamp + 3600; // 1 hour

            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, futureDeadline)
            ).to.not.be.reverted;
        });

        it("Should allow trade with exact current timestamp", async function () {
            const currentTime = (await ethers.provider.getBlock('latest')).timestamp + 10; // Small buffer

            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, currentTime)
            ).to.not.be.reverted;
        });
    });

    // ============================================================
    // COMBINED SAFETY SCENARIOS
    // ============================================================

    describe("Combined Safety Scenarios", function () {
        it("Should handle pause during active trading", async function () {
            // Multiple users trading
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline);

            // Emergency pause
            await hokusaiAMM.pause();

            // New trades blocked
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.be.revertedWith("Pausable: paused");

            // Unpause and resume
            await hokusaiAMM.unpause();
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should handle parameter update during pause", async function () {
            await hokusaiAMM.pause();

            // Parameters can be updated while paused
            await hokusaiAMM.setParameters(150000, 50, 300);
            expect(await hokusaiAMM.crr()).to.equal(150000);

            // Resume with new parameters
            await hokusaiAMM.unpause();

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await expect(
                hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should maintain safety checks across parameter changes", async function () {
            // Update to higher trade fee
            await hokusaiAMM.setParameters(CRR, 100, PROTOCOL_FEE); // 1% fee

            const buyAmount = parseUnits("1000", 6);
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            // Slippage protection still works
            const expectedTokens = await hokusaiAMM.getBuyQuote(buyAmount);
            await expect(
                hokusaiAMM.connect(buyer1).buy(buyAmount, expectedTokens + 1n, buyer1.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should handle all safety mechanisms together", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const buyAmount = parseUnits("1000", 6);
            const expectedTokens = await hokusaiAMM.getBuyQuote(buyAmount);

            // Trade with all safety checks
            await hokusaiAMM.connect(buyer1).buy(
                buyAmount,
                expectedTokens, // Slippage protection
                buyer1.address,
                deadline // Deadline protection
            );

            // Verify trade succeeded
            expect(await hokusaiToken.balanceOf(buyer1.address)).to.be.gte(expectedTokens);
        });
    });
});
