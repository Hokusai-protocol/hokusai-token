const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");
const { MaxUint256 } = require("ethers");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { loadLaunchTokensConfig } = require("../../scripts/lib/launch-tokens");
const { runLaunchDeploy } = require("../../scripts/create-mainnet-pools");
const { deployFactoryWithPoolDeployer } = require("../helpers/factoryDeployment");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hok-shared-whitelist-"));
}

function loadFixtureWithAddresses(replacements) {
  const fixturePath = path.join(__dirname, "..", "fixtures", "launch-tokens.fixture.json");
  let raw = fs.readFileSync(fixturePath, "utf8");
  for (const [placeholder, value] of Object.entries(replacements)) {
    raw = raw.replaceAll(placeholder, value);
  }

  const tempDir = makeTempDir();
  const configPath = path.join(tempDir, "launch-config.json");
  fs.writeFileSync(configPath, raw);
  return { configPath, tempDir };
}

describe("shared whitelist launch integration", function () {
  let owner;
  let supplier1;
  let supplier2;
  let supplier3;
  let governor1;
  let governor2;
  let governor3;
  let whitelistedBuyer;
  let nonWhitelistedBuyer;
  let usdc;
  let modelRegistry;
  let tokenManager;
  let factory;
  let whitelist;

  beforeEach(async function () {
    [
      owner,
      supplier1,
      supplier2,
      supplier3,
      governor1,
      governor2,
      governor3,
      whitelistedBuyer,
      nonWhitelistedBuyer,
    ] = await hre.ethers.getSigners();

    const MockUSDC = await hre.ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ModelRegistry = await hre.ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await hre.ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    const RewardVestingVault = await hre.ethers.getContractFactory("RewardVestingVault");
    const vestingVault = await RewardVestingVault.deploy(await tokenManager.getAddress());
    await vestingVault.waitForDeployment();
    await tokenManager.setVestingVault(await vestingVault.getAddress());

    const PurchaserWhitelist = await hre.ethers.getContractFactory("PurchaserWhitelist");
    whitelist = await PurchaserWhitelist.deploy(owner.address);
    await whitelist.waitForDeployment();

    ({ factory } = await deployFactoryWithPoolDeployer(modelRegistry, tokenManager, usdc, owner));
    await modelRegistry.setPoolRegistrar(await factory.getAddress(), true);
    await usdc.mint(owner.address, hre.ethers.parseUnits("200000", 6));
    await usdc.mint(whitelistedBuyer.address, hre.ethers.parseUnits("50000", 6));
    await usdc.mint(nonWhitelistedBuyer.address, hre.ethers.parseUnits("50000", 6));
  });

  it("blocks non-whitelisted buyers and allows whitelisted buyers across all launch pools", async function () {
    const { configPath, tempDir } = loadFixtureWithAddresses({
      "__SUPPLIER_1__": supplier1.address,
      "__SUPPLIER_2__": supplier2.address,
      "__SUPPLIER_3__": supplier3.address,
      "__GOVERNOR_1__": governor1.address,
      "__GOVERNOR_2__": governor2.address,
      "__GOVERNOR_3__": governor3.address,
    });
    const launchConfig = loadLaunchTokensConfig(configPath);
    const deployment = {
      timestamp: "2026-05-13T00:00:00.000Z",
      config: { reserveToken: await usdc.getAddress() },
      contracts: {
        ModelRegistry: await modelRegistry.getAddress(),
        TokenManager: await tokenManager.getAddress(),
        HokusaiAMMFactory: await factory.getAddress(),
        PurchaserWhitelist: await whitelist.getAddress(),
      },
    };

    await runLaunchDeploy({
      deployment,
      launchConfig,
      expectedChainId: 31337n,
      confirmationDelayMs: 0,
      datedDeploymentPath: path.join(tempDir, "mainnet-2026-05-13.json"),
      latestDeploymentPath: path.join(tempDir, "mainnet-latest.json"),
      pendingActionsPath: path.join(tempDir, "mainnet-pending-actions.json"),
    });

    await whitelist.addToWhitelist(whitelistedBuyer.address);

    for (const config of launchConfig.tokens) {
      const poolAddress = await factory.getPool(config.modelId);
      const pool = await hre.ethers.getContractAt("HokusaiAMM", poolAddress);
      const token = await hre.ethers.getContractAt("HokusaiToken", await tokenManager.getTokenAddress(config.modelId));

      await usdc.connect(whitelistedBuyer).approve(poolAddress, MaxUint256);
      await usdc.connect(nonWhitelistedBuyer).approve(poolAddress, MaxUint256);

      await expect(
        pool.connect(nonWhitelistedBuyer).buy(
          hre.ethers.parseUnits("1000", 6),
          0,
          nonWhitelistedBuyer.address,
          (await time.latest()) + 3600
        )
      ).to.be.revertedWithCustomError(pool, "NotWhitelisted").withArgs(nonWhitelistedBuyer.address);

      const beforeBalance = await token.balanceOf(whitelistedBuyer.address);
      await pool.connect(whitelistedBuyer).buy(
        hre.ethers.parseUnits("1000", 6),
        0,
        whitelistedBuyer.address,
        (await time.latest()) + 3600
      );
      const afterBalance = await token.balanceOf(whitelistedBuyer.address);
      expect(afterBalance).to.be.greaterThan(beforeBalance);
    }

    await whitelist.removeFromWhitelist(whitelistedBuyer.address);
    const poolAddress = await factory.getPool(launchConfig.tokens[0].modelId);
    const pool = await hre.ethers.getContractAt("HokusaiAMM", poolAddress);
    await expect(
      pool.connect(whitelistedBuyer).buy(
        hre.ethers.parseUnits("1000", 6),
        0,
        whitelistedBuyer.address,
        (await time.latest()) + 3600
      )
    ).to.be.revertedWithCustomError(pool, "NotWhitelisted").withArgs(whitelistedBuyer.address);
  });
});
