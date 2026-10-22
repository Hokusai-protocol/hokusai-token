const { expect } = require("chai");
const { ethers, upgrades } = require("hardhat");
const { parseEther, parseUnits, ZeroAddress } = require("ethers");

const { deployTestToken, deployTestTokenAddress } = require("./helpers/tokenDeployment");
const { deployFactoryWithPoolDeployer } = require("./helpers/factoryDeployment");

// HOK-3285: pool ProxyAdmin with exit-safe pause, per-pool freeze, and a fixed
// admin. Timelock wiring is covered in test/governance/Governance.test.js; here
// the owner is an EOA so revert reasons are visible.
describe("HokusaiPoolProxyAdmin", function () {
  const MODEL_A = "8201";
  const MODEL_B = "8202";

  let owner, treasury, outsider;
  let factory, poolDeployer, proxyAdmin, poolA, poolB, v2;

  async function addPool(modelRegistry, tokenManager, modelId) {
    const tokenAddress = await deployTestTokenAddress(tokenManager, modelId, "T", "T", parseEther("1"), owner.address);
    await deployTestToken(tokenManager, modelId, "T", "T", parseEther("1"), owner.address);
    await modelRegistry.registerStringModel(modelId, tokenAddress, "accuracy");
    const poolAddress = await factory.createPool.staticCall(modelId, tokenAddress);
    await factory.createPool(modelId, tokenAddress);
    return ethers.getContractAt("HokusaiAMMV2Mock", poolAddress);
  }

  beforeEach(async function () {
    [owner, treasury, outsider] = await ethers.getSigners();
    const modelRegistry = await ethers.deployContract("ModelRegistry");
    const tokenManager = await ethers.deployContract("TokenManager", [await modelRegistry.getAddress()]);
    const usdc = await ethers.deployContract("MockUSDC");
    ({ factory, poolDeployer } = await deployFactoryWithPoolDeployer(modelRegistry, tokenManager, usdc, treasury));
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);
    proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", await poolDeployer.proxyAdmin());
    poolA = await addPool(modelRegistry, tokenManager, MODEL_A);
    poolB = await addPool(modelRegistry, tokenManager, MODEL_B);
    v2 = await ethers.deployContract("HokusaiAMMV2Mock");
  });

  const implOf = async (pool) => upgrades.erc1967.getImplementationAddress(await pool.getAddress());

  it("is owned by the bootstrap owner and administers every pool", async function () {
    expect(await proxyAdmin.owner()).to.equal(owner.address);
    for (const pool of [poolA, poolB]) {
      expect(await upgrades.erc1967.getAdminAddress(await pool.getAddress())).to.equal(await proxyAdmin.getAddress());
    }
  });

  it("upgrades one pool, preserving its state and leaving the others alone", async function () {
    const reserveBefore = await poolA.reserveBalance();
    await proxyAdmin.upgrade(await poolA.getAddress(), await v2.getAddress());

    expect(await implOf(poolA)).to.equal(await v2.getAddress());
    expect(await poolA.version()).to.equal("v2");
    expect(await poolA.reserveBalance()).to.equal(reserveBefore);
    expect(await poolA.owner()).to.equal(await factory.getAddress());
    expect(await implOf(poolB)).to.equal(await poolDeployer.defaultImplementation());
  });

  it("restricts upgrade, upgradeAndCall and freeze to the owner", async function () {
    const pool = await poolA.getAddress();
    await expect(proxyAdmin.connect(outsider).upgrade(pool, await v2.getAddress())).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(
      proxyAdmin.connect(outsider).upgradeAndCall(pool, await v2.getAddress(), "0x")
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(proxyAdmin.connect(outsider).freezeUpgrades(pool)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
  });

  it("refuses to upgrade a paused pool, and allows it again once unpaused", async function () {
    const pool = await poolA.getAddress();
    await factory.pausePool(MODEL_A);
    await expect(proxyAdmin.upgrade(pool, await v2.getAddress())).to.be.revertedWith("Pool is paused");
    await expect(proxyAdmin.upgradeAndCall(pool, await v2.getAddress(), "0x")).to.be.revertedWith(
      "Pool is paused"
    );

    // Another, unpaused pool is unaffected.
    await proxyAdmin.upgrade(await poolB.getAddress(), await v2.getAddress());

    await factory.unpausePool(MODEL_A);
    await proxyAdmin.upgrade(pool, await v2.getAddress());
    expect(await implOf(poolA)).to.equal(await v2.getAddress());
  });

  it("freezes upgrades for one pool permanently", async function () {
    const pool = await poolA.getAddress();
    await expect(proxyAdmin.freezeUpgrades(pool)).to.emit(proxyAdmin, "UpgradesFrozen").withArgs(pool);
    expect(await proxyAdmin.upgradesFrozen(pool)).to.equal(true);

    await expect(proxyAdmin.upgrade(pool, await v2.getAddress())).to.be.revertedWith("Upgrades frozen");
    await expect(proxyAdmin.upgradeAndCall(pool, await v2.getAddress(), "0x")).to.be.revertedWith(
      "Upgrades frozen"
    );
    await expect(proxyAdmin.freezeUpgrades(pool)).to.be.revertedWith("Upgrades already frozen");
    expect(proxyAdmin.unfreezeUpgrades).to.be.undefined;

    // Freezing is per pool.
    await proxyAdmin.upgrade(await poolB.getAddress(), await v2.getAddress());
  });

  it("only freezes proxies it administers", async function () {
    const { amm } = await require("./helpers/ammDeployment").deployAMMProxyWithAdmin(
      await ethers.getContractFactory("HokusaiAMM"),
      await poolA.reserveToken(),
      await poolA.hokusaiToken(),
      await poolA.tokenManager(),
      "8299",
      treasury.address,
      200000,
      30,
      0,
      parseUnits("25000", 6),
      parseUnits("0.01", 6)
    );
    await expect(proxyAdmin.freezeUpgrades(await amm.getAddress())).to.be.reverted;
  });

  it("cannot hand a proxy to another admin", async function () {
    await expect(proxyAdmin.changeProxyAdmin(await poolA.getAddress(), outsider.address)).to.be.revertedWith(
      "Proxy admin is fixed"
    );
  });

  it("rejects a zero owner", async function () {
    const HokusaiPoolProxyAdmin = await ethers.getContractFactory("HokusaiPoolProxyAdmin");
    await expect(HokusaiPoolProxyAdmin.deploy(ZeroAddress)).to.be.revertedWith("Owner cannot be zero");
  });
});
