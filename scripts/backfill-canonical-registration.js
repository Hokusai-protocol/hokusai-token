const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const DEFAULT_MODELS = "27,28,30";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const ABIS = {
  modelRegistry: [
    "function owner() view returns (address)",
    "function registerModel(uint256 modelId,address token,string performanceMetric)",
    "function isRegistered(uint256 modelId) view returns (bool)",
    "function getTokenAddress(uint256 modelId) view returns (address)",
    "function getMetric(uint256 modelId) view returns (string)",
    "function modelsByString(string modelId) view returns (address tokenAddress,string performanceMetric,bool active)",
    "function isStringRegistered(string modelId) view returns (bool)",
  ],
  tokenManager: [
    "function hasToken(string modelId) view returns (bool)",
    "function getTokenAddress(string modelId) view returns (address)",
  ],
};

function parseArgs(argv) {
  const options = {
    deploymentFile: process.env.CANONICAL_BACKFILL_DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE,
    modelIds: parseModelIds(process.env.CANONICAL_BACKFILL_MODELS || DEFAULT_MODELS),
    dryRun: process.env.CANONICAL_BACKFILL_DRY_RUN === "1",
    json: process.env.CANONICAL_BACKFILL_JSON === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment-file") {
      options.deploymentFile = argv[++i];
    } else if (arg === "--models") {
      options.modelIds = parseModelIds(argv[++i]);
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Canonical ModelRegistry backfill

Dry run:
  node scripts/backfill-canonical-registration.js --dry-run

Execute writes:
  node scripts/backfill-canonical-registration.js

Options:
  --deployment-file <path>
  --models <csv>          Defaults to 27,28,30.
  --dry-run
  --json
`);
}

function parseModelIds(value) {
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    if (!/^\d+$/.test(entry)) {
      throw new Error(`Invalid model id "${entry}". Expected decimal string.`);
    }
    return entry;
  });
}

function loadDeployment(file) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

function requireAddress(label, value) {
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`Missing valid ${label} address`);
  }
  return hre.ethers.getAddress(value);
}

function normalizeAddress(value) {
  if (!value || value === ZERO_ADDRESS) {
    return ZERO_ADDRESS;
  }
  return hre.ethers.getAddress(value);
}

async function runBackfill({ modelIds, dryRun, modelRegistry, tokenManager, signer }) {
  if (!dryRun) {
    const owner = await modelRegistry.owner();
    if (normalizeAddress(owner) !== normalizeAddress(signer.address)) {
      throw new Error(`Signer ${signer.address} is not ModelRegistry owner ${owner}`);
    }
  }

  const results = [];
  for (const modelIdString of modelIds) {
    const modelId = BigInt(modelIdString);
    const [
      numericRegistered,
      numericToken,
      tokenManagerHasToken,
      tokenManagerToken,
      stringRegistered,
      stringModel,
    ] = await Promise.all([
      modelRegistry.isRegistered(modelId),
      modelRegistry.getTokenAddress(modelId).catch(() => ZERO_ADDRESS),
      tokenManager.hasToken(modelIdString),
      tokenManager.getTokenAddress(modelIdString).catch(() => ZERO_ADDRESS),
      modelRegistry.isStringRegistered(modelIdString),
      modelRegistry.modelsByString(modelIdString),
    ]);

    const stringToken = normalizeAddress(stringModel.tokenAddress || stringModel[0]);
    const metric = stringModel.performanceMetric || stringModel[1];
    const active = Boolean(stringModel.active ?? stringModel[2]);
    const managerToken = normalizeAddress(tokenManagerToken);
    const canonicalToken = normalizeAddress(numericToken);

    if (!tokenManagerHasToken || managerToken === ZERO_ADDRESS) {
      throw new Error(`TokenManager has no token mapping for model ${modelIdString}`);
    }
    if (!stringRegistered || stringToken === ZERO_ADDRESS || !active) {
      throw new Error(`String registry is missing or inactive for model ${modelIdString}`);
    }
    if (managerToken !== stringToken) {
      throw new Error(
        `Token mismatch for model ${modelIdString}: TokenManager=${managerToken}, stringRegistry=${stringToken}`,
      );
    }

    if (numericRegistered) {
      if (canonicalToken !== managerToken) {
        throw new Error(
          `RegistrationConflict: numeric registry drift for model ${modelIdString}: numeric=${canonicalToken}, expected=${managerToken}`,
        );
      }

      results.push({
        modelId: modelIdString,
        action: "skip",
        reason: "already_registered",
        token: managerToken,
        metric,
      });
      continue;
    }

    if (dryRun) {
      results.push({
        modelId: modelIdString,
        action: "would_register",
        token: managerToken,
        metric,
      });
      continue;
    }

    const tx = await modelRegistry.registerModel(modelId, managerToken, metric);
    const receipt = await tx.wait();
    results.push({
      modelId: modelIdString,
      action: "registered",
      token: managerToken,
      metric,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    });
  }

  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deployment = loadDeployment(options.deploymentFile);
  const contracts = deployment.contracts || {};
  const [signer] = await hre.ethers.getSigners();

  const modelRegistry = new hre.ethers.Contract(
    requireAddress("ModelRegistry", contracts.ModelRegistry),
    ABIS.modelRegistry,
    signer,
  );
  const tokenManager = new hre.ethers.Contract(
    requireAddress("TokenManager", contracts.TokenManager),
    ABIS.tokenManager,
    signer,
  );

  const results = await runBackfill({
    modelIds: options.modelIds,
    dryRun: options.dryRun,
    modelRegistry,
    tokenManager,
    signer,
  });

  if (options.json) {
    console.log(JSON.stringify({
      network: hre.network.name,
      deploymentFile: options.deploymentFile,
      dryRun: options.dryRun,
      results,
    }, null, 2));
    return;
  }

  console.log(`Network: ${hre.network.name}`);
  console.log(`Deployment file: ${options.deploymentFile}`);
  console.log(`Mode: ${options.dryRun ? "dry-run" : "execute"}`);
  for (const result of results) {
    const summary = `${result.modelId} ${result.action} ${result.token} ${result.metric}`;
    if (result.txHash) {
      console.log(`${summary} tx=${result.txHash}`);
    } else {
      console.log(summary);
    }
  }
}

module.exports = {
  parseArgs,
  parseModelIds,
  loadDeployment,
  runBackfill,
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
