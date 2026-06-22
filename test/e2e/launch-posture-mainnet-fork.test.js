const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");
const { runVerifyLaunchPosture } = require("../../scripts/verify-launch-posture");
const { saveJson } = require("../../scripts/lib/launch-posture");

// HOK-1694 custody handoff: admin/unpause -> Safe; PAUSER -> a DEDICATED hot pauser key (decision
// 2026-06-22: fast manual pause, separate from the Safe and the attester); submitter -> relayer;
// deployer fully revoked.
async function handoffRoles(deployment, adminSafeAddress, pauserAddress, relayerAddress, deployerAddress) {
  const deltaVerifier = await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier);
  const contributionRegistry = await hre.ethers.getContractAt("DataContributionRegistry", deployment.contracts.DataContributionRegistry);

  const defaultAdminRole = await deltaVerifier.DEFAULT_ADMIN_ROLE();
  const pauserRole = await deltaVerifier.PAUSER_ROLE();
  const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
  await (await deltaVerifier.grantRole(defaultAdminRole, adminSafeAddress)).wait();
  await (await deltaVerifier.grantRole(pauserRole, pauserAddress)).wait();
  await (await deltaVerifier.grantRole(submitterRole, relayerAddress)).wait();
  await (await deltaVerifier.revokeRole(pauserRole, deployerAddress)).wait();
  await (await deltaVerifier.revokeRole(submitterRole, deployerAddress)).wait();
  await (await deltaVerifier.revokeRole(defaultAdminRole, deployerAddress)).wait();

  const dcrAdminRole = await contributionRegistry.DEFAULT_ADMIN_ROLE();
  const recorderRole = await contributionRegistry.RECORDER_ROLE();
  await (await contributionRegistry.grantRole(dcrAdminRole, adminSafeAddress)).wait();
  await (await contributionRegistry.revokeRole(recorderRole, deployerAddress)).wait();
  await (await contributionRegistry.revokeRole(dcrAdminRole, deployerAddress)).wait();
}

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hok-launch-posture-e2e-"));
}

async function buildScenario() {
  const [deployer, adminSafe, relayer, attester, pauserKey] = await hre.ethers.getSigners();
  const result = await deployFullStack({
    name: "sepolia",
    expectedChainId: 31337n,
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
      maxReward: hre.ethers.parseEther("1000000"),
    },
    infrastructureCostOracleParams: {
      initialGrossMarginBps: 1500,
    },
    treasury: deployer.address,
    backendService: null,
    verifierAddress: deployer.address,
    minDeployerBalanceEth: "0",
    maxGasPriceGwei: null,
    confirmationPauseSeconds: 0,
  }, {
    hre,
    deployer,
    skipArtifactWrite: true,
  });
  const deployment = await result.artifact();

  const tokenManager = await hre.ethers.getContractAt(deployment.contracts._tokenManagerImpl, deployment.contracts.TokenManager);
  const modelRegistry = await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry);
  const params = {
    tokensPerDeltaOne: hre.ethers.parseEther("250000"),
    infrastructureAccrualBps: 6000,
    initialOraclePricePerThousandUsd: 1000,
    licenseHash: hre.ethers.ZeroHash,
    licenseURI: "",
    governor: adminSafe.address,
    vestingConfig: { enabled: false, immediateUnlockBps: 0, vestingDurationSeconds: 0, cliffSeconds: 0 },
  };
  const tokenAddress = await tokenManager.deployTokenWithParams.staticCall("30", "Launch Token", "LCH", hre.ethers.parseEther("1000000"), params);
  await tokenManager.deployTokenWithParams("30", "Launch Token", "LCH", hre.ethers.parseEther("1000000"), params);
  await modelRegistry.registerModel(30, tokenAddress, "accuracy");

  const tmpDir = mkTmpDir();
  const deploymentPath = path.join(tmpDir, "deployment.json");
  const configPath = path.join(tmpDir, "launch-posture.json");
  saveJson(deploymentPath, deployment);
  saveJson(configPath, {
    network: "hardhat",
    chainId: 31337,
    deploymentArtifactPath: deploymentPath,
    adminSafe: adminSafe.address,
    emergencySafe: pauserKey.address,
    deployerAddress: deployer.address,
    submitterRelayer: relayer.address,
    deltaVerifier: {
      legacyMintsDisabled: true,
      paused: false,
      attesterThreshold: 1,
      expectedAttesters: [attester.address],
      baseRewardRate: "1000",
      minImprovementBps: 100,
      maxReward: hre.ethers.parseEther("2500000").toString(),
    },
    models: [
      {
        modelId: 30,
        expectedMintBudgetRemaining: hre.ethers.parseEther("1500000").toString(),
        expectedWeightGenesis: "0x1111111111111111111111111111111111111111111111111111111111111111",
        expectedTokensPerDeltaOne: hre.ethers.parseEther("250000").toString(),
      },
    ],
    roleAudit: {
      DeltaVerifier: {
        DEFAULT_ADMIN_ROLE: { expected: ["ADMIN_SAFE"], forbidden: ["DEPLOYER"] },
        PAUSER_ROLE: { expected: ["EMERGENCY_SAFE"], forbidden: ["DEPLOYER"] },
        SUBMITTER_ROLE: { expected: ["RELAYER"], forbidden: ["DEPLOYER"] }
      },
      DataContributionRegistry: {
        DEFAULT_ADMIN_ROLE: { expected: ["ADMIN_SAFE"], forbidden: ["DEPLOYER"] },
        RECORDER_ROLE: { expected: ["CONTRACT:DeltaVerifier"], forbidden: ["DEPLOYER"] }
      }
    },
    wiring: {
      "DeltaVerifier.modelRegistry": "CONTRACT:ModelRegistry",
      "DeltaVerifier.tokenManager": "CONTRACT:TokenManager",
      "DeltaVerifier.contributionRegistry": "CONTRACT:DataContributionRegistry",
      "TokenManager.deltaVerifier": "CONTRACT:DeltaVerifier",
      "ModelRegistry.stringModelTokenManager": "CONTRACT:TokenManager"
    }
  });

  return { configPath, deploymentPath, deployment, adminSafe, relayer, deployer, pauserKey, attester };
}

// Apply the launch posture directly as the deployer (still admin pre-handoff). The init script's
// --execute path is Gate-8 tooling proven on live Sepolia (HOK-2176) and covered by HOK-2169; here
// we only need a correctly-posture'd deployment to exercise the custody handoff against.
async function applyLaunchPosture(deployment, attesterAddress) {
  const dv = await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier);
  const mr = await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry);
  await (await dv.disableLegacyMints()).wait();
  await (await dv.addAttester(attesterAddress)).wait();
  await (await dv.setAttesterThreshold(1)).wait();
  await (await dv.setMintBudget(30, hre.ethers.parseEther("1500000"))).wait();
  await (await dv.setMaxReward(hre.ethers.parseEther("2500000"))).wait();
  await (await mr.setWeightGenesis(30, "0x1111111111111111111111111111111111111111111111111111111111111111")).wait();
}

describe("launch posture integration", function () {
  // Full-stack deploy + init + handoff + verify is heavy; the default 40s mocha cap isn't enough.
  this.timeout(180000);

  it("custody handoff dry-run: verify passes, deployer defanged, new holders live", async function () {
    const { configPath, deployment, adminSafe, relayer, deployer, pauserKey, attester } = await buildScenario();
    await applyLaunchPosture(deployment, attester.address);
    await handoffRoles(deployment, adminSafe.address, pauserKey.address, relayer.address, deployer.address);

    const { report } = await runVerifyLaunchPosture(hre, ["--config", configPath]);
    expect(report.overall).to.equal("pass");

    // Behavioral proof the handoff actually moved authority (not just role enumeration):
    const dv = await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier);
    // Deployer is fully defanged.
    await expect(dv.connect(deployer).pause()).to.be.reverted;
    await expect(dv.connect(deployer).addAttester(relayer.address)).to.be.reverted;
    // The dedicated hot pauser key can hit the brakes; only the admin Safe can resume.
    await (await dv.connect(pauserKey).pause()).wait();
    expect(await dv.paused()).to.equal(true);
    await expect(dv.connect(pauserKey).unpause()).to.be.reverted; // pauser is not admin
    await (await dv.connect(adminSafe).unpause()).wait();
    expect(await dv.paused()).to.equal(false);
    // The admin Safe holds governance (e.g. the attester registry).
    await (await dv.connect(adminSafe).addAttester(relayer.address)).wait();
    expect(await dv.isAttester(relayer.address)).to.equal(true);
  });

  it("skipping legacy mint disablement fails on exactly that assertion", async function () {
    const { configPath } = await buildScenario();
    const { report } = await runVerifyLaunchPosture(hre, ["--config", configPath]);
    expect(report.failures.map((entry) => entry.name)).to.include("deltaVerifier.legacyMintsDisabled");
  });
});
