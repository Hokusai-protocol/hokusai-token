const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LaunchConfigError,
  loadLaunchTokensConfig,
  scaleTokenEntry,
} = require("../../scripts/lib/launch-tokens");

function writeConfig(config) {
  const filepath = path.join(os.tmpdir(), `launch-config-${Date.now()}-${Math.random()}.json`);
  fs.writeFileSync(filepath, JSON.stringify(config, null, 2));
  return filepath;
}

function buildToken(index, overrides = {}) {
  return {
    configKey: `token-${index}`,
    modelId: String(index),
    name: `Token ${index}`,
    symbol: `TK${index}`,
    supplierRecipient: "0x00000000000000000000000000000000000000A1",
    supplierAllocation: "2500000",
    investorAllocation: "10000000",
    tokensPerDeltaOne: "500000",
    infrastructureAccrualBps: 8000,
    initialOraclePricePerThousandUsd: "0",
    licenseHash: `0x${String(index).repeat(64).slice(0, 64)}`,
    licenseURI: "https://hokusai.ai/licenses/standard",
    governor: "0x00000000000000000000000000000000000000B1",
    vestingConfig: {
      enabled: false,
      immediateUnlockBps: 10000,
      vestingDurationSeconds: 0,
      cliffSeconds: 0,
    },
    distributionTiming: "post-verification",
    pool: {
      name: `Pool ${index}`,
      performanceMetric: "accuracy",
      initialReserveUsdc: "10000",
      crr: 300000,
      tradeFee: 30,
      ibrSeconds: 604800,
      flatCurveThresholdUsdc: "25000",
      flatCurvePriceUsdc: "0.01",
    },
    ...overrides,
  };
}

describe("launch-tokens helper", function () {
  it("loads and scales a valid launch config", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [buildToken(1), buildToken(2, {
        configKey: "token-2",
        modelId: "2",
        supplierRecipient: "0x00000000000000000000000000000000000000A2",
        governor: "0x00000000000000000000000000000000000000B2",
      }), buildToken(3, {
        configKey: "token-3",
        modelId: "3",
        supplierRecipient: "0x00000000000000000000000000000000000000A3",
        governor: "0x00000000000000000000000000000000000000B3",
      })],
    });

    const loaded = loadLaunchTokensConfig(filepath);
    const scaled = scaleTokenEntry(loaded.tokens[0]);

    expect(loaded.tokens).to.have.lengthOf(3);
    expect(loaded.tokens[0].public).to.equal(false);
    expect(scaled.supplierWei).to.equal(2500000n * 10n ** 18n);
    expect(scaled.investorWei).to.equal(10000000n * 10n ** 18n);
    expect(scaled.tokensPerDeltaOneWei).to.equal(500000n * 10n ** 18n);
    expect(scaled.initialReserveUsdc).to.equal(10000n * 10n ** 6n);
    expect(scaled.flatCurvePriceUsdc).to.equal(10000n);
  });

  it("rejects configs with the wrong token count", function () {
    const filepath = writeConfig({ version: 1, tokens: [buildToken(1)] });
    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "Launch config must define exactly 3 tokens");
  });

  it("H-1: rejects a token whose governor != requiredGovernor", function () {
    const SAFE = "0x158B985CC667b4E022AD05B99E89007790da66E2";
    const filepath = writeConfig({
      version: 1,
      requiredGovernor: SAFE,
      tokens: [
        buildToken(1, { supplierRecipient: SAFE, governor: SAFE }),
        // token-2 governor deliberately differs from requiredGovernor
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: SAFE, governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: SAFE, governor: SAFE }),
      ],
    });
    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "must equal requiredGovernor");
  });

  it("H-1: accepts when every governor equals requiredGovernor", function () {
    const SAFE = "0x158B985CC667b4E022AD05B99E89007790da66E2";
    const filepath = writeConfig({
      version: 1,
      requiredGovernor: SAFE,
      tokens: [
        buildToken(1, { supplierRecipient: SAFE, governor: SAFE }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: SAFE, governor: SAFE }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: SAFE, governor: SAFE }),
      ],
    });
    const loaded = loadLaunchTokensConfig(filepath);
    expect(loaded.tokens).to.have.lengthOf(3);
    expect(loaded.tokens.every((t) => t.governor === SAFE)).to.equal(true);
  });

  it("rejects zero addresses", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [
        buildToken(1, { supplierRecipient: "0x0000000000000000000000000000000000000000" }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: "0x00000000000000000000000000000000000000A2", governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: "0x00000000000000000000000000000000000000A3", governor: "0x00000000000000000000000000000000000000B3" }),
      ],
    });

    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "supplierRecipient must be non-zero checksum address");
  });

  it("rejects tokensPerDeltaOne below bounds", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [
        buildToken(1, { tokensPerDeltaOne: "50" }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: "0x00000000000000000000000000000000000000A2", governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: "0x00000000000000000000000000000000000000A3", governor: "0x00000000000000000000000000000000000000B3" }),
      ],
    });

    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "tokensPerDeltaOne out of bounds");
  });

  it("rejects invalid infrastructureAccrualBps", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [
        buildToken(1, { infrastructureAccrualBps: 12000 }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: "0x00000000000000000000000000000000000000A2", governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: "0x00000000000000000000000000000000000000A3", governor: "0x00000000000000000000000000000000000000B3" }),
      ],
    });

    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "infrastructureAccrualBps out of bounds");
  });

  it("accepts public=true and preserves it on the parsed entry", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [
        buildToken(1, { public: true }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: "0x00000000000000000000000000000000000000A2", governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: "0x00000000000000000000000000000000000000A3", governor: "0x00000000000000000000000000000000000000B3" }),
      ],
    });

    const loaded = loadLaunchTokensConfig(filepath);
    expect(loaded.tokens[0].public).to.equal(true);
  });

  it("rejects non-boolean public flag values", function () {
    const filepath = writeConfig({
      version: 1,
      tokens: [
        buildToken(1, { public: "yes" }),
        buildToken(2, { configKey: "token-2", modelId: "2", supplierRecipient: "0x00000000000000000000000000000000000000A2", governor: "0x00000000000000000000000000000000000000B2" }),
        buildToken(3, { configKey: "token-3", modelId: "3", supplierRecipient: "0x00000000000000000000000000000000000000A3", governor: "0x00000000000000000000000000000000000000B3" }),
      ],
    });

    expect(() => loadLaunchTokensConfig(filepath)).to.throw(LaunchConfigError, "public must be boolean when provided");
  });
});
