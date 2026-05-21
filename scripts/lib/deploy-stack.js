const { buildArtifact, writeArtifactFiles } = require("./deployment-artifact");

const HARDHAT_DRY_RUN_CHAIN_ID = 31337n;
const DEFAULT_VERIFIER_ADDRESS = null;

function normalizeAddress(address) {
  return address.toLowerCase();
}

function expectAddress(actual, expected, label) {
  if (normalizeAddress(actual) !== normalizeAddress(expected)) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function stringifyError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function uniqueAddresses(addresses) {
  return [...new Set(addresses.filter(Boolean).map((address) => normalizeAddress(address)))];
}

async function waitForTx(txPromise, bucket, key) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  bucket[key] = receipt.gasUsed.toString();
  return receipt;
}

async function recordDeployment(contract, bucket, key) {
  const deploymentTx = contract.deploymentTransaction();
  const receipt = await deploymentTx.wait();
  bucket[key] = receipt.gasUsed.toString();
  return receipt;
}

async function deployFullStack(networkConfig, runtime) {
  const {
    hre,
    dryRun = false,
    logger = console,
    skipArtifactWrite = false,
    scriptPaths,
  } = runtime;
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const providerNetwork = await ethers.provider.getNetwork();
  const actualChainId = BigInt(hre.network.config.chainId ?? providerNetwork.chainId);
  const expectedChainId = BigInt(networkConfig.expectedChainId);
  const dryRunAllowed = dryRun && actualChainId === HARDHAT_DRY_RUN_CHAIN_ID;

  if (actualChainId !== expectedChainId && !dryRunAllowed) {
    throw new Error(`Wrong network! Expected ${networkConfig.name} (${expectedChainId}), got ${actualChainId}`);
  }

  if (dryRunAllowed) {
    logger.log(`DRY_RUN enabled: allowing local chainId ${actualChainId} for ${networkConfig.name}`);
  }

  const treasury = networkConfig.treasury || deployer.address;
  const backendService = networkConfig.backendService || null;
  const verifierAddress = networkConfig.verifierAddress || DEFAULT_VERIFIER_ADDRESS || deployer.address;
  const balance = await ethers.provider.getBalance(deployer.address);
  const minBalanceWei = ethers.parseEther(networkConfig.minDeployerBalanceEth);

  if (balance < minBalanceWei) {
    throw new Error(
      `Insufficient ETH! Need at least ${networkConfig.minDeployerBalanceEth} ETH for deployment`
    );
  }

  const feeData = await ethers.provider.getFeeData();
  if (
    networkConfig.maxGasPriceGwei !== null &&
    networkConfig.maxGasPriceGwei !== undefined &&
    feeData.gasPrice !== null &&
    feeData.gasPrice > ethers.parseUnits(String(networkConfig.maxGasPriceGwei), "gwei")
  ) {
    logger.warn(
      `Gas price warning: ${ethers.formatUnits(feeData.gasPrice, "gwei")} gwei exceeds ${networkConfig.maxGasPriceGwei} gwei`
    );
  }

  if (!dryRun && networkConfig.confirmationPauseSeconds > 0) {
    logger.log(
      `Pausing ${networkConfig.confirmationPauseSeconds}s before deploying to ${networkConfig.name}. Ctrl+C to abort.`
    );
    await new Promise((resolve) => setTimeout(resolve, networkConfig.confirmationPauseSeconds * 1000));
  }

  const contracts = {};
  const roles = {};
  const gasUsed = { wiring: {} };
  const notes = {
    rewardVestingVaultWired: true,
  };
  const receipts = [];

  const recordReceipt = (receipt) => {
    receipts.push(receipt);
    return receipt;
  };

  logger.log("Phase 1: core infrastructure");
  const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
  const modelRegistry = await ModelRegistry.deploy();
  await modelRegistry.waitForDeployment();
  recordReceipt(await recordDeployment(modelRegistry, gasUsed, "ModelRegistry"));
  contracts.ModelRegistry = await modelRegistry.getAddress();

  const TokenDeploymentFactory = await ethers.getContractFactory("TokenDeploymentFactory");
  const tokenDeploymentFactory = await TokenDeploymentFactory.deploy();
  await tokenDeploymentFactory.waitForDeployment();
  recordReceipt(await recordDeployment(tokenDeploymentFactory, gasUsed, "TokenDeploymentFactory"));
  contracts.TokenDeploymentFactory = await tokenDeploymentFactory.getAddress();

  const DeployableTokenManager = await ethers.getContractFactory("DeployableTokenManager");
  const tokenManager = await DeployableTokenManager.deploy(
    contracts.ModelRegistry,
    contracts.TokenDeploymentFactory
  );
  await tokenManager.waitForDeployment();
  recordReceipt(await recordDeployment(tokenManager, gasUsed, "TokenManager"));
  contracts.TokenManager = await tokenManager.getAddress();
  contracts._tokenManagerImpl = "DeployableTokenManager";

  const RewardVestingVault = await ethers.getContractFactory("RewardVestingVault");
  const rewardVestingVault = await RewardVestingVault.deploy(contracts.TokenManager);
  await rewardVestingVault.waitForDeployment();
  recordReceipt(await recordDeployment(rewardVestingVault, gasUsed, "RewardVestingVault"));
  contracts.RewardVestingVault = await rewardVestingVault.getAddress();

  recordReceipt(
    await waitForTx(
      tokenManager.setVestingVault(contracts.RewardVestingVault),
      gasUsed.wiring,
      "setVestingVault"
    )
  );

  const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
  const contributionRegistry = await DataContributionRegistry.deploy();
  await contributionRegistry.waitForDeployment();
  recordReceipt(await recordDeployment(contributionRegistry, gasUsed, "DataContributionRegistry"));
  contracts.DataContributionRegistry = await contributionRegistry.getAddress();

  recordReceipt(
    await waitForTx(
      modelRegistry.setStringModelTokenManager(contracts.TokenManager),
      gasUsed.wiring,
      "setStringModelTokenManager"
    )
  );

  logger.log("Phase 2: AMM factory");
  let reserveTokenAddress = networkConfig.reserveTokenAddress;
  if (!reserveTokenAddress) {
    if (networkConfig.name === "mainnet") {
      throw new Error("Mainnet deployment requires reserveTokenAddress");
    }

    logger.warn("No Sepolia reserve token configured; deploying MockUSDC fallback");
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const mockUsdc = await MockUSDC.deploy();
    await mockUsdc.waitForDeployment();
    recordReceipt(await recordDeployment(mockUsdc, gasUsed, "MockUSDC"));
    reserveTokenAddress = await mockUsdc.getAddress();
    contracts.MockUSDC = reserveTokenAddress;

    recordReceipt(
      await waitForTx(
        mockUsdc.mint(deployer.address, ethers.parseUnits("1000000", 6)),
        gasUsed.wiring,
        "mockUsdcMint"
      )
    );
  }

  const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
  const factory = await HokusaiAMMFactory.deploy(
    contracts.ModelRegistry,
    contracts.TokenManager,
    reserveTokenAddress,
    treasury
  );
  await factory.waitForDeployment();
  recordReceipt(await recordDeployment(factory, gasUsed, "HokusaiAMMFactory"));
  contracts.HokusaiAMMFactory = await factory.getAddress();

  recordReceipt(
    await waitForTx(
      factory.setDefaults(
        networkConfig.factoryDefaults.crr,
        networkConfig.factoryDefaults.tradeFee,
        networkConfig.factoryDefaults.ibrDuration
      ),
      gasUsed.wiring,
      "factorySetDefaults"
    )
  );
  recordReceipt(
    await waitForTx(
      modelRegistry.setPoolRegistrar(contracts.HokusaiAMMFactory, true),
      gasUsed.wiring,
      "factoryPoolRegistrar"
    )
  );

  logger.log("Phase 3: infrastructure and fee routing");
  const InfrastructureReserve = await ethers.getContractFactory("InfrastructureReserve");
  const infrastructureReserve = await InfrastructureReserve.deploy(
    reserveTokenAddress,
    contracts.HokusaiAMMFactory,
    treasury
  );
  await infrastructureReserve.waitForDeployment();
  recordReceipt(await recordDeployment(infrastructureReserve, gasUsed, "InfrastructureReserve"));
  contracts.InfrastructureReserve = await infrastructureReserve.getAddress();

  const InfrastructureCostOracle = await ethers.getContractFactory("InfrastructureCostOracle");
  const infrastructureCostOracle = await InfrastructureCostOracle.deploy(
    deployer.address,
    networkConfig.infrastructureCostOracleParams.initialGrossMarginBps
  );
  await infrastructureCostOracle.waitForDeployment();
  recordReceipt(await recordDeployment(infrastructureCostOracle, gasUsed, "InfrastructureCostOracle"));
  contracts.InfrastructureCostOracle = await infrastructureCostOracle.getAddress();

  const UsageFeeRouter = await ethers.getContractFactory("UsageFeeRouter");
  const usageFeeRouter = await UsageFeeRouter.deploy(
    contracts.HokusaiAMMFactory,
    reserveTokenAddress,
    contracts.InfrastructureReserve,
    contracts.InfrastructureCostOracle
  );
  await usageFeeRouter.waitForDeployment();
  recordReceipt(await recordDeployment(usageFeeRouter, gasUsed, "UsageFeeRouter"));
  contracts.UsageFeeRouter = await usageFeeRouter.getAddress();

  const depositorRole = await infrastructureReserve.DEPOSITOR_ROLE();
  const payerRole = await infrastructureReserve.PAYER_ROLE();
  const feeDepositorRole = await usageFeeRouter.FEE_DEPOSITOR_ROLE();

  recordReceipt(
    await waitForTx(
      infrastructureReserve.grantRole(depositorRole, contracts.UsageFeeRouter),
      gasUsed.wiring,
      "infraDepositorRole"
    )
  );
  recordReceipt(
    await waitForTx(
      infrastructureReserve.grantRole(payerRole, treasury),
      gasUsed.wiring,
      "infraPayerRole"
    )
  );
  if (backendService && normalizeAddress(backendService) !== normalizeAddress(deployer.address)) {
    recordReceipt(
      await waitForTx(
        usageFeeRouter.grantRole(feeDepositorRole, backendService),
        gasUsed.wiring,
        "feeRouterDepositorRole"
      )
    );
  }

  logger.log("Phase 4: delta verifier");
  const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
  const deltaVerifier = await DeltaVerifier.deploy(
    contracts.ModelRegistry,
    contracts.TokenManager,
    contracts.DataContributionRegistry,
    networkConfig.deltaVerifierParams.baseRewardRate,
    networkConfig.deltaVerifierParams.minImprovementBps,
    networkConfig.deltaVerifierParams.maxReward
  );
  await deltaVerifier.waitForDeployment();
  recordReceipt(await recordDeployment(deltaVerifier, gasUsed, "DeltaVerifier"));
  contracts.DeltaVerifier = await deltaVerifier.getAddress();

  const recorderRole = await contributionRegistry.RECORDER_ROLE();
  const verifierRole = await contributionRegistry.VERIFIER_ROLE();

  recordReceipt(
    await waitForTx(
      contributionRegistry.grantRole(recorderRole, contracts.DeltaVerifier),
      gasUsed.wiring,
      "contributionRegistryRecorderRole"
    )
  );
  if (!(await contributionRegistry.hasRole(verifierRole, verifierAddress))) {
    recordReceipt(
      await waitForTx(
        contributionRegistry.grantRole(verifierRole, verifierAddress),
        gasUsed.wiring,
        "contributionRegistryVerifierRole"
      )
    );
  }

  recordReceipt(
    await waitForTx(
      tokenManager.setDeltaVerifier(contracts.DeltaVerifier),
      gasUsed.wiring,
      "setDeltaVerifier"
    )
  );

  logger.log("Verification");
  expectAddress(await modelRegistry.stringModelTokenManager(), contracts.TokenManager, "ModelRegistry.stringModelTokenManager");
  expectAddress(await tokenManager.deltaVerifier(), contracts.DeltaVerifier, "TokenManager.deltaVerifier");
  expectAddress(await tokenManager.vestingVault(), contracts.RewardVestingVault, "TokenManager.vestingVault");
  expectAddress(await rewardVestingVault.tokenManager(), contracts.TokenManager, "RewardVestingVault.tokenManager");
  expectAddress(await factory.modelRegistry(), contracts.ModelRegistry, "HokusaiAMMFactory.modelRegistry");
  expectAddress(await factory.tokenManager(), contracts.TokenManager, "HokusaiAMMFactory.tokenManager");
  expectAddress(await factory.reserveToken(), reserveTokenAddress, "HokusaiAMMFactory.reserveToken");
  expectAddress(await usageFeeRouter.factory(), contracts.HokusaiAMMFactory, "UsageFeeRouter.factory");
  expectAddress(await usageFeeRouter.reserveToken(), reserveTokenAddress, "UsageFeeRouter.reserveToken");
  expectAddress(await usageFeeRouter.infraReserve(), contracts.InfrastructureReserve, "UsageFeeRouter.infraReserve");
  expectAddress(await usageFeeRouter.costOracle(), contracts.InfrastructureCostOracle, "UsageFeeRouter.costOracle");
  expectAddress(await infrastructureReserve.factory(), contracts.HokusaiAMMFactory, "InfrastructureReserve.factory");
  expectAddress(await infrastructureReserve.reserveToken(), reserveTokenAddress, "InfrastructureReserve.reserveToken");
  expectAddress(await infrastructureReserve.treasury(), treasury, "InfrastructureReserve.treasury");
  expectEqual(await factory.defaultCrr(), BigInt(networkConfig.factoryDefaults.crr), "HokusaiAMMFactory.defaultCrr");
  expectEqual(await factory.defaultTradeFee(), BigInt(networkConfig.factoryDefaults.tradeFee), "HokusaiAMMFactory.defaultTradeFee");
  expectEqual(await factory.defaultIbrDuration(), BigInt(networkConfig.factoryDefaults.ibrDuration), "HokusaiAMMFactory.defaultIbrDuration");
  expectEqual(
    await factory.defaultFlatCurveThreshold(),
    BigInt(networkConfig.factoryDefaults.flatCurveThreshold),
    "HokusaiAMMFactory.defaultFlatCurveThreshold"
  );
  expectEqual(
    await factory.defaultFlatCurvePrice(),
    BigInt(networkConfig.factoryDefaults.flatCurvePrice),
    "HokusaiAMMFactory.defaultFlatCurvePrice"
  );
  if (!(await modelRegistry.poolRegistrars(contracts.HokusaiAMMFactory))) {
    throw new Error("ModelRegistry pool registrar role missing on HokusaiAMMFactory");
  }

  if (!(await contributionRegistry.hasRole(recorderRole, contracts.DeltaVerifier))) {
    throw new Error("DataContributionRegistry recorder role missing on DeltaVerifier");
  }
  if (!(await contributionRegistry.hasRole(verifierRole, verifierAddress))) {
    throw new Error("DataContributionRegistry verifier role missing on verifier address");
  }
  if (!(await infrastructureReserve.hasRole(depositorRole, contracts.UsageFeeRouter))) {
    throw new Error("InfrastructureReserve depositor role missing on UsageFeeRouter");
  }
  if (!(await infrastructureReserve.hasRole(payerRole, treasury))) {
    throw new Error("InfrastructureReserve payer role missing on treasury");
  }
  if (!(await usageFeeRouter.hasRole(feeDepositorRole, deployer.address))) {
    throw new Error("UsageFeeRouter fee depositor role missing on deployer");
  }
  if (backendService && !(await usageFeeRouter.hasRole(feeDepositorRole, backendService))) {
    throw new Error("UsageFeeRouter fee depositor role missing on backend service");
  }

  const totalGas = receipts.reduce((sum, receipt) => sum + receipt.gasUsed, 0n);
  const totalCostWei = receipts.reduce(
    (sum, receipt) => sum + (receipt.gasPrice || 0n) * receipt.gasUsed,
    0n
  );
  gasUsed.totalGas = totalGas.toString();
  gasUsed.totalCostWei = totalCostWei.toString();
  gasUsed.totalCostEth = ethers.formatEther(totalCostWei);

  roles.ModelRegistry = {
    owner: await modelRegistry.owner(),
    stringModelTokenManager: contracts.TokenManager,
    poolRegistrar: contracts.HokusaiAMMFactory,
  };
  roles.TokenManager = {
    owner: await tokenManager.owner(),
    deltaVerifier: await tokenManager.deltaVerifier(),
    vestingVault: await tokenManager.vestingVault(),
  };
  roles.DataContributionRegistry = {
    DEFAULT_ADMIN_ROLE: [deployer.address],
    RECORDER_ROLE: [deployer.address, contracts.DeltaVerifier],
    VERIFIER_ROLE: [verifierAddress],
  };
  roles.InfrastructureReserve = {
    DEFAULT_ADMIN_ROLE: [deployer.address],
    DEPOSITOR_ROLE: [contracts.UsageFeeRouter],
    PAYER_ROLE: [treasury],
  };
  roles.UsageFeeRouter = {
    DEFAULT_ADMIN_ROLE: [deployer.address],
    FEE_DEPOSITOR_ROLE: uniqueAddresses([deployer.address, backendService]),
  };
  roles.DeltaVerifier = {
    DEFAULT_ADMIN_ROLE: [deployer.address],
    SUBMITTER_ROLE: [deployer.address],
  };
  roles.InfrastructureCostOracle = {
    DEFAULT_ADMIN_ROLE: [deployer.address],
    GOV_ROLE: [deployer.address],
  };

  const result = {
    network: networkConfig.name,
    chainId: actualChainId,
    deployer: deployer.address,
    treasury,
    backendService,
    contracts,
    roles,
    config: {
      reserveToken: reserveTokenAddress,
      factoryDefaults: networkConfig.factoryDefaults,
      deltaVerifierParams: networkConfig.deltaVerifierParams,
      infrastructureCostOracleParams: networkConfig.infrastructureCostOracleParams,
      expectedChainId,
    },
    gasUsed,
    notes,
    async artifact(overrides = {}) {
      return buildArtifact({
        deploymentResult: result,
        network: networkConfig.name,
        dryRun,
        chainId: actualChainId,
        deployer: deployer.address,
        treasury,
        backendService,
        timestamp: overrides.timestamp,
        scriptPaths: overrides.scriptPaths || scriptPaths,
      });
    },
    async writeArtifact(overrides = {}) {
      const artifact = await result.artifact(overrides);
      if (skipArtifactWrite || process.env.SKIP_ARTIFACT_WRITE === "true") {
        return { artifact, paths: null };
      }

      const paths = writeArtifactFiles(artifact, overrides);
      return { artifact, paths };
    },
  };

  return result;
}

module.exports = {
  HARDHAT_DRY_RUN_CHAIN_ID,
  deployFullStack,
  expectAddress,
  stringifyError,
};
