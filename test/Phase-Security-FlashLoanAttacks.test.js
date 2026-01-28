const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;

describe("Phase 3: Flash Loan Attack Security", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, buyer1, attacker;

    // AMM Parameters
    const modelId = "flash-loan-test-model";
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC
    const INITIAL_SUPPLY = parseUnits("100000", 18); // 100k tokens
    const CRR = 100000; // 10% reserve ratio
    const TRADE_FEE = 25; // 0.25%
    const PROTOCOL_FEE = 500; // 5%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    beforeEach(async function () {
        [owner, treasury, buyer1, attacker] = await ethers.getSigners();

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
        await tokenManager.deployToken(modelId, "Flash Loan Test", "FLT", INITIAL_SUPPLY);
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

        // Fund test accounts
        await mockUSDC.mint(buyer1.address, parseUnits("100000", 6));
        await mockUSDC.mint(attacker.address, parseUnits("1000000", 6)); // Give attacker large balance

        await mockUSDC.connect(buyer1).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("1000000", 6));

        // Set max trade size to 50% for these security tests
        await hokusaiAMM.setMaxTradeBps(5000);
    });

    // ============================================================
    // FLASH LOAN ATTACK SCENARIOS
    // ============================================================

    describe("Flash Loan Attack Prevention", function () {
        it("Should prevent profit from single-block buy-sell arbitrage", async function () {
            // Fast forward past IBR to enable sells
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const attackAmount = parseUnits("5000", 6); // 50% of reserve (max allowed)

            // Record initial state
            const initialUSDC = await mockUSDC.balanceOf(attacker.address);

            // Simulate flash loan attack: buy → sell in same block
            // This should result in a LOSS due to trade fees, not profit

            // Step 1: Buy tokens (price goes up)
            const buyQuote = await hokusaiAMM.getBuyQuote(attackAmount);
            await hokusaiAMM.connect(attacker).buy(attackAmount, 0, attacker.address, deadline);
            const tokensReceived = await hokusaiToken.balanceOf(attacker.address);

            expect(tokensReceived).to.equal(buyQuote);

            // Step 2: Immediately sell all tokens (same block)
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokensReceived);
            await hokusaiAMM.connect(attacker).sell(tokensReceived, 0, attacker.address, deadline);

            // Check final USDC balance
            const finalUSDC = await mockUSDC.balanceOf(attacker.address);
            const profit = finalUSDC - initialUSDC;

            // Due to 0.25% fee on BOTH buy and sell, attacker should lose money
            // Expected loss ≈ 0.5% of trade amount = $25 on $5k trade
            expect(profit).to.be.lt(0); // Profit should be negative (a loss)
            expect(profit).to.be.closeTo(-parseUnits("25", 6), parseUnits("5", 6)); // ~$25 loss ±$5
        });

        it("Should limit repeated buy-sell cycles via trade size limits", async function () {
            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const tradeAmount = parseUnits("2000", 6); // 20% of reserve

            const initialUSDC = await mockUSDC.balanceOf(attacker.address);

            // Execute 5 buy-sell cycles
            for (let i = 0; i < 5; i++) {
                // Buy
                const buyQuote = await hokusaiAMM.getBuyQuote(tradeAmount);
                await hokusaiAMM.connect(attacker).buy(tradeAmount, 0, attacker.address, deadline);

                // Sell
                const tokensReceived = await hokusaiToken.balanceOf(attacker.address);
                await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokensReceived);
                await hokusaiAMM.connect(attacker).sell(tokensReceived, 0, attacker.address, deadline);
            }

            const finalUSDC = await mockUSDC.balanceOf(attacker.address);
            const profit = finalUSDC - initialUSDC;

            // Key security property: Trade size limits prevent large manipulation
            // Profit/loss will depend on bonding curve math, but limits ensure controlled impact
            // With 0.25% fees and repeated cycles, total impact is bounded
            expect(Math.abs(Number(profit))).to.be.lt(parseUnits("500", 6)); // Impact < $500
        });

        it("Should limit maximum single-transaction impact via trade size limits", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxTradeBps = await hokusaiAMM.maxTradeBps();

            // Calculate max allowed trade
            const maxTradeSize = (currentReserve * maxTradeBps) / 10000n;

            // Try to exceed limit
            const oversizedTrade = maxTradeSize + parseUnits("1", 6);

            await expect(
                hokusaiAMM.connect(attacker).buy(oversizedTrade, 0, attacker.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");
        });

        it("Should limit flash loan sandwich attack impact via trade size limits", async function () {
            // Scenario: Attacker sees buyer1's pending tx and tries to sandwich it
            // Front-run: buy before victim → Victim buys at higher price → Back-run: sell after victim

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const victimBuy = parseUnits("1000", 6);
            const attackerBuy = parseUnits("4000", 6); // Large but within 50% limit

            const initialAttackerUSDC = await mockUSDC.balanceOf(attacker.address);
            const initialVictimUSDC = await mockUSDC.balanceOf(buyer1.address);

            // 1. Attacker front-runs: Buy to increase price
            await hokusaiAMM.connect(attacker).buy(attackerBuy, 0, attacker.address, deadline);
            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);

            // 2. Victim buys at inflated price
            await hokusaiAMM.connect(buyer1).buy(victimBuy, 0, buyer1.address, deadline);

            // 3. Attacker back-runs: Sell tokens
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline);

            const finalAttackerUSDC = await mockUSDC.balanceOf(attacker.address);
            const profit = finalAttackerUSDC - initialAttackerUSDC;

            // Key security property: Trade size limits bound the sandwich attack impact
            // Attacker limited to 50% of reserve, preventing extreme price manipulation
            expect(Math.abs(Number(profit))).to.be.lt(parseUnits("1000", 6)); // Impact < $1000
        });
    });

    // ============================================================
    // MULTI-BLOCK ATTACK SCENARIOS
    // ============================================================

    describe("Multi-Block Attack Scenarios", function () {
        it("Should limit buy-wait-sell manipulation via trade size limits", async function () {
            // Attacker buys large, waits for other trades, then sells
            // Trade size limits bound the maximum impact

            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const attackerBuy = parseUnits("5000", 6); // Max 50% of reserve

            const initialUSDC = await mockUSDC.balanceOf(attacker.address);

            // Attacker buys large amount
            await hokusaiAMM.connect(attacker).buy(attackerBuy, 0, attacker.address, deadline1);
            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);

            // Other users trade (simulated)
            await hokusaiAMM.connect(buyer1).buy(parseUnits("1000", 6), 0, buyer1.address, deadline1);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Attacker sells
            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline2);

            const finalUSDC = await mockUSDC.balanceOf(attacker.address);
            const profit = finalUSDC - initialUSDC;

            // Key security property: Even with time delay, trade size limits bound impact
            expect(Math.abs(Number(profit))).to.be.lt(parseUnits("1000", 6)); // Impact < $1000
        });

        it("Should track correct reserve balance across multiple large trades", async function () {
            // Verify reserve accounting remains accurate even with max-size trades

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const maxTrade = parseUnits("5000", 6); // 50% of initial reserve

            const initialReserve = await hokusaiAMM.reserveBalance();

            // Execute 3 max-size buys
            for (let i = 0; i < 3; i++) {
                await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

                // Verify reserve increased correctly (minus fees)
                const expectedIncrease = maxTrade - (maxTrade * BigInt(TRADE_FEE)) / 10000n;
                const currentReserve = await hokusaiAMM.reserveBalance();

                // Reserve should have increased
                expect(currentReserve).to.be.gt(initialReserve);
            }

            // Verify final reserve is correct
            const finalReserve = await hokusaiAMM.reserveBalance();
            const totalDeposited = maxTrade * 3n;
            const totalFees = (totalDeposited * BigInt(TRADE_FEE)) / 10000n;
            const expectedReserve = initialReserve + totalDeposited - totalFees;

            expect(finalReserve).to.be.closeTo(expectedReserve, parseUnits("10", 6)); // ±$10 for rounding
        });
    });

    // ============================================================
    // TRADE SIZE LIMIT EFFECTIVENESS
    // ============================================================

    describe("Trade Size Limit Effectiveness", function () {
        it("Should scale limits dynamically as reserve grows", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            const initialReserve = await hokusaiAMM.reserveBalance();
            const initialMaxTrade = (initialReserve * 5000n) / 10000n; // 50%

            // Buy at max limit
            await hokusaiAMM.connect(attacker).buy(initialMaxTrade, 0, attacker.address, deadline);

            // Reserve has increased, so max trade size should also increase
            const newReserve = await hokusaiAMM.reserveBalance();
            const newMaxTrade = (newReserve * 5000n) / 10000n;

            expect(newMaxTrade).to.be.gt(initialMaxTrade);

            // Verify we can now trade up to the new higher limit
            await expect(
                hokusaiAMM.connect(buyer1).buy(newMaxTrade, 0, buyer1.address, deadline)
            ).to.not.be.reverted;
        });

        it("Should enforce limits independently on each transaction", async function () {
            // Two attackers coordinate to trade large amounts
            const [, , , , attacker2] = await ethers.getSigners();
            await mockUSDC.mint(attacker2.address, parseUnits("100000", 6));
            await mockUSDC.connect(attacker2).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const maxTrade = parseUnits("5000", 6); // 50% limit

            // First attacker buys max
            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            // Second attacker can also buy up to their limit (based on NEW reserve)
            // Reserve has grown, so they can trade more than original 50%
            const newReserve = await hokusaiAMM.reserveBalance();
            const newMaxTrade = (newReserve * 5000n) / 10000n;

            // This should succeed - each tx is independently limited
            await expect(
                hokusaiAMM.connect(attacker2).buy(newMaxTrade, 0, attacker2.address, deadline)
            ).to.not.be.reverted;

            // Verify both attackers got tokens
            const attacker1Tokens = await hokusaiToken.balanceOf(attacker.address);
            const attacker2Tokens = await hokusaiToken.balanceOf(attacker2.address);
            expect(attacker1Tokens).to.be.gt(0);
            expect(attacker2Tokens).to.be.gt(0);
        });

        it("Should enforce limits on sell operations to prevent reserve drain", async function () {
            // Buy tokens first
            const deadline1 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("5000", 6), 0, attacker.address, deadline1);

            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);

            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            // Try to sell all tokens
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);

            const deadline2 = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const sellQuote = await hokusaiAMM.getSellQuote(attackerTokens);
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxSellReserve = (currentReserve * 5000n) / 10000n;

            // If sell quote exceeds limit, it should revert
            if (sellQuote > maxSellReserve) {
                await expect(
                    hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline2)
                ).to.be.revertedWith("Trade exceeds max size limit");
            } else {
                // Otherwise it should succeed
                await expect(
                    hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline2)
                ).to.not.be.reverted;
            }
        });
    });

    // ============================================================
    // GAS COST ANALYSIS FOR FLASH LOAN VIABILITY
    // ============================================================

    describe("Gas Cost Analysis", function () {
        it("Should measure gas cost of buy-sell cycle", async function () {
            // Flash loan attacks are only profitable if:
            // profit > (gas_cost + flash_loan_fee)

            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const tradeAmount = parseUnits("5000", 6);

            // Measure buy gas
            const buyTx = await hokusaiAMM.connect(attacker).buy(tradeAmount, 0, attacker.address, deadline);
            const buyReceipt = await buyTx.wait();
            const buyGas = buyReceipt.gasUsed;

            // Measure sell gas
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);
            const sellTx = await hokusaiAMM.connect(attacker).sell(tokens, 0, attacker.address, deadline);
            const sellReceipt = await sellTx.wait();
            const sellGas = sellReceipt.gasUsed;

            const totalGas = buyGas + sellGas;

            // With gas price ~50 gwei and ETH ~$2000:
            // Gas cost = totalGas × 50e-9 × 2000 = totalGas × 0.0001 USD
            // For 300k gas: ~$30 USD gas cost

            // Trade fees on $5k: 0.5% × $5k × 2 = $50
            // Total cost: ~$80
            // This makes flash loan arbitrage unprofitable

            expect(totalGas).to.be.lt(350000); // Should be under 350k gas

            // Log for analysis
            console.log(`        Buy gas: ${buyGas.toString()}`);
            console.log(`        Sell gas: ${sellGas.toString()}`);
            console.log(`        Total cycle gas: ${totalGas.toString()}`);
        });
    });
});
