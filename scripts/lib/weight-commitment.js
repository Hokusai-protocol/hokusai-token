const crypto = require("crypto");

const WEIGHT_COMMITMENT_VERSION = "sha256-merkle-v1";

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  throw new TypeError("Weight commitment bytes must be a Buffer or Uint8Array");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest();
}

function comparePathsUtf8(a, b) {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function buildLeaf(path, bytes) {
  return sha256(Buffer.concat([
    Buffer.from(path, "utf8"),
    Buffer.from([0]),
    sha256(toBuffer(bytes)),
  ]));
}

function buildMerkleRoot(leaves) {
  if (leaves.length === 0) {
    throw new Error("Weight commitment requires at least one file");
  }

  let level = leaves.slice();
  while (level.length > 1) {
    const nextLevel = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] || left;
      nextLevel.push(sha256(Buffer.concat([left, right])));
    }
    level = nextLevel;
  }

  return level[0];
}

function computeWeightCommitment(records) {
  const normalizedRecords = [...records].map((record) => {
    if (!record || typeof record.path !== "string" || record.path.length === 0) {
      throw new TypeError("Weight commitment records require a non-empty path");
    }

    return {
      path: record.path,
      bytes: toBuffer(record.bytes),
    };
  });

  normalizedRecords.sort((a, b) => comparePathsUtf8(a.path, b.path));
  const leaves = normalizedRecords.map(({ path, bytes }) => buildLeaf(path, bytes));
  const root = buildMerkleRoot(leaves);

  return {
    version: WEIGHT_COMMITMENT_VERSION,
    root: `0x${root.toString("hex")}`,
    leafCount: leaves.length,
  };
}

module.exports = {
  WEIGHT_COMMITMENT_VERSION,
  computeWeightCommitment,
};
