const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

const { deployTestToken, deployTestTokenAddress } = require("./helpers/tokenDeployment");
const { deployFactoryWithPoolDeployer } = require("./helpers/factoryDeployment");

describe("HokusaiAMMPoolDeployer", function () {
  const MODEL_ID = "1846";
  const FLAT_CURVE_THRESHOLD = parseUnits("25000", 6);
  const FLAT_CURVE_PRICE = parseUnits("0.01", 6);

  let owner;
  let treasury;
  let outsider;
  let modelRegistry;
  let tokenManager;
  let mockUSDC;
  let factory;
  let poolDeployer;
  let tokenAddress;

  beforeEach(async function () {
    [owner, treasury, outsider] = await ethers.getSigners();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDC.deploy();
    await mockUSDC.waitForDeployment();

    ({ factory, poolDeployer } = await deployFactoryWithPoolDeployer(
      modelRegistry,
      tokenManager,
      mockUSDC,
      treasury
    ));
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);

    tokenAddress = await deployTestTokenAddress(
      tokenManager,
      MODEL_ID,
      "Pool Deployer Token",
      "POOL",
      parseEther("1"),
      owner.address
    );
    await deployTestToken(
      tokenManager,
      MODEL_ID,
      "Pool Deployer Token",
      "POOL",
      parseEther("1"),
      owner.address
    );
    await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, "accuracy");
  });

  it("rejects direct EOA deployPool calls", async function () {
    await expect(
      poolDeployer.connect(outsider).deployPool(
        await mockUSDC.getAddress(),
        tokenAddress,
        await tokenManager.getAddress(),
        MODEL_ID,
        treasury.address,
        200000,
        30,
        7 * 24 * 60 * 60,
        FLAT_CURVE_THRESHOLD,
        FLAT_CURVE_PRICE
      )
    ).to.be.revertedWith("OnlyFactory");
  });

  it("rejects deployPool calls proxied by a non-factory contract", async function () {
    const PoolDeployerCaller = await ethers.getContractFactory("PoolDeployerCaller");
    const caller = await PoolDeployerCaller.deploy();
    await caller.waitForDeployment();

    await expect(
      caller.callDeployPool(
        await poolDeployer.getAddress(),
        await mockUSDC.getAddress(),
        tokenAddress,
        await tokenManager.getAddress(),
        MODEL_ID,
        treasury.address,
        200000,
        30,
        7 * 24 * 60 * 60,
        FLAT_CURVE_THRESHOLD,
        FLAT_CURVE_PRICE
      )
    ).to.be.revertedWith("OnlyFactory");
  });

  it("hands pool ownership back to the factory after deployment", async function () {
    const poolAddress = await factory.createPool.staticCall(MODEL_ID, tokenAddress);
    await factory.createPool(MODEL_ID, tokenAddress);

    const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);
    expect(await pool.owner()).to.equal(await factory.getAddress());
  });

  it("rejects a second pool deployer configuration", async function () {
    const HokusaiAMMPoolDeployer = await ethers.getContractFactory("HokusaiAMMPoolDeployer");
    const otherPoolDeployer = await HokusaiAMMPoolDeployer.deploy(await factory.getAddress());
    await otherPoolDeployer.waitForDeployment();

    await expect(
      factory.setPoolDeployer(await otherPoolDeployer.getAddress())
    ).to.be.revertedWith("PoolDeployerAlreadySet");
  });

  it("rejects non-owner pool deployer configuration", async function () {
    const HokusaiAMMPoolDeployer = await ethers.getContractFactory("HokusaiAMMPoolDeployer");
    const otherPoolDeployer = await HokusaiAMMPoolDeployer.deploy(await factory.getAddress());
    await otherPoolDeployer.waitForDeployment();

    await expect(
      factory.connect(outsider).setPoolDeployer(await otherPoolDeployer.getAddress())
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("rejects a zero-address pool deployer", async function () {
    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    const unconfiguredFactory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await mockUSDC.getAddress(),
      treasury.address
    );
    await unconfiguredFactory.waitForDeployment();

    await expect(
      unconfiguredFactory.setPoolDeployer(ZeroAddress)
    ).to.be.revertedWithCustomError(unconfiguredFactory, "ZeroAddress");
  });

  it("rejects pool creation until the deployer is configured", async function () {
    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    const unconfiguredFactory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await mockUSDC.getAddress(),
      treasury.address
    );
    await unconfiguredFactory.waitForDeployment();
    await modelRegistry.setPoolRegistrar(await unconfiguredFactory.getAddress(), true);

    await expect(
      unconfiguredFactory.createPool(MODEL_ID, tokenAddress)
    ).to.be.revertedWith("PoolDeployerNotSet");
  });
});
