const { expect } = require("chai");

const posture = require("../../scripts/configs/mainnet-launch-posture.json");
const sources = require("../../scripts/configs/mainnet-weight-genesis-sources.json");

const PLACEHOLDER_ROOTS = new Set([
  "0x1111111111111111111111111111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333333333333333333333333333",
]);

describe("Mainnet weight genesis sources", function () {
  it("keeps launch posture roots aligned with the source manifest", function () {
    expect(sources.version).to.equal("sha256-merkle-v1");

    for (const source of sources.models) {
      const model = posture.models.find((entry) => Number(entry.modelId) === source.modelId);
      expect(model, `model ${source.modelId} launch posture entry`).to.exist;
      expect(model.expectedWeightGenesis).to.equal(source.expectedWeightGenesis);
      expect(PLACEHOLDER_ROOTS.has(model.expectedWeightGenesis)).to.equal(false);
      expect(source.fixtureSha256).to.match(/^[0-9a-f]{64}$/);
      expect(source.includedFiles.length, `model ${source.modelId} included files`).to.be.greaterThan(0);

      for (const file of source.includedFiles) {
        expect(file.path).to.be.a("string").and.not.equal("");
        expect(file.sha256).to.match(/^[0-9a-f]{64}$/);
        expect(file.byteLength).to.be.greaterThan(0);
      }
    }
  });
});
