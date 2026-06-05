const { expect } = require("chai");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildArtifact,
  getGitSha,
  getScriptSha,
  resolveArtifactPaths,
  toSerializable,
} = require("../../scripts/lib/deployment-artifact");

describe("deployment artifact helper", function () {
  it("serializes bigints and assembles the canonical artifact", function () {
    const artifact = buildArtifact({
      deploymentResult: {
        contracts: { ModelRegistry: "0x123", TokenManager: "0x456" },
        roles: { TokenManager: { owner: "0xabc", deltaVerifier: "0xdef" } },
        config: { expectedChainId: 1n, maxReward: 42n },
        gasUsed: { ModelRegistry: "12345", wiring: { setDeltaVerifier: "6789" } },
        notes: { rewardVestingVaultInert: "inert" },
      },
      network: "mainnet",
      dryRun: false,
      chainId: 1n,
      deployer: "0xdeployer",
      treasury: "0xtreasury",
      backendService: "0xbackend",
      timestamp: "2026-05-13T15:00:00.000Z",
      scriptPaths: [__filename],
    });

    expect(artifact.network).to.equal("mainnet");
    expect(artifact.chainId).to.equal("1");
    expect(artifact.git).to.have.keys(["sha", "dirty"]);
    expect(artifact.scriptSha).to.match(/^[a-f0-9]{64}$/);
    expect(artifact.config.expectedChainId).to.equal("1");
    expect(artifact.config.maxReward).to.equal("42");
    expect(artifact.notes.purchaserWhitelistGatingDefault).to.equal(true);
  });

  it("hashes script content deterministically", function () {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hok-script-sha-"));
    const fileA = path.join(tmpDir, "a.js");
    const fileB = path.join(tmpDir, "b.js");
    fs.writeFileSync(fileA, "alpha\n");
    fs.writeFileSync(fileB, "beta\n");

    const hashOne = getScriptSha([fileA, fileB]);
    const hashTwo = getScriptSha([fileB, fileA]);

    expect(hashOne).to.equal(hashTwo);
    expect(hashOne).to.match(/^[a-f0-9]{64}$/);
  });

  it("returns git metadata or an unknown fallback", function () {
    const git = getGitSha();
    expect(git).to.have.keys(["sha", "dirty"]);
    expect(git.dirty).to.be.a("boolean");
    expect(git.sha === "unknown" || /^[a-f0-9]{40}$/.test(git.sha)).to.equal(true);
  });

  it("computes dry-run artifact paths without touching latest", function () {
    const paths = resolveArtifactPaths({
      network: "mainnet",
      timestamp: "2026-05-13T15:00:00.000Z",
      dryRun: true,
      baseDir: "/tmp/deployments",
    });

    expect(paths.datedPath).to.equal("/tmp/deployments/mainnet-dryrun-2026-05-13T15-00-00-000Z.json");
    expect(paths.latestPath).to.equal("/tmp/deployments/mainnet-latest.json");
  });

  it("serializes nested structures recursively", function () {
    expect(
      toSerializable({
        a: 1n,
        b: [2n, { c: 3n }],
      })
    ).to.deep.equal({
      a: "1",
      b: ["2", { c: "3" }],
    });
  });
});
