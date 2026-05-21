/**
 * HOK-1823: Security Remediation Tests
 *
 * Verifies fixes for pre-existing Slither High/Medium findings:
 *   - reentrancy-eth  (deployTokenWithParams / deployTokenWithAllocations)
 *   - arbitrary-send-eth (pull-payment via withdrawDeploymentFees)
 *   - unchecked-transfer (HokusaiAMM.sell transferFrom return value)
 *
 * These tests are designed to PASS on post-fix contracts and FAIL on
 * the pre-fix contracts (where nonReentrant was absent and transferFrom
 * return values were unchecked).
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress, keccak256, toUtf8Bytes } = require("ethers");
const { buildDisabledVestingConfig, buildInitialParams, deployTestToken } = require("./helpers/tokenDeployment");

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function defaultParams(governor) {
  return buildInitialParams(governor, {
    tokensPerDeltaOne: parseEther("1000"),
    infrastructureAccrualBps: 8000,
    initialOraclePricePerThousandUsd: 0,
    licenseHash: keccak256(toUtf8Bytes("license")),
    licenseURI: "https://hokusai.ai/licenses/standard",
    vestingConfig: buildDisabledVestingConfig(),
  });
}

// DEPLOYMENT_FEE: fee charged per deployment
const DEPLOYMENT_FEE = parseEther("0.1");
// EXCESS must be >= DEPLOYMENT_FEE so the re-entry forwards enough ETH to pass
// fee validation and reach the nonReentrant check (not fail on the fee check first).
const EXCESS = parseEther("0.1");
const TOTAL_WITH_EXCESS = DEPLOYMENT_FEE + EXCESS; // 0.2 ETH total sent by attacker

// ---------------------------------------------------------------------------
// 1. TokenManager – reentrancy protection on deployTokenWithParams
// ---------------------------------------------------------------------------

describe("HOK-1823: TokenManager reentrancy protection – deployTokenWithParams", function () {
  let tokenManager, modelRegistry;
  let owner, governor;
  let malicious;

  beforeEach(async function () {
    [owner, governor] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);

    const Malicious = await ethers.getContractFactory("MaliciousReentrant");
    malicious = await Malicious.deploy(await tokenManager.getAddress());
    await malicious.waitForDeployment();
  });

  it("reverts reentrancy attack on deployTokenWithParams (nonReentrant guard)", async function () {
    const params = defaultParams(governor.address);

    // Outer call: registers model1
    const outerData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      "model1", "Token One", "T1", parseEther("100000"), params,
    ]);

    // Re-entry call: would register model2 (different model, same fee requirement)
    const reentryData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      "model2", "Token Two", "T2", parseEther("100000"), params,
    ]);

    // Set re-entry data BEFORE sending any ETH (setting storage does not trigger receive())
    await malicious.setReentryData(reentryData);

    // Attack flow:
    //   attack() sends 0.2 ETH → deployTokenWithParams("model1") with 0.2 ETH
    //   fee check passes (0.2 >= 0.1); state changes; _refundExcess sends 0.1 ETH back
    //   receive() receives 0.1 ETH, forwards it to re-enter deployTokenWithParams("model2")
    //   nonReentrant fires → reverts; receive() propagates; _refundExcess fails; outer reverts
    await expect(
      malicious.attack(outerData, { value: TOTAL_WITH_EXCESS })
    ).to.be.reverted;

    // Neither model was registered (full rollback due to revert)
    expect(await tokenManager.hasToken("model1")).to.be.false;
    expect(await tokenManager.hasToken("model2")).to.be.false;
  });

  it("allows normal deployment with exact fee (guard does not block legitimate calls)", async function () {
    const params = defaultParams(governor.address);

    await expect(
      tokenManager.deployTokenWithParams(
        "model1", "Token One", "T1", parseEther("100000"), params,
        { value: DEPLOYMENT_FEE }
      )
    ).to.not.be.reverted;

    expect(await tokenManager.hasToken("model1")).to.be.true;
  });
});

// ---------------------------------------------------------------------------
// 2. TokenManager – reentrancy protection on deployTokenWithAllocations
// ---------------------------------------------------------------------------

describe("HOK-1823: TokenManager reentrancy protection – deployTokenWithAllocations", function () {
  let tokenManager, modelRegistry;
  let owner, governor;
  let malicious;

  const MODEL_SUPPLIER_ALLOC = parseEther("2500000");
  const INVESTOR_ALLOC = parseEther("10000000");

  beforeEach(async function () {
    [owner, governor] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);

    const Malicious = await ethers.getContractFactory("MaliciousReentrant");
    malicious = await Malicious.deploy(await tokenManager.getAddress());
    await malicious.waitForDeployment();
  });

  it("reverts reentrancy attack on deployTokenWithAllocations (nonReentrant guard)", async function () {
    const params = defaultParams(governor.address);

    const outerData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      "model1", "Token One", "T1",
      MODEL_SUPPLIER_ALLOC, governor.address, INVESTOR_ALLOC, params,
    ]);

    const reentryData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      "model2", "Token Two", "T2",
      MODEL_SUPPLIER_ALLOC, governor.address, INVESTOR_ALLOC, params,
    ]);

    await malicious.setReentryData(reentryData);

    await expect(
      malicious.attack(outerData, { value: TOTAL_WITH_EXCESS })
    ).to.be.reverted;

    expect(await tokenManager.hasToken("model1")).to.be.false;
    expect(await tokenManager.hasToken("model2")).to.be.false;
  });
});

// ---------------------------------------------------------------------------
// 3. TokenManager – withdrawDeploymentFees (pull-payment)
// ---------------------------------------------------------------------------

describe("HOK-1823: TokenManager.withdrawDeploymentFees (pull-payment)", function () {
  let tokenManager, modelRegistry;
  let owner, governor, nonOwner, feeReceiver;

  beforeEach(async function () {
    [owner, governor, nonOwner, feeReceiver] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);
    await tokenManager.setFeeRecipient(feeReceiver.address);
  });

  it("fee stays in contract after deployment (pull-payment model)", async function () {
    const params = defaultParams(governor.address);

    const contractBefore = await ethers.provider.getBalance(await tokenManager.getAddress());
    const recipientBefore = await ethers.provider.getBalance(feeReceiver.address);

    await tokenManager.deployTokenWithParams(
      "model1", "Token One", "T1", parseEther("100000"), params,
      { value: DEPLOYMENT_FEE }
    );

    const contractAfter = await ethers.provider.getBalance(await tokenManager.getAddress());
    const recipientAfter = await ethers.provider.getBalance(feeReceiver.address);

    // Fee retained in contract (not pushed to feeRecipient)
    expect(contractAfter - contractBefore).to.equal(DEPLOYMENT_FEE);
    expect(recipientAfter).to.equal(recipientBefore);
  });

  it("reverts for non-owner", async function () {
    const params = defaultParams(governor.address);
    await tokenManager.deployTokenWithParams(
      "model1", "Token One", "T1", parseEther("100000"), params,
      { value: DEPLOYMENT_FEE }
    );

    await expect(
      tokenManager.connect(nonOwner).withdrawDeploymentFees()
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("reverts when no fees have been collected", async function () {
    await expect(tokenManager.withdrawDeploymentFees()).to.be.revertedWith("No fees to withdraw");
  });

  it("sends accumulated fees to feeRecipient and emits event", async function () {
    const params = defaultParams(governor.address);

    await tokenManager.deployTokenWithParams(
      "model1", "Token One", "T1", parseEther("100000"), params,
      { value: DEPLOYMENT_FEE }
    );
    await tokenManager.deployTokenWithParams(
      "model2", "Token Two", "T2", parseEther("100000"), params,
      { value: DEPLOYMENT_FEE }
    );

    const expectedFees = DEPLOYMENT_FEE * 2n;
    const recipientBefore = await ethers.provider.getBalance(feeReceiver.address);

    await expect(tokenManager.withdrawDeploymentFees())
      .to.emit(tokenManager, "DeploymentFeesWithdrawn")
      .withArgs(feeReceiver.address, expectedFees);

    const recipientAfter = await ethers.provider.getBalance(feeReceiver.address);
    expect(recipientAfter - recipientBefore).to.equal(expectedFees);

    // Contract balance zeroed after withdrawal
    expect(await ethers.provider.getBalance(await tokenManager.getAddress())).to.equal(0n);
  });
});

// ---------------------------------------------------------------------------
// 4. DeployableTokenManager – reentrancy protection
// ---------------------------------------------------------------------------

describe("HOK-1823: DeployableTokenManager reentrancy protection", function () {
  let tokenManager, modelRegistry;
  let owner, governor;
  let malicious;

  const MODEL_SUPPLIER_ALLOC = parseEther("2500000");
  const INVESTOR_ALLOC = parseEther("10000000");

  beforeEach(async function () {
    [owner, governor] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
    const factory = await TokenDeploymentFactory.deploy();
    await factory.waitForDeployment();

    const DeployableTokenManager = await ethers.getContractFactory("DeployableTokenManager");
    tokenManager = await DeployableTokenManager.deploy(
      await modelRegistry.getAddress(),
      await factory.getAddress()
    );
    await tokenManager.waitForDeployment();

    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);

    const Malicious = await ethers.getContractFactory("MaliciousReentrant");
    malicious = await Malicious.deploy(await tokenManager.getAddress());
    await malicious.waitForDeployment();
  });

  it("reverts reentrancy attack on deployTokenWithParams (nonReentrant guard)", async function () {
    const params = defaultParams(governor.address);

    const outerData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      "model1", "Token One", "T1", parseEther("100000"), params,
    ]);
    const reentryData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      "model2", "Token Two", "T2", parseEther("100000"), params,
    ]);

    await malicious.setReentryData(reentryData);

    await expect(
      malicious.attack(outerData, { value: TOTAL_WITH_EXCESS })
    ).to.be.reverted;

    expect(await tokenManager.hasToken("model1")).to.be.false;
    expect(await tokenManager.hasToken("model2")).to.be.false;
  });

  it("reverts reentrancy attack on deployTokenWithAllocations (nonReentrant guard)", async function () {
    const params = defaultParams(governor.address);

    const outerData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      "model1", "Token One", "T1",
      MODEL_SUPPLIER_ALLOC, governor.address, INVESTOR_ALLOC, params,
    ]);
    const reentryData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      "model2", "Token Two", "T2",
      MODEL_SUPPLIER_ALLOC, governor.address, INVESTOR_ALLOC, params,
    ]);

    await malicious.setReentryData(reentryData);

    await expect(
      malicious.attack(outerData, { value: TOTAL_WITH_EXCESS })
    ).to.be.reverted;

    expect(await tokenManager.hasToken("model1")).to.be.false;
    expect(await tokenManager.hasToken("model2")).to.be.false;
  });

  it("reverts withdrawDeploymentFees for non-owner", async function () {
    const [, , nonOwner] = await ethers.getSigners();
    const params = defaultParams(governor.address);

    await tokenManager.deployTokenWithParams(
      "model1", "Token One", "T1", parseEther("100000"), params,
      { value: DEPLOYMENT_FEE }
    );

    await expect(
      tokenManager.connect(nonOwner).withdrawDeploymentFees()
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("reverts withdrawDeploymentFees when no fees collected", async function () {
    await expect(tokenManager.withdrawDeploymentFees()).to.be.revertedWith("No fees to withdraw");
  });
});

// ---------------------------------------------------------------------------
// 5. HokusaiAMM.sell – unchecked-transfer fix
// ---------------------------------------------------------------------------

describe("HOK-1823: HokusaiAMM.sell() reverts when transferFrom returns false", function () {
  let tokenManager, modelRegistry;
  let mockUSDC, mockFailingToken, amm;
  let owner, treasury, seller;

  // Use IBR = 0 so sells are enabled from block 0
  const IBR_DURATION = 0;
  const CRR = 100000; // 10% reserve ratio
  const TRADE_FEE = 30; // 0.30%
  const FLAT_CURVE_THRESHOLD = parseUnits("1000", 6);
  const FLAT_CURVE_PRICE = parseUnits("0.01", 6);
  const MODEL_ID = "hok1823-sell-test";

  beforeEach(async function () {
    [owner, treasury, seller] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    // Register a real HokusaiToken for MODEL_ID so getRedeemableSupply() returns > 0
    await deployTestToken(
      tokenManager, MODEL_ID, "HOK Test", "HKT", parseEther("100000"), owner.address
    );

    // MockFailingTransferToken: transferFrom always returns false (not reverts)
    const MockFailingTransferToken = await ethers.getContractFactory("MockFailingTransferToken");
    mockFailingToken = await MockFailingTransferToken.deploy();
    await mockFailingToken.waitForDeployment();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    // Deploy AMM with mockFailingToken as hokusaiToken; same modelId as the real HokusaiToken
    // so _redeemableSupply() (backed by real token) returns a non-zero value for getSellQuote
    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    amm = await HokusaiAMM.deploy(
      await mockUSDC.getAddress(),
      await mockFailingToken.getAddress(),
      await tokenManager.getAddress(),
      MODEL_ID,
      treasury.address,
      CRR,
      TRADE_FEE,
      IBR_DURATION,
      FLAT_CURVE_THRESHOLD,
      FLAT_CURVE_PRICE
    );
    await amm.waitForDeployment();

    await tokenManager.authorizeAMM(await amm.getAddress());

    // Fund AMM with USDC (below threshold → flat pricing path, simpler quote)
    const reserveAmount = parseUnits("100", 6);
    await mockUSDC.mint(owner.address, reserveAmount);
    await mockUSDC.approve(await amm.getAddress(), reserveAmount);
    await amm.depositFees(reserveAmount);

    // Give seller some MockFailingToken and approve the AMM
    await mockFailingToken.mint(seller.address, parseEther("1000"));
    await mockFailingToken.connect(seller).approve(await amm.getAddress(), parseEther("1000"));
  });

  it("isSellEnabled is true immediately when IBR_DURATION is 0", async function () {
    expect(await amm.isSellEnabled()).to.be.true;
  });

  it("reverts with 'Token transfer failed' when transferFrom returns false", async function () {
    const deadline = (await ethers.provider.getBlock("latest")).timestamp + 300;

    // sell() reaches transferFrom, which returns false → require fails with the expected message
    await expect(
      amm.connect(seller).sell(parseEther("1"), 0, seller.address, deadline)
    ).to.be.revertedWith("Token transfer failed");
  });
});
