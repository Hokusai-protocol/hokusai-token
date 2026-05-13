const { expect } = require("chai");
const hre = require("hardhat");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");

describe("deployFullStack", function () {
  const baseConfig = {
    name: "mainnet",
    expectedChainId: 1n,
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
    treasury: null,
    backendService: null,
    verifierAddress: null,
    minDeployerBalanceEth: "0.1",
    maxGasPriceGwei: null,
    confirmationPauseSeconds: 0,
  };

  beforeEach(async function () {
    await hre.network.provider.send("hardhat_reset");
  });

  it("deploys the full stack, configures wiring, and builds a rich artifact", async function () {
    const [deployer, treasury, backendService] = await hre.ethers.getSigners();
    const result = await deployFullStack(
      {
        ...baseConfig,
        name: "sepolia",
        expectedChainId: 11155111n,
        treasury: treasury.address,
        backendService: backendService.address,
      },
      {
        hre,
        dryRun: true,
        skipArtifactWrite: true,
        logger: { log() {}, warn() {} },
        scriptPaths: [__filename],
      }
    );

    expect(result.contracts.ModelRegistry).to.properAddress;
    expect(result.contracts.TokenDeploymentFactory).to.properAddress;
    expect(result.contracts.TokenManager).to.properAddress;
    expect(result.contracts.RewardVestingVault).to.properAddress;
    expect(result.contracts.DataContributionRegistry).to.properAddress;
    expect(result.contracts.HokusaiAMMFactory).to.properAddress;
    expect(result.contracts.InfrastructureReserve).to.properAddress;
    expect(result.contracts.InfrastructureCostOracle).to.properAddress;
    expect(result.contracts.UsageFeeRouter).to.properAddress;
    expect(result.contracts.DeltaVerifier).to.properAddress;
    expect(result.contracts._tokenManagerImpl).to.equal("DeployableTokenManager");
    expect(result.notes.rewardVestingVaultInert).to.be.a("string");

    const modelRegistry = await hre.ethers.getContractAt("ModelRegistry", result.contracts.ModelRegistry);
    const tokenManager = await hre.ethers.getContractAt("DeployableTokenManager", result.contracts.TokenManager);
    const contributionRegistry = await hre.ethers.getContractAt(
      "DataContributionRegistry",
      result.contracts.DataContributionRegistry
    );
    const infraReserve = await hre.ethers.getContractAt(
      "InfrastructureReserve",
      result.contracts.InfrastructureReserve
    );
    const usageFeeRouter = await hre.ethers.getContractAt("UsageFeeRouter", result.contracts.UsageFeeRouter);

    expect(await modelRegistry.stringModelTokenManager()).to.equal(result.contracts.TokenManager);
    expect(await tokenManager.deltaVerifier()).to.equal(result.contracts.DeltaVerifier);
    expect(await usageFeeRouter.factory()).to.equal(result.contracts.HokusaiAMMFactory);
    expect(await usageFeeRouter.reserveToken()).to.equal(result.config.reserveToken);
    expect(await usageFeeRouter.infraReserve()).to.equal(result.contracts.InfrastructureReserve);
    expect(await usageFeeRouter.costOracle()).to.equal(result.contracts.InfrastructureCostOracle);

    const recorderRole = await contributionRegistry.RECORDER_ROLE();
    const verifierRole = await contributionRegistry.VERIFIER_ROLE();
    const depositorRole = await infraReserve.DEPOSITOR_ROLE();
    const payerRole = await infraReserve.PAYER_ROLE();
    const feeDepositorRole = await usageFeeRouter.FEE_DEPOSITOR_ROLE();

    expect(await contributionRegistry.hasRole(recorderRole, result.contracts.DeltaVerifier)).to.equal(true);
    expect(await contributionRegistry.hasRole(verifierRole, deployer.address)).to.equal(true);
    expect(await infraReserve.hasRole(depositorRole, result.contracts.UsageFeeRouter)).to.equal(true);
    expect(await infraReserve.hasRole(payerRole, treasury.address)).to.equal(true);
    expect(await usageFeeRouter.hasRole(feeDepositorRole, backendService.address)).to.equal(true);

    const artifact = await result.artifact({ timestamp: "2026-05-13T15:00:00.000Z" });
    expect(artifact.network).to.equal("sepolia");
    expect(artifact.chainId).to.equal("31337");
    expect(artifact.dryRun).to.equal(true);
    expect(artifact.contracts.DeltaVerifier).to.equal(result.contracts.DeltaVerifier);
    expect(artifact.roles.InfrastructureReserve.PAYER_ROLE).to.deep.equal([treasury.address]);
    expect(artifact.config.expectedChainId).to.equal("11155111");
    expect(artifact.gasUsed.ModelRegistry).to.match(/^\d+$/);
    expect(artifact.gasUsed.wiring.setDeltaVerifier).to.match(/^\d+$/);
    expect(artifact.gasUsed.totalCostEth).to.not.equal("0.0");
    expect(artifact.git.sha === "unknown" || /^[a-f0-9]{40}$/.test(artifact.git.sha)).to.equal(true);
    expect(artifact.scriptSha).to.match(/^[a-f0-9]{64}$/);
  });

  it("rejects the wrong live chain id", async function () {
    const [deployer] = await hre.ethers.getSigners();
    const fakeHre = {
      ...hre,
      network: {
        ...hre.network,
        config: {
          ...hre.network.config,
          chainId: 137,
        },
      },
    };

    await expect(
      deployFullStack(
        {
          ...baseConfig,
          name: "mainnet",
          treasury: deployer.address,
        },
        {
          hre: fakeHre,
          dryRun: false,
          skipArtifactWrite: true,
          logger: { log() {}, warn() {} },
          scriptPaths: [__filename],
        }
      )
    ).to.be.rejectedWith("Wrong network! Expected mainnet (1), got 137");
  });
});
