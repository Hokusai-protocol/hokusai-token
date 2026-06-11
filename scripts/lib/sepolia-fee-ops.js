const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXPECTED_ADDRESSES = Object.freeze({
  UsageFeeRouter: "0xCDa3604f9D7F89e47eE1ebc1d27A13fa7551C04d",
  MockUSDC: "0xc3Da8fb0Fb0014137FcBcbe80B093c51243c51Ad",
  InfrastructureReserve: "0x1Bcc924867E8CFfB29eECd27CffcF0D3F23F53F6",
  InfrastructureCostOracle: "0x715d2881FB8dbfC0b5d92A1e931dA3766544CC7c",
  Model30Pool: "0xdC4132c09DA135A9aaC28B6Da7c879D117C9dEFF",
});

function parseArgs(argv) {
  const args = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg.startsWith("--")) {
      continue;
    }

    const key = arg.slice(2);
    const next = argv[i + 1];

    if (!next || next.startsWith("--")) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    i += 1;
  }

  return args;
}

function requireSepolia(network = hre.network) {
  if (network.name !== "sepolia") {
    throw new Error(`This script only supports sepolia. Received network "${network.name}".`);
  }
}

function loadDeployment(file = DEFAULT_DEPLOYMENT_FILE) {
  const fullPath = path.resolve(process.cwd(), file);
  const deployment = JSON.parse(fs.readFileSync(fullPath, "utf8"));
  return { fullPath, deployment };
}

function toChecksumAddress(value) {
  return hre.ethers.getAddress(value);
}

function sameAddress(left, right) {
  return toChecksumAddress(left) === toChecksumAddress(right);
}

function requireChecksummedAddress(value, label) {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} is required.`);
  }

  if (!hre.ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid Ethereum address.`);
  }

  if (sameAddress(value, ZERO_ADDRESS)) {
    throw new Error(`${label} must not be the zero address.`);
  }

  const checksummed = toChecksumAddress(value);
  if (checksummed !== value) {
    throw new Error(`${label} must use checksum casing: ${checksummed}`);
  }

  return checksummed;
}

function requireDeploymentAddress(deployment, key) {
  const value = deployment?.contracts?.[key];
  if (!value) {
    throw new Error(`Deployment artifact is missing contracts.${key}.`);
  }
  return toChecksumAddress(value);
}

function assertExpectedAddress(actual, expected, label) {
  const normalizedActual = toChecksumAddress(actual);
  const normalizedExpected = toChecksumAddress(expected);

  if (normalizedActual !== normalizedExpected) {
    throw new Error(`${label} mismatch. Expected ${normalizedExpected}, got ${normalizedActual}.`);
  }

  return normalizedActual;
}

function getTokenConfigByModelId(deployment, modelId) {
  const token = deployment.tokens.find((entry) => entry.modelId === modelId);
  if (!token) {
    throw new Error(`No deployment token config found for modelId "${modelId}".`);
  }
  return token;
}

function getPoolConfigByModelId(deployment, modelId) {
  const pool = deployment.pools.find((entry) => entry.modelId === modelId);
  if (!pool) {
    throw new Error(`No deployment pool config found for modelId "${modelId}".`);
  }
  return pool;
}

function parseDecimalToUnits(value, decimals, label) {
  try {
    return hre.ethers.parseUnits(value, decimals);
  } catch (error) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function parseInteger(value, label) {
  if (!/^\d+$/.test(String(value))) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return BigInt(value);
}

function parseConfirmations(value) {
  if (value === undefined) {
    return 1;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`confirmations must be an integer >= 1. Received: ${value}`);
  }

  return parsed;
}

function parseEventLogs(receipt, contractInterface, eventName) {
  const parsed = [];

  for (const log of receipt.logs) {
    try {
      const entry = contractInterface.parseLog(log);
      if (entry && entry.name === eventName) {
        parsed.push(entry);
      }
    } catch (_error) {
      continue;
    }
  }

  return parsed;
}

function formatPrintable(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => formatPrintable(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, formatPrintable(entry)]),
    );
  }

  return value;
}

function printJson(value) {
  console.log(JSON.stringify(formatPrintable(value), null, 2));
}

function formatError(error) {
  if (!error) {
    return "Unknown error";
  }

  if (error.shortMessage) {
    return error.shortMessage;
  }

  if (error.info?.error?.message) {
    return error.info.error.message;
  }

  if (error.reason) {
    return error.reason;
  }

  if (error.message) {
    return error.message;
  }

  return String(error);
}

function buildUpdatedDeploymentArtifact(deployment, settlementWallet, grantTxHash) {
  const checksummedWallet = requireChecksummedAddress(
    settlementWallet,
    "SETTLEMENT_WALLET_ADDRESS",
  );
  const next = JSON.parse(JSON.stringify(deployment));
  const existingRoleHolders = Array.isArray(next.roles?.UsageFeeRouter?.FEE_DEPOSITOR_ROLE)
    ? next.roles.UsageFeeRouter.FEE_DEPOSITOR_ROLE
    : [];

  next.backendService = checksummedWallet;
  next.roles = next.roles || {};
  next.roles.UsageFeeRouter = next.roles.UsageFeeRouter || {};
  next.roles.UsageFeeRouter.FEE_DEPOSITOR_ROLE = dedupeAddresses([
    ...existingRoleHolders,
    checksummedWallet,
  ]);

  if (grantTxHash) {
    next.roles.UsageFeeRouter.feeDepositorGrantTx = {
      ...(next.roles.UsageFeeRouter.feeDepositorGrantTx || {}),
      [checksummedWallet]: grantTxHash,
    };
  }

  return next;
}

function dedupeAddresses(addresses) {
  const entries = new Map();

  for (const address of addresses) {
    if (!address) {
      continue;
    }

    const normalized = toChecksumAddress(address);
    entries.set(normalized.toLowerCase(), normalized);
  }

  return Array.from(entries.values());
}

module.exports = {
  DEFAULT_DEPLOYMENT_FILE,
  EXPECTED_ADDRESSES,
  assertExpectedAddress,
  buildUpdatedDeploymentArtifact,
  formatError,
  getPoolConfigByModelId,
  getTokenConfigByModelId,
  loadDeployment,
  parseArgs,
  parseConfirmations,
  parseDecimalToUnits,
  parseEventLogs,
  parseInteger,
  printJson,
  requireChecksummedAddress,
  requireDeploymentAddress,
  requireSepolia,
  sameAddress,
  toChecksumAddress,
};
