const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

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

  // Load deployment data
  const deploymentPath = path.join(__dirname, '..', 'deployments', 'sepolia-latest.json');

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

  // 5. HokusaiAMMFactory (constructor: ModelRegistry, TokenManager, USDC, treasury)
  if (deployment.contracts.HokusaiAMMFactory &&
      deployment.contracts.ModelRegistry &&
      deployment.contracts.TokenManager &&
      deployment.contracts.MockUSDC) {
    const treasury = deployment.treasury || deployment.deployer;
    const success = await verifyContract(
      deployment.contracts.HokusaiAMMFactory,
      [
        deployment.contracts.ModelRegistry,
        deployment.contracts.TokenManager,
        deployment.contracts.MockUSDC,
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
      deployment.contracts.MockUSDC &&
      deployment.contracts.InfrastructureReserve &&
      deployment.contracts.InfrastructureCostOracle) {
    const reserveToken = (deployment.config && deployment.config.reserveToken) || deployment.contracts.MockUSDC;
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
    // Default parameters from deployment scripts
    const baseRewardRate = 1000;  // 1000 tokens per 1% improvement
    const minImprovementBps = 100;  // 1% minimum improvement
    const maxReward = hre.ethers.parseEther("1000000");  // 1M tokens max

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
    if (pool.ammAddress && deployment.contracts.MockUSDC && deployment.contracts.TokenManager) {
      const treasury = deployment.treasury || deployment.deployer;
      const reserveToken = (deployment.config && deployment.config.reserveToken) || deployment.contracts.MockUSDC;

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
  console.log(`https://sepolia.etherscan.io/address/${deployment.contracts.ModelRegistry}#code`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
