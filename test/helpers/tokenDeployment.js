const { parseEther, keccak256, toUtf8Bytes } = require("ethers");

function wholeTokens(value) {
  return parseEther(value.toString());
}

function buildInitialParams(governor, overrides = {}) {
  return {
    tokensPerDeltaOne: wholeTokens(500000),
    infrastructureAccrualBps: 8000,
    licenseHash: keccak256(toUtf8Bytes("default-license")),
    licenseURI: "https://hokusai.ai/licenses/default",
    governor,
    ...overrides,
  };
}

module.exports = {
  buildInitialParams,
  wholeTokens,
};
