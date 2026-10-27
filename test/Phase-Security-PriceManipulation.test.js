const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseUnits } = ethers;
const { deployTestToken } = require("./helpers/tokenDeployment");
const { deployAMMProxy, bindPool } = require("./helpers/ammDeployment");
const { curveModel, poolCurveState, near } = require("./helpers/curveModel");

describe("Phase 6: Price Manipulation Attack Security", function () {
    let hokusaiAMM, hokusaiToken, mockUSDC, tokenManager, modelRegistry;
    let owner, treasury, victim, attacker;

    // AMM Parameters
    const modelId = "1204";
    const INITIAL_RESERVE = parseUnits("10000", 6); // $10k USDC
    const INITIAL_SUPPLY = parseUnits("100000", 18); // 100k tokens
    const CRR = 100000; // 10% reserve ratio
    const TRADE_FEE = 30; // 0.30%
    const IBR_DURATION = 7 * 24 * 60 * 60; // 7 days
    const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $25k threshold
    const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token

    beforeEach(async function () {
        [owner, treasury, victim, attacker] = await ethers.getSigners();

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
        await deployTestToken(tokenManager, modelId, "Price Manipulation Test", "PMT", INITIAL_SUPPLY, owner.address);
        const tokenAddress = await tokenManager.getTokenAddress(modelId);
        hokusaiToken = await ethers.getContractAt("HokusaiToken", tokenAddress);

        // Deploy AMM
        const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
        hokusaiAMM = await deployAMMProxy(HokusaiAMM,
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
        await bindPool(tokenManager, await hokusaiAMM.getAddress());

        // Fund initial reserve
        await mockUSDC.mint(owner.address, INITIAL_RESERVE);
        await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
        await hokusaiAMM.depositFees(INITIAL_RESERVE);

        // Fund users
        await mockUSDC.mint(victim.address, parseUnits("100000", 6));
        await mockUSDC.mint(attacker.address, parseUnits("1000000", 6)); // Give attacker more funds

        await mockUSDC.connect(victim).approve(await hokusaiAMM.getAddress(), parseUnits("100000", 6));
        await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("1000000", 6));

        // Set max trade size to 50% for attack scenarios
        await hokusaiAMM.setMaxTradeBps(5000);
    });

    // ============================================================
    // PRICE PUMP & DUMP ATTACKS
    // ============================================================

    describe("Price Pump & Dump Prevention", function () {
        it("Should limit price impact via trade size restrictions", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

            const initialPrice = await hokusaiAMM.spotPrice();
            const initialReserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (initialReserve * 5000n) / 10000n; // 50% max

            // Attacker tries to pump price with max trade
            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            const priceAfterPump = await hokusaiAMM.spotPrice();

            // The fixture is graduated by depositFees at its current supply, so
            // it sits at the curve anchor (HOK-3317): the curve reserve is only
            // w × reserve ($1k at CRR 10%), and the price moves exactly as
            // (1 + net / (w × R))^(1 - w). With the $5k floor this trade is 5x
            // the curve reserve, so the price rises about 5x. Trade size limits
            // bound the dollars per trade, not the multiple near graduation.
            const model = curveModel(CRR);
            const net = Number(maxTrade - (maxTrade * BigInt(TRADE_FEE)) / 10000n);
            const expected = Number(initialPrice) * Math.pow(1 + net / (model.w * Number(initialReserve)), 1 - model.w);
            expect(priceAfterPump).to.be.closeTo(...near(expected, 1e-6));
            expect(priceAfterPump).to.be.lt(initialPrice * 6n);
        });

        it("Should prevent attacker from profiting via pump and dump", async function () {
            // Fast forward past IBR to enable sells
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const initialBalance = await mockUSDC.balanceOf(attacker.address);

            // Pump: Buy large amount
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (currentReserve * 5000n) / 10000n;
            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            // Dump: Sell immediately
            const tokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokens);
            await hokusaiAMM.connect(attacker).sell(tokens, 0, attacker.address, deadline);

            const finalBalance = await mockUSDC.balanceOf(attacker.address);

            // Attacker should lose money due to fees (0.25% on both buy and sell)
            expect(finalBalance).to.be.lt(initialBalance);
        });

        it("Should protect victims from inflated prices via slippage", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const victimBuy = parseUnits("1000", 6);

            // Get quote for victim's trade at current price
            const expectedTokens = await hokusaiAMM.getBuyQuote(victimBuy);

            // Attacker front-runs with large buy to pump price
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (currentReserve * 5000n) / 10000n;
            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            // Victim's transaction with slippage protection should revert
            await expect(
                hokusaiAMM.connect(victim).buy(victimBuy, expectedTokens, victim.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should limit cumulative price impact from multiple trades", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const initialPrice = await hokusaiAMM.spotPrice();

            // Attacker makes 5 maximum-size buys
            for (let i = 0; i < 5; i++) {
                const currentReserve = await hokusaiAMM.reserveBalance();
                const maxTrade = (currentReserve * 5000n) / 10000n;
                await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);
            }

            // Path independence: five max trades land exactly where one buy of
            // the same total would, (1 + X / (w × R0))^(1 - w) from the anchor.
            const model = curveModel(CRR);
            const finalPrice = await hokusaiAMM.spotPrice();
            const totalNet = Number((await hokusaiAMM.reserveBalance()) - INITIAL_RESERVE);
            const expected = Number(initialPrice) *
                Math.pow(1 + totalNet / (model.w * Number(INITIAL_RESERVE)), 1 - model.w);
            expect(finalPrice).to.be.closeTo(...near(expected, 1e-6));
        });
    });

    // ============================================================
    // SANDWICH ATTACKS
    // ============================================================

    describe("Sandwich Attack Prevention", function () {
        it("Should bound sandwich attack profitability via trade size limits", async function () {
            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const initialAttackerBalance = await mockUSDC.balanceOf(attacker.address);

            // Front-run: Attacker buys before victim
            const attackerBuy = parseUnits("4000", 6);
            await hokusaiAMM.connect(attacker).buy(attackerBuy, 0, attacker.address, deadline);

            // Victim's trade
            const victimBuy = parseUnits("1000", 6);
            await hokusaiAMM.connect(victim).buy(victimBuy, 0, victim.address, deadline);

            // Back-run: Attacker sells after victim
            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline);

            const finalAttackerBalance = await mockUSDC.balanceOf(attacker.address);
            const profit = finalAttackerBalance - initialAttackerBalance;

            // Key security property: trade size limits bound max extractable value
            // Profit is limited by max trade size (50% of reserve)
            expect(Math.abs(Number(profit))).to.be.lt(parseUnits("1000", 6)); // < $1000
        });

        it("Should protect victim from excessive slippage in sandwich", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const victimBuy = parseUnits("1000", 6);

            // Victim gets quote
            const quote = await hokusaiAMM.getBuyQuote(victimBuy);

            // Attacker front-runs
            await hokusaiAMM.connect(attacker).buy(parseUnits("4000", 6), 0, attacker.address, deadline);

            // Victim's trade with 5% slippage tolerance should revert
            const minTokens = (quote * 95n) / 100n; // 5% slippage
            await expect(
                hokusaiAMM.connect(victim).buy(victimBuy, minTokens, victim.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should bound victim's loss in sandwich attack", async function () {
            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const victimBuy = parseUnits("1000", 6);

            const initialVictimUSDC = await mockUSDC.balanceOf(victim.address);
            const initialAttackerUSDC = await mockUSDC.balanceOf(attacker.address);
            const initialTreasuryUSDC = await mockUSDC.balanceOf(treasury.address);
            const initialReserve = await hokusaiAMM.reserveBalance();

            // Attacker front-runs
            await hokusaiAMM.connect(attacker).buy(parseUnits("3000", 6), 0, attacker.address, deadline);

            // Victim buys at inflated price (with wide slippage tolerance)
            await hokusaiAMM.connect(victim).buy(victimBuy, 0, victim.address, deadline);
            const victimTokens = await hokusaiToken.balanceOf(victim.address);

            // Attacker back-runs
            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline);

            // Victim sells at lower price
            await hokusaiToken.connect(victim).approve(await hokusaiAMM.getAddress(), victimTokens);
            await hokusaiAMM.connect(victim).sell(victimTokens, 0, victim.address, deadline);

            const finalVictimUSDC = await mockUSDC.balanceOf(victim.address);
            const victimLoss = initialVictimUSDC - finalVictimUSDC;
            const attackerGain = (await mockUSDC.balanceOf(attacker.address)) - initialAttackerUSDC;
            expect(attackerGain).to.be.gt(0n);
            const fees = (await mockUSDC.balanceOf(treasury.address)) - initialTreasuryUSDC;

            // Near the curve anchor (HOK-3317) a $1k victim buy behind a $3k
            // front-run on a $1k curve reserve loses most of its value without
            // slippage protection (see the slippage tests above). What must
            // hold: the pool takes nothing, the victim never loses more than
            // they paid, and the attacker gains exactly the victim's loss net
            // of trade fees.
            expect(victimLoss).to.be.lt(victimBuy);
            expect(await hokusaiAMM.reserveBalance()).to.be.closeTo(initialReserve, 2n);
            expect(victimLoss).to.be.closeTo(attackerGain + fees, 2n);
        });
    });

    // ============================================================
    // ORACLE MANIPULATION
    // ============================================================

    describe("Price Oracle Manipulation Prevention", function () {
        it("Should make spot price manipulation expensive", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            const initialPrice = await hokusaiAMM.spotPrice();
            const initialBalance = await mockUSDC.balanceOf(attacker.address);

            // Try to double the price
            let currentPrice = initialPrice;
            let costToDouble = 0n;

            while (currentPrice < initialPrice * 2n) {
                const currentReserve = await hokusaiAMM.reserveBalance();
                const maxTrade = (currentReserve * 5000n) / 10000n;

                await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

                costToDouble += maxTrade;
                currentPrice = await hokusaiAMM.spotPrice();

                // Safety: break if we've spent too much
                if (costToDouble > parseUnits("100000", 6)) break;
            }

            // At the curve anchor (HOK-3317) doubling the price takes
            // w × R × (2^(1/(1-w)) - 1) of net reserve, about $1.16k at CRR 10%
            // on $10k, not the whole reserve; max trades overshoot it, so the
            // spend is at least that.
            const model = curveModel(CRR);
            const minNet = model.w * Number(INITIAL_RESERVE) * (Math.pow(2, 1 / (1 - model.w)) - 1);
            expect(Number(costToDouble)).to.be.gte(minNet);
        });

        it("Should reflect price changes from depositFees operations", async function () {
            const priceBefore = await hokusaiAMM.spotPrice();
            const supplyBefore = await hokusaiToken.totalSupply();

            // Large deposit to reserve (increases reserve without changing supply)
            const depositAmount = parseUnits("50000", 6);
            await mockUSDC.mint(owner.address, depositAmount);
            await mockUSDC.approve(await hokusaiAMM.getAddress(), depositAmount);
            await hokusaiAMM.depositFees(depositAmount);

            const priceAfter = await hokusaiAMM.spotPrice();
            const supplyAfter = await hokusaiToken.totalSupply();

            // Supply unchanged
            expect(supplyAfter).to.equal(supplyBefore);

            // With bonding curve: price = (reserve/supply)^(1/CRR)
            // More reserve with same supply → higher price
            // This is expected behavior, not a vulnerability
            expect(priceAfter).to.be.gt(priceBefore);

            // Price increase is bounded by reserve increase ratio
            const reserveRatio = (INITIAL_RESERVE + depositAmount) * 10000n / INITIAL_RESERVE;
            const priceRatio = priceAfter * 10000n / priceBefore;

            // With CRR=10%, price increases less than or equal to reserve (price ∝ reserve^(1/CRR))
            // In practice price increase should be much less, but we verify it doesn't exceed
            expect(priceRatio).to.be.lte(reserveRatio);
        });

        it("Should maintain price integrity across multiple blocks", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

            // Record prices across multiple trades in different blocks
            const prices = [];
            prices.push(await hokusaiAMM.spotPrice());

            for (let i = 0; i < 5; i++) {
                await hokusaiAMM.connect(attacker).buy(parseUnits("500", 6), 0, attacker.address, deadline);
                await ethers.provider.send("evm_mine");
                prices.push(await hokusaiAMM.spotPrice());
            }

            // Prices should increase monotonically (no manipulation possible)
            for (let i = 1; i < prices.length; i++) {
                expect(prices[i]).to.be.gte(prices[i - 1]);
            }
        });
    });

    // ============================================================
    // QUOTE MANIPULATION
    // ============================================================

    describe("Quote Manipulation Prevention", function () {
        it("Should provide consistent buy quotes for same input", async function () {
            const buyAmount = parseUnits("1000", 6);

            const quote1 = await hokusaiAMM.getBuyQuote(buyAmount);
            const quote2 = await hokusaiAMM.getBuyQuote(buyAmount);

            // Quotes should be identical for same state
            expect(quote1).to.equal(quote2);
        });

        it("Should provide consistent sell quotes for same input", async function () {
            // Buy some tokens first
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;
            await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline);

            const sellAmount = parseUnits("100", 18);

            const quote1 = await hokusaiAMM.getSellQuote(sellAmount);
            const quote2 = await hokusaiAMM.getSellQuote(sellAmount);

            // Quotes should be identical for same state
            expect(quote1).to.equal(quote2);
        });

        it("Should prevent quote front-running via actual trade differences", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const buyAmount = parseUnits("1000", 6);

            // Victim gets quote
            const quote = await hokusaiAMM.getBuyQuote(buyAmount);

            // Attacker makes a trade
            await hokusaiAMM.connect(attacker).buy(parseUnits("2000", 6), 0, attacker.address, deadline);

            // Quote has changed now
            const newQuote = await hokusaiAMM.getBuyQuote(buyAmount);
            expect(newQuote).to.be.lt(quote);

            // But victim is protected if they set minTokensOut to original quote
            await expect(
                hokusaiAMM.connect(victim).buy(buyAmount, quote, victim.address, deadline)
            ).to.be.revertedWith("Slippage exceeded");
        });

        it("Should make quotes degrade gracefully with reserve state", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
            const buyAmount = parseUnits("100", 6);

            const quotes = [];
            quotes.push(await hokusaiAMM.getBuyQuote(buyAmount));

            // Make several trades and track how quotes change
            for (let i = 0; i < 5; i++) {
                await hokusaiAMM.connect(attacker).buy(parseUnits("1000", 6), 0, attacker.address, deadline);
                quotes.push(await hokusaiAMM.getBuyQuote(buyAmount));
            }

            // Quotes should decrease (get worse) as price increases
            for (let i = 1; i < quotes.length; i++) {
                expect(quotes[i]).to.be.lt(quotes[i - 1]);
            }

            // But quotes should degrade gradually, not cliff
            for (let i = 1; i < quotes.length; i++) {
                const degradation = ((quotes[i - 1] - quotes[i]) * 10000n) / quotes[i - 1];
                expect(degradation).to.be.lt(5000n); // < 50% drop per step
            }
        });
    });

    // ============================================================
    // PRICE RECOVERY MECHANISMS
    // ============================================================

    describe("Price Recovery After Manipulation", function () {
        it("Should allow price to recover via natural sell pressure", async function () {
            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const initialPrice = await hokusaiAMM.spotPrice();

            // Attacker pumps price
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (currentReserve * 5000n) / 10000n;
            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            const pumpedPrice = await hokusaiAMM.spotPrice();
            expect(pumpedPrice).to.be.gt(initialPrice);

            // Natural sellers bring price back down
            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline);

            const recoveredPrice = await hokusaiAMM.spotPrice();

            // Price should recover toward original (though not exactly due to fees)
            expect(recoveredPrice).to.be.lt(pumpedPrice);
            expect(recoveredPrice).to.be.closeTo(initialPrice, initialPrice / 2n);
        });

        it("Should maintain fair pricing after failed manipulation", async function () {
            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;
            const initialPrice = await hokusaiAMM.spotPrice();

            // Attacker attempts manipulation but transaction reverts (oversized)
            const currentReserve = await hokusaiAMM.reserveBalance();
            const oversized = (currentReserve * 6000n) / 10000n; // 60%, exceeds 50% limit

            await expect(
                hokusaiAMM.connect(attacker).buy(oversized, 0, attacker.address, deadline)
            ).to.be.revertedWith("Trade exceeds max size limit");

            // Price unchanged after failed manipulation
            const finalPrice = await hokusaiAMM.spotPrice();
            expect(finalPrice).to.equal(initialPrice);
        });

        it("Should restore fair value after pump and dump cycle", async function () {
            // Fast forward past IBR
            await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
            await ethers.provider.send("evm_mine");

            const deadline = (await ethers.provider.getBlock('latest')).timestamp + 600;

            // Record initial state
            const initialPrice = await hokusaiAMM.spotPrice();
            const initialReserve = await hokusaiAMM.reserveBalance();
            const initialSupply = await hokusaiToken.totalSupply();

            // Full pump and dump cycle
            const currentReserve = await hokusaiAMM.reserveBalance();
            const maxTrade = (currentReserve * 5000n) / 10000n;

            await hokusaiAMM.connect(attacker).buy(maxTrade, 0, attacker.address, deadline);

            const attackerTokens = await hokusaiToken.balanceOf(attacker.address);
            await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), attackerTokens);
            await hokusaiAMM.connect(attacker).sell(attackerTokens, 0, attacker.address, deadline);

            // Check final state
            const finalPrice = await hokusaiAMM.spotPrice();
            const finalReserve = await hokusaiAMM.reserveBalance();
            const finalSupply = await hokusaiToken.totalSupply();

            // Supply should return to initial
            expect(finalSupply).to.equal(initialSupply);

            // Price should be close to initial (slightly lower due to fees collected)
            expect(finalPrice).to.be.closeTo(initialPrice, initialPrice / 10n);

            // Reserve should be slightly higher (fees kept in reserve)
            expect(finalReserve).to.be.gte(initialReserve);
        });
    });
});
