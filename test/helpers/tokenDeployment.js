const { parseEther, keccak256, toUtf8Bytes } = require("ethers");

function wholeTokens(value) {
  return parseEther(value.toString());
}

function buildVestingConfig(overrides = {}) {
  return {
    enabled: true,
    immediateUnlockBps: 1000,
    vestingDurationSeconds: 365 * 24 * 60 * 60,
    cliffSeconds: 0,
    ...overrides,
  };
}

function buildDisabledVestingConfig(overrides = {}) {
  return {
    enabled: false,
    immediateUnlockBps: 10000,
    vestingDurationSeconds: 0,
    cliffSeconds: 0,
    ...overrides,
  };
}

function buildInitialParams(governor, overrides = {}) {
  return {
    tokensPerDeltaOne: wholeTokens(500000),
    infrastructureAccrualBps: 8000,
    initialOraclePricePerThousandUsd: 0,
    licenseHash: keccak256(toUtf8Bytes("default-license")),
    licenseURI: "https://hokusai.ai/licenses/default",
    governor,
    vestingConfig: buildDisabledVestingConfig(),
    ...overrides,
  };
}

/**
 * Test helper that replicates the old 4-arg deployToken signature.
 * Uses deployTokenWithParams (legacy unlimited-supply mode) so tests can mint
 * freely without hitting a maxSupply cap.
 */
async function deployTestToken(tokenManager, modelId, name, symbol, totalSupply, ownerAddress) {
  const params = buildInitialParams(ownerAddress);
  return tokenManager.deployTokenWithParams(modelId, name, symbol, totalSupply, params);
}

/**
 * Static-call version — returns the token address without executing.
 */
async function deployTestTokenAddress(tokenManager, modelId, name, symbol, totalSupply, ownerAddress) {
  const params = buildInitialParams(ownerAddress);
  return tokenManager.deployTokenWithParams.staticCall(modelId, name, symbol, totalSupply, params);
}

module.exports = {
  buildInitialParams,
  buildDisabledVestingConfig,
  buildVestingConfig,
  wholeTokens,
  deployTestToken,
  deployTestTokenAddress,
};
