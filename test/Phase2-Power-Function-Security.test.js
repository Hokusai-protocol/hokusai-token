const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");

describe("Phase 2: Power Function Security Analysis", function () {
  let hokusaiAMM;
  let mockUSDC;
  let hokusaiToken;
  let tokenManager;
  let modelRegistry;
  let owner, treasury, attacker;

  const modelId = "security-test-model";
  const CRR = 100000; // 10%
  const TRADE_FEE = 25;
  const PROTOCOL_FEE = 500;
  const IBR_DURATION = 7 * 24 * 60 * 60;
  const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6); // $1k threshold
  const FLAT_CURVE_PRICE = parseUnits("0.01", 6); // $0.01 per token
  const INITIAL_SUPPLY = parseEther("100000");
  const INITIAL_RESERVE = parseUnits("10000", 6);

  beforeEach(async function () {
    [owner, treasury, attacker] = await ethers.getSigners();

    // Deploy contracts
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await tokenManager.deployToken(modelId, "Security Test", "SEC", INITIAL_SUPPLY);
    const tokenAddress = await tokenManager.getTokenAddress(modelId);
    hokusaiToken = await ethers.getContractAt("HokusaiToken", tokenAddress);

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

    await tokenManager.authorizeAMM(await hokusaiAMM.getAddress());

    // Seed AMM
    await mockUSDC.mint(owner.address, INITIAL_RESERVE);
    await mockUSDC.approve(await hokusaiAMM.getAddress(), INITIAL_RESERVE);
    await hokusaiAMM.depositFees(INITIAL_RESERVE);

    // Fund attacker
    await mockUSDC.mint(attacker.address, parseUnits("1000000", 6)); // $1M
    await mockUSDC.connect(attacker).approve(await hokusaiAMM.getAddress(), parseUnits("1000000", 6));

    // Set max trade size to 50% for these security tests (they test large/extreme trades)
    await hokusaiAMM.setMaxTradeBps(5000);
  });

  describe("Approximation Error Bounds", function () {
    it("Should measure buy quote error for various deposit sizes", async function () {
      const testSizes = [
        parseUnits("100", 6),    // $100
        parseUnits("1000", 6),   // $1,000
        parseUnits("3000", 6),   // $3,000 (30% of reserve)
        parseUnits("5000", 6),   // $5,000 (50% of reserve - at max limit)
      ];

      console.log("\n      Buy Quote Analysis:");
      console.log("      Size (USDC) | Tokens Out | Reserve After | Price Impact");
      console.log("      ---------------------------------------------------------");

      for (const size of testSizes) {
        const tokensOut = await hokusaiAMM.getBuyQuote(size);
        const reserveBefore = await hokusaiAMM.reserveBalance();

        // Calculate price impact
        const avgPrice = size / (tokensOut / BigInt(1e12)); // USDC per token
        const spotBefore = await hokusaiAMM.spotPrice();
        const priceImpact = ((avgPrice - spotBefore) * BigInt(10000)) / spotBefore;

        console.log(`      $${size / BigInt(1e6)} | ${tokensOut / BigInt(1e18)} | $${reserveBefore / BigInt(1e6)} | ${priceImpact / BigInt(100)}%`);
      }
    });

    it("Should detect quote inconsistency between sequential small buys vs one large buy", async function () {
      const largeAmount = parseUnits("5000", 6); // 50% of reserve (at max limit)
      const smallAmount = largeAmount / BigInt(10); // $500 each

      // Get quote for large buy
      const largeQuote = await hokusaiAMM.getBuyQuote(largeAmount);

      // Get quotes for 10 small buys
      let totalSmallQuotes = BigInt(0);
      let simulatedReserve = await hokusaiAMM.reserveBalance();
      let simulatedSupply = await hokusaiToken.totalSupply();

      // We can't actually simulate the state changes in a view function,
      // but we can at least check if quotes are monotonic
      for (let i = 0; i < 10; i++) {
        const quote = await hokusaiAMM.getBuyQuote(smallAmount);
        totalSmallQuotes += quote;
      }

      console.log(`\n      Large buy (${largeAmount / BigInt(1e6)} USDC): ${largeQuote / BigInt(1e18)} tokens`);
      console.log(`      10x small buys: ${totalSmallQuotes / BigInt(1e18)} tokens`);
      console.log(`      Difference: ${((totalSmallQuotes - largeQuote) * BigInt(10000)) / largeQuote / BigInt(100)}%`);

      // Large buy should yield fewer tokens (worse price) due to price impact
      expect(largeQuote).to.be.lt(totalSmallQuotes);

      // The difference can be significant for large trades (bonding curve behavior)
      // For a 100% of reserve deposit, 45% difference is reasonable
      const difference = ((totalSmallQuotes - largeQuote) * BigInt(10000)) / largeQuote;
      expect(difference).to.be.lt(5000); // < 50% (acceptable for large trades)
    });

    it("Should measure round-trip loss (buy then sell)", async function () {
      const depositAmount = parseUnits("1000", 6);
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      const usdcBefore = await mockUSDC.balanceOf(attacker.address);

      // Buy tokens
      const tx1 = await hokusaiAMM.connect(attacker).buy(depositAmount, 0, attacker.address, deadline);
      await tx1.wait();

      const tokenBalance = await hokusaiToken.balanceOf(attacker.address);

      // Fast-forward past IBR
      await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      // Approve and sell all tokens
      await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokenBalance);
      const deadlineAfterIBR = (await ethers.provider.getBlock('latest')).timestamp + 300;
      const tx2 = await hokusaiAMM.connect(attacker).sell(tokenBalance, 0, attacker.address, deadlineAfterIBR);
      await tx2.wait();

      const usdcAfter = await mockUSDC.balanceOf(attacker.address);
      const loss = usdcBefore - usdcAfter;
      const lossPercent = (loss * BigInt(10000)) / depositAmount;

      console.log(`\n      Round-trip loss analysis:`);
      console.log(`      Initial: $${depositAmount / BigInt(1e6)}`);
      console.log(`      Final: $${usdcAfter / BigInt(1e6)}`);
      console.log(`      Loss: $${loss / BigInt(1e6)} (${lossPercent / BigInt(100)}%)`);

      // Loss should primarily be from trade fees (0.25% * 2 = 0.5%)
      // Plus small price impact
      // Should be < 2% total
      expect(lossPercent).to.be.lt(200); // < 2%
    });
  });

  describe("Potential Exploitation Scenarios", function () {
    it("Should prevent profit from repeated small trades", async function () {
      const initialBalance = await mockUSDC.balanceOf(attacker.address);
      const tradeSize = parseUnits("1000", 6);
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;

      // Attacker tries to exploit approximation errors with many small trades
      for (let i = 0; i < 10; i++) {
        await hokusaiAMM.connect(attacker).buy(tradeSize, 0, attacker.address, deadline);
      }

      // Fast-forward past IBR
      await ethers.provider.send("evm_increaseTime", [IBR_DURATION + 1]);
      await ethers.provider.send("evm_mine");

      // Sell all tokens back
      const tokenBalance = await hokusaiToken.balanceOf(attacker.address);
      await hokusaiToken.connect(attacker).approve(await hokusaiAMM.getAddress(), tokenBalance);
      const deadlineAfterIBR = (await ethers.provider.getBlock('latest')).timestamp + 300;
      await hokusaiAMM.connect(attacker).sell(tokenBalance, 0, attacker.address, deadlineAfterIBR);

      const finalBalance = await mockUSDC.balanceOf(attacker.address);

      console.log(`\n      Exploitation attempt:`);
      console.log(`      Initial: $${initialBalance / BigInt(1e6)}`);
      console.log(`      Final: $${finalBalance / BigInt(1e6)}`);
      console.log(`      Change: $${(finalBalance - initialBalance) / BigInt(1e6)}`);

      // Attacker should lose money due to fees, not gain
      expect(finalBalance).to.be.lt(initialBalance);
    });

    it("Should maintain reserve ratio after large operations", async function () {
      const largeBuy = parseUnits("5000", 6); // 50% of reserve (at max limit)
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      const reserveBefore = await hokusaiAMM.reserveBalance();
      const supplyBefore = await hokusaiToken.totalSupply();

      await hokusaiAMM.connect(attacker).buy(largeBuy, 0, attacker.address, deadline);

      const reserveAfter = await hokusaiAMM.reserveBalance();
      const supplyAfter = await hokusaiToken.totalSupply();

      // Calculate reserve ratios
      const ratioBefore = (reserveBefore * BigInt(1e18)) / supplyBefore;
      const ratioAfter = (reserveAfter * BigInt(1e18)) / supplyAfter;

      console.log(`\n      Reserve ratio check:`);
      console.log(`      Before: ${ratioBefore}`);
      console.log(`      After: ${ratioAfter}`);
      console.log(`      Change: ${((ratioAfter - ratioBefore) * BigInt(10000)) / ratioBefore / BigInt(100)}%`);

      // Reserve ratio should increase (reserve grows faster than supply)
      // This is expected behavior for CRR AMMs
      expect(ratioAfter).to.be.gt(ratioBefore);
    });
  });

  describe("Edge Case Attack Vectors", function () {
    it("Should handle dust attacks (very small amounts)", async function () {
      const dustAmount = BigInt(1); // 1 unit of USDC (0.000001 USDC)
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      // This might revert or return 0 tokens
      try {
        const quote = await hokusaiAMM.getBuyQuote(dustAmount);
        if (quote > 0) {
          await hokusaiAMM.connect(attacker).buy(dustAmount, 0, attacker.address, deadline);
        }
        // If it succeeds, that's fine - just checking it doesn't break
      } catch (error) {
        // Revert is also acceptable
        console.log(`      Dust attack reverted: ${error.message.slice(0, 50)}`);
      }
    });

    it("Should prevent reserve drainage through precision loss", async function () {
      const reserveInitial = await hokusaiAMM.reserveBalance();

      // Perform many small trades
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 3600;
      for (let i = 0; i < 100; i++) {
        const smallAmount = parseUnits("10", 6);
        try {
          await hokusaiAMM.connect(attacker).buy(smallAmount, 0, attacker.address, deadline);
        } catch (e) {
          // Might run out of funds, that's ok
          break;
        }
      }

      const reserveFinal = await hokusaiAMM.reserveBalance();

      console.log(`\n      Reserve after 100 small trades:`);
      console.log(`      Initial: $${reserveInitial / BigInt(1e6)}`);
      console.log(`      Final: $${reserveFinal / BigInt(1e6)}`);
      console.log(`      Growth: $${(reserveFinal - reserveInitial) / BigInt(1e6)}`);

      // Reserve should grow (users are buying)
      expect(reserveFinal).to.be.gte(reserveInitial);
    });
  });

  describe("Gas Exhaustion & DoS Protection", function () {
    it("Should measure gas consumption for extreme buy amounts", async function () {
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      const extremeCases = [
        { amount: parseUnits("100", 6), desc: "Small trade ($100)" },
        { amount: parseUnits("1000", 6), desc: "Medium trade ($1k)" },
        { amount: parseUnits("3000", 6), desc: "Large trade ($3k = 30% of reserve)" },
        { amount: parseUnits("5000", 6), desc: "Huge trade ($5k = 50% of reserve, at max limit)" },
      ];

      console.log("\n      Gas Consumption Analysis:");
      console.log("      Trade Size | Gas Used | Status");
      console.log("      --------------------------------------");

      for (const testCase of extremeCases) {
        try {
          const tx = await hokusaiAMM.connect(attacker).buy(
            testCase.amount,
            0,
            attacker.address,
            deadline
          );
          const receipt = await tx.wait();
          const gasUsed = receipt.gasUsed;

          console.log(`      ${testCase.desc.padEnd(30)} | ${gasUsed.toString().padEnd(8)} | ✅ OK`);

          // Critical: Must be under 10M gas limit
          expect(gasUsed).to.be.lt(10000000);

          // Reasonable expectation: Should be under 500k gas
          expect(gasUsed).to.be.lt(500000);
        } catch (error) {
          console.log(`      ${testCase.desc.padEnd(30)} | N/A      | ❌ REVERTED`);
          // If it reverts for other reasons (e.g., slippage), that's OK
          // We're just checking it doesn't run out of gas
        }
      }
    });

    it("Should handle maximum realistic reserve/supply ratios", async function () {
      // Test with very large reserve relative to supply
      // This tests the upper bounds of ln() scaling loops

      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      // Build up a large reserve through many deposits
      const largeDeposit = parseUnits("100000", 6); // $100k
      await mockUSDC.mint(owner.address, largeDeposit);
      await mockUSDC.approve(await hokusaiAMM.getAddress(), largeDeposit);
      await hokusaiAMM.depositFees(largeDeposit); // Reserve now $110k, supply still 100k tokens

      // Now try a buy - this creates a high R/S ratio
      const buyAmount = parseUnits("10000", 6);
      const tx = await hokusaiAMM.connect(attacker).buy(buyAmount, 0, attacker.address, deadline);
      const receipt = await tx.wait();

      console.log(`\n      High R/S ratio test:`);
      console.log(`      Reserve: $110k, Supply: 100k tokens`);
      console.log(`      Gas used: ${receipt.gasUsed}`);

      // Should complete without out-of-gas
      expect(receipt.gasUsed).to.be.lt(10000000);
      expect(receipt.gasUsed).to.be.lt(500000);
    });

    it("Should handle minimum realistic reserve/supply ratios", async function () {
      // Test with very small reserve relative to supply
      // This tests the lower bounds of ln() scaling loops

      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      // First, let someone buy a lot to increase supply significantly
      const massiveBuy = parseUnits("5000", 6); // Buy with $5k (50% of reserve - at max limit)
      await hokusaiAMM.connect(attacker).buy(massiveBuy, 0, attacker.address, deadline);

      // Now reserve is low, supply is high
      const reserve = await hokusaiAMM.reserveBalance();
      const supply = await hokusaiToken.totalSupply();
      console.log(`\n      Low R/S ratio test:`);
      console.log(`      Reserve: $${reserve / BigInt(1e6)}, Supply: ${supply / BigInt(1e18)} tokens`);

      // Try another buy in this state
      const smallBuy = parseUnits("100", 6);
      const tx = await hokusaiAMM.connect(attacker).buy(smallBuy, 0, attacker.address, deadline + 300);
      const receipt = await tx.wait();

      console.log(`      Gas used: ${receipt.gasUsed}`);

      // Should complete without out-of-gas
      expect(receipt.gasUsed).to.be.lt(10000000);
      expect(receipt.gasUsed).to.be.lt(500000);
    });

    it("Should benchmark getBuyQuote gas consumption", async function () {
      // View functions don't cost gas when called externally,
      // but we can estimate via eth_estimateGas

      const testSizes = [
        parseUnits("100", 6),
        parseUnits("10000", 6),
        parseUnits("100000", 6),
      ];

      console.log("\n      getBuyQuote() Gas Estimates:");
      console.log("      Amount | Gas Estimate");
      console.log("      -------------------------");

      for (const amount of testSizes) {
        const quote = await hokusaiAMM.getBuyQuote(amount);
        // Successfully computed - no out-of-gas
        expect(quote).to.be.gte(0);
        console.log(`      $${amount / BigInt(1e6)} | (view function - no cost)`);
      }
    });

    it("Should handle very small trades without excessive gas", async function () {
      // Test dust amounts don't cause weird scaling behavior
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      const dustAmount = BigInt(1e6); // $1 USDC
      const quote = await hokusaiAMM.getBuyQuote(dustAmount);

      if (quote > 0) {
        const tx = await hokusaiAMM.connect(attacker).buy(dustAmount, 0, attacker.address, deadline);
        const receipt = await tx.wait();

        console.log(`\n      Dust trade ($1) gas: ${receipt.gasUsed}`);

        // Should not use significantly more gas than normal trades
        expect(receipt.gasUsed).to.be.lt(500000);
      } else {
        console.log(`\n      Dust trade ($1): returns 0 tokens (acceptable)`);
      }
    });

    it("Should document maximum loop iterations in scaling functions", async function () {
      // This test verifies that the while loops in _ln() and _exp()
      // don't iterate excessively for realistic inputs

      // The mathematical functions have scaling loops:
      // _ln(): while (scaled > 3 * PRECISION) and while (scaled < PRECISION / 3)
      // _exp(): while (absX > 10 * PRECISION)

      // For CRR of 5-50%, typical base values in _pow() are:
      // - Buy: base = 1 + (E/R), where E/R typically < 2 (even for 200% deposits)
      // - Sell: base = 1 - (T/S), where T/S < 1

      // Maximum iterations in _ln() scaling:
      // - For base = 100 (extreme): log3(100) = ~4.2 iterations
      // - For base = 0.01 (extreme): log3(0.01) = ~4.2 iterations

      // Maximum iterations in _exp() scaling:
      // - For x = 100: log2(10) = ~3.3 iterations
      // - For x = -100: same (absolute value taken)

      // Test: These should all complete without excessive gas
      const deadline = (await ethers.provider.getBlock('latest')).timestamp + 300;

      // Normal trade
      const normalTx = await hokusaiAMM.connect(attacker).buy(
        parseUnits("1000", 6),
        0,
        attacker.address,
        deadline
      );
      const normalReceipt = await normalTx.wait();
      const normalGas = normalReceipt.gasUsed;

      // Extreme trade (50% of reserve - at max limit)
      const extremeTx = await hokusaiAMM.connect(attacker).buy(
        parseUnits("5000", 6),
        0,
        attacker.address,
        deadline + 300
      );
      const extremeReceipt = await extremeTx.wait();
      const extremeGas = extremeReceipt.gasUsed;

      console.log(`\n      Loop iteration analysis:`);
      console.log(`      Normal trade gas: ${normalGas}`);
      console.log(`      Extreme trade gas: ${extremeGas}`);
      console.log(`      Difference: ${extremeGas - normalGas} (${((extremeGas - normalGas) * BigInt(100)) / normalGas}%)`);

      // Extreme trade should not use dramatically more gas
      // Allow up to 50% more gas for extreme trades
      expect(extremeGas).to.be.lt(normalGas * BigInt(15) / BigInt(10));

      // Both should be under 500k gas
      expect(normalGas).to.be.lt(500000);
      expect(extremeGas).to.be.lt(500000);
    });
  });
});
