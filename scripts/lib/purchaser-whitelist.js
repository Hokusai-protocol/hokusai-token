const fs = require("fs");
const path = require("path");

const DEFAULT_BATCH_SIZE = 200;

function getDefaultDeploymentPath(networkName) {
  return path.resolve(__dirname, "..", "..", "deployments", `${networkName}-latest.json`);
}

function parseArgs(argv) {
  const options = {
    address: null,
    batchFile: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--batch") {
      options.batchFile = argv[++i];
    } else if (!options.address) {
      options.address = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return options;
}

function ensureExpectedNetwork(runtime, deployment) {
  const runtimeName = runtime.network.name;
  if (deployment.network && deployment.network !== runtimeName) {
    throw new Error(
      `Deployment artifact network mismatch: expected ${runtimeName}, found ${deployment.network}`
    );
  }

  const runtimeChainId = String(runtime.network.config.chainId ?? "");
  if (deployment.chainId && runtimeChainId && String(deployment.chainId) !== runtimeChainId) {
    throw new Error(
      `Deployment artifact chainId mismatch: expected ${runtimeChainId}, found ${deployment.chainId}`
    );
  }
}

function loadDeployment(runtime, overridePath) {
  const deploymentPath = path.resolve(
    overridePath || getDefaultDeploymentPath(runtime.network.name)
  );
  if (!fs.existsSync(deploymentPath)) {
    throw new Error(`Deployment artifact not found: ${deploymentPath}`);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
  ensureExpectedNetwork(runtime, deployment);
  return { deploymentPath, deployment };
}

function resolveWhitelistAddress(runtime, deployment) {
  const overrideAddress = process.env.WHITELIST_ADDRESS;
  if (overrideAddress) {
    const address = runtime.ethers.getAddress(overrideAddress);
    if (address === runtime.ethers.ZeroAddress) {
      throw new Error("WHITELIST_ADDRESS cannot be zero address");
    }
    return { address, source: "WHITELIST_ADDRESS" };
  }

  const artifactAddress = deployment.contracts?.PurchaserWhitelist;
  if (!artifactAddress) {
    throw new Error("Deployment artifact is missing contracts.PurchaserWhitelist");
  }

  const address = runtime.ethers.getAddress(artifactAddress);
  if (address === runtime.ethers.ZeroAddress) {
    throw new Error("Deployment artifact purchaser whitelist cannot be zero address");
  }

  return { address, source: "deployment artifact" };
}

function normalizeAddress(runtime, address) {
  const normalized = runtime.ethers.getAddress(address);
  if (normalized === runtime.ethers.ZeroAddress) {
    throw new Error("Address cannot be zero address");
  }
  return normalized;
}

function loadBatchAddresses(runtime, batchFile) {
  const resolvedPath = path.resolve(batchFile);
  const parsed = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  if (!parsed || !Array.isArray(parsed.addresses)) {
    throw new Error("Batch file must be JSON with an addresses array");
  }

  return parsed.addresses.map((address) => normalizeAddress(runtime, address));
}

function chunkAddresses(addresses, batchSize = DEFAULT_BATCH_SIZE) {
  const chunks = [];
  for (let i = 0; i < addresses.length; i += batchSize) {
    chunks.push(addresses.slice(i, i + batchSize));
  }
  return chunks;
}

async function getWhitelistContract(runtime, options = {}) {
  const { deploymentPath, deployment } = loadDeployment(runtime, options.deploymentPath);
  const { address, source } = resolveWhitelistAddress(runtime, deployment);
  const signer = options.signer || (await runtime.ethers.getSigners())[0];
  const whitelist = await runtime.ethers.getContractAt("PurchaserWhitelist", address, signer);
  return { whitelist, signer, address, source, deployment, deploymentPath };
}

async function add(runtime, address, options = {}) {
  const { whitelist } = await getWhitelistContract(runtime, options);
  const normalized = normalizeAddress(runtime, address);
  const tx = await whitelist.addToWhitelist(normalized);
  const receipt = await tx.wait();
  return { address: normalized, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function remove(runtime, address, options = {}) {
  const { whitelist } = await getWhitelistContract(runtime, options);
  const normalized = normalizeAddress(runtime, address);
  const tx = await whitelist.removeFromWhitelist(normalized);
  const receipt = await tx.wait();
  return { address: normalized, txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
}

async function check(runtime, address, options = {}) {
  const { whitelist } = await getWhitelistContract(runtime, options);
  const normalized = normalizeAddress(runtime, address);
  const isWhitelisted = await whitelist.isWhitelisted(normalized);
  return { address: normalized, isWhitelisted };
}

async function runBatch(runtime, method, addresses, options = {}) {
  const { whitelist } = await getWhitelistContract(runtime, options);
  const normalized = addresses.map((address) => normalizeAddress(runtime, address));
  const chunks = chunkAddresses(normalized);
  let gasUsedTotal = 0n;
  const receipts = [];

  for (const batch of chunks) {
    const tx = await whitelist[method](batch);
    const receipt = await tx.wait();
    gasUsedTotal += receipt.gasUsed;
    receipts.push({
      size: batch.length,
      txHash: receipt.hash,
      gasUsed: receipt.gasUsed.toString(),
    });
  }

  return {
    count: normalized.length,
    chunks: receipts.length,
    gasUsedTotal: gasUsedTotal.toString(),
    receipts,
  };
}

async function addBatch(runtime, addresses, options = {}) {
  return runBatch(runtime, "addBatch", addresses, options);
}

async function removeBatch(runtime, addresses, options = {}) {
  return runBatch(runtime, "removeBatch", addresses, options);
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  add,
  addBatch,
  check,
  chunkAddresses,
  getDefaultDeploymentPath,
  getWhitelistContract,
  loadBatchAddresses,
  loadDeployment,
  normalizeAddress,
  parseArgs,
  remove,
  removeBatch,
  resolveWhitelistAddress,
};
