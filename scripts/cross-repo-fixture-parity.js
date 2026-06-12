#!/usr/bin/env node
// Strict byte-hash parity check between the vendored pipeline fixture and the
// sibling pipeline checkout. Used by the scheduled cross-repo conformance workflow.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const VENDORED = path.resolve(__dirname, "../services/contract-deployer/tests/fixtures/mint_request.v1.json");
const SIBLING = path.resolve(__dirname, "../../hokusai-data-pipeline/schema/examples/mint_request.v1.json");

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath, "utf8")).digest("hex");
}

function main() {
  if (!fs.existsSync(VENDORED)) {
    console.error("FAIL: vendored fixture not found:", VENDORED);
    process.exit(1);
  }

  if (!fs.existsSync(SIBLING)) {
    console.error("FAIL: sibling pipeline fixture not found:", SIBLING);
    console.error("Expected path:", SIBLING);
    console.error("Did the cross-repo workflow clone hokusai-data-pipeline?");
    process.exit(1);
  }

  const vendoredHash = sha256(VENDORED);
  const siblingHash = sha256(SIBLING);

  if (vendoredHash !== siblingHash) {
    console.error("FAIL: vendored fixture and sibling pipeline copy are NOT byte-identical.");
    console.error("  vendored SHA256:", vendoredHash);
    console.error("  sibling  SHA256:", siblingHash);
    console.error("");
    console.error("One side was updated without the other. See docs/mint-request-fixture-bump-protocol.md");
    process.exit(1);
  }

  console.log("OK: vendored and sibling pipeline fixtures are byte-identical.");
  console.log("  SHA256:", vendoredHash);
}

main();
