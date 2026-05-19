const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const {
  loadLaunchTokensConfig,
  scaleTokenEntry,
  validateNumericModelId,
} = require("./lib/launch-tokens");

const { ethers } = hre;

const DEFAULT_DEPLOYMENT_PATH = path.join(__dirname, "..", "deployments", "mainnet-latest.json");
const DEFAULT_CONFIG_PATH = path.join(__dirname, "configs", "mainnet-launch-tokens.json");
const DEFAULT_PENDING_ACTIONS_PATH = path.join(__dirname, "..", "deployments", "mainnet-pending-actions.json");
const POOLS_TO_CREATE = ["conservative", "aggressive", "balanced"];

async function loadDeployment(deploymentPath = DEFAULT_DEPLOYMENT_PATH) {
  if (!fs.existsSync(deploymentPath)) {
    throw new Error("Deployment artifact not found! Run deploy-mainnet.js first.");
  }

  return JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
}

function getDatedDeploymentPath() {
  const deploymentDir = path.join(__dirname, "..", "deployments");
  const timestamp = new Date().toISOString().split("T")[0];
  return path.join(deploymentDir, `mainnet-${timestamp}.json`);
}

function getEtherscanBaseUrl(chainId) {
  if (chainId === 1n) {
    return "https://etherscan.io";
  }
  if (chainId === 31337n) {
    return "http://localhost:8545";
  }
  return "https://etherscan.io";
}

function extractEventArg(receipt, contractInterface, eventName, argName) {
  for (const log of receipt.logs) {
    try {
      const parsed = contractInterface.parseLog(log);
      if (parsed && parsed.name === eventName) {
        return parsed.args[argName];
      }
    } catch (error) {
      // Skip logs from other contracts.
    }
  }

  return undefined;
}

function formatMismatchValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return value.toString();
}

async function verifyDeployedToken({ tokenManager, tokenAddress, expected }) {
  const token = await ethers.getContractAt("HokusaiToken", tokenAddress);
  const paramsAddress = await token.params();
  const params = await ethers.getContractAt("HokusaiParams", paramsAddress);
  const vestingConfig = await params.vestingConfig();
  const govRole = await params.GOV_ROLE();
  const maxSupply = await token.maxSupply();
  const supplierAllocation = await token.modelSupplierAllocation();

  const checks = [
    ["supplierRecipient", await token.modelSupplierRecipient(), ethers.getAddress(expected.supplierRecipient)],
    ["supplierAllocation", supplierAllocation, expected.supplierWei],
    ["investorAllocation", maxSupply - supplierAllocation, expected.investorWei],
    ["maxSupply", maxSupply, expected.maxSupplyWei],
    ["modelSupplierDistributed", await token.modelSupplierDistributed(), false],
    ["tokensPerDeltaOne", await params.tokensPerDeltaOne(), expected.tokensPerDeltaOneWei],
    ["infrastructureAccrualBps", await params.infrastructureAccrualBps(), expected.infrastructureAccrualBps],
    ["oraclePricePerThousandUsd", await params.oraclePricePerThousandUsd(), expected.oraclePriceValue],
    ["licenseHash", await params.licenseHash(), expected.licenseHash],
    ["licenseURI", await params.licenseURI(), expected.licenseURI],
    ["governor (GOV_ROLE)", await params.hasRole(govRole, expected.governor), true],
    ["vesting.enabled", vestingConfig.enabled, expected.vestingConfig.enabled],
    ["vesting.immediateUnlockBps", vestingConfig.immediateUnlockBps, expected.vestingConfig.immediateUnlockBps],
    ["vesting.vestingDurationSeconds", vestingConfig.vestingDurationSeconds, BigInt(expected.vestingConfig.vestingDurationSeconds)],
    ["vesting.cliffSeconds", vestingConfig.cliffSeconds, BigInt(expected.vestingConfig.cliffSeconds)],
    ["tokenManager mapping", await tokenManager.getTokenAddress(expected.modelId), tokenAddress],
  ];

  const mismatches = checks.filter(([, actual, want]) => formatMismatchValue(actual) !== formatMismatchValue(want));
  if (mismatches.length > 0) {
    for (const [label, actual, want] of mismatches) {
      console.error(`   ❌ VERIFICATION FAILED: ${label} → got ${formatMismatchValue(actual)}, expected ${formatMismatchValue(want)}`);
    }
    throw new Error(`Verification failed for ${expected.modelId}`);
  }

  return { token, params, paramsAddress };
}

async function verifyRegisteredModel({ modelRegistry, tokenAddress, expected }) {
  const numericModelId = validateNumericModelId(expected.modelId, "modelId");
  const checks = [
    ["modelRegistry.isRegistered", await modelRegistry.isRegistered(numericModelId), true],
    ["modelRegistry.getTokenAddress", await modelRegistry.getTokenAddress(numericModelId), tokenAddress],
    ["modelRegistry.isStringRegistered", await modelRegistry.isStringRegistered(expected.modelId), true],
    ["modelRegistry.getStringToken", await modelRegistry.getStringToken(expected.modelId), tokenAddress],
  ];

  const mismatches = checks.filter(([, actual, want]) => formatMismatchValue(actual) !== formatMismatchValue(want));
  if (mismatches.length > 0) {
    for (const [label, actual, want] of mismatches) {
      console.error(`   ❌ VERIFICATION FAILED: ${label} → got ${formatMismatchValue(actual)}, expected ${formatMismatchValue(want)}`);
    }
    throw new Error(`ModelRegistry verification failed for ${expected.modelId}`);
  }
}

function resolvePendingActionsOutputPath(basePath) {
  if (!fs.existsSync(basePath)) {
    return basePath;
  }

  const ext = path.extname(basePath);
  const base = ext ? basePath.slice(0, -ext.length) : basePath;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}-${timestamp}${ext || ".json"}`;
}

function writePendingActions(basePath, pendingActions) {
  if (pendingActions.length === 0) {
    return null;
  }

  const outputPath = resolvePendingActionsOutputPath(basePath);
  fs.writeFileSync(outputPath, JSON.stringify({
    createdAt: new Date().toISOString(),
    actions: pendingActions,
  }, null, 2));
  return outputPath;
}

async function runLaunchDeploy({
  deployment,
  launchConfig,
  expectedChainId = 1n,
  confirmationDelayMs = 15000,
  datedDeploymentPath = getDatedDeploymentPath(),
  latestDeploymentPath = DEFAULT_DEPLOYMENT_PATH,
  pendingActionsPath = DEFAULT_PENDING_ACTIONS_PATH,
} = {}) {
  console.log("🏊 Creating Mainnet AMM Pools...\n");
  console.log("=".repeat(70));
  console.log("⚠️  WARNING: Creating pools on MAINNET");
  console.log("⚠️  This will use real USDC for initial reserves");
  console.log("⚠️  Please verify all parameters carefully");
  console.log("=".repeat(70));
  console.log();

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();

  if (network.chainId !== expectedChainId) {
    throw new Error(`Wrong network! Expected chainId ${expectedChainId}, got ${network.chainId}`);
  }

  console.log("Network:", network.name, `(chainId: ${network.chainId})`);
  console.log("Deployer:", deployer.address);

  console.log("\n📂 Loading deployment info...");
  console.log("✅ Loaded deployment from:", deployment.timestamp);

  const usdcAddress = deployment.config.reserveToken;
  const registryAddress = deployment.contracts.ModelRegistry;
  const managerAddress = deployment.contracts.TokenManager;
  const factoryAddress = deployment.contracts.HokusaiAMMFactory;

  console.log("\n📋 Contract Addresses:");
  console.log(`   USDC:             ${usdcAddress}`);
  console.log(`   ModelRegistry:    ${registryAddress}`);
  console.log(`   TokenManager:     ${managerAddress}`);
  console.log(`   AMMFactory:       ${factoryAddress}`);

  const usdc = await ethers.getContractAt("IERC20", usdcAddress);
  const modelRegistry = await ethers.getContractAt("ModelRegistry", registryAddress);
  const tokenManager = await ethers.getContractAt("TokenManager", managerAddress);
  const factory = await ethers.getContractAt("HokusaiAMMFactory", factoryAddress);

  const scaledEntries = launchConfig.tokens
    .filter((entry) => POOLS_TO_CREATE.includes(entry.configKey))
    .map(scaleTokenEntry);

  if (scaledEntries.length !== POOLS_TO_CREATE.length) {
    throw new Error(`Expected ${POOLS_TO_CREATE.length} configured launch tokens, found ${scaledEntries.length}`);
  }

  const usdcBalance = await usdc.balanceOf(deployer.address);
  console.log("\n💰 Deployer USDC balance:", ethers.formatUnits(usdcBalance, 6), "USDC");

  const totalUsdcNeeded = scaledEntries.reduce((sum, entry) => sum + entry.initialReserveUsdc, 0n);
  console.log("💰 Total USDC needed:", ethers.formatUnits(totalUsdcNeeded, 6), "USDC");

  if (usdcBalance < totalUsdcNeeded) {
    throw new Error(`Insufficient USDC! Need ${ethers.formatUnits(totalUsdcNeeded, 6)} USDC`);
  }

  const ethBalance = await ethers.provider.getBalance(deployer.address);
  console.log("💰 Deployer ETH balance:", ethers.formatEther(ethBalance), "ETH");

  if (ethBalance < ethers.parseEther("0.1")) {
    throw new Error("Insufficient ETH! Need at least 0.1 ETH for gas");
  }

  console.log("\n📊 Pools to Create:");
  for (const config of scaledEntries) {
    console.log(`\n   ${config.pool.name}:`);
    console.log(`     Model ID:              ${config.modelId}`);
    console.log(`     Token:                 ${config.name} (${config.symbol})`);
    console.log(`     Supplier Recipient:    ${config.supplierRecipient}`);
    console.log(`     Supplier Allocation:   ${config.supplierAllocation} tokens`);
    console.log(`     Investor Allocation:   ${config.investorAllocation} tokens`);
    console.log(`     Max Supply:            ${ethers.formatUnits(config.maxSupplyWei, 18)} tokens`);
    console.log(`     Tokens Per DeltaOne:   ${config.tokensPerDeltaOne}`);
    console.log(`     Initial Reserve:       $${ethers.formatUnits(config.initialReserveUsdc, 6)} USDC`);
    console.log(`     CRR:                   ${config.pool.crr / 10000}%`);
    console.log(`     Trade Fee:             ${config.pool.tradeFee / 100}%`);
    console.log(`     IBR Duration:          ${config.pool.ibrSeconds / 86400} days`);
    console.log(`     Distribution Timing:   ${config.distributionTiming}`);
  }

  console.log("\n🛑 Please review the above information");
  console.log("   Press Ctrl+C to cancel, or wait 15 seconds to continue...\n");
  await new Promise((resolve) => setTimeout(resolve, confirmationDelayMs));

  if (!deployment.tokens) deployment.tokens = [];
  if (!deployment.pools) deployment.pools = [];

  const pendingActions = [];
  const etherscanBaseUrl = getEtherscanBaseUrl(network.chainId);

  console.log("\n📦 Creating Pools...");
  console.log("-".repeat(70));

  for (const config of scaledEntries) {
    console.log(`\n🏊 Creating ${config.pool.name}...`);
    console.log(`   ${"-".repeat(66)}`);

    try {
      console.log(`   📝 Deploying token: ${config.name} (${config.symbol})`);
      const tokenTx = await tokenManager.deployTokenWithAllocations(
        config.modelId,
        config.name,
        config.symbol,
        config.supplierWei,
        config.supplierRecipient,
        config.investorWei,
        {
          tokensPerDeltaOne: config.tokensPerDeltaOneWei,
          infrastructureAccrualBps: config.infrastructureAccrualBps,
          initialOraclePricePerThousandUsd: config.oraclePriceValue,
          licenseHash: config.licenseHash,
          licenseURI: config.licenseURI,
          governor: config.governor,
          vestingConfig: config.vestingConfig,
        }
      );
      const tokenReceipt = await tokenTx.wait();
      console.log(`   ⛽ Gas used: ${tokenReceipt.gasUsed.toString()}`);

      const tokenAddress = extractEventArg(tokenReceipt, tokenManager.interface, "TokenDeployed", "tokenAddress");
      if (!tokenAddress) {
        throw new Error("Failed to extract token address from TokenDeployed event");
      }

      console.log(`   ✅ Token deployed: ${tokenAddress}`);
      console.log(`   🔗 View on Etherscan: ${etherscanBaseUrl}/token/${tokenAddress}`);

      console.log("   🔍 Verifying deployed token configuration...");
      const { token, paramsAddress } = await verifyDeployedToken({
        tokenManager,
        tokenAddress,
        expected: config,
      });
      console.log("   ✅ Token configuration verified");

      console.log("   📋 Registering model in ModelRegistry...");
      const numericModelId = validateNumericModelId(config.modelId, "modelId");
      const registerTx = await modelRegistry.registerModel(
        numericModelId,
        tokenAddress,
        config.pool.performanceMetric
      );
      const registerReceipt = await registerTx.wait();
      console.log(`   ✅ Model registered: ${config.modelId}`);
      console.log(`   ⛽ Gas used: ${registerReceipt.gasUsed.toString()}`);

      console.log("   🔍 Verifying ModelRegistry mapping...");
      await verifyRegisteredModel({
        modelRegistry,
        tokenAddress,
        expected: config,
      });
      console.log("   ✅ ModelRegistry mapping verified");

      console.log("   🏊 Creating AMM pool...");
      const poolTx = await factory.createPoolWithParams(
        config.modelId,
        tokenAddress,
        config.pool.crr,
        config.pool.tradeFee,
        config.pool.ibrSeconds,
        config.flatCurveThresholdUsdc,
        config.flatCurvePriceUsdc
      );
      const poolReceipt = await poolTx.wait();
      console.log(`   ⛽ Gas used: ${poolReceipt.gasUsed.toString()}`);

      const poolAddress = extractEventArg(poolReceipt, factory.interface, "PoolCreated", "poolAddress");
      if (!poolAddress) {
        throw new Error("Failed to extract pool address from PoolCreated event");
      }

      console.log(`   ✅ Pool created: ${poolAddress}`);
      console.log(`   🔗 View on Etherscan: ${etherscanBaseUrl}/address/${poolAddress}`);

      console.log("   🔐 Authorizing AMM to mint tokens...");
      const authorizeTx = await tokenManager.authorizeAMM(poolAddress);
      await authorizeTx.wait();
      console.log("   ✅ AMM authorized with MINTER_ROLE");

      console.log(`   💰 Adding initial liquidity ($${ethers.formatUnits(config.initialReserveUsdc, 6)} USDC)...`);
      const pool = await ethers.getContractAt("HokusaiAMM", poolAddress);

      console.log("   🔓 Approving USDC...");
      const approveTx = await usdc.approve(poolAddress, config.initialReserveUsdc);
      await approveTx.wait();
      console.log("   ✅ USDC approved");

      console.log("   💵 Depositing initial reserve...");
      const depositTx = await pool.depositFees(config.initialReserveUsdc);
      const depositReceipt = await depositTx.wait();
      console.log("   ✅ Initial reserve deposited");
      console.log(`   ⛽ Gas used: ${depositReceipt.gasUsed.toString()}`);

      const reserveBalance = await pool.reserveBalance();
      const spotPrice = await pool.spotPrice();
      const totalSupply = await token.totalSupply();

      console.log("\n   📊 Pool State:");
      console.log(`     Reserve:     $${ethers.formatUnits(reserveBalance, 6)} USDC`);
      console.log(`     Spot Price:  $${ethers.formatUnits(spotPrice, 6)}`);
      console.log(`     Supply:      ${ethers.formatEther(totalSupply)} tokens`);
      console.log(`     Market Cap:  $${ethers.formatUnits(reserveBalance * 10n ** 18n / BigInt(config.pool.crr) * 1000000n / 10n ** 18n, 6)}`);

      console.log("\n   📊 Fetching phase parameters...");
      const flatCurveThreshold = await pool.FLAT_CURVE_THRESHOLD();
      const flatCurvePrice = await pool.FLAT_CURVE_PRICE();

      console.log("   ✅ Phase Parameters:");
      console.log(`      Flat Curve Threshold: $${ethers.formatUnits(flatCurveThreshold, 6)} USDC`);
      console.log(`      Flat Curve Price: $${ethers.formatUnits(flatCurvePrice, 6)}`);

      let modelSupplierDistributed = await token.modelSupplierDistributed();
      if (config.distributionTiming === "pre-launch") {
        console.log("   🪙 Distributing supplier allocation pre-launch...");
        const distributeTx = await tokenManager.distributeModelSupplierAllocation(config.modelId);
        await distributeTx.wait();
        modelSupplierDistributed = await token.modelSupplierDistributed();
        const supplierBalance = await token.balanceOf(config.supplierRecipient);
        if (!modelSupplierDistributed || supplierBalance !== config.supplierWei) {
          throw new Error(`Supplier allocation verification failed for ${config.modelId}`);
        }
        console.log("   ✅ Supplier allocation distributed");
      } else {
        pendingActions.push({
          modelId: config.modelId,
          tokenAddress,
          supplierRecipient: config.supplierRecipient,
          amount: config.supplierWei.toString(),
          signer: await tokenManager.owner(),
          reason: "post-verification supplier mint",
        });
        console.log("   ⏭️  Supplier allocation deferred until post-verification");
      }

      deployment.tokens.push({
        configKey: config.configKey,
        modelId: config.modelId,
        name: config.name,
        symbol: config.symbol,
        address: tokenAddress,
        supplierRecipient: config.supplierRecipient,
        supplierAllocation: config.supplierWei.toString(),
        investorAllocation: config.investorWei.toString(),
        maxSupply: config.maxSupplyWei.toString(),
        distributionTiming: config.distributionTiming,
        paramsAddress,
        vestingConfig: config.vestingConfig,
        modelSupplierDistributed,
      });

      deployment.pools.push({
        configKey: config.configKey,
        modelId: config.modelId,
        tokenAddress,
        ammAddress: poolAddress,
        initialReserve: config.initialReserveUsdc.toString(),
        crr: config.pool.crr,
        tradeFee: config.pool.tradeFee,
        ibrDuration: config.pool.ibrSeconds,
        ibrEndsAt: new Date(Date.now() + config.pool.ibrSeconds * 1000).toISOString(),
        flatCurveThreshold: ethers.formatUnits(config.flatCurveThresholdUsdc, 6),
        flatCurvePrice: ethers.formatUnits(config.flatCurvePriceUsdc, 6),
      });

      console.log(`   ✅ ${config.pool.name} complete!`);
    } catch (error) {
      console.error(`   ❌ Failed to create ${config.pool.name}:`, error.message);
      throw error;
    }
  }

  console.log("\n\n💾 Saving Updated Deployment...");
  console.log("-".repeat(70));

  deployment.poolsCreatedAt = new Date().toISOString();
  const writtenPendingActionsPath = writePendingActions(pendingActionsPath, pendingActions);
  if (writtenPendingActionsPath) {
    deployment.pendingActionsPath = path.relative(path.join(__dirname, ".."), writtenPendingActionsPath);
    console.log(`✅ Pending actions saved to: ${deployment.pendingActionsPath}`);
  }

  fs.writeFileSync(datedDeploymentPath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Deployment saved to: ${path.relative(path.join(__dirname, ".."), datedDeploymentPath)}`);

  fs.writeFileSync(latestDeploymentPath, JSON.stringify(deployment, null, 2));
  console.log(`✅ Updated: ${path.relative(path.join(__dirname, ".."), latestDeploymentPath)}`);

  console.log(`\n\n${"=".repeat(70)}`);
  console.log("🎉 POOL CREATION SUCCESSFUL!");
  console.log("=".repeat(70));

  console.log("\n🪙 Tokens Created:");
  for (const token of deployment.tokens) {
    console.log(`   ${token.name} (${token.symbol}):`);
    console.log(`     Address:    ${token.address}`);
    console.log(`     Model ID:   ${token.modelId}`);
    console.log(`     Etherscan:  ${etherscanBaseUrl}/token/${token.address}`);
  }

  console.log("\n🏊 Pools Created:");
  for (const pool of deployment.pools) {
    const config = scaledEntries.find((entry) => entry.configKey === pool.configKey);
    console.log(`   ${config.pool.name}:`);
    console.log(`     AMM Address:    ${pool.ammAddress}`);
    console.log(`     Token Address:  ${pool.tokenAddress}`);
    console.log(`     Model ID:       ${pool.modelId}`);
    console.log(`     Initial Reserve: $${ethers.formatUnits(pool.initialReserve, 6)} USDC`);
    console.log(`     CRR:            ${pool.crr / 10000}%`);
    console.log(`     Trade Fee:      ${pool.tradeFee / 100}%`);
    console.log(`     IBR Ends:       ${pool.ibrEndsAt}`);
    console.log(`     Etherscan:      ${etherscanBaseUrl}/address/${pool.ammAddress}`);
  }

  if (writtenPendingActionsPath) {
    console.log("\n📝 Pending Supplier Distribution Actions:");
    console.log(`   ${path.relative(path.join(__dirname, ".."), writtenPendingActionsPath)}`);
  }

  console.log("\n📝 Next Steps:");
  console.log("   1. Configure monitoring service:");
  console.log("      - Use addresses from deployments/mainnet-latest.json");
  console.log("      - Monitoring will auto-discover new pools via PoolCreated events");
  console.log("   2. Start monitoring service BEFORE announcing pools");
  console.log("   3. Test buy/sell functionality with small amounts");
  console.log("   4. Monitor for IBR period (7 days)");
  console.log("   5. Verify all events are being captured by monitoring");

  console.log("\n⚠️  IMPORTANT POST-DEPLOYMENT:");
  console.log("   [ ] Monitoring service running and receiving events");
  console.log("   [ ] Test small buy transaction on each pool");
  console.log("   [ ] Verify reserve balances match expectations");
  console.log("   [ ] Confirm IBR end times (sells disabled until then)");
  console.log("   [ ] Set up alerts for large trades and price movements");
  console.log("   [ ] Monitor CloudWatch dashboard for metrics");
  console.log("   [ ] Document pool addresses in team documentation");

  return {
    deployment,
    pendingActionsPath: writtenPendingActionsPath,
  };
}

async function main() {
  const deployment = await loadDeployment();
  const launchConfig = loadLaunchTokensConfig(DEFAULT_CONFIG_PATH);
  await runLaunchDeploy({
    deployment,
    launchConfig,
  });
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_DEPLOYMENT_PATH,
  DEFAULT_PENDING_ACTIONS_PATH,
  loadDeployment,
  runLaunchDeploy,
  verifyDeployedToken,
  verifyRegisteredModel,
};

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("\n❌ Pool creation failed:", error);
      process.exit(1);
    });
}
