const hre = require("hardhat");
const fs = require('fs');
const path = require('path');
const { loadLaunchTokensConfig, scaleTokenEntry } = require('./lib/launch-tokens');

/**
 * Verifies all deployed contracts on Etherscan
 * Reads from deployments/sepolia-latest.json
 */

async function verifyContract(address, constructorArguments = [], contractName = "", contractPath = null) {
  console.log(`\n🔍 Verifying ${contractName} at ${address}...`);

  try {
    const verifyArgs = {
      address: address,
      constructorArguments: constructorArguments,
    };
    if (contractPath) {
      verifyArgs.contract = contractPath;
    }
    await hre.run("verify:verify", verifyArgs);
    console.log(`   ✅ ${contractName} verified successfully`);
    return true;
  } catch (error) {
    // Etherscan returns several wordings for an already-verified contract, e.g.
    // "Already Verified" and "has already been verified on the block explorer".
    if (/already.*verified/i.test(error.message)) {
      console.log(`   ℹ️  ${contractName} already verified`);
      return true;
    } else {
      console.log(`   ❌ ${contractName} verification failed:`, error.message);
      return false;
    }
  }
}

async function main() {
  console.log("🚀 Starting Contract Verification...\n");
  console.log("=".repeat(70));

  // Load deployment data for the target network (sepolia-latest.json / mainnet-latest.json).
  // Override with DEPLOYMENT_FILE=<path> if needed.
  const deploymentFile =
    process.env.DEPLOYMENT_FILE || `deployments/${hre.network.name}-latest.json`;
  const deploymentPath = path.isAbsolute(deploymentFile)
    ? deploymentFile
    : path.join(__dirname, '..', deploymentFile);

  if (!fs.existsSync(deploymentPath)) {
    console.error("❌ Deployment file not found:", deploymentPath);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

  console.log("Network:", deployment.network);
  console.log("Chain ID:", deployment.chainId);
  console.log("Deployment Date:", deployment.timestamp);
  console.log("=".repeat(70));

  const results = {
    success: [],
    failed: []
  };

  // Reserve token used as a constructor arg by the factory, fee router, and pools.
  // Sepolia deploys a MockUSDC fallback; mainnet uses real USDC, recorded in
  // config.reserveToken. Prefer config (correct on every network), fall back to MockUSDC.
  const reserveToken =
    (deployment.config && deployment.config.reserveToken) || deployment.contracts.MockUSDC;

  // 1. ModelRegistry (no constructor args)
  if (deployment.contracts.ModelRegistry) {
    const success = await verifyContract(
      deployment.contracts.ModelRegistry,
      [],
      "ModelRegistry"
    );
    if (success) results.success.push("ModelRegistry");
    else results.failed.push("ModelRegistry");
  }

  // 1b. TokenDeploymentFactory (no constructor args)
  if (deployment.contracts.TokenDeploymentFactory) {
    const success = await verifyContract(
      deployment.contracts.TokenDeploymentFactory,
      [],
      "TokenDeploymentFactory",
      "contracts/TokenDeploymentFactory.sol:TokenDeploymentFactory"
    );
    if (success) results.success.push("TokenDeploymentFactory");
    else results.failed.push("TokenDeploymentFactory");
  }

  // 2. TokenManager (DeployableTokenManager constructor: registryAddress, tokenDeploymentFactoryAddress)
  if (deployment.contracts.TokenManager &&
      deployment.contracts.ModelRegistry &&
      deployment.contracts.TokenDeploymentFactory) {
    const success = await verifyContract(
      deployment.contracts.TokenManager,
      [
        deployment.contracts.ModelRegistry,
        deployment.contracts.TokenDeploymentFactory
      ],
      "TokenManager",
      "contracts/DeployableTokenManager.sol:DeployableTokenManager"
    );
    if (success) results.success.push("TokenManager");
    else results.failed.push("TokenManager");
  }

  // 3. DataContributionRegistry (no constructor args)
  if (deployment.contracts.DataContributionRegistry) {
    const success = await verifyContract(
      deployment.contracts.DataContributionRegistry,
      [],
      "DataContributionRegistry"
    );
    if (success) results.success.push("DataContributionRegistry");
    else results.failed.push("DataContributionRegistry");
  }

  // 3b. RewardVestingVault (constructor: tokenManagerAddress)
  if (deployment.contracts.RewardVestingVault && deployment.contracts.TokenManager) {
    const success = await verifyContract(
      deployment.contracts.RewardVestingVault,
      [deployment.contracts.TokenManager],
      "RewardVestingVault",
      "contracts/RewardVestingVault.sol:RewardVestingVault"
    );
    if (success) results.success.push("RewardVestingVault");
    else results.failed.push("RewardVestingVault");
  }

  // 3c. HokusaiAMMPoolDeployer (constructor: _factory)
  if (deployment.contracts.HokusaiAMMPoolDeployer && deployment.contracts.HokusaiAMMFactory) {
    const success = await verifyContract(
      deployment.contracts.HokusaiAMMPoolDeployer,
      [deployment.contracts.HokusaiAMMFactory],
      "HokusaiAMMPoolDeployer",
      "contracts/HokusaiAMMPoolDeployer.sol:HokusaiAMMPoolDeployer"
    );
    if (success) results.success.push("HokusaiAMMPoolDeployer");
    else results.failed.push("HokusaiAMMPoolDeployer");
  }

  // 3d. PurchaserWhitelist (constructor: admin). Admin was the deployer at construction
  // time; governance roles are granted/renounced post-deploy, but the constructor arg
  // is fixed to the original admin (deployer).
  if (deployment.contracts.PurchaserWhitelist) {
    const admin = deployment.deployer;
    const success = await verifyContract(
      deployment.contracts.PurchaserWhitelist,
      [admin],
      "PurchaserWhitelist",
      "contracts/PurchaserWhitelist.sol:PurchaserWhitelist"
    );
    if (success) results.success.push("PurchaserWhitelist");
    else results.failed.push("PurchaserWhitelist");
  }

  // 3e. InfrastructureReserve (constructor: _reserveToken, _factory, _treasury)
  if (deployment.contracts.InfrastructureReserve &&
      reserveToken &&
      deployment.contracts.HokusaiAMMFactory) {
    const treasury = deployment.treasury || deployment.deployer;
    const success = await verifyContract(
      deployment.contracts.InfrastructureReserve,
      [reserveToken, deployment.contracts.HokusaiAMMFactory, treasury],
      "InfrastructureReserve",
      "contracts/InfrastructureReserve.sol:InfrastructureReserve"
    );
    if (success) results.success.push("InfrastructureReserve");
    else results.failed.push("InfrastructureReserve");
  }

  // 3f. InfrastructureCostOracle (constructor: admin, initialGrossMarginBps). Admin was
  // the deployer at construction (GOV_ROLE re-granted to governance post-deploy).
  if (deployment.contracts.InfrastructureCostOracle) {
    const icoParams = (deployment.config && deployment.config.infrastructureCostOracleParams) || {};
    const initialGrossMarginBps =
      icoParams.initialGrossMarginBps != null ? icoParams.initialGrossMarginBps : 1500;
    const success = await verifyContract(
      deployment.contracts.InfrastructureCostOracle,
      [deployment.deployer, initialGrossMarginBps],
      "InfrastructureCostOracle",
      "contracts/InfrastructureCostOracle.sol:InfrastructureCostOracle"
    );
    if (success) results.success.push("InfrastructureCostOracle");
    else results.failed.push("InfrastructureCostOracle");
  }

  // 4. MockUSDC (no constructor args)
  if (deployment.contracts.MockUSDC) {
    const success = await verifyContract(
      deployment.contracts.MockUSDC,
      [],
      "MockUSDC"
    );
    if (success) results.success.push("MockUSDC");
    else results.failed.push("MockUSDC");
  }

  // 5. HokusaiAMMFactory (constructor: ModelRegistry, TokenManager, reserveToken, treasury)
  if (deployment.contracts.HokusaiAMMFactory &&
      deployment.contracts.ModelRegistry &&
      deployment.contracts.TokenManager &&
      reserveToken) {
    const treasury = deployment.treasury || deployment.deployer;
    const success = await verifyContract(
      deployment.contracts.HokusaiAMMFactory,
      [
        deployment.contracts.ModelRegistry,
        deployment.contracts.TokenManager,
        reserveToken,
        treasury
      ],
      "HokusaiAMMFactory"
    );
    if (success) results.success.push("HokusaiAMMFactory");
    else results.failed.push("HokusaiAMMFactory");
  }

  // 6. UsageFeeRouter (constructor: _factory, _reserveToken, _infraReserve, _costOracle)
  if (deployment.contracts.UsageFeeRouter &&
      deployment.contracts.HokusaiAMMFactory &&
      reserveToken &&
      deployment.contracts.InfrastructureReserve &&
      deployment.contracts.InfrastructureCostOracle) {
    const success = await verifyContract(
      deployment.contracts.UsageFeeRouter,
      [
        deployment.contracts.HokusaiAMMFactory,
        reserveToken,
        deployment.contracts.InfrastructureReserve,
        deployment.contracts.InfrastructureCostOracle
      ],
      "UsageFeeRouter"
    );
    if (success) results.success.push("UsageFeeRouter");
    else results.failed.push("UsageFeeRouter");
  }

  // 7. DeltaVerifier (constructor: ModelRegistry, TokenManager, DataContributionRegistry, baseRewardRate, minImprovementBps, maxReward)
  if (deployment.contracts.DeltaVerifier &&
      deployment.contracts.ModelRegistry &&
      deployment.contracts.TokenManager &&
      deployment.contracts.DataContributionRegistry) {
    // Source the deployed reward params from the artifact (the deploy now reads
    // maxReward from locked-economics.json, e.g. 2.5M — NOT the legacy 1M). Fall
    // back to legacy defaults only for older artifacts that didn't record them.
    const dvp = (deployment.config && deployment.config.deltaVerifierParams) || {};
    const baseRewardRate = dvp.baseRewardRate != null ? dvp.baseRewardRate : 1000;
    const minImprovementBps = dvp.minImprovementBps != null ? dvp.minImprovementBps : 100;
    const maxReward =
      dvp.maxReward != null ? dvp.maxReward : hre.ethers.parseEther("1000000").toString();

    const success = await verifyContract(
      deployment.contracts.DeltaVerifier,
      [
        deployment.contracts.ModelRegistry,
        deployment.contracts.TokenManager,
        deployment.contracts.DataContributionRegistry,
        baseRewardRate,
        minImprovementBps,
        maxReward
      ],
      "DeltaVerifier"
    );
    if (success) results.success.push("DeltaVerifier");
    else results.failed.push("DeltaVerifier");
  }

  // 7b. Verify per-token HokusaiParams contracts.
  // Each token has a sibling params contract (token.paramsAddress) deployed by
  // TokenDeploymentFactory.deployTokenAndParams -> new HokusaiParams(
  //   tokensPerDeltaOne, infrastructureAccrualBps, oraclePricePerThousandUsd,
  //   licenseHash, licenseURI, governor, vestingConfig).
  // The scalar/wei constructor values are NOT stored in the deployment artifact, so we
  // source them from the same launch-tokens config the deploy used, scaled identically
  // (scaleTokenEntry), and join to the deployed tokens by configKey.
  const launchConfigPath =
    process.env.LAUNCH_TOKENS_CONFIG ||
    path.join(__dirname, 'configs', `${hre.network.name}-launch-tokens.json`);

  let scaledByConfigKey = null;
  if ((deployment.tokens || []).length > 0) {
    try {
      const launchConfig = loadLaunchTokensConfig(launchConfigPath);
      scaledByConfigKey = new Map(
        launchConfig.tokens.map(scaleTokenEntry).map((e) => [e.configKey, e])
      );
    } catch (err) {
      console.log(
        `\n⚠️  Skipping HokusaiParams verification — could not load launch config ` +
        `(${launchConfigPath}): ${err.message}`
      );
    }
  }

  if (scaledByConfigKey) {
    console.log("\n⚙️  Verifying HokusaiParams contracts...");
    for (const token of deployment.tokens || []) {
      if (!token.paramsAddress) continue;
      const scaled = scaledByConfigKey.get(token.configKey);
      if (!scaled) {
        console.log(
          `   ⚠️  No launch-config entry for configKey "${token.configKey}" — ` +
          `skipping ${token.symbol} params`
        );
        results.failed.push(`${token.symbol} Params`);
        continue;
      }

      const vc = scaled.vestingConfig;
      const success = await verifyContract(
        token.paramsAddress,
        [
          scaled.tokensPerDeltaOneWei.toString(),   // initialTokensPerDeltaOne
          scaled.infrastructureAccrualBps,          // initialInfrastructureAccrualBps
          scaled.oraclePriceValue.toString(),       // initialOraclePricePerThousandUsd
          scaled.licenseHash,                       // initialLicenseHash
          scaled.licenseURI,                        // initialLicenseURI
          scaled.governor,                          // governor
          [                                         // VestingConfig tuple
            vc.enabled,
            vc.immediateUnlockBps,
            vc.vestingDurationSeconds,
            vc.cliffSeconds,
          ],
        ],
        `${token.symbol} Params`,
        "contracts/HokusaiParams.sol:HokusaiParams"
      );
      if (success) results.success.push(`${token.symbol} Params`);
      else results.failed.push(`${token.symbol} Params`);
    }
  }

  // 8. Verify all tokens (HokusaiToken instances)
  // Deployed via TokenManager.deployTokenWithAllocations -> TokenDeploymentFactory.deployTokenAndParams
  // -> new HokusaiToken(name, symbol, controller, params, initialSupply, maxSupply,
  //    modelSupplierAllocation, investorAllocation, modelSupplierRecipient).
  // controller = TokenManager (address(this) in DeployableTokenManager); initialSupply = 0 (cap-based).
  for (const token of deployment.tokens || []) {
    if (token.address && deployment.contracts.TokenManager && token.paramsAddress) {
      const success = await verifyContract(
        token.address,
        [
          token.name,                          // _name
          token.symbol,                        // _symbol
          deployment.contracts.TokenManager,   // _controller
          token.paramsAddress,                 // _params
          "0",                                 // _initialSupply (cap-based deploy passes 0)
          token.maxSupply,                     // _maxSupply
          token.supplierAllocation,            // _modelSupplierAllocation
          token.investorAllocation,            // _investorAllocation
          token.supplierRecipient              // _modelSupplierRecipient
        ],
        `${token.symbol} Token`
      );
      if (success) results.success.push(`${token.symbol} Token`);
      else results.failed.push(`${token.symbol} Token`);
    }
  }

  // 9. Verify all AMM pools
  console.log("\n🏊 Verifying AMM Pools...");
  for (const pool of deployment.pools || []) {
    if (pool.ammAddress && reserveToken && deployment.contracts.TokenManager) {
      const treasury = deployment.treasury || deployment.deployer;

      // The pool contract is HokusaiAMM, created via
      // factory.createPoolWithParamsAndWhitelist -> HokusaiAMMPoolDeployer.deployPool
      // -> new HokusaiAMM(reserveToken, hokusaiToken, tokenManager, modelId, treasury,
      //    crr, tradeFee, ibrDuration, flatCurveThreshold, flatCurvePrice).
      // The artifact stores flatCurveThreshold/flatCurvePrice as human-readable strings
      // (ethers.formatUnits(value, 6)); the constructor received the 6-decimal integers,
      // so we reverse via parseUnits(value, 6). e.g. "25000.0" -> 25000000000, "0.01" -> 10000.
      const flatCurveThreshold = hre.ethers.parseUnits(String(pool.flatCurveThreshold), 6);
      const flatCurvePrice = hre.ethers.parseUnits(String(pool.flatCurvePrice), 6);

      const constructorArgs = [
        reserveToken,                            // _reserveToken
        pool.tokenAddress,                       // _hokusaiToken
        deployment.contracts.TokenManager,       // _tokenManager (payable)
        pool.modelId,                           // _modelId
        treasury,                               // _treasury
        pool.crr,                               // _crr
        pool.tradeFee,                          // _tradeFee
        pool.ibrDuration,                       // _ibrDuration
        flatCurveThreshold,                     // _flatCurveThreshold (6-decimal integer)
        flatCurvePrice                          // _flatCurvePrice (6-decimal integer)
      ];

      const success = await verifyContract(
        pool.ammAddress,
        constructorArgs,
        `${pool.modelId} AMM Pool`
      );
      if (success) results.success.push(`${pool.modelId} Pool`);
      else results.failed.push(`${pool.modelId} Pool`);
    }
  }

  // Summary
  console.log("\n" + "=".repeat(70));
  console.log("📊 VERIFICATION SUMMARY");
  console.log("=".repeat(70));
  console.log(`✅ Successfully verified: ${results.success.length}`);
  results.success.forEach(name => console.log(`   - ${name}`));

  if (results.failed.length > 0) {
    console.log(`\n❌ Failed to verify: ${results.failed.length}`);
    results.failed.forEach(name => console.log(`   - ${name}`));
  }

  console.log("\n🎉 Verification process complete!");
  console.log("\nView verified contracts at:");
  const explorerBase =
    hre.network.name === "mainnet" || String(deployment.chainId) === "1"
      ? "https://etherscan.io"
      : "https://sepolia.etherscan.io";
  console.log(`${explorerBase}/address/${deployment.contracts.ModelRegistry}#code`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
