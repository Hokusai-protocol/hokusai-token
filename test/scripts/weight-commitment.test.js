const crypto = require("crypto");
const { expect } = require("chai");

const {
  WEIGHT_COMMITMENT_VERSION,
  computeWeightCommitment,
} = require("../../scripts/lib/weight-commitment");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function leaf(path, bytes) {
  return sha256(Buffer.concat([
    Buffer.from(path, "utf8"),
    Buffer.from([0]),
    sha256(bytes),
  ]));
}

function rootFromLeaves(leaves) {
  if (leaves.length === 1) {
    return leaves[0];
  }

  const next = [];
  for (let index = 0; index < leaves.length; index += 2) {
    const left = leaves[index];
    const right = leaves[index + 1] || left;
    next.push(sha256(Buffer.concat([left, right])));
  }

  return rootFromLeaves(next);
}

describe("weight commitment helper", function () {
  it("computes the expected single-leaf root", function () {
    const bytes = Buffer.from("single-leaf-payload", "utf8");
    const expected = `0x${leaf("weights.bin", bytes).toString("hex")}`;
    const result = computeWeightCommitment([
      { path: "weights.bin", bytes },
    ]);

    expect(result.version).to.equal(WEIGHT_COMMITMENT_VERSION);
    expect(result.leafCount).to.equal(1);
    expect(result.root).to.equal(expected);
  });

  it("sorts input paths before building the two-leaf tree", function () {
    const leftBytes = Buffer.from("left", "utf8");
    const rightBytes = Buffer.from("right", "utf8");
    const expected = `0x${rootFromLeaves([
      leaf("a.bin", leftBytes),
      leaf("b.bin", rightBytes),
    ]).toString("hex")}`;

    const result = computeWeightCommitment([
      { path: "b.bin", bytes: rightBytes },
      { path: "a.bin", bytes: leftBytes },
    ]);

    expect(result.root).to.equal(expected);
  });

  it("duplicates the final leaf when the tree width is odd", function () {
    const leaves = [
      leaf("a.bin", Buffer.from("a", "utf8")),
      leaf("b.bin", Buffer.from("b", "utf8")),
      leaf("c.bin", Buffer.from("c", "utf8")),
    ];
    const expected = `0x${rootFromLeaves(leaves).toString("hex")}`;

    const result = computeWeightCommitment([
      { path: "a.bin", bytes: Buffer.from("a", "utf8") },
      { path: "b.bin", bytes: Buffer.from("b", "utf8") },
      { path: "c.bin", bytes: Buffer.from("c", "utf8") },
    ]);

    expect(result.root).to.equal(expected);
  });

  it("is invariant to input order", function () {
    const ordered = computeWeightCommitment([
      { path: "a.bin", bytes: Buffer.from("1", "utf8") },
      { path: "b.bin", bytes: Buffer.from("2", "utf8") },
      { path: "c.bin", bytes: Buffer.from("3", "utf8") },
    ]);
    const shuffled = computeWeightCommitment([
      { path: "c.bin", bytes: Buffer.from("3", "utf8") },
      { path: "a.bin", bytes: Buffer.from("1", "utf8") },
      { path: "b.bin", bytes: Buffer.from("2", "utf8") },
    ]);

    expect(shuffled.root).to.equal(ordered.root);
  });

  it("changes when only the path changes", function () {
    const bytes = Buffer.from("same", "utf8");
    const first = computeWeightCommitment([{ path: "a.bin", bytes }]);
    const second = computeWeightCommitment([{ path: "b.bin", bytes }]);

    expect(second.root).to.not.equal(first.root);
  });

  it("changes when only the bytes change", function () {
    const first = computeWeightCommitment([{ path: "a.bin", bytes: Buffer.from("x", "utf8") }]);
    const second = computeWeightCommitment([{ path: "a.bin", bytes: Buffer.from("y", "utf8") }]);

    expect(second.root).to.not.equal(first.root);
  });
});
