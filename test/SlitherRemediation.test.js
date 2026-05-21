const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits } = require("ethers");
const { buildInitialParams } = require("./helpers/tokenDeployment");

describe("Slither remediations", function () {
  let owner;
  let governor;
  let modelSupplier;
  let seller;
  let treasury;

  const DEPLOYMENT_FEE = parseEther("0.1");
  const TOKENS_IN = parseEther("100");
  const MODEL_SUPPLIER_ALLOCATION = parseEther("2500");
  const INVESTOR_ALLOCATION = parseEther("10000");

  beforeEach(async function () {
    [owner, governor, modelSupplier, seller, treasury] = await ethers.getSigners();
  });

  function buildParams() {
    return buildInitialParams(governor.address);
  }

  async function deployTokenManager() {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    return tokenManager;
  }

  async function deployDeployableTokenManager() {
    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
    const tokenDeploymentFactory = await TokenDeploymentFactory.deploy();
    await tokenDeploymentFactory.waitForDeployment();

    const DeployableTokenManager = await ethers.getContractFactory("DeployableTokenManager");
    const tokenManager = await DeployableTokenManager.deploy(
      await modelRegistry.getAddress(),
      await tokenDeploymentFactory.getAddress()
    );
    await tokenManager.waitForDeployment();

    return tokenManager;
  }

  async function expectReentryBlocked({
    tokenManager,
    outerCall,
    innerCallData,
    outerModelId,
    innerModelId,
  }) {
    const ReentrantFeeRecipient = await ethers.getContractFactory("ReentrantFeeRecipient");
    const feeRecipient = await ReentrantFeeRecipient.deploy();
    await feeRecipient.waitForDeployment();

    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);
    await tokenManager.setFeeRecipient(await feeRecipient.getAddress());
    await feeRecipient.configure(await tokenManager.getAddress(), innerCallData);

    await expect(outerCall(await feeRecipient.getAddress())).to.not.be.reverted;
    expect(await feeRecipient.reentryBlocked()).to.equal(true);
    expect(await tokenManager.hasToken(outerModelId)).to.equal(true);
    expect(await tokenManager.hasToken(innerModelId)).to.equal(false);
  }

  it("blocks fee-recipient reentrancy on TokenManager.deployTokenWithParams", async function () {
    const tokenManager = await deployTokenManager();
    const params = buildParams();
    const outerModelId = "outer-params";
    const innerModelId = "inner-params";

    const innerCallData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      innerModelId,
      "Inner Token",
      "INR",
      parseEther("1000"),
      params,
    ]);

    await expectReentryBlocked({
      tokenManager,
      innerCallData,
      outerModelId,
      innerModelId,
      outerCall: () => tokenManager.deployTokenWithParams(
        outerModelId,
        "Outer Token",
        "OUT",
        parseEther("1000"),
        params,
        { value: DEPLOYMENT_FEE }
      ),
    });
  });

  it("blocks fee-recipient reentrancy on TokenManager.deployTokenWithAllocations", async function () {
    const tokenManager = await deployTokenManager();
    const params = buildParams();
    const outerModelId = "outer-allocations";
    const innerModelId = "inner-allocations";

    const innerCallData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      innerModelId,
      "Inner Allocation Token",
      "IAT",
      MODEL_SUPPLIER_ALLOCATION,
      modelSupplier.address,
      INVESTOR_ALLOCATION,
      params,
    ]);

    await expectReentryBlocked({
      tokenManager,
      innerCallData,
      outerModelId,
      innerModelId,
      outerCall: () => tokenManager.deployTokenWithAllocations(
        outerModelId,
        "Outer Allocation Token",
        "OAT",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        params,
        { value: DEPLOYMENT_FEE }
      ),
    });
  });

  it("blocks fee-recipient reentrancy on DeployableTokenManager.deployTokenWithParams", async function () {
    const tokenManager = await deployDeployableTokenManager();
    const params = buildParams();
    const outerModelId = "deployable-outer-params";
    const innerModelId = "deployable-inner-params";

    const innerCallData = tokenManager.interface.encodeFunctionData("deployTokenWithParams", [
      innerModelId,
      "Deployable Inner",
      "DIN",
      parseEther("1000"),
      params,
    ]);

    await expectReentryBlocked({
      tokenManager,
      innerCallData,
      outerModelId,
      innerModelId,
      outerCall: () => tokenManager.deployTokenWithParams(
        outerModelId,
        "Deployable Outer",
        "DOT",
        parseEther("1000"),
        params,
        { value: DEPLOYMENT_FEE }
      ),
    });
  });

  it("blocks fee-recipient reentrancy on DeployableTokenManager.deployTokenWithAllocations", async function () {
    const tokenManager = await deployDeployableTokenManager();
    const params = buildParams();
    const outerModelId = "deployable-outer-allocations";
    const innerModelId = "deployable-inner-allocations";

    const innerCallData = tokenManager.interface.encodeFunctionData("deployTokenWithAllocations", [
      innerModelId,
      "Deployable Inner Allocation",
      "DIA",
      MODEL_SUPPLIER_ALLOCATION,
      modelSupplier.address,
      INVESTOR_ALLOCATION,
      params,
    ]);

    await expectReentryBlocked({
      tokenManager,
      innerCallData,
      outerModelId,
      innerModelId,
      outerCall: () => tokenManager.deployTokenWithAllocations(
        outerModelId,
        "Deployable Outer Allocation",
        "DOA",
        MODEL_SUPPLIER_ALLOCATION,
        modelSupplier.address,
        INVESTOR_ALLOCATION,
        params,
        { value: DEPLOYMENT_FEE }
      ),
    });
  });

  it("reverts AMM sells when the token transferFrom returns false", async function () {
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const reserveToken = await MockUSDC.deploy();
    await reserveToken.waitForDeployment();

    const FalseReturnERC20 = await ethers.getContractFactory("FalseReturnERC20");
    const hokusaiToken = await FalseReturnERC20.deploy();
    await hokusaiToken.waitForDeployment();

    const MockTokenManagerForAMM = await ethers.getContractFactory("MockTokenManagerForAMM");
    const tokenManager = await MockTokenManagerForAMM.deploy();
    await tokenManager.waitForDeployment();
    await tokenManager.setRedeemableSupply(parseEther("1000000"));

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const amm = await HokusaiAMM.deploy(
      await reserveToken.getAddress(),
      await hokusaiToken.getAddress(),
      await tokenManager.getAddress(),
      "slither-amm",
      treasury.address,
      100000,
      30,
      0,
      parseUnits("1000", 6),
      parseUnits("1", 6)
    );
    await amm.waitForDeployment();

    await reserveToken.mint(owner.address, parseUnits("100000", 6));
    await reserveToken.approve(await amm.getAddress(), parseUnits("100000", 6));
    await amm.depositFees(parseUnits("100000", 6));

    await hokusaiToken.mint(seller.address, TOKENS_IN);
    await hokusaiToken.connect(seller).approve(await amm.getAddress(), TOKENS_IN);

    const latestBlock = await ethers.provider.getBlock("latest");
    const deadline = latestBlock.timestamp + 300;

    await expect(
      amm.connect(seller).sell(TOKENS_IN, 0, seller.address, deadline)
    ).to.be.revertedWith("Token transfer failed");
  });
});
