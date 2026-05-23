const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, parseUnits, MaxUint256 } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployTestToken, deployTestTokenAddress } = require("./helpers/tokenDeployment");

describe("HokusaiAMM Purchaser Whitelist Integration", function () {
  let modelRegistry;
  let tokenManager;
  let mockUSDC;
  let whitelist;
  let factory;
  let pool;
  let poolNoWhitelist;
  let token;
  let owner, treasury, buyer, nonWhitelisted;

  const MODEL_ID = "18351";
  const MODEL_ID_2 = "18352";

  beforeEach(async function () {
    [owner, treasury, buyer, nonWhitelisted] = await ethers.getSigners();

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

    const PurchaserWhitelist = await ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy();
    await whitelist.waitForDeployment();

    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    factory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await mockUSDC.getAddress(),
      treasury.address
    );
    await factory.waitForDeployment();
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);

    const tokenAddress = await deployTestTokenAddress(
      tokenManager,
      MODEL_ID,
      "Whitelist Token",
      "WLT",
      parseEther("1"),
      owner.address
    );
    await deployTestToken(tokenManager, MODEL_ID, "Whitelist Token", "WLT", parseEther("1"), owner.address);
    await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, "metric");
    token = await ethers.getContractAt("HokusaiToken", tokenAddress);

    const tokenAddress2 = await deployTestTokenAddress(
      tokenManager,
      MODEL_ID_2,
      "Open Token",
      "OPT",
      parseEther("1"),
      owner.address
    );
    await deployTestToken(tokenManager, MODEL_ID_2, "Open Token", "OPT", parseEther("1"), owner.address);
    await modelRegistry.registerStringModel(MODEL_ID_2, tokenAddress2, "metric");

    const poolAddress = await factory.createPoolWithWhitelist.staticCall(
      MODEL_ID,
      tokenAddress,
      await whitelist.getAddress()
    );
    await factory.createPoolWithWhitelist(MODEL_ID, tokenAddress, await whitelist.getAddress());
    pool = await ethers.getContractAt("HokusaiAMM", poolAddress);
    await tokenManager.authorizeAMM(poolAddress);

    const poolNoWhitelistAddress = await factory.createPool.staticCall(MODEL_ID_2, tokenAddress2);
    await factory.createPool(MODEL_ID_2, tokenAddress2);
    poolNoWhitelist = await ethers.getContractAt("HokusaiAMM", poolNoWhitelistAddress);
    await tokenManager.authorizeAMM(poolNoWhitelistAddress);

    const seed = parseUnits("200000", 6);
    await mockUSDC.mint(owner.address, seed * 2n);
    await mockUSDC.approve(await pool.getAddress(), seed);
    await pool.depositFees(seed);
    await mockUSDC.approve(await poolNoWhitelist.getAddress(), seed);
    await poolNoWhitelist.depositFees(seed);

    await mockUSDC.mint(buyer.address, parseUnits("50000", 6));
    await mockUSDC.mint(nonWhitelisted.address, parseUnits("50000", 6));
    await mockUSDC.connect(buyer).approve(await pool.getAddress(), MaxUint256);
    await mockUSDC.connect(nonWhitelisted).approve(await pool.getAddress(), MaxUint256);
    await mockUSDC.connect(nonWhitelisted).approve(await poolNoWhitelist.getAddress(), MaxUint256);
    await mockUSDC.connect(buyer).approve(await poolNoWhitelist.getAddress(), MaxUint256);

  });

  it("whitelisted buyer can buy", async function () {
    await whitelist.addToWhitelist(buyer.address);

    const buyAmount = parseUnits("1000", 6);
    const before = await token.balanceOf(buyer.address);
    await pool.connect(buyer).buy(buyAmount, 0, buyer.address, (await time.latest()) + 3600);
    const after = await token.balanceOf(buyer.address);

    expect(after).to.be.gt(before);
  });

  it("non-whitelisted buyer cannot buy and state is unchanged", async function () {
    const buyAmount = parseUnits("1000", 6);
    const reserveBefore = await pool.reserveBalance();

    await expect(
      pool.connect(nonWhitelisted).buy(buyAmount, 0, nonWhitelisted.address, (await time.latest()) + 3600)
    ).to.be.revertedWithCustomError(pool, "NotWhitelisted").withArgs(nonWhitelisted.address);

    expect(await pool.reserveBalance()).to.equal(reserveBefore);
  });

  it("ungated pool allows any buyer", async function () {
    expect(await poolNoWhitelist.purchaserWhitelist()).to.equal(ethers.ZeroAddress);

    await expect(
      poolNoWhitelist.connect(nonWhitelisted).buy(parseUnits("1000", 6), 0, nonWhitelisted.address, (await time.latest()) + 3600)
    ).to.not.be.reverted;
  });

  it("setPurchaserWhitelist emits and enforces owner-only", async function () {
    const PurchaserWhitelist = await ethers.getContractFactory("PurchaserWhitelist");
    const newWhitelist = await PurchaserWhitelist.deploy();
    await newWhitelist.waitForDeployment();

    const HokusaiAMM = await ethers.getContractFactory("HokusaiAMM");
    const standalonePool = await HokusaiAMM.deploy(
      await mockUSDC.getAddress(),
      await token.getAddress(),
      await tokenManager.getAddress(),
      "18353",
      treasury.address,
      200000,
      30,
      7 * 24 * 60 * 60,
      parseUnits("25000", 6),
      parseUnits("0.01", 6)
    );
    await standalonePool.waitForDeployment();

    await expect(standalonePool.setPurchaserWhitelist(await newWhitelist.getAddress()))
      .to.emit(standalonePool, "PurchaserWhitelistUpdated")
      .withArgs(ethers.ZeroAddress, await newWhitelist.getAddress());

    await expect(
      standalonePool.connect(buyer).setPurchaserWhitelist(await whitelist.getAddress())
    ).to.be.revertedWith("Ownable: caller is not the owner");
  });

  it("sell remains unrestricted for non-whitelisted holders", async function () {
    await whitelist.addToWhitelist(buyer.address);

    const buyAmount = parseUnits("1000", 6);
    await pool.connect(buyer).buy(buyAmount, 0, buyer.address, (await time.latest()) + 3600);

    const holderBalance = await token.balanceOf(buyer.address);
    await token.connect(buyer).transfer(nonWhitelisted.address, holderBalance / 2n);
    await token.connect(nonWhitelisted).approve(await pool.getAddress(), MaxUint256);

    await time.increase(8 * 24 * 60 * 60);

    await expect(
      pool.connect(nonWhitelisted).sell(holderBalance / 4n, 0, nonWhitelisted.address, (await time.latest()) + 3600)
    ).to.not.be.reverted;

    await expect(
      pool.connect(nonWhitelisted).buy(parseUnits("10", 6), 0, nonWhitelisted.address, (await time.latest()) + 3600)
    ).to.be.revertedWithCustomError(pool, "NotWhitelisted").withArgs(nonWhitelisted.address);
  });

  it("factory createPoolWithWhitelist wires whitelist; createPool remains ungated", async function () {
    expect(await pool.purchaserWhitelist()).to.equal(await whitelist.getAddress());
    expect(await poolNoWhitelist.purchaserWhitelist()).to.equal(ethers.ZeroAddress);
  });
});
