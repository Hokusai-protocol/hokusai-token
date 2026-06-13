const { expect } = require("chai");

const { computeWeightCommitment } = require("../../scripts/lib/weight-commitment");
const fixture = require("../fixtures/sepolia-rehearsal-model-30.json");
const sepoliaConfig = require("../../scripts/configs/sepolia-launch-posture.json");

describe("Sepolia weight commitment parity", function () {
  it("keeps the Model 30 config root aligned with the pinned rehearsal fixture", function () {
    const commitment = computeWeightCommitment(
      fixture.files.map((entry) => ({
        path: entry.path,
        bytes: Buffer.from(entry.hex.slice(2), "hex"),
      }))
    );
    const model = sepoliaConfig.models.find((entry) => Number(entry.modelId) === fixture.modelId);

    expect(model, "Model 30 launch posture config").to.exist;
    expect(commitment.root).to.equal(model.expectedWeightGenesis);
  });
});
