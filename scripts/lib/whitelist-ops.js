const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const { ethers } = hre;

const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_DEPLOYMENTS_DIR = path.join(__dirname, "..", "..", "deployments");

function getDeploymentsDir(overrides = {}) {
  return overrides.deploymentsDir
    || process.env.WHITELIST_DEPLOYMENTS_DIR
    || DEFAULT_DEPLOYMENTS_DIR;
}

function resolveDeploymentArtifactPath(network, overrides = {}) {
  return path.join(getDeploymentsDir(overrides), `${network}-latest.json`);
}

function loadWhitelistAddress({ network = hre.network.name, override, deploymentsDir } = {}) {
  const explicitOverride = override || process.env.WHITELIST_ADDRESS_OVERRIDE;
  if (explicitOverride) {
    return ethers.getAddress(explicitOverride);
  }

  const artifactPath = resolveDeploymentArtifactPath(network, { deploymentsDir });
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Whitelist deployment artifact not found: ${artifactPath}`);
  }

  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const address = artifact.contracts?.PurchaserWhitelist || artifact.config?.purchaserWhitelist;
  if (!address) {
    throw new Error(`PurchaserWhitelist missing from deployment artifact: ${artifactPath}`);
  }

  return ethers.getAddress(address);
}

async function loadWhitelistContract(address, signer) {
  return hre.ethers.getContractAt("PurchaserWhitelist", ethers.getAddress(address), signer);
}

function chunkAddresses(addresses, chunkSize = DEFAULT_BATCH_SIZE) {
  const chunks = [];
  for (let index = 0; index < addresses.length; index += chunkSize) {
    chunks.push(addresses.slice(index, index + chunkSize));
  }
  return chunks;
}

function parseAddressesFromFile(filepath) {
  return fs.readFileSync(filepath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseAddressesFromArgv(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("Provide at least one address or --file <path>");
  }

  let rawAddresses = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      const filepath = argv[index + 1];
      if (!filepath) {
        throw new Error("Missing value for --file");
      }
      rawAddresses = rawAddresses.concat(parseAddressesFromFile(filepath));
      index += 1;
      continue;
    }

    rawAddresses.push(arg);
  }

  if (rawAddresses.length === 0) {
    throw new Error("Provide at least one address or --file <path>");
  }

  return rawAddresses.map((address) => {
    try {
      return ethers.getAddress(address);
    } catch (error) {
      throw new Error(`Invalid address: ${address}`);
    }
  });
}

async function getWhitelistState(contract, addresses) {
  const results = [];
  for (const address of addresses) {
    results.push({
      address,
      whitelisted: await contract.isWhitelisted(address),
    });
  }
  return results;
}

async function runAdd({ whitelist, addresses, batchSize = DEFAULT_BATCH_SIZE, logger = console }) {
  const before = await getWhitelistState(whitelist, addresses);
  const toAdd = before.filter((entry) => !entry.whitelisted).map((entry) => entry.address);
  const skipped = before.filter((entry) => entry.whitelisted).map((entry) => entry.address);
  const txHashes = [];

  for (const batch of chunkAddresses(toAdd, batchSize)) {
    if (batch.length === 0) {
      continue;
    }

    const tx = batch.length === 1
      ? await whitelist.addToWhitelist(batch[0])
      : await whitelist.addBatch(batch);
    txHashes.push(tx.hash);
    await tx.wait();
    logger.log(`Added ${batch.length} wallet(s) in tx ${tx.hash}`);
  }

  return {
    address: await whitelist.getAddress(),
    added: toAdd,
    skipped,
    txHashes,
    results: await getWhitelistState(whitelist, addresses),
  };
}

async function runRemove({ whitelist, addresses, batchSize = DEFAULT_BATCH_SIZE, logger = console }) {
  const before = await getWhitelistState(whitelist, addresses);
  const toRemove = before.filter((entry) => entry.whitelisted).map((entry) => entry.address);
  const skipped = before.filter((entry) => !entry.whitelisted).map((entry) => entry.address);
  const txHashes = [];

  for (const batch of chunkAddresses(toRemove, batchSize)) {
    if (batch.length === 0) {
      continue;
    }

    const tx = batch.length === 1
      ? await whitelist.removeFromWhitelist(batch[0])
      : await whitelist.removeBatch(batch);
    txHashes.push(tx.hash);
    await tx.wait();
    logger.log(`Removed ${batch.length} wallet(s) in tx ${tx.hash}`);
  }

  return {
    address: await whitelist.getAddress(),
    removed: toRemove,
    skipped,
    txHashes,
    results: await getWhitelistState(whitelist, addresses),
  };
}

async function runCheck({ whitelist, addresses }) {
  return {
    address: await whitelist.getAddress(),
    results: await getWhitelistState(whitelist, addresses),
  };
}

module.exports = {
  DEFAULT_BATCH_SIZE,
  chunkAddresses,
  loadWhitelistAddress,
  loadWhitelistContract,
  parseAddressesFromArgv,
  resolveDeploymentArtifactPath,
  runAdd,
  runCheck,
  runRemove,
};
