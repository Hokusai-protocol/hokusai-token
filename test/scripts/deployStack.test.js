const { expect } = require("chai");
const hre = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const { deployFullStack } = require("../../scripts/lib/deploy-stack");
const { deployTestToken, deployTestTokenAddress } = require("../helpers/tokenDeployment");

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
    expect(result.contracts.HokusaiAMMPoolDeployer).to.properAddress;
    expect(result.contracts.PurchaserWhitelist).to.properAddress;
    expect(result.contracts.InfrastructureReserve).to.properAddress;
    expect(result.contracts.InfrastructureCostOracle).to.properAddress;
    expect(result.contracts.UsageFeeRouter).to.properAddress;
    expect(result.contracts.DeltaVerifier).to.properAddress;
    expect(result.contracts._tokenManagerImpl).to.equal("DeployableTokenManager");
    expect(result.notes.rewardVestingVaultWired).to.equal(true);

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
    const whitelist = await hre.ethers.getContractAt("PurchaserWhitelist", result.contracts.PurchaserWhitelist);

    expect(await modelRegistry.stringModelTokenManager()).to.equal(result.contracts.TokenManager);
    expect(await tokenManager.deltaVerifier()).to.equal(result.contracts.DeltaVerifier);
    expect(await tokenManager.vestingVault()).to.equal(result.contracts.RewardVestingVault);
    expect(await (await hre.ethers.getContractAt("HokusaiAMMFactory", result.contracts.HokusaiAMMFactory)).poolDeployer())
      .to.equal(result.contracts.HokusaiAMMPoolDeployer);
    expect(await usageFeeRouter.factory()).to.equal(result.contracts.HokusaiAMMFactory);
    expect(await usageFeeRouter.reserveToken()).to.equal(result.config.reserveToken);
    expect(await usageFeeRouter.infraReserve()).to.equal(result.contracts.InfrastructureReserve);
    expect(await usageFeeRouter.costOracle()).to.equal(result.contracts.InfrastructureCostOracle);
    expect(await modelRegistry.poolRegistrars(result.contracts.HokusaiAMMFactory)).to.equal(true);
    expect(await whitelist.hasRole(await whitelist.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(true);
    expect(await whitelist.hasRole(await whitelist.WHITELIST_ADMIN_ROLE(), deployer.address)).to.equal(true);

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

    const tokenAddress = await deployTestTokenAddress(
      tokenManager,
      "501",
      "Deploy Stack Token",
      "DSTK",
      hre.ethers.parseEther("1"),
      deployer.address
    );
    await deployTestToken(
      tokenManager,
      "501",
      "Deploy Stack Token",
      "DSTK",
      hre.ethers.parseEther("1"),
      deployer.address
    );
    expect(tokenAddress).to.properAddress;

    await modelRegistry.registerStringModel("501", tokenAddress, "accuracy");
    const factory = await hre.ethers.getContractAt("HokusaiAMMFactory", result.contracts.HokusaiAMMFactory);
    const poolAddress = await factory.createPoolWithParamsAndWhitelist.staticCall(
      "501",
      tokenAddress,
      200000,
      30,
      7 * 24 * 60 * 60,
      25000n * 10n ** 6n,
      10000,
      result.contracts.PurchaserWhitelist
    );
    await factory.createPoolWithParamsAndWhitelist(
      "501",
      tokenAddress,
      200000,
      30,
      7 * 24 * 60 * 60,
      25000n * 10n ** 6n,
      10000,
      result.contracts.PurchaserWhitelist
    );
    expect(await factory.getPool("501")).to.equal(poolAddress);
    expect(await modelRegistry.getPool("501")).to.equal(poolAddress);
    const pool = await hre.ethers.getContractAt("HokusaiAMM", poolAddress);
    expect(await pool.purchaserWhitelist()).to.equal(result.contracts.PurchaserWhitelist);

    await tokenManager.authorizeAMM(poolAddress);
    const mockUsdc = await hre.ethers.getContractAt("MockUSDC", result.config.reserveToken);
    const buyAmount = hre.ethers.parseUnits("1000", 6);
    await mockUsdc.approve(poolAddress, buyAmount * 100n);
    await pool.depositFees(buyAmount * 100n);

    const [, buyer] = await hre.ethers.getSigners();
    await mockUsdc.mint(buyer.address, buyAmount);
    await mockUsdc.connect(buyer).approve(poolAddress, buyAmount);
    await expect(
      pool.connect(buyer).buy(buyAmount, 0, buyer.address, (await time.latest()) + 3600)
    ).to.be.revertedWithCustomError(pool, "NotWhitelisted").withArgs(buyer.address);

    await whitelist.addToWhitelist(buyer.address);
    await expect(
      pool.connect(buyer).buy(buyAmount, 0, buyer.address, (await time.latest()) + 3600)
    ).to.not.be.reverted;

    const artifact = await result.artifact({ timestamp: "2026-05-13T15:00:00.000Z" });
    expect(artifact.network).to.equal("sepolia");
    expect(artifact.chainId).to.equal("31337");
    expect(artifact.dryRun).to.equal(true);
    expect(artifact.contracts.DeltaVerifier).to.equal(result.contracts.DeltaVerifier);
    expect(artifact.contracts.PurchaserWhitelist).to.equal(result.contracts.PurchaserWhitelist);
    expect(artifact.roles.InfrastructureReserve.PAYER_ROLE).to.deep.equal([treasury.address]);
    expect(artifact.roles.PurchaserWhitelist.WHITELIST_ADMIN_ROLE).to.deep.equal([deployer.address]);
    expect(artifact.roles.ModelRegistry.poolRegistrar).to.equal(result.contracts.HokusaiAMMFactory);
    expect(artifact.config.expectedChainId).to.equal("11155111");
    expect(artifact.config.purchaserWhitelist).to.equal(result.contracts.PurchaserWhitelist);
    expect(artifact.gasUsed.ModelRegistry).to.match(/^\d+$/);
    expect(artifact.gasUsed.PurchaserWhitelist).to.match(/^\d+$/);
    expect(artifact.gasUsed.wiring.setDeltaVerifier).to.match(/^\d+$/);
    expect(artifact.gasUsed.wiring.factorySetPoolDeployer).to.match(/^\d+$/);
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
