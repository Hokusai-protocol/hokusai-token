const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hre = require("hardhat");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");
const { assertLaunchPosture, planLaunchPostureInit } = require("../../scripts/lib/launch-posture");

const MODEL_ID = 30;
const MODEL_ID_STRING = "30";
const BUDGET = hre.ethers.parseEther("1500000");
const TOKENS_PER_DELTA_ONE = hre.ethers.parseEther("250000");
const MAX_REWARD = hre.ethers.parseEther("2500000");
const GENESIS = "0x1111111111111111111111111111111111111111111111111111111111111111";

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hok-launch-posture-"));
}

async function setupFixture(options = {}) {
  const [deployer, adminSafe, relayer, attester, outsider] = await hre.ethers.getSigners();
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
  const tokenManager = await hre.ethers.getContractAt(
    deployment.contracts._tokenManagerImpl,
    deployment.contracts.TokenManager
  );
  const modelRegistry = await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry);
  const deltaVerifier = await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier);
  const contributionRegistry = await hre.ethers.getContractAt("DataContributionRegistry", deployment.contracts.DataContributionRegistry);

  const params = {
    tokensPerDeltaOne: TOKENS_PER_DELTA_ONE,
    infrastructureAccrualBps: 6000,
    initialOraclePricePerThousandUsd: 1000,
    licenseHash: hre.ethers.ZeroHash,
    licenseURI: "",
    governor: adminSafe.address,
    vestingConfig: {
      enabled: false,
      immediateUnlockBps: 0,
      vestingDurationSeconds: 0,
      cliffSeconds: 0,
    },
  };
  const tokenAddress = await tokenManager.deployTokenWithParams.staticCall(
    MODEL_ID_STRING,
    "Launch Token",
    "LCH",
    hre.ethers.parseEther("1000000"),
    params
  );
  await tokenManager.deployTokenWithParams(
    MODEL_ID_STRING,
    "Launch Token",
    "LCH",
    hre.ethers.parseEther("1000000"),
    params
  );
  await modelRegistry.registerModel(MODEL_ID, tokenAddress, "accuracy");

  const config = {
    network: "hardhat",
    chainId: 31337,
    deploymentArtifactPath: "",
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
      maxReward: MAX_REWARD.toString(),
    },
    models: [
      {
        modelId: MODEL_ID,
        expectedMintBudgetRemaining: BUDGET.toString(),
        expectedWeightGenesis: GENESIS,
        expectedTokensPerDeltaOne: TOKENS_PER_DELTA_ONE.toString(),
      },
    ],
    roleAudit: {
      DeltaVerifier: {
        DEFAULT_ADMIN_ROLE: { expected: ["ADMIN_SAFE"], forbidden: ["DEPLOYER"] },
        PAUSER_ROLE: { expected: ["EMERGENCY_SAFE"], forbidden: ["DEPLOYER"] },
        SUBMITTER_ROLE: { expected: ["RELAYER"], forbidden: ["DEPLOYER"] },
      },
      DataContributionRegistry: {
        DEFAULT_ADMIN_ROLE: { expected: ["ADMIN_SAFE"], forbidden: ["DEPLOYER"] },
        RECORDER_ROLE: { expected: ["CONTRACT:DeltaVerifier"], forbidden: ["DEPLOYER"] },
      },
    },
    wiring: {
      "DeltaVerifier.modelRegistry": "CONTRACT:ModelRegistry",
      "DeltaVerifier.tokenManager": "CONTRACT:TokenManager",
      "DeltaVerifier.contributionRegistry": "CONTRACT:DataContributionRegistry",
      "TokenManager.deltaVerifier": "CONTRACT:DeltaVerifier",
      "ModelRegistry.stringModelTokenManager": "CONTRACT:TokenManager",
    },
  };

  if (!options.skipInit) {
    const plan = await planLaunchPostureInit({ hre, config, deployment });
    for (const step of plan.plan) {
      const contract = await hre.ethers.getContractAt(step.contractName, step.to, deployer);
      await (await contract[step.method](...step.args)).wait();
    }
  }

  const defaultAdminRole = await deltaVerifier.DEFAULT_ADMIN_ROLE();
  const pauserRole = await deltaVerifier.PAUSER_ROLE();
  const submitterRole = await deltaVerifier.SUBMITTER_ROLE();
  if (!options.skipRoleHandoff) {
    await (await deltaVerifier.grantRole(defaultAdminRole, adminSafe.address)).wait();
    await (await deltaVerifier.grantRole(pauserRole, adminSafe.address)).wait();
    await (await deltaVerifier.grantRole(submitterRole, relayer.address)).wait();
    await (await deltaVerifier.revokeRole(pauserRole, deployer.address)).wait();
    await (await deltaVerifier.revokeRole(submitterRole, deployer.address)).wait();
    await (await deltaVerifier.revokeRole(defaultAdminRole, deployer.address)).wait();

    const dcrAdminRole = await contributionRegistry.DEFAULT_ADMIN_ROLE();
    const recorderRole = await contributionRegistry.RECORDER_ROLE();
    await (await contributionRegistry.grantRole(dcrAdminRole, adminSafe.address)).wait();
    await (await contributionRegistry.revokeRole(recorderRole, deployer.address)).wait();
    await (await contributionRegistry.revokeRole(dcrAdminRole, deployer.address)).wait();
  }

  return {
    deployment,
    config,
    deltaVerifier,
    modelRegistry,
    tokenManager,
    contributionRegistry,
    signers: { deployer, adminSafe, relayer, attester, outsider },
  };
}

describe("launch posture assertions", function () {
  it("passes when launch posture is fully configured", async function () {
    const fixture = await setupFixture();
    const report = await assertLaunchPosture({
      hre,
      config: fixture.config,
      deployment: fixture.deployment,
    });

    expect(report.overall).to.equal("pass");
    expect(report.failures).to.deep.equal([]);
  });

  it("fails legacy mint assertion when init skips disablement", async function () {
    const fixture = await setupFixture({ skipInit: true, skipRoleHandoff: true });
    const report = await assertLaunchPosture({
      hre,
      config: fixture.config,
      deployment: fixture.deployment,
    });
    expect(report.failures.map((entry) => entry.name)).to.include("deltaVerifier.legacyMintsDisabled");
  });

  const cases = [
    {
      name: "fails paused assertion",
      mutate: async (fixture) => {
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).pause()).wait();
      },
      expectedFailure: "deltaVerifier.paused",
    },
    {
      name: "fails attester threshold assertion",
      configMutate: (config) => {
        config.deltaVerifier.attesterThreshold = 2;
      },
      expectedFailure: "deltaVerifier.attesterThreshold",
    },
    {
      name: "fails attester set assertion",
      mutate: async (fixture) => {
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).addAttester(fixture.signers.outsider.address)).wait();
      },
      expectedFailure: "deltaVerifier.attesterSet",
    },
    {
      name: "fails reward param assertion",
      mutate: async (fixture) => {
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).setMaxReward(hre.ethers.parseEther("1"))).wait();
      },
      expectedFailure: "deltaVerifier.maxReward",
    },
    {
      name: "fails mint budget assertion",
      mutate: async (fixture) => {
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).setMintBudget(MODEL_ID, 1n)).wait();
      },
      expectedFailure: `model.${MODEL_ID}.mintBudgetRemaining`,
    },
    {
      name: "fails weight genesis assertion",
      configMutate: (config) => {
        config.models[0].expectedWeightGenesis = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
      },
      expectedFailure: `model.${MODEL_ID}.weightGenesis`,
    },
    {
      name: "fails tokensPerDeltaOne assertion",
      configMutate: (config) => {
        config.models[0].expectedTokensPerDeltaOne = hre.ethers.parseEther("1").toString();
      },
      expectedFailure: `model.${MODEL_ID}.tokensPerDeltaOne`,
    },
    {
      name: "fails wiring assertion",
      configMutate: (config) => {
        config.wiring["TokenManager.deltaVerifier"] = hre.ethers.ZeroAddress;
      },
      expectedFailure: "wiring.TokenManager.deltaVerifier",
    },
    {
      name: "fails role expected assertion",
      mutate: async (fixture) => {
        const role = await fixture.deltaVerifier.SUBMITTER_ROLE();
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).revokeRole(role, fixture.signers.relayer.address)).wait();
      },
      expectedFailure: "roleAudit.DeltaVerifier.SUBMITTER_ROLE.expected",
    },
    {
      name: "fails role forbidden assertion",
      mutate: async (fixture) => {
        const role = await fixture.deltaVerifier.SUBMITTER_ROLE();
        await (await fixture.deltaVerifier.connect(fixture.signers.adminSafe).grantRole(role, fixture.signers.deployer.address)).wait();
      },
      expectedFailure: "roleAudit.DeltaVerifier.SUBMITTER_ROLE.forbidden",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, async function () {
      const fixture = await setupFixture();
      if (testCase.mutate) {
        await testCase.mutate(fixture);
      }
      if (testCase.configMutate) {
        testCase.configMutate(fixture.config);
      }

      const report = await assertLaunchPosture({
        hre,
        config: fixture.config,
        deployment: fixture.deployment,
      });
      expect(report.overall).to.equal("fail");
      expect(report.failures.map((entry) => entry.name)).to.include(testCase.expectedFailure);
    });
  }
});
