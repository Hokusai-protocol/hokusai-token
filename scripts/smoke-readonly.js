const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

/**
 * Network-agnostic READ-ONLY smoke checks. Sends zero transactions.
 *
 * Runs on any network whose deployment artifact follows the standard shape
 * (Sepolia or mainnet). It auto-detects the target network from the artifact
 * (deployment.chainId) and asserts the Hardhat provider matches it.
 *
 * What is a HARD assertion (PASS/FAIL) — network-invariant facts:
 *   - every contract address has deployed bytecode
 *   - structural wiring between contracts (registry <-> manager <-> factory <->
 *     router <-> infra <-> oracle <-> deltaVerifier <-> vault <-> contribution)
 *   - reserve token wiring matches the artifact's resolved reserve token
 *     (config.reserveToken on mainnet; MockUSDC on Sepolia)
 *   - per-model registration/activation, token identity, pool existence and
 *     shared-whitelist wiring
 *   - factory default parameters match the artifact config
 *   - DeltaVerifier is not paused
 *   - functional role grants that are WIRING, not custody: RECORDER_ROLE ->
 *     DeltaVerifier, DEPOSITOR_ROLE -> UsageFeeRouter (must hold post-handoff too)
 *
 * What is REPORTED but never fails the smoke — custody that legitimately differs
 * by network / handoff state:
 *   - who holds DEFAULT_ADMIN / GOV / WHITELIST_ADMIN / SUBMITTER / PAYER / owner
 *   Pre-handoff (no `governance` block) the deployer holds these; post-handoff
 *   they move to the timelock / admin Safe. Custody correctness is audited by
 *   `verify:governance:<net>` and `verify:launch-posture:<net>`, not here — this
 *   smoke only surfaces the holders so a human/CI can eyeball them.
 *
 * Health-endpoint checks run only when a health URL is available (explicitly via
 * --health-url / SMOKE_HEALTH_URL, or the built-in default on the Sepolia testnet
 * where the monitoring service lives). They are skipped cleanly otherwise.
 */

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const SEPOLIA_CHAIN_ID = "11155111";
const SEPOLIA_HEALTH_BASE_URL = "https://contracts.hokus.ai";
const DEFAULT_MIN_SIGNER_ETH = "0.01";
const DEFAULT_TOKEN_MODELS = "HMESS:28,HLEAD:27,HROUT:30";
const REQUEST_TIMEOUT_MS = 10_000;

const ABIS = {
  modelRegistry: [
    "function owner() view returns (address)",
    "function stringModelTokenManager() view returns (address)",
    "function isRegistered(uint256 modelId) view returns (bool)",
    "function isModelActive(uint256 modelId) view returns (bool)",
    "function getTokenAddress(uint256 modelId) view returns (address)",
    "function isStringRegistered(string modelId) view returns (bool)",
    "function isStringActive(string modelId) view returns (bool)",
    "function getStringToken(string modelId) view returns (address)",
  ],
  tokenManager: [
    "function owner() view returns (address)",
    "function registry() view returns (address)",
    "function tokenDeploymentFactory() view returns (address)",
    "function deltaVerifier() view returns (address)",
    "function vestingVault() view returns (address)",
    "function hasToken(string modelId) view returns (bool)",
    "function getTokenAddress(string modelId) view returns (address)",
  ],
  deltaVerifier: [
    "function SUBMITTER_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function modelRegistry() view returns (address)",
    "function tokenManager() view returns (address)",
    "function contributionRegistry() view returns (address)",
    "function paused() view returns (bool)",
  ],
  contributionRegistry: [
    "function RECORDER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ],
  ammFactory: [
    "function owner() view returns (address)",
    "function modelRegistry() view returns (address)",
    "function tokenManager() view returns (address)",
    "function reserveToken() view returns (address)",
    "function treasury() view returns (address)",
    "function poolCount() view returns (uint256)",
    "function defaultCrr() view returns (uint256)",
    "function defaultTradeFee() view returns (uint256)",
    "function defaultIbrDuration() view returns (uint256)",
    "function defaultFlatCurveThreshold() view returns (uint256)",
    "function defaultFlatCurvePrice() view returns (uint256)",
    "function getPool(string modelId) view returns (address)",
  ],
  usageFeeRouter: [
    "function FEE_DEPOSITOR_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function factory() view returns (address)",
    "function reserveToken() view returns (address)",
    "function infraReserve() view returns (address)",
    "function costOracle() view returns (address)",
  ],
  infrastructureReserve: [
    "function DEPOSITOR_ROLE() view returns (bytes32)",
    "function PAYER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ],
  infrastructureCostOracle: [
    "function GOV_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
  ],
  purchaserWhitelist: [
    "function WHITELIST_ADMIN_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role, address account) view returns (bool)",
    "function isWhitelisted(address account) view returns (bool)",
  ],
  ammPool: [
    "function purchaserWhitelist() view returns (address)",
  ],
};

function parseArgs(argv) {
  const options = {
    deploymentFile: process.env.SMOKE_DEPLOYMENT_FILE || null,
    healthBaseUrl: process.env.SMOKE_HEALTH_URL || null,
    skipHealth: process.env.SMOKE_SKIP_HEALTH === "1",
    minSignerEth: process.env.SMOKE_MIN_SIGNER_ETH || DEFAULT_MIN_SIGNER_ETH,
    tokenModels: parseTokenModels(process.env.SMOKE_TOKEN_MODELS || DEFAULT_TOKEN_MODELS),
    requireEmptyQueues: process.env.SMOKE_REQUIRE_EMPTY_QUEUES === "1",
    requireWhitelist: process.env.SMOKE_REQUIRE_WHITELIST !== "0",
    json: process.env.SMOKE_JSON === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment-file") {
      options.deploymentFile = argv[++i];
    } else if (arg === "--health-url") {
      options.healthBaseUrl = argv[++i];
    } else if (arg === "--skip-health") {
      options.skipHealth = true;
    } else if (arg === "--min-signer-eth") {
      options.minSignerEth = argv[++i];
    } else if (arg === "--token-models") {
      options.tokenModels = parseTokenModels(argv[++i]);
    } else if (arg === "--require-empty-queues") {
      options.requireEmptyQueues = true;
    } else if (arg === "--allow-missing-whitelist") {
      options.requireWhitelist = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  if (options.healthBaseUrl) {
    options.healthBaseUrl = options.healthBaseUrl.replace(/\/+$/, "");
  }
  return options;
}

function printUsage() {
  console.log(`Network-agnostic read-only smoke checks (Sepolia + mainnet)

Usage:
  npm run smoke:sepolia
  npm run smoke:mainnet
  npx hardhat run scripts/smoke-readonly.js --network <sepolia|mainnet>

The target network is taken from the deployment artifact and asserted against
the Hardhat provider. By default the artifact is deployments/<network>-latest.json.

CI/environment options:
  SMOKE_DEPLOYMENT_FILE=deployments/mainnet-latest.json
  SMOKE_HEALTH_URL=https://contracts.hokus.ai   (health checks; omit to skip)
  SMOKE_SKIP_HEALTH=1
  SMOKE_MIN_SIGNER_ETH=0.01
  SMOKE_TOKEN_MODELS=HMESS:28,HLEAD:27,HROUT:30
  SMOKE_REQUIRE_EMPTY_QUEUES=1
  SMOKE_REQUIRE_WHITELIST=0
  SMOKE_JSON=1

Options:
  --deployment-file <path>     Same as SMOKE_DEPLOYMENT_FILE.
  --health-url <url>           Same as SMOKE_HEALTH_URL.
  --skip-health                Skip all health-endpoint checks.
  --min-signer-eth <eth>       Same as SMOKE_MIN_SIGNER_ETH.
  --token-models <mapping>     Same as SMOKE_TOKEN_MODELS.
  --require-empty-queues       Same as SMOKE_REQUIRE_EMPTY_QUEUES=1.
  --allow-missing-whitelist    Allow pools without purchaser whitelists.
  --json                       Same as SMOKE_JSON=1.

Note: npm/Hardhat may consume appended flags. Prefer the SMOKE_* environment
variables when running through npm.
`);
}

function parseTokenModels(value) {
  return value.split(",").map((entry) => {
    const [symbol, modelId] = entry.split(":").map((part) => part.trim());
    if (!symbol || !modelId || !/^\d+$/.test(modelId)) {
      throw new Error(`Invalid token mapping "${entry}". Expected SYMBOL:numericModelId.`);
    }
    return { symbol: symbol.toUpperCase(), modelId };
  });
}

function loadDeployment(file) {
  const fullPath = path.resolve(process.cwd(), file);
  return {
    fullPath,
    deployment: JSON.parse(fs.readFileSync(fullPath, "utf8")),
  };
}

function asAddress(value) {
  return hre.ethers.getAddress(value);
}

function sameAddress(actual, expected) {
  return asAddress(actual) === asAddress(expected);
}

// Resolve the reserve token the deployment actually uses: real USDC on mainnet
// (config.reserveToken), MockUSDC on Sepolia. Mirrors verify-all-contracts.js.
function resolveReserveToken(deployment) {
  return (deployment.config && deployment.config.reserveToken) ||
    (deployment.contracts && deployment.contracts.MockUSDC);
}

// Structural admin custody differs by handoff state. Post-handoff (a `governance`
// block is present) admin lives with the timelock / admin Safe; pre-handoff the
// deployer holds it. Returns the principals we EXPECT to hold structural roles,
// for reporting only (never a hard failure — see the module header).
function expectedAdminPrincipals(deployment) {
  const gov = deployment.governance;
  if (gov && (gov.timelock || gov.adminSafe || gov.emergencySafe)) {
    return [...new Set([gov.timelock, gov.adminSafe, gov.emergencySafe].filter(Boolean))];
  }
  return [deployment.deployer].filter(Boolean);
}

function formatValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
}

function toPrintable(details) {
  if (details === undefined) {
    return undefined;
  }

  if (Array.isArray(details)) {
    return details.map(formatValue);
  }

  if (details && typeof details === "object") {
    return Object.fromEntries(
      Object.entries(details).map(([key, value]) => [key, formatValue(value)]),
    );
  }

  return formatValue(details);
}

function createRecorder() {
  const checks = [];

  return {
    checks,
    pass(name, details) {
      checks.push({ status: "pass", name, details: toPrintable(details) });
    },
    warn(name, details) {
      checks.push({ status: "warn", name, details: toPrintable(details) });
    },
    fail(name, details) {
      checks.push({ status: "fail", name, details: toPrintable(details) });
    },
    info(name, details) {
      checks.push({ status: "info", name, details: toPrintable(details) });
    },
    assert(name, condition, details) {
      if (condition) {
        this.pass(name, details);
      } else {
        this.fail(name, details);
      }
    },
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      body = { parseError: error.message, raw: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function getCodeCheck(recorder, provider, label, address) {
  const code = await provider.getCode(address);
  recorder.assert(`${label} has deployed bytecode`, code !== "0x", { address });
}

async function checkEndpoint(recorder, baseUrl, pathName) {
  const url = `${baseUrl}${pathName}`;
  try {
    const result = await fetchJson(url);
    recorder.assert(`GET ${pathName} returns 200`, result.status === 200, {
      url,
      status: result.status,
    });
    return result.body;
  } catch (error) {
    recorder.fail(`GET ${pathName} returns 200`, {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// Core contracts that exist on every network. MockUSDC is Sepolia-only and is
// validated separately via the resolved reserve token, so it is not required here.
function deploymentContracts(deployment) {
  const contracts = deployment.contracts || {};
  const required = [
    "ModelRegistry",
    "TokenDeploymentFactory",
    "TokenManager",
    "RewardVestingVault",
    "DataContributionRegistry",
    "HokusaiAMMFactory",
    "PurchaserWhitelist",
    "InfrastructureReserve",
    "InfrastructureCostOracle",
    "UsageFeeRouter",
    "DeltaVerifier",
  ];

  for (const name of required) {
    if (!contracts[name] || !hre.ethers.isAddress(contracts[name])) {
      throw new Error(`Deployment artifact is missing a valid contracts.${name} address`);
    }
  }

  const reserveToken = resolveReserveToken(deployment);
  if (!reserveToken || !hre.ethers.isAddress(reserveToken)) {
    throw new Error("Deployment artifact is missing a valid reserve token (config.reserveToken or contracts.MockUSDC)");
  }

  return { contracts, reserveToken };
}

function compareReadyAddresses(recorder, readyBody, contracts, reserveToken) {
  const readyAddresses = readyBody?.checks?.contracts?.addresses || readyBody?.checks?.contracts;
  if (!readyAddresses) {
    recorder.fail("/health/ready exposes fresh contract addresses", { available: false });
    return;
  }

  recorder.pass("/health/ready exposes fresh contract addresses");

  const expectedByName = {
    ModelRegistry: contracts.ModelRegistry,
    TokenManager: contracts.TokenManager,
    HokusaiAMMFactory: contracts.HokusaiAMMFactory,
    UsageFeeRouter: contracts.UsageFeeRouter,
    DeltaVerifier: contracts.DeltaVerifier,
  };
  const readyAddressKeys = {
    ModelRegistry: ["ModelRegistry", "modelRegistry"],
    TokenManager: ["TokenManager", "tokenManager"],
    HokusaiAMMFactory: ["HokusaiAMMFactory", "factory"],
    UsageFeeRouter: ["UsageFeeRouter", "usageFeeRouter"],
    DeltaVerifier: ["DeltaVerifier", "deltaVerifier"],
    // reserve token is MockUSDC on Sepolia, real USDC on mainnet
    reserveToken: ["reserveToken", "MockUSDC", "usdc", "USDC"],
  };
  expectedByName.reserveToken = reserveToken;

  for (const [name, keys] of Object.entries(readyAddressKeys)) {
    const expected = expectedByName[name];
    const readyKey = keys.find((key) => readyAddresses[key] !== undefined);
    if (!readyKey) {
      recorder.warn(`/health/ready omits ${name}`, { expected });
      continue;
    }

    recorder.assert(`/health/ready ${name} matches artifact`, sameAddress(readyAddresses[readyKey], expected), {
      ready: readyAddresses[readyKey],
      artifact: expected,
    });
  }
}

function checkQueueDepths(recorder, readyBody, requireEmptyQueues) {
  const queueDepths = readyBody?.checks?.redis?.queueDepths || readyBody?.checks?.redis?.queues;
  if (!queueDepths) {
    recorder.warn("/health/ready does not expose MintRequest queue depths");
    return;
  }

  const depths = Object.fromEntries(
    Object.entries(queueDepths).map(([name, value]) => [name, Number(value)]),
  );
  const nonEmpty = Object.entries(depths).filter(([, depth]) => depth > 0);
  recorder.pass("MintRequest queue depths are visible", depths);

  if (nonEmpty.length === 0) {
    recorder.pass("MintRequest queues are empty", depths);
  } else if (requireEmptyQueues) {
    recorder.fail("MintRequest queues are empty", depths);
  } else {
    recorder.warn("MintRequest queues are not empty", depths);
  }
}

// Report (never fail on) who holds a custody role among the expected principals.
async function reportCustodyRole(recorder, contract, roleLabel, role, principals) {
  const holders = [];
  for (const principal of principals) {
    // eslint-disable-next-line no-await-in-loop
    if (await contract.hasRole(role, principal)) {
      holders.push(principal);
    }
  }
  if (holders.length > 0) {
    recorder.info(`${roleLabel} held by expected principal`, { holders });
  } else {
    recorder.warn(`${roleLabel} not held by any expected principal (audit via verify:governance)`, {
      expectedPrincipals: principals,
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recorder = createRecorder();

  const provider = hre.ethers.provider;
  const network = await provider.getNetwork();
  const chainId = network.chainId.toString();

  // Default the artifact to deployments/<hardhat-network>-latest.json.
  const deploymentFile =
    options.deploymentFile || `deployments/${hre.network.name}-latest.json`;
  const { fullPath, deployment } = loadDeployment(deploymentFile);
  const { contracts, reserveToken } = deploymentContracts(deployment);

  const artifactChainId = String(deployment.chainId);
  recorder.assert("Hardhat provider chainId matches artifact", chainId === artifactChainId, {
    providerChainId: chainId,
    artifactChainId,
    hardhatNetwork: hre.network.name,
    artifactNetwork: deployment.network,
  });

  const handedOff = Boolean(
    deployment.governance &&
    (deployment.governance.timelock || deployment.governance.adminSafe),
  );

  // ---- Health-endpoint checks (only when a health URL is available) ----
  let healthBaseUrl = options.healthBaseUrl;
  if (!healthBaseUrl && !options.skipHealth && artifactChainId === SEPOLIA_CHAIN_ID) {
    healthBaseUrl = SEPOLIA_HEALTH_BASE_URL; // monitoring service lives on testnet
  }

  if (options.skipHealth || !healthBaseUrl) {
    recorder.info("Health-endpoint checks skipped", {
      reason: options.skipHealth ? "--skip-health" : "no health URL for this network",
    });
  } else {
    const healthBody = await checkEndpoint(recorder, healthBaseUrl, "/health");
    recorder.assert("/health reports healthy", healthBody?.status === "healthy", healthBody);

    const readyBody = await checkEndpoint(recorder, healthBaseUrl, "/health/ready");
    recorder.assert("/health/ready reports ready", readyBody?.status === "ready", {
      status: readyBody?.status,
    });
    recorder.assert("/health/ready RPC check is healthy", readyBody?.checks?.rpc?.ok === true, {
      chainId: readyBody?.checks?.rpc?.chainId,
      blockNumber: readyBody?.checks?.rpc?.blockNumber,
    });
    recorder.assert("/health/ready signer is funded", readyBody?.checks?.signer?.ok === true, {
      address: readyBody?.checks?.signer?.address,
      balanceEth: readyBody?.checks?.signer?.balanceEth,
    });
    recorder.assert("/health/ready DeltaVerifier role check passes", readyBody?.checks?.deltaVerifier?.ok === true, {
      signerHasSubmitterRole: readyBody?.checks?.deltaVerifier?.signerHasSubmitterRole,
    });
    recorder.assert("/health/ready Redis check passes", readyBody?.checks?.redis?.ok === true);
    compareReadyAddresses(recorder, readyBody, contracts, reserveToken);
    checkQueueDepths(recorder, readyBody, options.requireEmptyQueues);

    const monitoringHealth = await checkEndpoint(recorder, healthBaseUrl, "/api/monitoring/health");
    recorder.assert("/api/monitoring/health reports success", monitoringHealth?.success === true, monitoringHealth);

    const poolsBody = await checkEndpoint(recorder, healthBaseUrl, "/api/monitoring/pools");
    recorder.assert("/api/monitoring/pools reports success", poolsBody?.success === true, {
      count: poolsBody?.count,
    });
  }

  // ---- On-chain bytecode presence ----
  for (const [name, address] of Object.entries(contracts)) {
    if (!name.startsWith("_") && hre.ethers.isAddress(address)) {
      await getCodeCheck(recorder, provider, name, address);
    }
  }
  await getCodeCheck(recorder, provider, "ReserveToken", reserveToken);

  // Deployer ETH is informational (a warning): post-handoff the deployer no
  // longer operates the system, so a low balance is not a health failure.
  const deployer = asAddress(deployment.deployer);
  const balance = await provider.getBalance(deployer);
  const minBalance = hre.ethers.parseEther(options.minSignerEth);
  if (balance >= minBalance) {
    recorder.pass("Deployment signer meets minimum ETH", {
      signer: deployer,
      balanceEth: hre.ethers.formatEther(balance),
    });
  } else {
    recorder.warn("Deployment signer below minimum ETH (informational)", {
      signer: deployer,
      balanceEth: hre.ethers.formatEther(balance),
      minimumEth: options.minSignerEth,
    });
  }

  const modelRegistry = new hre.ethers.Contract(contracts.ModelRegistry, ABIS.modelRegistry, provider);
  const tokenManager = new hre.ethers.Contract(contracts.TokenManager, ABIS.tokenManager, provider);
  const deltaVerifier = new hre.ethers.Contract(contracts.DeltaVerifier, ABIS.deltaVerifier, provider);
  const contributionRegistry = new hre.ethers.Contract(
    contracts.DataContributionRegistry,
    ABIS.contributionRegistry,
    provider,
  );
  const ammFactory = new hre.ethers.Contract(contracts.HokusaiAMMFactory, ABIS.ammFactory, provider);
  const usageFeeRouter = new hre.ethers.Contract(contracts.UsageFeeRouter, ABIS.usageFeeRouter, provider);
  const infrastructureReserve = new hre.ethers.Contract(
    contracts.InfrastructureReserve,
    ABIS.infrastructureReserve,
    provider,
  );
  const costOracle = new hre.ethers.Contract(
    contracts.InfrastructureCostOracle,
    ABIS.infrastructureCostOracle,
    provider,
  );
  const purchaserWhitelist = new hre.ethers.Contract(
    contracts.PurchaserWhitelist,
    ABIS.purchaserWhitelist,
    provider,
  );

  // ---- Structural wiring (hard assertions, network-invariant) ----
  const stringModelTokenManager = await modelRegistry.stringModelTokenManager();
  recorder.assert("ModelRegistry.stringModelTokenManager matches TokenManager", sameAddress(stringModelTokenManager, contracts.TokenManager), {
    actual: stringModelTokenManager,
    expected: contracts.TokenManager,
  });

  const tokenManagerRegistry = await tokenManager.registry();
  recorder.assert("TokenManager.registry matches ModelRegistry", sameAddress(tokenManagerRegistry, contracts.ModelRegistry), {
    actual: tokenManagerRegistry,
    expected: contracts.ModelRegistry,
  });

  const tokenDeploymentFactory = await tokenManager.tokenDeploymentFactory();
  recorder.assert(
    "TokenManager.tokenDeploymentFactory matches artifact",
    sameAddress(tokenDeploymentFactory, contracts.TokenDeploymentFactory),
    { actual: tokenDeploymentFactory, expected: contracts.TokenDeploymentFactory },
  );

  const tokenManagerDeltaVerifier = await tokenManager.deltaVerifier();
  recorder.assert("TokenManager.deltaVerifier matches DeltaVerifier", sameAddress(tokenManagerDeltaVerifier, contracts.DeltaVerifier), {
    actual: tokenManagerDeltaVerifier,
    expected: contracts.DeltaVerifier,
  });

  const tokenManagerVestingVault = await tokenManager.vestingVault();
  recorder.assert("TokenManager.vestingVault matches RewardVestingVault", sameAddress(tokenManagerVestingVault, contracts.RewardVestingVault), {
    actual: tokenManagerVestingVault,
    expected: contracts.RewardVestingVault,
  });

  const [
    deltaModelRegistry,
    deltaTokenManager,
    deltaContributionRegistry,
    submitterRole,
    defaultAdminRole,
    paused,
  ] = await Promise.all([
    deltaVerifier.modelRegistry(),
    deltaVerifier.tokenManager(),
    deltaVerifier.contributionRegistry(),
    deltaVerifier.SUBMITTER_ROLE(),
    deltaVerifier.DEFAULT_ADMIN_ROLE(),
    deltaVerifier.paused(),
  ]);

  recorder.assert("DeltaVerifier.modelRegistry matches ModelRegistry", sameAddress(deltaModelRegistry, contracts.ModelRegistry), {
    actual: deltaModelRegistry,
    expected: contracts.ModelRegistry,
  });
  recorder.assert("DeltaVerifier.tokenManager matches TokenManager", sameAddress(deltaTokenManager, contracts.TokenManager), {
    actual: deltaTokenManager,
    expected: contracts.TokenManager,
  });
  recorder.assert(
    "DeltaVerifier.contributionRegistry matches DataContributionRegistry",
    sameAddress(deltaContributionRegistry, contracts.DataContributionRegistry),
    { actual: deltaContributionRegistry, expected: contracts.DataContributionRegistry },
  );
  recorder.assert("DeltaVerifier is not paused", paused === false, { paused });

  // RECORDER_ROLE -> DeltaVerifier is functional wiring (mint/reward path), not
  // custody: it must hold on every network, pre- and post-handoff.
  const recorderRole = await contributionRegistry.RECORDER_ROLE();
  recorder.assert(
    "DataContributionRegistry grants RECORDER_ROLE to DeltaVerifier",
    await contributionRegistry.hasRole(recorderRole, contracts.DeltaVerifier),
    { deltaVerifier: contracts.DeltaVerifier },
  );

  const [
    factoryModelRegistry,
    factoryTokenManager,
    factoryReserveToken,
    factoryTreasury,
    poolCount,
    defaultCrr,
    defaultTradeFee,
    defaultIbrDuration,
    defaultFlatCurveThreshold,
    defaultFlatCurvePrice,
  ] = await Promise.all([
    ammFactory.modelRegistry(),
    ammFactory.tokenManager(),
    ammFactory.reserveToken(),
    ammFactory.treasury(),
    ammFactory.poolCount(),
    ammFactory.defaultCrr(),
    ammFactory.defaultTradeFee(),
    ammFactory.defaultIbrDuration(),
    ammFactory.defaultFlatCurveThreshold(),
    ammFactory.defaultFlatCurvePrice(),
  ]);

  recorder.assert("HokusaiAMMFactory.modelRegistry matches ModelRegistry", sameAddress(factoryModelRegistry, contracts.ModelRegistry), {
    actual: factoryModelRegistry,
    expected: contracts.ModelRegistry,
  });
  recorder.assert("HokusaiAMMFactory.tokenManager matches TokenManager", sameAddress(factoryTokenManager, contracts.TokenManager), {
    actual: factoryTokenManager,
    expected: contracts.TokenManager,
  });
  recorder.assert("HokusaiAMMFactory.reserveToken matches artifact reserve token", sameAddress(factoryReserveToken, reserveToken), {
    actual: factoryReserveToken,
    expected: reserveToken,
  });
  recorder.pass("HokusaiAMMFactory pool count", { poolCount });
  recorder.assert("HokusaiAMMFactory treasury is nonzero", !sameAddress(factoryTreasury, ZERO_ADDRESS), {
    treasury: factoryTreasury,
  });
  recorder.assert("HokusaiAMMFactory defaults match artifact config", (
    defaultCrr === BigInt(deployment.config.factoryDefaults.crr) &&
    defaultTradeFee === BigInt(deployment.config.factoryDefaults.tradeFee) &&
    defaultIbrDuration === BigInt(deployment.config.factoryDefaults.ibrDuration) &&
    defaultFlatCurveThreshold === BigInt(deployment.config.factoryDefaults.flatCurveThreshold) &&
    defaultFlatCurvePrice === BigInt(deployment.config.factoryDefaults.flatCurvePrice)
  ), {
    crr: defaultCrr,
    tradeFee: defaultTradeFee,
    ibrDuration: defaultIbrDuration,
    flatCurveThreshold: defaultFlatCurveThreshold,
    flatCurvePrice: defaultFlatCurvePrice,
  });

  // ---- Per-model registration + pool wiring ----
  for (const { symbol, modelId } of options.tokenModels) {
    const [
      numericRegistered,
      numericActive,
      numericToken,
      stringRegistered,
      stringActive,
      stringToken,
      hasToken,
      managerToken,
      poolAddress,
    ] = await Promise.all([
      modelRegistry.isRegistered(modelId),
      modelRegistry.isModelActive(modelId),
      modelRegistry.getTokenAddress(modelId).catch(() => ZERO_ADDRESS),
      modelRegistry.isStringRegistered(modelId),
      modelRegistry.isStringActive(modelId),
      modelRegistry.getStringToken(modelId).catch(() => ZERO_ADDRESS),
      tokenManager.hasToken(modelId),
      tokenManager.getTokenAddress(modelId).catch(() => ZERO_ADDRESS),
      ammFactory.getPool(modelId).catch(() => ZERO_ADDRESS),
    ]);

    const label = `${symbol} / ${modelId}`;
    recorder.assert(`${label} numeric registration exists`, numericRegistered === true, { modelId });
    recorder.assert(`${label} numeric registration is active`, numericActive === true, { modelId });
    recorder.assert(`${label} string registration exists`, stringRegistered === true, { modelId });
    recorder.assert(`${label} string registration is active`, stringActive === true, { modelId });
    recorder.assert(`${label} TokenManager mapping exists`, hasToken === true, { modelId });
    recorder.assert(`${label} registry token is nonzero`, !sameAddress(numericToken, ZERO_ADDRESS), { numericToken });
    recorder.assert(
      `${label} registry and TokenManager tokens match`,
      sameAddress(numericToken, stringToken) && sameAddress(stringToken, managerToken),
      { numericToken, stringToken, managerToken },
    );
    recorder.assert(`${label} AMM pool exists`, !sameAddress(poolAddress, ZERO_ADDRESS), { poolAddress });
    if (!sameAddress(poolAddress, ZERO_ADDRESS)) {
      const pool = new hre.ethers.Contract(poolAddress, ABIS.ammPool, provider);
      const poolWhitelist = await pool.purchaserWhitelist();
      recorder.assert(
        `${label} pool whitelist matches shared whitelist`,
        sameAddress(poolWhitelist, contracts.PurchaserWhitelist),
        { poolWhitelist, sharedWhitelist: contracts.PurchaserWhitelist },
      );
      if (options.requireWhitelist) {
        recorder.assert(
          `${label} pool whitelist is nonzero`,
          !sameAddress(poolWhitelist, ZERO_ADDRESS),
          { poolWhitelist },
        );
      }
    }
  }

  // ---- UsageFeeRouter wiring (hard) + FEE_DEPOSITOR custody (reported) ----
  const [
    routerFactory,
    routerReserveToken,
    routerInfraReserve,
    routerCostOracle,
    feeDepositorRole,
  ] = await Promise.all([
    usageFeeRouter.factory(),
    usageFeeRouter.reserveToken(),
    usageFeeRouter.infraReserve(),
    usageFeeRouter.costOracle(),
    usageFeeRouter.FEE_DEPOSITOR_ROLE(),
  ]);

  recorder.assert("UsageFeeRouter.factory matches HokusaiAMMFactory", sameAddress(routerFactory, contracts.HokusaiAMMFactory), {
    actual: routerFactory,
    expected: contracts.HokusaiAMMFactory,
  });
  recorder.assert("UsageFeeRouter.reserveToken matches artifact reserve token", sameAddress(routerReserveToken, reserveToken), {
    actual: routerReserveToken,
    expected: reserveToken,
  });
  recorder.assert("UsageFeeRouter.infraReserve matches InfrastructureReserve", sameAddress(routerInfraReserve, contracts.InfrastructureReserve), {
    actual: routerInfraReserve,
    expected: contracts.InfrastructureReserve,
  });
  recorder.assert("UsageFeeRouter.costOracle matches InfrastructureCostOracle", sameAddress(routerCostOracle, contracts.InfrastructureCostOracle), {
    actual: routerCostOracle,
    expected: contracts.InfrastructureCostOracle,
  });

  // DEPOSITOR_ROLE -> UsageFeeRouter is functional wiring (fee path), not custody.
  const [depositorRole, payerRole] = await Promise.all([
    infrastructureReserve.DEPOSITOR_ROLE(),
    infrastructureReserve.PAYER_ROLE(),
  ]);
  recorder.assert(
    "InfrastructureReserve grants DEPOSITOR_ROLE to UsageFeeRouter",
    await infrastructureReserve.hasRole(depositorRole, contracts.UsageFeeRouter),
    { usageFeeRouter: contracts.UsageFeeRouter },
  );

  // ---- Custody roles: reported, never fatal (audit via verify:governance) ----
  const principals = expectedAdminPrincipals(deployment);
  recorder.info("Custody audit context", {
    handedOff,
    expectedPrincipals: principals,
    note: "custody correctness is enforced by verify:governance / verify:launch-posture, not this smoke",
  });

  const govRole = await costOracle.GOV_ROLE();
  const whitelistAdminRole = await purchaserWhitelist.WHITELIST_ADMIN_ROLE();
  await reportCustodyRole(recorder, deltaVerifier, "DeltaVerifier DEFAULT_ADMIN_ROLE", defaultAdminRole, principals);
  await reportCustodyRole(recorder, deltaVerifier, "DeltaVerifier SUBMITTER_ROLE", submitterRole, principals);
  await reportCustodyRole(recorder, usageFeeRouter, "UsageFeeRouter FEE_DEPOSITOR_ROLE", feeDepositorRole, principals);
  await reportCustodyRole(recorder, costOracle, "InfrastructureCostOracle GOV_ROLE", govRole, principals);
  await reportCustodyRole(recorder, purchaserWhitelist, "PurchaserWhitelist WHITELIST_ADMIN_ROLE", whitelistAdminRole, principals);

  // PAYER_ROLE holders are recorded per-deployment in the artifact; assert those
  // recorded holders still hold it (functional invariant for infra payouts).
  const expectedPayers = deployment.roles?.InfrastructureReserve?.PAYER_ROLE || [];
  if (expectedPayers.length > 0) {
    const payerChecks = await Promise.all(
      expectedPayers.map(async (payer) => ({
        payer,
        hasRole: await infrastructureReserve.hasRole(payerRole, payer),
      })),
    );
    recorder.assert(
      "InfrastructureReserve PAYER_ROLE holders match artifact",
      payerChecks.every((check) => check.hasRole),
      { payerChecks },
    );
  } else {
    recorder.info("InfrastructureReserve PAYER_ROLE holders not recorded in artifact");
  }

  const failures = recorder.checks.filter((check) => check.status === "fail");
  const warnings = recorder.checks.filter((check) => check.status === "warn");
  const result = {
    ok: failures.length === 0,
    network: deployment.network || hre.network.name,
    chainId: artifactChainId,
    handedOff,
    deploymentFile: path.relative(process.cwd(), fullPath),
    reserveToken,
    healthBaseUrl: healthBaseUrl || null,
    checks: recorder.checks,
    summary: {
      passed: recorder.checks.filter((check) => check.status === "pass").length,
      info: recorder.checks.filter((check) => check.status === "info").length,
      warnings: warnings.length,
      failed: failures.length,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\nRead-only smoke check (${result.network}, chainId ${result.chainId}${result.handedOff ? ", governance handed off" : ""})`);
    console.log(`Deployment: ${result.deploymentFile}`);
    console.log(`Reserve token: ${result.reserveToken}`);
    console.log(`Health URL: ${result.healthBaseUrl || "(skipped)"}`);
    console.log("");
    for (const check of recorder.checks) {
      const marker = {
        pass: "PASS",
        warn: "WARN",
        fail: "FAIL",
        info: "INFO",
      }[check.status];
      console.log(`${marker} ${check.name}`);
      if (check.details !== undefined && check.status !== "pass") {
        console.log(`     ${JSON.stringify(check.details)}`);
      }
    }
    console.log("");
    console.log(`Summary: ${result.summary.passed} passed, ${result.summary.info} info, ${result.summary.warnings} warnings, ${result.summary.failed} failed`);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
