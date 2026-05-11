const { parseEther, keccak256, toUtf8Bytes } = require("ethers");

function wholeTokens(value) {
  return parseEther(value.toString());
}

function defaultVestingConfig() {
  return {
    enabled: true,
    immediateUnlockBps: 1000, // 10%
    vestingDurationSeconds: 365 * 24 * 60 * 60, // 365 days
    cliffSeconds: 0
  };
}

function buildInitialParams(governor, overrides = {}) {
  return {
    tokensPerDeltaOne: wholeTokens(500000),
    infrastructureAccrualBps: 8000,
    initialOraclePricePerThousandUsd: 0,
    licenseHash: keccak256(toUtf8Bytes("default-license")),
    licenseURI: "https://hokusai.ai/licenses/default",
    vestingConfig: defaultVestingConfig(),
    governor,
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
  defaultVestingConfig,
  wholeTokens,
  deployTestToken,
  deployTestTokenAddress,
};
