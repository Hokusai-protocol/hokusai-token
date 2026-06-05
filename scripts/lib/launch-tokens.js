const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const TOKEN_DECIMALS = 18;
const USDC_DECIMALS = 6;
const MIN_TOKENS_PER_DELTA_ONE = ethers.parseUnits("100", TOKEN_DECIMALS);
const MAX_TOKENS_PER_DELTA_ONE = ethers.parseUnits("10000000", TOKEN_DECIMALS);
const MIN_INFRASTRUCTURE_ACCRUAL_BPS = 1000;
const MAX_INFRASTRUCTURE_ACCRUAL_BPS = 10000;
const MIN_CRR = 50000;
const MAX_CRR = 1000000;
const MAX_TRADE_FEE = 1000;
const MIN_IBR_DURATION = 24 * 60 * 60;
const MAX_IBR_DURATION = 30 * 24 * 60 * 60;
const DISTRIBUTION_TIMINGS = new Set(["pre-launch", "post-verification"]);
const DECIMAL_STRING_RE = /^(0|[1-9]\d*)(\.\d+)?$/;
const PLACEHOLDER_ADDRESS_RE = /^0xPLACEHOLDER/i;
const MODEL_ID_DECIMAL_RE = /^\d+$/;

class LaunchConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "LaunchConfigError";
  }
}

function assertChecksumAddress(address, label) {
  if (typeof address !== "string" || PLACEHOLDER_ADDRESS_RE.test(address)) {
    throw new LaunchConfigError(`${label} must be non-zero checksum address`);
  }

  let checksummed;
  try {
    checksummed = ethers.getAddress(address);
  } catch (error) {
    throw new LaunchConfigError(`${label} must be non-zero checksum address`);
  }

  if (checksummed === ethers.ZeroAddress) {
    throw new LaunchConfigError(`${label} must be non-zero checksum address`);
  }

  return checksummed;
}

function assertDecimalString(value, label) {
  if (typeof value !== "string" || !DECIMAL_STRING_RE.test(value)) {
    throw new LaunchConfigError(`${label} must be decimal string`);
  }
  return value;
}

function assertIntegerInBounds(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LaunchConfigError(`${label} out of bounds`);
  }
}

function validateNumericModelId(value, label = "modelId") {
  if (typeof value !== "string" || !MODEL_ID_DECIMAL_RE.test(value)) {
    throw new LaunchConfigError(`${label} must be decimal uint256 string`);
  }

  try {
    return BigInt(value);
  } catch (error) {
    throw new LaunchConfigError(`${label} must be decimal uint256 string`);
  }
}

function validateVestingConfig(vestingConfig) {
  if (!vestingConfig || typeof vestingConfig !== "object") {
    throw new LaunchConfigError("vestingConfig is required");
  }

  const {
    enabled,
    immediateUnlockBps,
    vestingDurationSeconds,
    cliffSeconds,
  } = vestingConfig;

  if (typeof enabled !== "boolean") {
    throw new LaunchConfigError("vestingConfig.enabled must be boolean");
  }

  assertIntegerInBounds(immediateUnlockBps, 0, 10000, "vestingConfig.immediateUnlockBps");

  if (!Number.isInteger(vestingDurationSeconds) || vestingDurationSeconds < 0) {
    throw new LaunchConfigError("vestingConfig.vestingDurationSeconds must be non-negative integer");
  }

  if (!Number.isInteger(cliffSeconds) || cliffSeconds < 0) {
    throw new LaunchConfigError("vestingConfig.cliffSeconds must be non-negative integer");
  }

  if (enabled) {
    if (vestingDurationSeconds === 0) {
      throw new LaunchConfigError("vestingConfig.vestingDurationSeconds must be > 0 when vesting is enabled");
    }
    if (cliffSeconds > vestingDurationSeconds) {
      throw new LaunchConfigError("vestingConfig.cliffSeconds cannot exceed vestingDurationSeconds");
    }
  } else {
    if (vestingDurationSeconds !== 0) {
      throw new LaunchConfigError("vestingConfig.vestingDurationSeconds must be 0 when vesting is disabled");
    }
    if (cliffSeconds !== 0) {
      throw new LaunchConfigError("vestingConfig.cliffSeconds must be 0 when vesting is disabled");
    }
  }
}

function validatePoolConfig(pool) {
  if (!pool || typeof pool !== "object") {
    throw new LaunchConfigError("pool config is required");
  }

  assertDecimalString(pool.initialReserveUsdc, "pool.initialReserveUsdc");
  assertDecimalString(pool.flatCurveThresholdUsdc, "pool.flatCurveThresholdUsdc");
  assertDecimalString(pool.flatCurvePriceUsdc, "pool.flatCurvePriceUsdc");
  assertIntegerInBounds(pool.crr, MIN_CRR, MAX_CRR, "pool.crr");
  assertIntegerInBounds(pool.tradeFee, 0, MAX_TRADE_FEE, "pool.tradeFee");
  assertIntegerInBounds(pool.ibrSeconds, MIN_IBR_DURATION, MAX_IBR_DURATION, "pool.ibrSeconds");

  if (typeof pool.name !== "string" || pool.name.length === 0) {
    throw new LaunchConfigError("pool.name is required");
  }

  if (typeof pool.performanceMetric !== "string" || pool.performanceMetric.length === 0) {
    throw new LaunchConfigError("pool.performanceMetric is required");
  }

  if (pool.public !== undefined && typeof pool.public !== "boolean") {
    throw new LaunchConfigError("pool.public must be boolean");
  }
}

function validateTokenEntry(entry) {
  if (!entry || typeof entry !== "object") {
    throw new LaunchConfigError("token entry must be object");
  }

  if (typeof entry.configKey !== "string" || entry.configKey.length === 0) {
    throw new LaunchConfigError("configKey is required");
  }
  if (typeof entry.modelId !== "string" || entry.modelId.length === 0) {
    throw new LaunchConfigError("modelId is required");
  }
  validateNumericModelId(entry.modelId, "modelId");
  if (typeof entry.name !== "string" || entry.name.length === 0) {
    throw new LaunchConfigError("name is required");
  }
  if (typeof entry.symbol !== "string" || entry.symbol.length === 0) {
    throw new LaunchConfigError("symbol is required");
  }

  entry.supplierRecipient = assertChecksumAddress(entry.supplierRecipient, "supplierRecipient");
  entry.governor = assertChecksumAddress(entry.governor, "governor");

  assertDecimalString(entry.supplierAllocation, "supplierAllocation");
  assertDecimalString(entry.investorAllocation, "investorAllocation");
  assertDecimalString(entry.tokensPerDeltaOne, "tokensPerDeltaOne");
  assertDecimalString(entry.initialOraclePricePerThousandUsd, "initialOraclePricePerThousandUsd");

  const tokensPerDeltaOneWei = ethers.parseUnits(entry.tokensPerDeltaOne, TOKEN_DECIMALS);
  if (tokensPerDeltaOneWei < MIN_TOKENS_PER_DELTA_ONE || tokensPerDeltaOneWei > MAX_TOKENS_PER_DELTA_ONE) {
    throw new LaunchConfigError("tokensPerDeltaOne out of bounds");
  }

  assertIntegerInBounds(
    entry.infrastructureAccrualBps,
    MIN_INFRASTRUCTURE_ACCRUAL_BPS,
    MAX_INFRASTRUCTURE_ACCRUAL_BPS,
    "infrastructureAccrualBps"
  );

  if (typeof entry.licenseHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(entry.licenseHash)) {
    throw new LaunchConfigError("licenseHash must be 32-byte hex string");
  }
  if (typeof entry.licenseURI !== "string" || entry.licenseURI.length === 0) {
    throw new LaunchConfigError("licenseURI is required");
  }

  if (!DISTRIBUTION_TIMINGS.has(entry.distributionTiming)) {
    throw new LaunchConfigError("distributionTiming must be one of pre-launch, post-verification");
  }

  validateVestingConfig(entry.vestingConfig);
  validatePoolConfig(entry.pool);
}

function loadLaunchTokensConfig(configPath) {
  const resolvedPath = path.resolve(configPath);
  const config = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));

  if (!config || typeof config !== "object") {
    throw new LaunchConfigError("Launch config must be an object");
  }

  if (!Array.isArray(config.tokens) || config.tokens.length !== 3) {
    throw new LaunchConfigError("Launch config must define exactly 3 tokens");
  }

  const modelIds = new Set();
  const configKeys = new Set();

  for (const entry of config.tokens) {
    validateTokenEntry(entry);

    if (modelIds.has(entry.modelId)) {
      throw new LaunchConfigError("Duplicate modelId in launch config");
    }
    if (configKeys.has(entry.configKey)) {
      throw new LaunchConfigError("Duplicate configKey in launch config");
    }

    modelIds.add(entry.modelId);
    configKeys.add(entry.configKey);
  }

  return config;
}

function scaleTokenEntry(entry) {
  const supplierWei = ethers.parseUnits(entry.supplierAllocation, TOKEN_DECIMALS);
  const investorWei = ethers.parseUnits(entry.investorAllocation, TOKEN_DECIMALS);
  const tokensPerDeltaOneWei = ethers.parseUnits(entry.tokensPerDeltaOne, TOKEN_DECIMALS);
  const oraclePriceValue = ethers.parseUnits(entry.initialOraclePricePerThousandUsd, USDC_DECIMALS);
  const initialReserveUsdc = ethers.parseUnits(entry.pool.initialReserveUsdc, USDC_DECIMALS);
  const flatCurveThresholdUsdc = ethers.parseUnits(entry.pool.flatCurveThresholdUsdc, USDC_DECIMALS);
  const flatCurvePriceUsdc = ethers.parseUnits(entry.pool.flatCurvePriceUsdc, USDC_DECIMALS);

  return {
    ...entry,
    supplierWei,
    investorWei,
    tokensPerDeltaOneWei,
    oraclePriceValue,
    initialReserveUsdc,
    flatCurveThresholdUsdc,
    flatCurvePriceUsdc,
    maxSupplyWei: supplierWei + investorWei,
  };
}

module.exports = {
  DISTRIBUTION_TIMINGS,
  LaunchConfigError,
  assertChecksumAddress,
  loadLaunchTokensConfig,
  scaleTokenEntry,
  validateNumericModelId,
};
