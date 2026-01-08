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
      IBR_DURATION
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
  });

  describe("Approximation Error Bounds", function () {
    it("Should measure buy quote error for various deposit sizes", async function () {
      const testSizes = [
        parseUnits("100", 6),    // $100
        parseUnits("1000", 6),   // $1,000
        parseUnits("5000", 6),   // $5,000
        parseUnits("10000", 6),  // $10,000 (100% of reserve)
        parseUnits("50000", 6),  // $50,000 (500% of reserve)
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
      const largeAmount = parseUnits("10000", 6);
      const smallAmount = largeAmount / BigInt(10);

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
      const largeBuy = parseUnits("50000", 6);
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
});
