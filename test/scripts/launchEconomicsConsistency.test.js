/*
 * HOK-2199 / HOK-2207 — launch-economics drift guard.
 *
 * tokensPerDeltaOne repeatedly drifted back to the stale 500,000 (design-locked value is 250,000),
 * and launch-token vesting drifted (mainnet was 100%-immediate). This test makes both impossible to
 * merge: every model in every *-launch-tokens.json and *-launch-posture.json must agree with the
 * single locked source of truth (scripts/configs/locked-economics.json), and the two config families
 * must agree with each other per shared modelId. It runs in the blocking `npm test` (Hardhat) lane.
 */
const { expect } = require("chai");
const fs = require("fs");
const path = require("path");

const CONFIG_DIR = path.resolve(__dirname, "..", "..", "scripts", "configs");
const load = (file) => JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), "utf8"));
const locked = load("locked-economics.json");

// Launch-tokens use whole-token strings; launch-posture uses wei strings. Normalize to wei.
const toWei = (whole) => (BigInt(whole) * 10n ** 18n).toString();

const TOKEN_CONFIGS = ["sepolia-launch-tokens.json", "mainnet-launch-tokens.json"];
const POSTURE_CONFIGS = ["sepolia-launch-posture.json", "mainnet-launch-posture.json"];

describe("Launch economics consistency (HOK-2199/HOK-2207 drift guard)", function () {
  it("the locked source of truth holds the design-locked values (never 500k)", function () {
    expect(locked.tokensPerDeltaOne).to.equal("250000");
    expect(locked.tokensPerDeltaOne).to.not.equal("500000");
    expect(locked.maxReward).to.equal("2500000");
    expect(locked.startingMintBudget).to.equal("1500000");
    expect(locked.vestingConfig).to.deep.equal({
      enabled: true,
      immediateUnlockBps: 1000,
      vestingDurationSeconds: 31536000,
      cliffSeconds: 0,
    });
  });

  for (const file of TOKEN_CONFIGS) {
    describe(file, function () {
      const cfg = load(file);
      for (const token of cfg.tokens) {
        it(`${token.symbol} (model ${token.modelId}): tokensPerDeltaOne and vesting match the lock`, function () {
          expect(token.tokensPerDeltaOne, `${token.symbol} tokensPerDeltaOne`).to.equal(
            locked.tokensPerDeltaOne,
          );
          expect(token.tokensPerDeltaOne, `${token.symbol} must never be 500k`).to.not.equal("500000");
          expect(token.vestingConfig, `${token.symbol} vestingConfig`).to.deep.equal(
            locked.vestingConfig,
          );
        });
      }
    });
  }

  for (const file of POSTURE_CONFIGS) {
    describe(file, function () {
      const cfg = load(file);
      it("deltaVerifier.maxReward matches the lock (wei)", function () {
        expect(cfg.deltaVerifier.maxReward).to.equal(toWei(locked.maxReward));
      });
      for (const model of cfg.models) {
        it(`model ${model.modelId}: expectedTokensPerDeltaOne and budget match the lock (wei)`, function () {
          expect(
            model.expectedTokensPerDeltaOne,
            `model ${model.modelId} expectedTokensPerDeltaOne`,
          ).to.equal(toWei(locked.tokensPerDeltaOne));
          expect(
            model.expectedMintBudgetRemaining,
            `model ${model.modelId} expectedMintBudgetRemaining`,
          ).to.equal(toWei(locked.startingMintBudget));
        });
      }
    });
  }

  it("token configs and posture configs agree per shared modelId", function () {
    const tokenById = {};
    for (const file of TOKEN_CONFIGS) {
      for (const t of load(file).tokens) {
        tokenById[String(t.modelId)] = toWei(t.tokensPerDeltaOne);
      }
    }
    for (const file of POSTURE_CONFIGS) {
      for (const m of load(file).models) {
        const id = String(m.modelId);
        if (tokenById[id] !== undefined) {
          expect(
            m.expectedTokensPerDeltaOne,
            `posture vs token tokensPerDeltaOne disagree for model ${id}`,
          ).to.equal(tokenById[id]);
        }
      }
    }
  });
});
