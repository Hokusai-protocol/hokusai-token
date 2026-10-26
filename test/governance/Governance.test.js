const { expect } = require("chai");
const hre = require("hardhat");
const { ethers } = hre;
const { ZeroAddress, ZeroHash, id, parseEther } = require("ethers");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");
const { buildInitialParams } = require("../helpers/tokenDeployment");
const { loadPolicy, runGovernanceTransfer, verifyGovernance } = require("../../scripts/governance/lib");

describe("Governance transfer and timelock controls", function () {
  const MODEL_ID = "701";
  const TOKEN_NAME = "Governance Token";
  const TOKEN_SYMBOL = "GOV701";
  const MIN_DELAY = 2;

  // Hermeticity: hardhat loads .env(.sepolia), which may define ops governance addresses
  // (e.g. ADMIN_SAFE_ADDRESS = the real mainnet Safe). getGovernanceContext prefers those env
  // vars over deployment.governance, which would make the lib check a Safe this test's timelock
  // never granted (pre-flight fails with "adminSafe proposer/executor/canceller"). Clear them so
  // the lib resolves adminSafe/timelock from this test's self-contained deployment artifact.
  const GOV_ENV_KEYS = [
    "ADMIN_SAFE_ADDRESS",
    "EMERGENCY_SAFE_ADDRESS",
    "TIMELOCK_ADDRESS",
    "TIMELOCK_MIN_DELAY",
    "SUBMITTER_RELAYER_ADDRESS",
    "MAINNET_BACKEND_ADDRESS",
  ];
  let savedGovEnv;
  before(function () {
    savedGovEnv = {};
    for (const key of GOV_ENV_KEYS) {
      savedGovEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  after(function () {
    for (const key of GOV_ENV_KEYS) {
      if (savedGovEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedGovEnv[key];
      }
    }
  });

  async function scheduleAndExecute(timelock, safe, target, data, delay = MIN_DELAY) {
    const salt = id(`salt:${target}:${data}`);
    await timelock.connect(safe).schedule(target, 0, data, ZeroHash, salt, delay);
    await expect(
      timelock.connect(safe).execute(target, 0, data, ZeroHash, salt)
    ).to.be.reverted;
    await hre.network.provider.send("evm_increaseTime", [delay + 1]);
    await hre.network.provider.send("evm_mine");
    await timelock.connect(safe).execute(target, 0, data, ZeroHash, salt);
  }

  async function deployFixture() {
    await hre.network.provider.send("hardhat_reset");
    const [deployer, treasury, backendService, safe, emergencySafe, outsider, controller] =
      await ethers.getSigners();

    const result = await deployFullStack(
      {
        name: "sepolia",
        expectedChainId: 11155111n,
        reserveTokenAddress: null,
        factoryDefaults: {
          crr: 200000,
          tradeFee: 30,
          ibrDuration: 7 * 24 * 60 * 60,
          flatCurveThreshold: 25000n * 10n ** 6n,
          flatCurvePrice: 10000,
        },
        deltaVerifierParams: {
          baseRewardRate: 1000,
          minImprovementBps: 100,
          maxReward: 10n ** 24n,
        },
        infrastructureCostOracleParams: {
          initialGrossMarginBps: 1500,
        },
        treasury: treasury.address,
        backendService: backendService.address,
        verifierAddress: deployer.address,
        minDeployerBalanceEth: "0.1",
        maxGasPriceGwei: null,
        confirmationPauseSeconds: 0,
      },
      {
        hre,
        dryRun: true,
        skipArtifactWrite: true,
        logger: { log() {}, warn() {} },
        scriptPaths: [__filename],
      }
    );

    const artifact = await result.artifact({ timestamp: "2026-05-22T00:00:00.000Z" });
    artifact.roles.DeltaVerifier.PAUSER_ROLE = [deployer.address];
    artifact.roles.InfrastructureReserve.PAUSER_ROLE = [deployer.address];

    const tokenManager = await ethers.getContractAt(result.contracts._tokenManagerImpl, result.contracts.TokenManager);
    const modelRegistry = await ethers.getContractAt("ModelRegistry", result.contracts.ModelRegistry);
    const factory = await ethers.getContractAt("HokusaiAMMFactory", result.contracts.HokusaiAMMFactory);
    const deltaVerifier = await ethers.getContractAt("DeltaVerifier", result.contracts.DeltaVerifier);
    const infraReserve = await ethers.getContractAt("InfrastructureReserve", result.contracts.InfrastructureReserve);
    const paramsInput = buildInitialParams(deployer.address);

    const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
      MODEL_ID,
      TOKEN_NAME,
      TOKEN_SYMBOL,
      parseEther("100000"),
      paramsInput
    );
    await tokenManager.deployTokenWithParams(
      MODEL_ID,
      TOKEN_NAME,
      TOKEN_SYMBOL,
      parseEther("100000"),
      paramsInput
    );
    await modelRegistry.registerStringModel(MODEL_ID, tokenAddress, "accuracy");
    await factory.createPool(MODEL_ID, tokenAddress);
    const poolAddress = await factory.getPool(MODEL_ID);

    const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
    const params = await ethers.getContractAt("HokusaiParams", await token.params());
    const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);

    artifact.tokens = [
      {
        modelId: MODEL_ID,
        address: tokenAddress,
        paramsAddress: await token.params(),
      },
    ];
    artifact.pools = [
      {
        modelId: MODEL_ID,
        ammAddress: poolAddress,
      },
    ];

    const Timelock = await ethers.getContractFactory("HokusaiTimelockController");
    const timelock = await Timelock.connect(deployer).deploy(
      MIN_DELAY,
      [safe.address],
      [safe.address],
      ZeroAddress
    );
    await timelock.waitForDeployment();

    artifact.governance = {
      timelock: await timelock.getAddress(),
      adminSafe: safe.address,
      emergencySafe: emergencySafe.address,
      minDelay: MIN_DELAY,
    };

    const policy = loadPolicy();

    return {
      artifact,
      policy,
      deployer,
      treasury,
      backendService,
      safe,
      emergencySafe,
      outsider,
      controller,
      modelRegistry,
      tokenManager,
      token,
      params,
      factory,
      deltaVerifier,
      infraReserve,
      pool,
      timelock,
    };
  }

  it("transfers governance, enforces timelock admin calls, and preserves fast pause", async function () {
    const fixture = await deployFixture();
    const {
      artifact,
      policy,
      deployer,
      safe,
      emergencySafe,
      outsider,
      controller,
      modelRegistry,
      tokenManager,
      token,
      params,
      factory,
      deltaVerifier,
      infraReserve,
      pool,
      timelock,
    } = fixture;

    expect(await timelock.hasRole(await timelock.PROPOSER_ROLE(), safe.address)).to.equal(true);
    expect(await timelock.hasRole(await timelock.EXECUTOR_ROLE(), safe.address)).to.equal(true);
    expect(await timelock.hasRole(await timelock.CANCELLER_ROLE(), safe.address)).to.equal(true);
    expect(await timelock.hasRole(await timelock.TIMELOCK_ADMIN_ROLE(), deployer.address)).to.equal(false);
    expect(await deltaVerifier.hasRole(await deltaVerifier.PAUSER_ROLE(), deployer.address)).to.equal(true);
    expect(await infraReserve.hasRole(await infraReserve.PAUSER_ROLE(), deployer.address)).to.equal(true);

    await runGovernanceTransfer({
      hre,
      deployment: artifact,
      policy,
      dryRun: false,
      logger: { log() {} },
    });

    expect(await modelRegistry.owner()).to.equal(await timelock.getAddress());
    // Per-model token ownership stays at the admin Safe (the governor), NOT the timelock
    // (H-1 / launch decision 2026-06-30): the token's only owner-power is setController, kept
    // under the 2-of-3 Safe rather than 48h-timelocked. The deployer never owns the token, so
    // the handoff does not move it.
    expect(await token.owner()).to.equal(safe.address);
    expect(await factory.owner()).to.equal(await timelock.getAddress());

    await expect(
      modelRegistry.connect(outsider).registerStringModel("702", await token.getAddress(), "accuracy")
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(
      modelRegistry.connect(deployer).registerStringModel("702", await token.getAddress(), "accuracy")
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      token.connect(outsider).setController(outsider.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(
      token.connect(deployer).setController(deployer.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(
      tokenManager.connect(outsider).setDeltaVerifier(outsider.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(
      tokenManager.connect(deployer).setDeltaVerifier(deployer.address)
    ).to.be.revertedWith("Ownable: caller is not the owner");

    await expect(deltaVerifier.connect(outsider).setBaseRewardRate(123)).to.be.reverted;
    await expect(deltaVerifier.connect(deployer).setBaseRewardRate(123)).to.be.reverted;
    await expect(factory.connect(outsider).setDefaults(210000, 25, 7 * 24 * 60 * 60)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(factory.connect(deployer).setDefaults(210000, 25, 7 * 24 * 60 * 60)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(infraReserve.connect(outsider).setTreasury(outsider.address)).to.be.reverted;
    await expect(infraReserve.connect(deployer).setTreasury(deployer.address)).to.be.reverted;
    await expect(params.connect(outsider).setTokensPerDeltaOne(parseEther("600000"))).to.be.reverted;
    await expect(params.connect(deployer).setTokensPerDeltaOne(parseEther("600000"))).to.be.reverted;

    const updateMetricData = modelRegistry.interface.encodeFunctionData("updateStringMetric", [MODEL_ID, "precision"]);
    await scheduleAndExecute(timelock, safe, await modelRegistry.getAddress(), updateMetricData);
    const metricInfo = await modelRegistry.modelsByString(MODEL_ID);
    expect(metricInfo.performanceMetric).to.equal("precision");

    // DeltaVerifier DEFAULT_ADMIN intentionally stays at the 2-of-3 admin Safe (not the timelock)
    // so mint-config changes are immediate, not 48h-delayed (security review H-3). The Safe calls
    // admin functions directly; the timelock has no admin power over DeltaVerifier.
    await expect(
      scheduleAndExecute(
        timelock,
        safe,
        await deltaVerifier.getAddress(),
        deltaVerifier.interface.encodeFunctionData("setBaseRewardRate", [4321])
      )
    ).to.be.reverted;
    await (await deltaVerifier.connect(safe).setBaseRewardRate(4321)).wait();
    expect(await deltaVerifier.baseRewardRate()).to.equal(4321);

    await deltaVerifier.connect(emergencySafe).pause();
    expect(await deltaVerifier.paused()).to.equal(true);
    await expect(deltaVerifier.connect(emergencySafe).unpause()).to.be.reverted; // PAUSER cannot unpause
    await expect(deltaVerifier.connect(deployer).pause()).to.be.reverted;
    // Unpause is DEFAULT_ADMIN -> the admin Safe (immediate), not the timelock.
    await (await deltaVerifier.connect(safe).unpause()).wait();
    expect(await deltaVerifier.paused()).to.equal(false);

    await infraReserve.connect(emergencySafe).pause();
    expect(await infraReserve.paused()).to.equal(true);
    await expect(infraReserve.connect(emergencySafe).unpause()).to.be.reverted;
    await expect(infraReserve.connect(deployer).pause()).to.be.reverted;
    await scheduleAndExecute(
      timelock,
      safe,
      await infraReserve.getAddress(),
      infraReserve.interface.encodeFunctionData("unpause", [])
    );
    expect(await infraReserve.paused()).to.equal(false);

    await factory.connect(emergencySafe).pausePool(MODEL_ID);
    expect(await pool.paused()).to.equal(true);
    await expect(factory.connect(emergencySafe).unpausePool(MODEL_ID)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await scheduleAndExecute(
      timelock,
      safe,
      await factory.getAddress(),
      factory.interface.encodeFunctionData("unpausePool", [MODEL_ID])
    );
    expect(await pool.paused()).to.equal(false);

    const report = await verifyGovernance({ hre, deployment: artifact, policy });
    if (report.overall !== "pass") {
      console.log(report.checks.filter((check) => check.status === "fail"));
    }
    expect(report.overall).to.equal("pass");
  });

  it("routes SUBMITTER to the relayer and strips the deployer's bootstrap SUBMITTER/RECORDER without re-granting", async function () {
    // Regression for the mainnet 2026-07-01 incident: the handoff policy resolved
    // DeltaVerifier.SUBMITTER_ROLE / DataContributionRegistry.RECORDER_ROLE via DEPLOYMENT_ROLE,
    // which points at the bootstrap deployer, and neither was in revokedFromDeployer — so the
    // handoff re-granted the deployer both roles right after a pre-handoff cleanup, forcing a
    // post-handoff Safe round. The policy now grants SUBMITTER to the RELAYER and revokes the
    // deployer's SUBMITTER + RECORDER, producing the correct end-state in one pass.
    const fixture = await deployFixture();
    const { artifact, policy, deployer, backendService, deltaVerifier } = fixture;
    const dataRegistry = await ethers.getContractAt(
      "DataContributionRegistry",
      artifact.contracts.DataContributionRegistry
    );
    const SUBMITTER = await deltaVerifier.SUBMITTER_ROLE();
    const RECORDER = await dataRegistry.RECORDER_ROLE();
    const deltaVerifierAddress = await deltaVerifier.getAddress();

    // Bootstrap state from deploy: deployer holds both roles, relayer holds neither.
    expect(await deltaVerifier.hasRole(SUBMITTER, deployer.address)).to.equal(true);
    expect(await deltaVerifier.hasRole(SUBMITTER, backendService.address)).to.equal(false);
    expect(await dataRegistry.hasRole(RECORDER, deployer.address)).to.equal(true);
    expect(await dataRegistry.hasRole(RECORDER, deltaVerifierAddress)).to.equal(true);

    // The relayer is the canonical SUBMITTER holder for the handoff (resolves the "RELAYER" symbol).
    artifact.governance.submitterRelayer = backendService.address;

    await runGovernanceTransfer({ hre, deployment: artifact, policy, dryRun: false, logger: { log() {} } });

    // Relayer can submit; deployer is stripped of both and NOT re-granted; DeltaVerifier keeps RECORDER.
    expect(await deltaVerifier.hasRole(SUBMITTER, backendService.address)).to.equal(true);
    expect(await deltaVerifier.hasRole(SUBMITTER, deployer.address)).to.equal(false);
    expect(await dataRegistry.hasRole(RECORDER, deltaVerifierAddress)).to.equal(true);
    expect(await dataRegistry.hasRole(RECORDER, deployer.address)).to.equal(false);
  });
  // HOK-3285: pool upgrades are owned by the timelock through HokusaiPoolProxyAdmin.
  async function handedOffFixture() {
    const fixture = await deployFixture();
    await runGovernanceTransfer({
      hre,
      deployment: fixture.artifact,
      policy: fixture.policy,
      dryRun: false,
      logger: { log() {} },
    });
    // Past the pool's buy-only period; the ProxyAdmin refuses upgrades before then.
    await hre.network.provider.send("evm_setNextBlockTimestamp", [Number(await fixture.pool.buyOnlyUntil())]);
    await hre.network.provider.send("evm_mine");
    const proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", fixture.artifact.contracts.PoolProxyAdmin);
    const v2 = await ethers.deployContract("HokusaiAMMV2Mock");
    const upgradeData = proxyAdmin.interface.encodeFunctionData("upgrade", [
      await fixture.pool.getAddress(),
      await v2.getAddress(),
    ]);
    return { ...fixture, proxyAdmin, v2, upgradeData };
  }

  async function poolImplementation(pool) {
    return hre.upgrades.erc1967.getImplementationAddress(await pool.getAddress());
  }

  async function schedule(timelock, safe, target, data, label) {
    const salt = id(`salt:${label}`);
    await timelock.connect(safe).schedule(target, 0, data, ZeroHash, salt, MIN_DELAY);
    return salt;
  }

  async function elapse() {
    await hre.network.provider.send("evm_increaseTime", [MIN_DELAY + 1]);
    await hre.network.provider.send("evm_mine");
  }

  it("hands the pool ProxyAdmin to the timelock and verifies proxy wiring and deployer revocation", async function () {
    const { artifact, policy, deployer, tokenManager, pool, proxyAdmin, timelock } = await handedOffFixture();

    expect(await proxyAdmin.owner()).to.equal(await timelock.getAddress());
    expect(await hre.upgrades.erc1967.getAdminAddress(await pool.getAddress())).to.equal(
      await proxyAdmin.getAddress()
    );
    expect(await tokenManager.hasRole(await tokenManager.MINTER_ROLE(), deployer.address)).to.equal(false);
    expect(await tokenManager.hasRole(await tokenManager.DEPLOYER_ROLE(), deployer.address)).to.equal(false);

    const report = await verifyGovernance({ hre, deployment: artifact, policy });
    const failures = report.checks.filter((check) => check.status === "fail");
    expect(failures).to.deep.equal([]);
    const checkNames = report.checks.map((check) => `${check.contract}:${check.check}`);
    for (const expected of [
      "PoolProxyAdmin:owner",
      "HokusaiAMM[0]:proxyImplementation",
      "HokusaiAMM[0]:proxyAdmin",
      `HokusaiAMM[0]:ModelRegistry.getPool(${MODEL_ID})`,
      "HokusaiAMM[0]:TokenManager.MINTER_ROLE not held",
      "HokusaiAMMFactory:poolImplementation",
      "TokenManager:deployer-MINTER_ROLE-revoked",
      "UsageFeeRouter:deployer-FEE_DEPOSITOR_ROLE-revoked",
      "PurchaserWhitelist:deployer-WHITELIST_ADMIN_ROLE-revoked",
    ]) {
      expect(checkNames).to.include(expected);
    }
  });

  it("flags a deployer that still holds a role, and an unapproved pool implementation", async function () {
    const { artifact, policy, tokenManager, deployer, pool, proxyAdmin, v2, timelock, safe, upgradeData } =
      await handedOffFixture();

    // The deployer no longer administers TokenManager roles; impersonate the timelock to re-grant.
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [await timelock.getAddress()] });
    await hre.network.provider.send("hardhat_setBalance", [await timelock.getAddress(), "0xDE0B6B3A7640000"]);
    const timelockSigner = await ethers.getSigner(await timelock.getAddress());
    await tokenManager.connect(timelockSigner).grantRole(await tokenManager.MINTER_ROLE(), deployer.address);
    await hre.network.provider.request({ method: "hardhat_stopImpersonatingAccount", params: [await timelock.getAddress()] });

    const salt = await schedule(timelock, safe, await proxyAdmin.getAddress(), upgradeData, "flag-upgrade");
    await elapse();
    await timelock.connect(safe).execute(await proxyAdmin.getAddress(), 0, upgradeData, ZeroHash, salt);
    expect(await poolImplementation(pool)).to.equal(await v2.getAddress());

    let report = await verifyGovernance({ hre, deployment: artifact, policy });
    const failed = report.checks.filter((check) => check.status === "fail").map((check) => `${check.contract}:${check.check}`);
    expect(failed).to.have.members(["TokenManager:deployer-MINTER_ROLE-revoked", "HokusaiAMM[0]:proxyImplementation"]);

    // Recording the governance-approved implementation clears the slot check.
    artifact.upgrades = { approvedPoolImplementations: [await v2.getAddress()] };
    report = await verifyGovernance({ hre, deployment: artifact, policy });
    expect(report.checks.filter((check) => check.status === "fail").map((check) => check.check)).to.deep.equal([
      "deployer-MINTER_ROLE-revoked",
    ]);
  });

  it("refuses a handoff whose policy resolves a role to the deployer", async function () {
    const { artifact, policy, deployer } = await deployFixture();
    // e.g. TREASURY_ADDRESS unset, so the treasury (InfrastructureReserve payer) fell back to the deployer.
    artifact.roles.InfrastructureReserve.PAYER_ROLE = [deployer.address];

    await expect(
      runGovernanceTransfer({ hre, deployment: artifact, policy, dryRun: true, logger: { log() {} } })
    ).to.be.rejectedWith(/resolves these to the deployer .*InfrastructureReserve\.PAYER_ROLE/);
  });

  it("audits the recorded deployer, the timelock delay floor and unrecorded pools", async function () {
    const { artifact, policy, deployer, outsider } = await handedOffFixture();
    const names = (report) => report.checks.map((check) => `${check.contract}:${check.check}`);
    const failed = (report) =>
      report.checks.filter((check) => check.status === "fail").map((check) => `${check.contract}:${check.check}`);

    let report = await verifyGovernance({ hre, deployment: artifact, policy });
    expect(names(report)).to.include.members([
      "Timelock:minDelay",
      "Timelock:deployer-proposer/executor/canceller-revoked",
      "HokusaiAMMFactory:poolCount matches deployment.pools",
    ]);
    expect(failed(report)).to.deep.equal([]);

    // A pool missing from the artifact is caught rather than silently unchecked.
    const recordedPools = artifact.pools;
    artifact.pools = [];
    expect(failed(await verifyGovernance({ hre, deployment: artifact, policy }))).to.include(
      "HokusaiAMMFactory:poolCount matches deployment.pools"
    );
    artifact.pools = recordedPools;

    // The audited deployer is the artifact's, whatever key is loaded.
    expect(artifact.deployer).to.equal(deployer.address);
    artifact.deployer = outsider.address;
    report = await verifyGovernance({ hre, deployment: artifact, policy });
    expect(report.checks.find((check) => check.check === "TIMELOCK_ADMIN_ROLE").expected).to.equal(outsider.address);
  });

  it("only upgrades pools through a delayed, cancellable timelock operation", async function () {
    const { deployer, safe, emergencySafe, outsider, pool, proxyAdmin, v2, timelock, upgradeData } =
      await handedOffFixture();
    const defaultImplementation = await poolImplementation(pool);
    const target = await proxyAdmin.getAddress();
    const poolAddress = await pool.getAddress();

    // Unauthorized: nobody but the timelock can upgrade, including the Safe and the deployer.
    for (const signer of [outsider, deployer, safe, emergencySafe]) {
      await expect(proxyAdmin.connect(signer).upgrade(poolAddress, await v2.getAddress())).to.be.revertedWith(
        "Ownable: caller is not the owner"
      );
    }
    await expect(
      timelock.connect(outsider).schedule(target, 0, upgradeData, ZeroHash, id("x"), MIN_DELAY)
    ).to.be.reverted;

    // Early: a scheduled upgrade cannot run before the delay.
    const salt = await schedule(timelock, safe, target, upgradeData, "early");
    await expect(timelock.connect(safe).execute(target, 0, upgradeData, ZeroHash, salt)).to.be.revertedWith(
      "TimelockController: operation is not ready"
    );

    // Cancellation: a cancelled upgrade can never execute.
    const operationId = await timelock.hashOperation(target, 0, upgradeData, ZeroHash, salt);
    await timelock.connect(safe).cancel(operationId);
    await elapse();
    await expect(timelock.connect(safe).execute(target, 0, upgradeData, ZeroHash, salt)).to.be.revertedWith(
      "TimelockController: operation is not ready"
    );
    expect(await poolImplementation(pool)).to.equal(defaultImplementation);

    // Delayed: after the delay the upgrade applies and pool state survives.
    const reserveBefore = await pool.reserveBalance();
    const salt2 = await schedule(timelock, safe, target, upgradeData, "delayed");
    await elapse();
    await timelock.connect(safe).execute(target, 0, upgradeData, ZeroHash, salt2);
    expect(await poolImplementation(pool)).to.equal(await v2.getAddress());
    const upgraded = await ethers.getContractAt("HokusaiAMMV2Mock", poolAddress);
    expect(await upgraded.version()).to.equal("v2");
    expect(await upgraded.reserveBalance()).to.equal(reserveBefore);
  });

  it("refuses timelocked upgrades of paused or frozen pools", async function () {
    const { safe, emergencySafe, factory, pool, proxyAdmin, timelock, upgradeData } = await handedOffFixture();
    const target = await proxyAdmin.getAddress();
    const defaultImplementation = await poolImplementation(pool);

    // Paused at execution time: the upgrade reverts (timelock surfaces a generic reason).
    const salt = await schedule(timelock, safe, target, upgradeData, "paused");
    await factory.connect(emergencySafe).pausePool(MODEL_ID);
    await elapse();
    await expect(timelock.connect(safe).execute(target, 0, upgradeData, ZeroHash, salt)).to.be.revertedWith(
      "TimelockController: underlying transaction reverted"
    );
    expect(await poolImplementation(pool)).to.equal(defaultImplementation);

    await scheduleAndExecute(timelock, safe, await factory.getAddress(), factory.interface.encodeFunctionData("unpausePool", [MODEL_ID]));

    // Frozen: freezeUpgrades is itself timelocked, then upgrades are refused for good.
    await scheduleAndExecute(
      timelock,
      safe,
      target,
      proxyAdmin.interface.encodeFunctionData("freezeUpgrades", [await pool.getAddress()])
    );
    expect(await proxyAdmin.upgradesFrozen(await pool.getAddress())).to.equal(true);
    await expect(timelock.connect(safe).execute(target, 0, upgradeData, ZeroHash, salt)).to.be.revertedWith(
      "TimelockController: underlying transaction reverted"
    );
    expect(await poolImplementation(pool)).to.equal(defaultImplementation);
  });

  it("keeps the pauser to pausing only, and every operating call reachable through the timelock", async function () {
    const { safe, emergencySafe, factory, pool, proxyAdmin, v2, timelock, artifact } = await handedOffFixture();
    const poolAddress = await pool.getAddress();

    // Pauser cannot upgrade, unpause or withdraw.
    await factory.connect(emergencySafe).pausePool(MODEL_ID);
    await expect(proxyAdmin.connect(emergencySafe).upgrade(poolAddress, await v2.getAddress())).to.be.reverted;
    await expect(proxyAdmin.connect(emergencySafe).freezeUpgrades(poolAddress)).to.be.reverted;
    await expect(factory.connect(emergencySafe).unpausePool(MODEL_ID)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(factory.connect(emergencySafe).unpausePools([MODEL_ID])).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    const withdraw = pool.interface.encodeFunctionData("withdrawTreasury", [1]);
    await expect(factory.connect(emergencySafe).callPool(MODEL_ID, withdraw)).to.be.revertedWith(
      "Ownable: caller is not the owner"
    );
    await expect(pool.connect(emergencySafe).withdrawTreasury(1)).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(pool.connect(emergencySafe).unpause()).to.be.revertedWith("Ownable: caller is not the owner");

    // Operating calls reachable after handoff, via the timelock.
    const factoryAddress = await factory.getAddress();
    await scheduleAndExecute(timelock, safe, factoryAddress, factory.interface.encodeFunctionData("unpausePool", [MODEL_ID]));
    expect(await pool.paused()).to.equal(false);
    await scheduleAndExecute(
      timelock,
      safe,
      factoryAddress,
      factory.interface.encodeFunctionData("callPool", [
        MODEL_ID,
        pool.interface.encodeFunctionData("setMaxTradeBps", [1500]),
      ])
    );
    expect(await pool.maxTradeBps()).to.equal(1500);
    await scheduleAndExecute(
      timelock,
      safe,
      factoryAddress,
      factory.interface.encodeFunctionData("callPool", [
        MODEL_ID,
        pool.interface.encodeFunctionData("setPurchaserWhitelist", [artifact.contracts.PurchaserWhitelist]),
      ])
    );
    expect(await pool.purchaserWhitelist()).to.equal(artifact.contracts.PurchaserWhitelist);
    await scheduleAndExecute(
      timelock,
      safe,
      factoryAddress,
      factory.interface.encodeFunctionData("setPoolImplementation", [await v2.getAddress()])
    );
    expect(await factory.poolImplementation()).to.equal(await v2.getAddress());
    await scheduleAndExecute(
      timelock,
      safe,
      await proxyAdmin.getAddress(),
      proxyAdmin.interface.encodeFunctionData("upgrade", [poolAddress, await v2.getAddress()])
    );
    expect(await poolImplementation(pool)).to.equal(await v2.getAddress());

    // The admin Safe still administers the purchaser whitelist directly (no deployer).
    const whitelist = await ethers.getContractAt("PurchaserWhitelist", artifact.contracts.PurchaserWhitelist);
    await whitelist.connect(safe).addToWhitelist(emergencySafe.address);
    expect(await whitelist.isWhitelisted(emergencySafe.address)).to.equal(true);
  });
});
