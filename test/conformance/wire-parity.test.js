const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { expect } = require("chai");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats");

const FIXTURE_PATH = path.resolve(
  __dirname,
  "../../services/contract-deployer/tests/fixtures/mint_request.v1.json"
);
const KNOWN_ANSWER_PATH = path.resolve(
  __dirname,
  "../../services/contract-deployer/tests/fixtures/mint_request.v1.known_answer.json"
);

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function resolvePipelineRoot() {
  const override = process.env.HOKUSAI_DATA_PIPELINE_DIR;
  if (override) {
    const candidate = path.resolve(override);
    return fs.existsSync(path.join(candidate, "schema/examples/mint_request.v1.json")) ? candidate : null;
  }

  const repoRoot = path.resolve(__dirname, "../..");
  const siblingRoot = path.dirname(repoRoot);
  const preferredNames = ["hokusai-data-pipeline"];

  for (const name of preferredNames) {
    const candidate = path.join(siblingRoot, name);
    if (fs.existsSync(path.join(candidate, "schema/examples/mint_request.v1.json"))) {
      return candidate;
    }
  }

  for (const entry of fs.readdirSync(siblingRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(siblingRoot, entry.name);
    if (fs.existsSync(path.join(candidate, "schema/examples/mint_request.v1.json"))) {
      return candidate;
    }
  }

  return null;
}

function expectSchemaValid(schemaPath, fixture) {
  const schema = loadJson(schemaPath);
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  const valid = validate(fixture);
  expect(valid, `${path.basename(schemaPath)} errors: ${JSON.stringify(validate.errors)}`).to.equal(true);
}

describe("MintRequest wire parity", function () {
  it("pins the vendored fixture bytes to the committed sha256 and validates sibling schemas when reachable", function () {
    const knownAnswer = loadJson(KNOWN_ANSWER_PATH);
    const vendoredRaw = fs.readFileSync(FIXTURE_PATH);
    const vendoredFixture = JSON.parse(vendoredRaw.toString("utf8"));
    const vendoredSha = sha256Hex(vendoredRaw);
    const pipelineRoot = resolvePipelineRoot();

    expect(vendoredSha).to.equal(knownAnswer.fixture_sha256);

    if (pipelineRoot) {
      const siblingFixturePath = path.join(pipelineRoot, "schema/examples/mint_request.v1.json");
      const siblingRaw = fs.readFileSync(siblingFixturePath);

      expect(sha256Hex(siblingRaw)).to.equal(vendoredSha);
      expect(Buffer.compare(siblingRaw, vendoredRaw)).to.equal(0);
      expectSchemaValid(path.join(pipelineRoot, "schema/mint_request.v1.json"), vendoredFixture);
      expectSchemaValid(path.join(pipelineRoot, "schema/mint_request.consumer.v1.json"), vendoredFixture);
      return;
    }

    console.warn("hokusai-data-pipeline checkout not found; skipping sibling byte/schema parity checks");
  });
});
