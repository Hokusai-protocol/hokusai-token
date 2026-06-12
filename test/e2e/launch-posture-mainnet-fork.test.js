const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");
const { runInitLaunchPosture } = require("../../scripts/init-launch-posture");
const { runVerifyLaunchPosture } = require("../../scripts/verify-launch-posture");
const { saveJson } = require("../../scripts/lib/launch-posture");

async function handoffRoles(deployment, adminSafeAddress, relayerAddress, deployerAddress) {
  const deltaVerifier = await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier);
  const contributionRegistry = await hre.ethers.getContractAt("DataContributionRegistry", deployment.contracts.DataContributionRegistry);

  const defaultAdminRole = await deltaVerifier.DEFAULT_ADMIN_ROLE();
  const pauserRole = await deltaVerifier.PAUSER_ROLE();
  const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
  await (await deltaVerifier.grantRole(defaultAdminRole, adminSafeAddress)).wait();
  await (await deltaVerifier.grantRole(pauserRole, adminSafeAddress)).wait();
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
  const [deployer, adminSafe, relayer, attester] = await hre.ethers.getSigners();
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
    emergencySafe: adminSafe.address,
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

  return { configPath, deploymentPath, deployment, adminSafe, relayer, deployer };
}

describe("launch posture integration", function () {
  it("deploy + init + verify passes", async function () {
    const { configPath, deployment, adminSafe, relayer, deployer } = await buildScenario();
    await runInitLaunchPosture(hre, ["--config", configPath, "--execute"]);
    await handoffRoles(deployment, adminSafe.address, relayer.address, deployer.address);
    const { report } = await runVerifyLaunchPosture(hre, ["--config", configPath]);
    expect(report.overall).to.equal("pass");
  });

  it("skipping legacy mint disablement fails on exactly that assertion", async function () {
    const { configPath } = await buildScenario();
    const { report } = await runVerifyLaunchPosture(hre, ["--config", configPath]);
    expect(report.failures.map((entry) => entry.name)).to.include("deltaVerifier.legacyMintsDisabled");
  });
});
