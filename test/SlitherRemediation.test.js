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

  // With pull-payment, deployToken* no longer pushes ETH to feeRecipient during execution.
  // Fees accumulate in the contract and are withdrawn by the owner via withdrawDeploymentFees().
  // Reentrancy on withdrawDeploymentFees is blocked by nonReentrant.

  async function expectDeploymentRetainsFee(outerCall, tokenManager, outerModelId) {
    await tokenManager.setDeploymentFee(DEPLOYMENT_FEE);
    await expect(outerCall()).to.not.be.reverted;
    expect(await tokenManager.hasToken(outerModelId)).to.equal(true);
    // Fee is held in the contract, not pushed to feeRecipient
    const balance = await ethers.provider.getBalance(await tokenManager.getAddress());
    expect(balance).to.equal(DEPLOYMENT_FEE);
  }

  it("deployment retains fee in contract (pull-payment) on TokenManager.deployTokenWithParams", async function () {
    const tokenManager = await deployTokenManager();
    const params = buildParams();
    const outerModelId = "outer-params";

    await expectDeploymentRetainsFee(
      () => tokenManager.deployTokenWithParams(
        outerModelId, "Outer Token", "OUT", parseEther("1000"), params, { value: DEPLOYMENT_FEE }
      ),
      tokenManager,
      outerModelId
    );
  });

  it("deployment retains fee in contract (pull-payment) on TokenManager.deployTokenWithAllocations", async function () {
    const tokenManager = await deployTokenManager();
    const params = buildParams();
    const outerModelId = "outer-allocations";

    await expectDeploymentRetainsFee(
      () => tokenManager.deployTokenWithAllocations(
        outerModelId, "Outer Allocation Token", "OAT",
        MODEL_SUPPLIER_ALLOCATION, modelSupplier.address, INVESTOR_ALLOCATION,
        params, { value: DEPLOYMENT_FEE }
      ),
      tokenManager,
      outerModelId
    );
  });

  it("deployment retains fee in contract (pull-payment) on DeployableTokenManager.deployTokenWithParams", async function () {
    const tokenManager = await deployDeployableTokenManager();
    const params = buildParams();
    const outerModelId = "deployable-outer-params";

    await expectDeploymentRetainsFee(
      () => tokenManager.deployTokenWithParams(
        outerModelId, "Deployable Outer", "DOT", parseEther("1000"), params, { value: DEPLOYMENT_FEE }
      ),
      tokenManager,
      outerModelId
    );
  });

  it("deployment retains fee in contract (pull-payment) on DeployableTokenManager.deployTokenWithAllocations", async function () {
    const tokenManager = await deployDeployableTokenManager();
    const params = buildParams();
    const outerModelId = "deployable-outer-allocations";

    await expectDeploymentRetainsFee(
      () => tokenManager.deployTokenWithAllocations(
        outerModelId, "Deployable Outer Allocation", "DOA",
        MODEL_SUPPLIER_ALLOCATION, modelSupplier.address, INVESTOR_ALLOCATION,
        params, { value: DEPLOYMENT_FEE }
      ),
      tokenManager,
      outerModelId
    );
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
