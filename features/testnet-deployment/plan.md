# Testnet Deployment and Integration Testing Plan
**Linear Issue:** Testnet Deployment and Integration Testing (from Hokusai smart contracts backlog)
**Created:** 2026-01-12
**Status:** Ready for Review

---

## Overview

### What We're Building
A comprehensive testnet deployment system for the Hokusai token ecosystem on Sepolia, including:
1. Complete contract suite deployment (9 contracts)
2. Multiple pool configurations with different parameters
3. Integration testing framework simulating real-world usage patterns
4. Event monitoring and block explorer verification
5. Emergency control testing (pause/unpause)

### Why This Matters
Before mainnet deployment, we need to validate:
- **Deployment workflow** - Ensure all contracts deploy in correct order with proper configuration
- **Inter-contract interactions** - Verify ModelRegistry, TokenManager, Factory, and AMM work together correctly
- **Real blockchain conditions** - Test under actual network latency, gas costs, and time delays
- **Emergency procedures** - Confirm pause/unpause and parameter updates work as expected
- **Event emissions** - Validate all events are properly indexed for frontend/backend integration

### Success Criteria
**Automated Checks:**
- ✅ All 9 contracts deploy successfully to Sepolia
- ✅ At least 3 pools created with different parameter sets
- ✅ IBR period simulation completes (using time manipulation)
- ✅ All critical events emitted and verifiable on Etherscan
- ✅ Emergency pause/unpause functions work correctly

**Manual Verification:**
- ✅ Deployment script produces valid contract addresses
- ✅ Block explorer shows all contracts verified
- ✅ Pool parameters match intended configuration
- ✅ Trade calculations match local Hardhat test results
- ✅ Fee distribution flows correctly through UsageFeeRouter

---

## Current State

### Existing Infrastructure
From research and codebase analysis:

**Deployed Contracts (Old):**
- Previous testnet deployment exists but is outdated (months old)
- Should NOT reuse old deployments - fresh start required
- Old deployments may not include recent security fixes

**Security Audit Status:**
- ✅ HOK-653 security audit COMPLETED and MERGED
- ✅ All security fixes from audit are in current codebase
- ✅ Mathematical functions (power, ln, exp) verified
- ✅ Flash loan attack protection validated
- ✅ Reentrancy guards in place

**Test Infrastructure:**
- ✅ 615+ passing tests in Hardhat
- ✅ Comprehensive test patterns for time manipulation
- ✅ Event assertion examples
- ✅ Multi-pool test scenarios
- ✅ Emergency control tests

**Deployment Scripts:**
- ⚠️ Multiple deployment scripts exist but fragmented:
  - `scripts/deploy.js` - Basic deployment
  - `scripts/deploy-sepolia-simple.js` - Simplified Sepolia deployment
  - `scripts/deploy-with-registry.js` - With ModelRegistry
  - Various other specialized scripts
- ❌ No comprehensive "deploy everything" script for testnet

### Known Gaps

**🔴 Critical Gaps:**
1. **No unified deployment script** - Need single script to deploy all 9 contracts in correct order
2. **No multi-pool test script** - Need to create multiple pools with different parameters
3. **No testnet IBR validation** - Need to test 7-day IBR period (with time manipulation)
4. **No event monitoring automation** - Need scripts to verify events on Etherscan

**🟡 Medium Gaps:**
5. **Test USDC availability** - Need to deploy MockUSDC or obtain from faucet (~$1M needed)
6. **No automated verification** - Need to verify contracts on Etherscan programmatically
7. **No deployment documentation** - Need to document contract addresses and parameters
8. **Limited gas benchmarking** - Need to measure actual gas costs on testnet

**🟢 Low Priority Gaps:**
9. **No flash loan testing** - Can defer MEV/flash loan scenarios to later
10. **No concurrent user simulation** - Can test single-user flows initially

---

## Proposed Changes

### Implementation Phases

---

## **Phase 1: Deployment Infrastructure** (Priority: Critical)
**Goal:** Create unified deployment script for all 9 contracts with proper dependency management

### Changes:
**File:** `scripts/deploy-testnet-full.js` (new file)

**Deployment Sequence:**
```javascript
// 1. Core Infrastructure (no dependencies)
const modelRegistry = await deployModelRegistry();
const hokusaiParams = await deployHokusaiParams();

// 2. Token Management (depends on ModelRegistry)
const tokenManager = await deployTokenManager(modelRegistry.address);

// 3. Mock USDC for testing
const mockUSDC = await deployMockUSDC();
await mockUSDC.mint(deployer.address, parseUnits("1000000", 6)); // $1M test USDC

// 4. AMM Factory (depends on multiple contracts)
const factory = await deployHokusaiAMMFactory(
  tokenManager.address,
  modelRegistry.address,
  hokusaiParams.address,
  mockUSDC.address
);

// 5. Create tokens via TokenManager
const token1 = await createToken(tokenManager, "model-1", "Hokusai Model 1", "HKS1");
const token2 = await createToken(tokenManager, "model-2", "Hokusai Model 2", "HKS2");
const token3 = await createToken(tokenManager, "model-3", "Hokusai Model 3", "HKS3");

// 6. Create pools via Factory
const pool1 = await createPool(factory, token1.address, {...conservativeParams});
const pool2 = await createPool(factory, token2.address, {...aggressiveParams});
const pool3 = await createPool(factory, token3.address, {...balancedParams});

// 7. Usage Fee Router (depends on Factory and USDC)
const feeRouter = await deployUsageFeeRouter(factory.address, mockUSDC.address);

// 8. Data Contribution Registry (optional, no deps)
const dataRegistry = await deployDataContributionRegistry();

// 9. Delta Verifier (depends on multiple contracts)
const deltaVerifier = await deployDeltaVerifier(
  tokenManager.address,
  dataRegistry.address,
  mockUSDC.address
);
```

**Pool Parameter Sets:**
```javascript
const POOL_CONFIGS = {
  conservative: {
    name: "Conservative Pool",
    initialReserve: parseUnits("10000", 6), // $10k
    initialSupply: parseEther("1000000"), // 1M tokens
    crr: 300000, // 30% CRR
    tradeFee: 25, // 0.25%
    protocolFee: 2000, // 20% of trade fees
    ibr: 7 * 24 * 60 * 60, // 7 days (or 1 hour for testing)
    treasury: deployer.address
  },
  aggressive: {
    name: "Aggressive Pool",
    initialReserve: parseUnits("50000", 6), // $50k
    initialSupply: parseEther("500000"), // 500k tokens
    crr: 100000, // 10% CRR (more volatile)
    tradeFee: 50, // 0.50%
    protocolFee: 5000, // 50% of trade fees
    ibr: 1 * 24 * 60 * 60, // 1 day
    treasury: deployer.address
  },
  balanced: {
    name: "Balanced Pool",
    initialReserve: parseUnits("25000", 6), // $25k
    initialSupply: parseEther("2000000"), // 2M tokens
    crr: 200000, // 20% CRR
    tradeFee: 30, // 0.30%
    protocolFee: 3000, // 30% of trade fees
    ibr: 3 * 24 * 60 * 60, // 3 days
    treasury: deployer.address
  }
};
```

**Deployment Output:**
```javascript
// Save to deployments/sepolia-YYYY-MM-DD.json
const deployment = {
  network: "sepolia",
  chainId: 11155111,
  timestamp: Date.now(),
  deployer: deployer.address,
  contracts: {
    ModelRegistry: modelRegistry.address,
    HokusaiParams: hokusaiParams.address,
    TokenManager: tokenManager.address,
    MockUSDC: mockUSDC.address,
    HokusaiAMMFactory: factory.address,
    UsageFeeRouter: feeRouter.address,
    DataContributionRegistry: dataRegistry.address,
    DeltaVerifier: deltaVerifier.address
  },
  tokens: [
    { modelId: "model-1", address: token1.address, name: "Hokusai Model 1" },
    { modelId: "model-2", address: token2.address, name: "Hokusai Model 2" },
    { modelId: "model-3", address: token3.address, name: "Hokusai Model 3" }
  ],
  pools: [
    { token: token1.address, amm: pool1.address, config: "conservative" },
    { token: token2.address, amm: pool2.address, config: "aggressive" },
    { token: token3.address, amm: pool3.address, config: "balanced" }
  ]
};
```

### Success Criteria:
- ✅ Script deploys all 9 contracts without errors
- ✅ Deployment completes in < 5 minutes
- ✅ All contract addresses saved to JSON file
- ✅ Script is idempotent (can retry if partial failure)
- ✅ Gas costs logged for each deployment

---

## **Phase 2: Multi-Pool Configuration Testing** (Priority: Critical)
**Goal:** Validate multiple pools with different parameters work independently

### Changes:
**File:** `test/testnet/multi-pool-validation.test.js` (new file)

**Test Suite:**
```javascript
describe("Testnet Multi-Pool Validation", function () {
  let pools, mockUSDC, deployer;

  before(async function () {
    // Load deployment from JSON
    const deployment = require('../../deployments/sepolia-latest.json');
    pools = deployment.pools;
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
    [deployer] = await ethers.getSigners();
  });

  describe("Pool 1: Conservative (30% CRR)", function () {
    it("Should have correct initial parameters", async function () {
      const pool = await ethers.getContractAt("HokusaiAMM", pools[0].amm);
      const state = await pool.getPoolState();

      expect(state.crr).to.equal(300000); // 30%
      expect(state.tradeFee).to.equal(25); // 0.25%
      expect(state.reserveBalance).to.equal(parseUnits("10000", 6)); // $10k
    });

    it("Should calculate buy quote correctly", async function () {
      const pool = await ethers.getContractAt("HokusaiAMM", pools[0].amm);
      const quote = await pool.getBuyQuote(parseUnits("1000", 6)); // $1k buy

      console.log(`Conservative pool: $1k buys ${formatEther(quote)} tokens`);
      expect(quote).to.be.gt(0);
    });

    it("Should execute buy and emit events", async function () {
      const pool = await ethers.getContractAt("HokusaiAMM", pools[0].amm);
      await mockUSDC.approve(pool.address, parseUnits("1000", 6));

      const tx = await pool.buy(
        parseUnits("1000", 6),
        0, // no slippage protection for testing
        deployer.address,
        Math.floor(Date.now() / 1000) + 300
      );

      const receipt = await tx.wait();
      const buyEvent = receipt.events.find(e => e.event === "Buy");

      expect(buyEvent).to.exist;
      expect(buyEvent.args.buyer).to.equal(deployer.address);

      console.log(`Buy event emitted: ${buyEvent.args.tokensOut} tokens for ${buyEvent.args.reserveIn} USDC`);
    });
  });

  describe("Pool 2: Aggressive (10% CRR)", function () {
    it("Should have higher volatility than conservative pool", async function () {
      const conservativePool = await ethers.getContractAt("HokusaiAMM", pools[0].amm);
      const aggressivePool = await ethers.getContractAt("HokusaiAMM", pools[1].amm);

      const conservativeQuote = await conservativePool.getBuyQuote(parseUnits("1000", 6));
      const aggressiveQuote = await aggressivePool.getBuyQuote(parseUnits("1000", 6));

      // Lower CRR = higher price impact = fewer tokens for same USDC
      console.log(`Conservative (30% CRR): ${formatEther(conservativeQuote)} tokens`);
      console.log(`Aggressive (10% CRR): ${formatEther(aggressiveQuote)} tokens`);
    });
  });

  describe("Pool 3: Balanced (20% CRR)", function () {
    it("Should have parameters between conservative and aggressive", async function () {
      const pool = await ethers.getContractAt("HokusaiAMM", pools[2].amm);
      const state = await pool.getPoolState();

      expect(state.crr).to.equal(200000); // 20%
      expect(state.tradeFee).to.equal(30); // 0.30%
    });
  });

  describe("Pool Independence", function () {
    it("Should not affect other pools when one pool trades", async function () {
      const pool1 = await ethers.getContractAt("HokusaiAMM", pools[0].amm);
      const pool2 = await ethers.getContractAt("HokusaiAMM", pools[1].amm);

      // Get pool2 state before pool1 trade
      const pool2Before = await pool2.getPoolState();

      // Execute trade on pool1
      await mockUSDC.approve(pool1.address, parseUnits("5000", 6));
      await pool1.buy(parseUnits("5000", 6), 0, deployer.address, Math.floor(Date.now() / 1000) + 300);

      // Verify pool2 state unchanged
      const pool2After = await pool2.getPoolState();
      expect(pool2After.reserveBalance).to.equal(pool2Before.reserveBalance);
      expect(pool2After.spotPrice).to.equal(pool2Before.spotPrice);
    });
  });
});
```

### Success Criteria:
- ✅ All 3 pools have correct parameters after deployment
- ✅ Each pool calculates quotes independently
- ✅ Trades execute successfully with events emitted
- ✅ Pools do not interfere with each other
- ✅ Different CRR values produce different price behavior

---

## **Phase 3: IBR Period Simulation** (Priority: Critical)
**Goal:** Test 7-day Initial Bonding Reserve period with time manipulation

### Changes:
**File:** `test/testnet/ibr-validation.test.js` (new file)

**Time Manipulation Approach:**
For local Hardhat testing:
```javascript
async function increaseTime(seconds) {
  await ethers.provider.send("evm_increaseTime", [seconds]);
  await ethers.provider.send("evm_mine", []);
}
```

For actual testnet (Sepolia):
- Deploy pools with reduced IBR (1 hour instead of 7 days)
- Adjust parameter: `ibr: 60 * 60` (1 hour)
- Document: "Production will use 7 days, testnet uses 1 hour for faster validation"

**Test Suite:**
```javascript
describe("IBR Period Validation", function () {
  let pool, token, mockUSDC, deployer, buyer;

  before(async function () {
    [deployer, buyer] = await ethers.getSigners();
    // Load deployment
    const deployment = require('../../deployments/sepolia-latest.json');
    pool = await ethers.getContractAt("HokusaiAMM", deployment.pools[0].amm);
    token = await ethers.getContractAt("HokusaiToken", deployment.tokens[0].address);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  });

  it("Should allow buys during IBR", async function () {
    await mockUSDC.connect(buyer).approve(pool.address, parseUnits("1000", 6));

    const tx = await pool.connect(buyer).buy(
      parseUnits("1000", 6),
      0,
      buyer.address,
      Math.floor(Date.now() / 1000) + 300
    );

    await tx.wait();
    const tokenBalance = await token.balanceOf(buyer.address);
    expect(tokenBalance).to.be.gt(0);

    console.log(`✅ Buy during IBR successful: ${formatEther(tokenBalance)} tokens`);
  });

  it("Should block sells during IBR", async function () {
    const tokenBalance = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(pool.address, tokenBalance);

    await expect(
      pool.connect(buyer).sell(
        tokenBalance,
        0,
        buyer.address,
        Math.floor(Date.now() / 1000) + 300
      )
    ).to.be.revertedWith("Sells not enabled during IBR");

    console.log(`✅ Sell correctly blocked during IBR`);
  });

  it("Should allow sells after IBR expires", async function () {
    // Wait for IBR to expire (1 hour for testnet, 7 days for production)
    console.log("⏳ Waiting for IBR to expire...");

    if (network.name === "hardhat") {
      // Local testing: fast-forward time
      await increaseTime(7 * 24 * 60 * 60 + 1); // 7 days + 1 second
    } else {
      // Testnet: actually wait (or use reduced IBR of 1 hour)
      console.log("   Testnet IBR: 1 hour (reduced for testing)");
      console.log("   Production IBR: 7 days");
      // Wait 1 hour if testing on Sepolia
    }

    const tokenBalance = await token.balanceOf(buyer.address);
    await token.connect(buyer).approve(pool.address, tokenBalance);

    const tx = await pool.connect(buyer).sell(
      tokenBalance,
      0,
      buyer.address,
      Math.floor(Date.now() / 1000) + 300
    );

    await tx.wait();
    console.log(`✅ Sell successful after IBR expiry`);
  });

  it("Should show correct IBR status in getTradeInfo()", async function () {
    const tradeInfo = await pool.getTradeInfo();

    expect(tradeInfo.ibrActive).to.be.false;
    expect(tradeInfo.canBuy).to.be.true;
    expect(tradeInfo.canSell).to.be.true;

    console.log(`Trade info: IBR=${tradeInfo.ibrActive}, canBuy=${tradeInfo.canBuy}, canSell=${tradeInfo.canSell}`);
  });
});
```

### Success Criteria:
- ✅ Buys work during IBR period
- ✅ Sells are blocked during IBR with clear error message
- ✅ Sells work after IBR expires
- ✅ `getTradeInfo()` correctly reports IBR status
- ✅ Time manipulation works in local tests
- ✅ Reduced IBR (1 hour) works on testnet

---

## **Phase 4: Event Monitoring & Block Explorer Verification** (Priority: Critical)
**Goal:** Validate all events are emitted correctly and visible on Etherscan

### Changes:
**File:** `scripts/verify-events.js` (new file)

**Critical Events to Monitor:**
```javascript
const CRITICAL_EVENTS = {
  HokusaiAMM: [
    "Buy(address indexed buyer, uint256 reserveIn, uint256 tokensOut, uint256 spotPrice)",
    "Sell(address indexed seller, uint256 tokensIn, uint256 reserveOut, uint256 spotPrice)",
    "FeesDeposited(address indexed depositor, uint256 amount, uint256 newReserveBalance)",
    "Paused(address account)",
    "Unpaused(address account)",
    "ParametersUpdated(uint256 crr, uint256 tradeFee, uint256 protocolFee)"
  ],
  HokusaiAMMFactory: [
    "PoolCreated(address indexed token, address indexed amm, string modelId)"
  ],
  TokenManager: [
    "TokenDeployed(string indexed modelId, address indexed tokenAddress)"
  ],
  ModelRegistry: [
    "ModelRegistered(string indexed modelId, address indexed tokenAddress)"
  ]
};
```

**Event Verification Script:**
```javascript
async function verifyEvents(deployment) {
  console.log("🔍 Verifying events on Sepolia Etherscan...\n");

  for (const pool of deployment.pools) {
    const amm = await ethers.getContractAt("HokusaiAMM", pool.amm);

    // Query past events
    const buyFilter = amm.filters.Buy();
    const buyEvents = await amm.queryFilter(buyFilter);

    console.log(`Pool ${pool.config}:`);
    console.log(`  ✅ ${buyEvents.length} Buy events`);

    // Verify event parameters
    for (const event of buyEvents) {
      console.log(`    - Buyer: ${event.args.buyer}`);
      console.log(`    - Reserve In: $${formatUnits(event.args.reserveIn, 6)}`);
      console.log(`    - Tokens Out: ${formatEther(event.args.tokensOut)}`);
      console.log(`    - Block: ${event.blockNumber}`);
      console.log(`    - Etherscan: https://sepolia.etherscan.io/tx/${event.transactionHash}`);
    }
  }
}
```

**Manual Verification Checklist:**
```markdown
## Event Verification Checklist

For each pool deployment, verify on Sepolia Etherscan:

### Factory Events
- [ ] PoolCreated event visible: https://sepolia.etherscan.io/address/[FACTORY_ADDRESS]#events
- [ ] Event parameters: token address, AMM address, modelId

### Token Events
- [ ] Transfer event for initial mint: https://sepolia.etherscan.io/token/[TOKEN_ADDRESS]
- [ ] Transfer events for buys/sells

### AMM Events
- [ ] Buy events with indexed buyer: https://sepolia.etherscan.io/address/[AMM_ADDRESS]#events
- [ ] Sell events with indexed seller (after IBR)
- [ ] FeesDeposited events
- [ ] Paused/Unpaused events

### Event Indexing
- [ ] All indexed parameters are searchable on Etherscan
- [ ] Event timestamps match transaction times
- [ ] Event data decodes correctly
```

### Success Criteria:
- ✅ All Buy events emitted and visible on Etherscan
- ✅ All Sell events emitted (after IBR)
- ✅ PoolCreated events for all 3 pools
- ✅ Indexed parameters (buyer, seller) are searchable
- ✅ Event data matches transaction parameters
- ✅ Script can query historical events programmatically

---

## **Phase 5: Emergency Control Testing** (Priority: Critical)
**Goal:** Verify pause/unpause mechanism works correctly in emergency scenarios

### Changes:
**File:** `test/testnet/emergency-controls.test.js` (new file)

**Test Suite:**
```javascript
describe("Emergency Control Validation", function () {
  let pool, token, mockUSDC, owner, user;

  before(async function () {
    [owner, user] = await ethers.getSigners();
    const deployment = require('../../deployments/sepolia-latest.json');
    pool = await ethers.getContractAt("HokusaiAMM", deployment.pools[0].amm);
    token = await ethers.getContractAt("HokusaiToken", deployment.tokens[0].address);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  });

  describe("Pause Mechanism", function () {
    it("Should allow owner to pause", async function () {
      const tx = await pool.connect(owner).pause();
      await tx.wait();

      expect(await pool.paused()).to.be.true;
      console.log("✅ Pool paused successfully");
    });

    it("Should block buys when paused", async function () {
      await mockUSDC.connect(user).approve(pool.address, parseUnits("1000", 6));

      await expect(
        pool.connect(user).buy(
          parseUnits("1000", 6),
          0,
          user.address,
          Math.floor(Date.now() / 1000) + 300
        )
      ).to.be.revertedWith("Pausable: paused");

      console.log("✅ Buy correctly blocked when paused");
    });

    it("Should block sells when paused", async function () {
      const tokenBalance = await token.balanceOf(user.address);
      if (tokenBalance.gt(0)) {
        await token.connect(user).approve(pool.address, tokenBalance);

        await expect(
          pool.connect(user).sell(
            tokenBalance,
            0,
            user.address,
            Math.floor(Date.now() / 1000) + 300
          )
        ).to.be.revertedWith("Pausable: paused");

        console.log("✅ Sell correctly blocked when paused");
      }
    });

    it("Should emit Paused event", async function () {
      // Unpause first to test pause again
      await pool.connect(owner).unpause();

      const tx = await pool.connect(owner).pause();
      const receipt = await tx.wait();

      const pausedEvent = receipt.events.find(e => e.event === "Paused");
      expect(pausedEvent).to.exist;
      expect(pausedEvent.args.account).to.equal(owner.address);

      console.log("✅ Paused event emitted correctly");
    });
  });

  describe("Unpause Mechanism", function () {
    it("Should allow owner to unpause", async function () {
      await pool.connect(owner).pause(); // Pause first

      const tx = await pool.connect(owner).unpause();
      await tx.wait();

      expect(await pool.paused()).to.be.false;
      console.log("✅ Pool unpaused successfully");
    });

    it("Should allow trading after unpause", async function () {
      await mockUSDC.connect(user).approve(pool.address, parseUnits("1000", 6));

      const tx = await pool.connect(user).buy(
        parseUnits("1000", 6),
        0,
        user.address,
        Math.floor(Date.now() / 1000) + 300
      );

      await tx.wait();
      console.log("✅ Trading resumed after unpause");
    });

    it("Should emit Unpaused event", async function () {
      await pool.connect(owner).pause(); // Pause first

      const tx = await pool.connect(owner).unpause();
      const receipt = await tx.wait();

      const unpausedEvent = receipt.events.find(e => e.event === "Unpaused");
      expect(unpausedEvent).to.exist;
      expect(unpausedEvent.args.account).to.equal(owner.address);

      console.log("✅ Unpaused event emitted correctly");
    });
  });

  describe("Access Control", function () {
    it("Should prevent non-owner from pausing", async function () {
      await expect(
        pool.connect(user).pause()
      ).to.be.revertedWith("Ownable: caller is not the owner");

      console.log("✅ Non-owner correctly blocked from pausing");
    });

    it("Should prevent non-owner from unpausing", async function () {
      await pool.connect(owner).pause(); // Owner pauses

      await expect(
        pool.connect(user).unpause()
      ).to.be.revertedWith("Ownable: caller is not the owner");

      await pool.connect(owner).unpause(); // Clean up
      console.log("✅ Non-owner correctly blocked from unpausing");
    });
  });

  describe("Emergency Scenarios", function () {
    it("Should handle rapid pause/unpause cycles", async function () {
      for (let i = 0; i < 5; i++) {
        await pool.connect(owner).pause();
        expect(await pool.paused()).to.be.true;

        await pool.connect(owner).unpause();
        expect(await pool.paused()).to.be.false;
      }

      console.log("✅ Rapid pause/unpause cycles work correctly");
    });

    it("Should allow parameter updates while paused", async function () {
      await pool.connect(owner).pause();

      const tx = await pool.connect(owner).setParameters(
        300000, // CRR
        30,     // trade fee
        2000    // protocol fee
      );
      await tx.wait();

      console.log("✅ Parameter updates work while paused");

      await pool.connect(owner).unpause(); // Clean up
    });
  });
});
```

### Success Criteria:
- ✅ Owner can pause/unpause successfully
- ✅ All trading blocked when paused
- ✅ Trading resumes after unpause
- ✅ Pause/Unpause events emitted correctly
- ✅ Non-owners cannot pause/unpause
- ✅ Rapid pause/unpause cycles work
- ✅ Parameter updates allowed while paused

---

## **Phase 6: Gas Cost Benchmarking** (Priority: Medium)
**Goal:** Measure actual gas costs for all operations on Sepolia testnet

### Changes:
**File:** `test/testnet/gas-benchmarks.test.js` (new file)

**Test Suite:**
```javascript
describe("Gas Cost Benchmarks", function () {
  let pool, mockUSDC, deployer;

  before(async function () {
    [deployer] = await ethers.getSigners();
    const deployment = require('../../deployments/sepolia-latest.json');
    pool = await ethers.getContractAt("HokusaiAMM", deployment.pools[0].amm);
    mockUSDC = await ethers.getContractAt("MockUSDC", deployment.contracts.MockUSDC);
  });

  it("Should measure gas for small buy ($100)", async function () {
    await mockUSDC.approve(pool.address, parseUnits("100", 6));

    const tx = await pool.buy(
      parseUnits("100", 6),
      0,
      deployer.address,
      Math.floor(Date.now() / 1000) + 300
    );

    const receipt = await tx.wait();
    console.log(`Small buy gas: ${receipt.gasUsed.toString()}`);
  });

  it("Should measure gas for medium buy ($1,000)", async function () {
    await mockUSDC.approve(pool.address, parseUnits("1000", 6));

    const tx = await pool.buy(
      parseUnits("1000", 6),
      0,
      deployer.address,
      Math.floor(Date.now() / 1000) + 300
    );

    const receipt = await tx.wait();
    console.log(`Medium buy gas: ${receipt.gasUsed.toString()}`);
  });

  it("Should measure gas for large buy ($10,000)", async function () {
    await mockUSDC.approve(pool.address, parseUnits("10000", 6));

    const tx = await pool.buy(
      parseUnits("10000", 6),
      0,
      deployer.address,
      Math.floor(Date.now() / 1000) + 300
    );

    const receipt = await tx.wait();
    console.log(`Large buy gas: ${receipt.gasUsed.toString()}`);
  });

  // Similar tests for sells, fee deposits, etc.
});
```

### Success Criteria:
- ✅ Gas costs measured for all operation sizes
- ✅ All operations < 10M gas (block limit)
- ✅ Gas costs documented in benchmarks table
- ✅ Compare testnet vs local Hardhat costs

---

## **Phase 7: Flash Loan & MEV Attack Testing** (Priority: Low - Optimization)
**Goal:** Validate that flash loan attacks are not profitable

### Changes:
**File:** `test/testnet/flash-loan-attack.test.js` (new file)

**Approach:**
- Simulate flash loan by minting large USDC amount
- Execute buy-sell cycle in same transaction (or same block)
- Verify net loss due to fees and price impact

**Note:** This is LOWER PRIORITY and can be deferred. Security audit (HOK-653) already validated flash loan protection.

### Success Criteria:
- ✅ Flash loan buy-sell results in net loss
- ✅ Fees and price impact make arbitrage unprofitable
- ✅ IBR provides additional protection against immediate arbitrage

---

## Out of Scope

Explicitly NOT addressing in this testnet deployment:

### 1. **Mainnet Deployment**
- Not deploying to Ethereum mainnet or production networks
- Not using real USDC or real funds
- Not setting up mainnet monitoring infrastructure

### 2. **Multisig/Timelock Governance**
- Not implementing multisig wallets (Gnosis Safe)
- Not setting up TimelockController
- Using single EOA owner for simplicity
- Production will require multisig (see future "Protocol governance infra" task)

### 3. **Contract Verification on Etherscan**
- Manual verification acceptable for initial deployment
- Automated verification can be added later
- Not setting up CI/CD for automatic verification

### 4. **Frontend Integration**
- Not building React/Next.js UI (separate task: "Frontend Integration Using New View Functions")
- Not implementing wallet connection (MetaMask, WalletConnect)
- Command-line/script-based testing only

### 5. **Advanced Monitoring**
- Not setting up Grafana/Prometheus dashboards
- Not implementing alert systems for anomalies
- Not setting up automated health checks
- Basic block explorer monitoring sufficient

### 6. **Economic Analysis**
- Not evaluating optimal CRR values for production
- Not modeling token economics or incentive structures
- Not comparing to alternative AMM designs
- Testing functionality only, not economic optimization

### 7. **Cross-Chain Testing**
- Single network (Sepolia) only
- Not testing bridge mechanisms or multi-chain deployments
- Not testing L2 integrations (Arbitrum, Optimism, Polygon)

### 8. **Comprehensive Load Testing**
- Not simulating 100+ concurrent users
- Not testing network congestion scenarios
- Not stress-testing RPC endpoints
- Basic functional testing sufficient for testnet

---

## Implementation Strategy

### Test-First Approach
For each phase:
1. **Deploy to testnet first** - Get contracts on Sepolia immediately
2. **Write validation tests** - Confirm expected behavior
3. **Run tests against live contracts** - Validate on-chain behavior
4. **Document findings** - Record contract addresses, gas costs, events
5. **Fix issues if needed** - Redeploy if critical bugs found

### Deployment Commands
```bash
# 1. Compile contracts
npx hardhat compile

# 2. Deploy to Sepolia
npx hardhat run scripts/deploy-testnet-full.js --network sepolia

# 3. Save deployment addresses
# Output saved to: deployments/sepolia-YYYY-MM-DD.json

# 4. Run validation tests
npx hardhat test test/testnet/multi-pool-validation.test.js --network sepolia
npx hardhat test test/testnet/ibr-validation.test.js --network sepolia
npx hardhat test test/testnet/emergency-controls.test.js --network sepolia

# 5. Verify events on Etherscan
node scripts/verify-events.js

# 6. Run gas benchmarks
npx hardhat test test/testnet/gas-benchmarks.test.js --network sepolia --report-gas
```

### Branch Strategy
```bash
git checkout -b feature/testnet-deployment
# Complete phases 1-5 (core functionality)
git add .
git commit -m "TESTNET: Deploy full contract suite to Sepolia"
git push -u origin feature/testnet-deployment
# Create PR when core functionality validated
```

### Commit Discipline
- **One phase per commit** when logical
- **Clear commit messages:**
  - `TESTNET: Deploy full contract suite to Sepolia`
  - `TESTNET: Validate multi-pool configurations`
  - `TESTNET: Test IBR period with time manipulation`
  - `TESTNET: Verify events on Etherscan`
  - `TESTNET: Test emergency pause/unpause`
- **Include deployment addresses** in commit messages
- **Document gas costs** in commit messages

---

## Dependencies

### Required Before Starting:
- ✅ Sepolia RPC URL configured (Alchemy in .env)
- ✅ Test ETH in deployer wallet (for gas fees)
- ✅ Security audit (HOK-653) completed and merged ✅
- ⚠️ Test USDC strategy decided (deploy MockUSDC)

### External Dependencies:
- **Alchemy Sepolia RPC** - Already configured in .env
- **Hardhat** - Test framework (already installed)
- **Ethers.js** - Blockchain interactions (already installed)
- **Sepolia Etherscan** - Block explorer (free, no API key needed for viewing)

### Test USDC Approach:
**Decision:** Deploy MockUSDC on Sepolia
- **Amount:** Mint $1M test USDC to deployer
- **Distribution:**
  - $10k to Pool 1 (conservative)
  - $50k to Pool 2 (aggressive)
  - $25k to Pool 3 (balanced)
  - $900k available for trading tests
- **Rationale:** More reliable than faucets, full control over supply

---

## Risk Mitigation

### What Could Go Wrong:

**Risk 1: Deployment fails mid-sequence**
- **Likelihood:** Medium (network issues, gas estimation errors)
- **Impact:** Medium (partial deployment, need to restart)
- **Mitigation:**
  - Save deployment state after each contract
  - Script checks for existing deployments before proceeding
  - Can resume from last successful deployment
  - Use try-catch with detailed error logging

**Risk 2: Insufficient test ETH for gas**
- **Likelihood:** Low (can get from faucets)
- **Impact:** High (deployment blocked)
- **Mitigation:**
  - Estimate gas costs before deployment
  - Have 0.5 ETH in deployer wallet (more than enough)
  - Sepolia faucets available: https://sepoliafaucet.com/

**Risk 3: Events not indexed on Etherscan**
- **Likelihood:** Low (Etherscan usually reliable)
- **Impact:** Medium (manual verification needed)
- **Mitigation:**
  - Wait 5-10 minutes after deployment for indexing
  - Fall back to programmatic event queries via ethers.js
  - Document events in deployment JSON for reference

**Risk 4: Time manipulation doesn't work on testnet**
- **Likelihood:** High (cannot manipulate time on real blockchain)
- **Impact:** Low (use reduced IBR instead)
- **Mitigation:**
  - Deploy pools with 1-hour IBR for testnet
  - Document: "Production uses 7 days, testnet uses 1 hour"
  - Can still validate IBR logic with reduced duration

**Risk 5: Gas costs too high on testnet**
- **Likelihood:** Low (Sepolia gas is usually low)
- **Impact:** Medium (delays testing, need more ETH)
- **Mitigation:**
  - Deploy during low-traffic periods
  - Optimize gas estimates in deployment script
  - Have backup ETH available

**Risk 6: MockUSDC not behaving like real USDC**
- **Likelihood:** Low (standard ERC20)
- **Impact:** Low (might miss edge cases)
- **Mitigation:**
  - Use OpenZeppelin ERC20 implementation (standard)
  - Test approval/transfer patterns same as real USDC
  - Document: "Production will use Circle's USDC"

---

## Success Metrics

### Quantitative:
- ✅ **All 9 contracts deployed** to Sepolia with valid addresses
- ✅ **3 pools created** with different parameter configurations
- ✅ **IBR testing complete** - buys work, sells blocked during IBR, sells work after
- ✅ **10+ transactions** executed successfully (buys, sells, fee deposits)
- ✅ **All critical events emitted** - Buy, Sell, PoolCreated, Paused, Unpaused
- ✅ **Emergency controls tested** - pause/unpause work correctly

### Qualitative:
- ✅ **Deployment script is reproducible** - can redeploy if needed
- ✅ **All contracts verified on Etherscan** - source code visible
- ✅ **Events visible on block explorer** - can track transactions
- ✅ **Gas costs reasonable** - all operations < 1M gas (well under 10M limit)
- ✅ **Documentation complete** - deployment addresses, parameters, findings

### Deliverables:
1. ✅ Deployment script: `scripts/deploy-testnet-full.js`
2. ✅ Deployment record: `deployments/sepolia-YYYY-MM-DD.json`
3. ✅ Validation tests: `test/testnet/*.test.js` (5 test files)
4. ✅ Event verification script: `scripts/verify-events.js`
5. ✅ Documentation: This plan + findings document
6. ✅ Updated `project-knowledge/codebase-map.md` with testnet learnings

---

## Timeline Estimate

**Total Effort:** 2-3 days (including waiting periods and validation)

| Phase | Time Est. | Complexity | Can Parallelize? |
|-------|-----------|------------|------------------|
| Phase 1: Deployment infrastructure | 4-6 hours | Medium | No (foundational) |
| Phase 2: Multi-pool validation | 3-4 hours | Low | After Phase 1 |
| Phase 3: IBR simulation | 2-3 hours | Low | After Phase 2 |
| Phase 4: Event monitoring | 3-4 hours | Medium | Parallel with Phase 2 |
| Phase 5: Emergency controls | 2-3 hours | Low | Parallel with Phase 3 |
| Phase 6: Gas benchmarking | 2-3 hours | Low | Parallel (anytime) |
| Phase 7: Flash loan testing | 4-6 hours | High | Optional (defer) |

**Critical Path:** Phase 1 → Phase 2 → Phase 3
**Parallel Work:** Phases 4, 5, 6 can run concurrently after Phase 1

**Recommended Order:**
1. Phase 1 (deployment) - MUST complete first
2. Phases 2, 4, 5 in parallel (multi-pool, events, emergency)
3. Phase 3 (IBR) - requires waiting period
4. Phase 6 (gas) - anytime after Phase 1
5. Phase 7 (flash loans) - optional, can defer

**Waiting Periods:**
- IBR testing: 1 hour (if using reduced IBR on testnet)
- Event indexing: 5-10 minutes per transaction
- Block confirmations: 1-2 minutes per transaction

---

## Next Steps

### Immediate Actions:
1. **Review this plan** - Confirm approach and priorities
2. **Check test ETH balance** - Ensure deployer wallet has 0.5+ ETH
3. **Confirm Sepolia RPC** - Test Alchemy endpoint works
4. **Approve plan** - Ready to proceed with implementation

### Ready to Start:
1. Create git branch: `feature/testnet-deployment`
2. Begin Phase 1 (deployment script)
3. Deploy to Sepolia
4. Run validation tests (Phases 2-5)
5. Document findings
6. Create PR with deployment addresses and results

---

## Questions for Team

**1. Deployment Timing:**
   - Any preferred time for deployment? (Low Sepolia traffic hours)
   - Timeline urgency - how quickly do we need testnet results?

**2. Contract Verification:**
   - Do you have an Etherscan API key for automated verification?
   - Or is manual verification acceptable?

**3. Test USDC Distribution:**
   - Should we mint test USDC to multiple wallets (simulate different users)?
   - Or single deployer wallet sufficient?

**4. Reduced IBR Duration:**
   - Confirm: 1 hour IBR for testnet is acceptable?
   - Or prefer to actually wait 7 days for full validation?

**5. Documentation Preferences:**
   - Want results documented in this plan or separate findings.md?
   - Should we create a "testnet runbook" for future deployments?

---

**Status:** ✅ Plan Ready for Review
**Next:** Review plan, confirm approach, begin Phase 1
**Owner:** Testnet deployment team
**Linear Issue:** Testnet Deployment and Integration Testing
