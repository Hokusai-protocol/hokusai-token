const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers } = require("hardhat");

const {
  loadLaunchTokensConfig,
} = require("../../scripts/lib/launch-tokens");
const {
  runLaunchDeploy,
} = require("../../scripts/create-mainnet-pools");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hok-launch-"));
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

describe("mainnet launch deploy flow", function () {
  let owner;
  let supplier1;
  let supplier2;
  let supplier3;
  let governor1;
  let governor2;
  let governor3;
  let usdc;
  let modelRegistry;
  let tokenManager;
  let factory;

  beforeEach(async function () {
    [
      owner,
      supplier1,
      supplier2,
      supplier3,
      governor1,
      governor2,
      governor3,
    ] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();
    await modelRegistry.setStringModelTokenManager(await tokenManager.getAddress());

    const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
    factory = await HokusaiAMMFactory.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await usdc.getAddress(),
      owner.address
    );
    await factory.waitForDeployment();

    await usdc.mint(owner.address, ethers.parseUnits("200000", 6));
  });

  it("deploys three launch tokens with allocation-based creation", async function () {
    const { configPath, tempDir } = loadFixtureWithAddresses({
      "__SUPPLIER_1__": supplier1.address,
      "__SUPPLIER_2__": supplier2.address,
      "__SUPPLIER_3__": supplier3.address,
      "__GOVERNOR_1__": governor1.address,
      "__GOVERNOR_2__": governor2.address,
      "__GOVERNOR_3__": governor3.address,
    });
    const launchConfig = loadLaunchTokensConfig(configPath);

    const datedDeploymentPath = path.join(tempDir, "mainnet-2026-05-13.json");
    const latestDeploymentPath = path.join(tempDir, "mainnet-latest.json");
    const pendingActionsPath = path.join(tempDir, "mainnet-pending-actions.json");

    const deployment = {
      timestamp: "2026-05-13T00:00:00.000Z",
      config: {
        reserveToken: await usdc.getAddress(),
      },
      contracts: {
        ModelRegistry: await modelRegistry.getAddress(),
        TokenManager: await tokenManager.getAddress(),
        HokusaiAMMFactory: await factory.getAddress(),
      },
    };

    const result = await runLaunchDeploy({
      deployment,
      launchConfig,
      expectedChainId: 31337n,
      confirmationDelayMs: 0,
      datedDeploymentPath,
      latestDeploymentPath,
      pendingActionsPath,
    });

    expect(result.deployment.tokens).to.have.lengthOf(3);
    expect(result.deployment.pools).to.have.lengthOf(3);
    expect(fs.existsSync(datedDeploymentPath)).to.equal(true);
    expect(fs.existsSync(latestDeploymentPath)).to.equal(true);
    expect(fs.existsSync(result.pendingActionsPath)).to.equal(true);

    const pendingActions = JSON.parse(fs.readFileSync(result.pendingActionsPath, "utf8"));
    expect(pendingActions.actions).to.have.lengthOf(2);

    for (const config of launchConfig.tokens) {
      const tokenAddress = await tokenManager.getTokenAddress(config.modelId);
      expect(tokenAddress).to.not.equal(ethers.ZeroAddress);

      const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
      const params = await ethers.getContractAt("HokusaiParams", await token.params());
      const poolAddress = await factory.getPool(config.modelId);

      expect(await modelRegistry.isStringRegistered(config.modelId)).to.equal(true);
      expect(await modelRegistry.getStringToken(config.modelId)).to.equal(tokenAddress);
      expect(poolAddress).to.not.equal(ethers.ZeroAddress);

      const supplierWei = ethers.parseUnits(config.supplierAllocation, 18);
      const investorWei = ethers.parseUnits(config.investorAllocation, 18);
      const tokensPerDeltaOneWei = ethers.parseUnits(config.tokensPerDeltaOne, 18);

      expect(await token.modelSupplierAllocation()).to.equal(supplierWei);
      expect(await token.maxSupply()).to.equal(supplierWei + investorWei);
      expect(await params.tokensPerDeltaOne()).to.equal(tokensPerDeltaOneWei);

      const vestingConfig = await params.vestingConfig();
      expect(vestingConfig.enabled).to.equal(config.vestingConfig.enabled);
      expect(vestingConfig.immediateUnlockBps).to.equal(BigInt(config.vestingConfig.immediateUnlockBps));
      expect(vestingConfig.vestingDurationSeconds).to.equal(BigInt(config.vestingConfig.vestingDurationSeconds));
      expect(vestingConfig.cliffSeconds).to.equal(BigInt(config.vestingConfig.cliffSeconds));

      if (config.distributionTiming === "pre-launch") {
        expect(await token.modelSupplierDistributed()).to.equal(true);
        expect(await token.balanceOf(config.supplierRecipient)).to.equal(supplierWei);
      } else {
        expect(await token.modelSupplierDistributed()).to.equal(false);
        expect(await token.balanceOf(config.supplierRecipient)).to.equal(0n);
        expect(
          pendingActions.actions.some((action) => (
            action.modelId === config.modelId &&
            action.tokenAddress === tokenAddress &&
            action.amount === supplierWei.toString()
          ))
        ).to.equal(true);
      }
    }
  });

  it("rejects invalid config before sending transactions", async function () {
    const { configPath } = loadFixtureWithAddresses({
      "__SUPPLIER_1__": supplier1.address,
      "__SUPPLIER_2__": supplier2.address,
      "__SUPPLIER_3__": supplier3.address,
      "__GOVERNOR_1__": governor1.address,
      "__GOVERNOR_2__": governor2.address,
      "__GOVERNOR_3__": governor3.address,
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.tokens[0].supplierRecipient = ethers.ZeroAddress;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await expect(Promise.resolve().then(() => loadLaunchTokensConfig(configPath)))
      .to.be.rejectedWith("supplierRecipient must be non-zero checksum address");
  });

  it("rejects tokensPerDeltaOne below bounds before deployment", async function () {
    const { configPath } = loadFixtureWithAddresses({
      "__SUPPLIER_1__": supplier1.address,
      "__SUPPLIER_2__": supplier2.address,
      "__SUPPLIER_3__": supplier3.address,
      "__GOVERNOR_1__": governor1.address,
      "__GOVERNOR_2__": governor2.address,
      "__GOVERNOR_3__": governor3.address,
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.tokens[0].tokensPerDeltaOne = "50";
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await expect(Promise.resolve().then(() => loadLaunchTokensConfig(configPath)))
      .to.be.rejectedWith("tokensPerDeltaOne out of bounds");
  });

  it("rejects configs that do not define exactly three launch tokens", async function () {
    const { configPath } = loadFixtureWithAddresses({
      "__SUPPLIER_1__": supplier1.address,
      "__SUPPLIER_2__": supplier2.address,
      "__SUPPLIER_3__": supplier3.address,
      "__GOVERNOR_1__": governor1.address,
      "__GOVERNOR_2__": governor2.address,
      "__GOVERNOR_3__": governor3.address,
    });
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.tokens = config.tokens.slice(0, 2);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    await expect(Promise.resolve().then(() => loadLaunchTokensConfig(configPath)))
      .to.be.rejectedWith("Launch config must define exactly 3 tokens");
  });
});
