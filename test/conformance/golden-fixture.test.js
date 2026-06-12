const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther } = require("ethers");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

const { deployTestToken } = require("../helpers/tokenDeployment");
const {
  MINT_REQUEST_EIP712_TYPES,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
} = require("../helpers/mintRequest");

const GOLDEN_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/deltaverifier-mint-request.golden.json");
const KNOWN_ANSWER_PATH = path.resolve(__dirname, "../fixtures/deltaverifier-mint-request.known-answer.json");
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");

function loadGoldenFixture() {
  return JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, "utf8"));
}

function loadKnownAnswer() {
  return JSON.parse(fs.readFileSync(KNOWN_ANSWER_PATH, "utf8"));
}

function buildPayload(golden) {
  return {
    pipelineRunId: golden.pipelineRunId,
    baselineScoreBps: golden.baselineScoreBps,
    candidateScoreBps: golden.candidateScoreBps,
    maxCostUsdMicro: golden.maxCostUsdMicro,
    actualCostUsdMicro: golden.actualCostUsdMicro,
    totalSamples: golden.totalSamples,
    anchors: {
      benchmarkSpecHash: golden.benchmarkSpecHash,
      datasetHash: golden.datasetHash,
      attestationHash: golden.attestationHash,
      idempotencyKey: golden.idempotencyKey,
      metricName: golden.metricName,
      metricFamily: golden.metricFamily,
    },
    baselineCommitment: golden.baselineCommitment,
    candidateCommitment: golden.candidateCommitment,
  };
}

// Walk the EIP-712 type schema and produce a flat list of dotted paths to every leaf field,
// along with each field's Solidity type. Generated from the schema so new fields auto-test.
// Array fields are expanded against the sample value, so fixtures of any length work.
function enumerateSignedFields(types, sampleValue) {
  const paths = [];

  function walk(typeName, prefix, value) {
    const fields = types[typeName];
    if (!fields) return;
    for (const { name, type } of fields) {
      const fieldPath = prefix ? `${prefix}.${name}` : name;
      const fieldValue = value === undefined ? undefined : value[name];
      const arrayBase = type.replace("[]", "");
      if (types[arrayBase]) {
        if (type.endsWith("[]")) {
          const length = Array.isArray(fieldValue) ? fieldValue.length : 0;
          for (let i = 0; i < length; i++) {
            walk(arrayBase, `${fieldPath}[${i}]`, fieldValue[i]);
          }
        } else {
          walk(arrayBase, fieldPath, fieldValue);
        }
      } else {
        paths.push({ path: fieldPath, type });
      }
    }
  }

  walk("MintRequest", "", sampleValue);
  return paths;
}

function mutateValue(value, solidityType) {
  if (solidityType === "uint256") {
    return typeof value === "bigint" ? value + 1n : BigInt(value) + 1n;
  }
  if (solidityType === "bytes32") {
    const bytes = ethers.getBytes(value);
    bytes[31] = (bytes[31] + 1) % 256;
    return ethers.hexlify(bytes);
  }
  if (solidityType === "string") {
    return value + "X";
  }
  if (solidityType === "address") {
    const n = BigInt(value) + 1n;
    return ethers.zeroPadValue(ethers.toBeHex(n), 20);
  }
  throw new Error(`Unknown type: ${solidityType}`);
}

function deepGet(obj, dottedPath) {
  const segments = dottedPath.split(".");
  let cursor = obj;
  for (const seg of segments) {
    const match = seg.match(/^(.+)\[(\d+)\]$/);
    if (match) {
      cursor = cursor[match[1]][parseInt(match[2])];
    } else {
      cursor = cursor[seg];
    }
  }
  return cursor;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj, (_, v) => typeof v === "bigint" ? `__bigint__${v}` : v), (_, v) => {
    if (typeof v === "string" && v.startsWith("__bigint__")) return BigInt(v.slice(10));
    return v;
  });
}

function deepSet(obj, dottedPath, value) {
  const clone = deepClone(obj);
  const segments = dottedPath.split(".");
  let cursor = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const match = segments[i].match(/^(.+)\[(\d+)\]$/);
    if (match) {
      cursor = cursor[match[1]][parseInt(match[2])];
    } else {
      cursor = cursor[segments[i]];
    }
  }
  const last = segments[segments.length - 1];
  const lastMatch = last.match(/^(.+)\[(\d+)\]$/);
  if (lastMatch) {
    cursor[lastMatch[1]][parseInt(lastMatch[2])] = value;
  } else {
    cursor[last] = value;
  }
  return clone;
}

function buildEip712Value(golden) {
  return {
    modelId: BigInt(golden.modelId),
    payload: buildPayload(golden),
    contributors: golden.contributors.map(c => ({
      walletAddress: c.walletAddress,
      weight: c.weight,
    })),
  };
}

describe("DeltaVerifier golden fixture conformance", function () {
  const knownAnswer = loadKnownAnswer();
  const golden = loadGoldenFixture();

  async function deployConformanceFixture() {
    // Reset the chain so signer[0] starts at nonce 0, ensuring DeltaVerifier
    // deploys at the deterministic address regardless of test execution order.
    await ethers.provider.send("hardhat_reset", []);
    const [owner, submitter, attester] = await ethers.getSigners();
    const modelId = BigInt(golden.modelId);
    const modelIdStr = golden.modelId;

    const ModelRegistry = await ethers.getContractFactory("ModelRegistry");
    const modelRegistry = await ModelRegistry.deploy();
    await modelRegistry.waitForDeployment();

    const TokenManager = await ethers.getContractFactory("TokenManager");
    const tokenManager = await TokenManager.deploy(await modelRegistry.getAddress());
    await tokenManager.waitForDeployment();

    const DataContributionRegistry = await ethers.getContractFactory("DataContributionRegistry");
    const contributionRegistry = await DataContributionRegistry.deploy();
    await contributionRegistry.waitForDeployment();

    const DeltaVerifier = await ethers.getContractFactory("DeltaVerifier");
    const deltaVerifier = await DeltaVerifier.deploy(
      await modelRegistry.getAddress(),
      await tokenManager.getAddress(),
      await contributionRegistry.getAddress(),
      parseEther("1000"),
      MIN_IMPROVEMENT_BPS,
      MAX_REWARD,
    );
    await deltaVerifier.waitForDeployment();

    await deployTestToken(tokenManager, modelIdStr, "Golden Fixture Token", "GLDN", parseEther("10000"), owner.address);
    await modelRegistry.registerModel(modelId, await tokenManager.getTokenAddress(modelIdStr), golden.metricName);

    // Register the mutated model id (modelId + 1) too, so the mutation matrix's modelId case
    // reaches signature verification (SignerNotAttester) instead of "Model not registered".
    const mutatedModelId = modelId + 1n;
    const mutatedModelIdStr = mutatedModelId.toString();
    await deployTestToken(tokenManager, mutatedModelIdStr, "Golden Fixture Token (mutated)", "GLDM", parseEther("10000"), owner.address);
    await modelRegistry.registerModel(mutatedModelId, await tokenManager.getTokenAddress(mutatedModelIdStr), golden.metricName);
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);
    await configureLaunchAttester(deltaVerifier, owner, attester);
    await configureMintBudget(deltaVerifier, owner, modelId);
    await configureLineageGenesis(modelRegistry, owner, modelId, golden.baselineCommitment);

    return { owner, attester, deltaVerifier, modelId, submitter, modelRegistry };
  }

  describe("deployment pinning", function () {
    it("deploys DeltaVerifier at the pinned verifyingContract address", async function () {
      const { deltaVerifier } = await loadFixture(deployConformanceFixture);
      const actual = await deltaVerifier.getAddress();
      expect(actual).to.equal(
        knownAnswer.domain.verifyingContract,
        "DeltaVerifier deployed at unexpected address. If the deploy sequence changed, run: npm run conformance:regen"
      );
    });
  });

  describe("assertion A — digest parity", function () {
    it("on-chain hashMintRequest equals committed typedDataDigest", async function () {
      const { deltaVerifier } = await loadFixture(deployConformanceFixture);
      const payload = buildPayload(golden);
      const modelId = BigInt(golden.modelId);
      const contributors = golden.contributors.map(c => ({
        walletAddress: c.walletAddress,
        weight: c.weight,
      }));

      const onChainDigest = await deltaVerifier.hashMintRequest(modelId, payload, contributors);
      expect(onChainDigest).to.equal(knownAnswer.typedDataDigest);
    });

    it("ethers TypedDataEncoder.hashStruct equals committed structHash", async function () {
      const value = buildEip712Value(golden);
      const structHash = ethers.TypedDataEncoder.hashStruct("MintRequest", MINT_REQUEST_EIP712_TYPES, value);
      expect(structHash).to.equal(knownAnswer.structHash);
    });

    it("ethers TypedDataEncoder.hash under pinned domain equals committed typedDataDigest", async function () {
      const value = buildEip712Value(golden);
      const typedDataDigest = ethers.TypedDataEncoder.hash(
        knownAnswer.domain,
        MINT_REQUEST_EIP712_TYPES,
        value,
      );
      expect(typedDataDigest).to.equal(knownAnswer.typedDataDigest);
    });
  });

  describe("assertion C — accept path", function () {
    it("accepts the canonical golden payload with committed signatures", async function () {
      const { deltaVerifier, modelId, submitter } = await loadFixture(deployConformanceFixture);
      const payload = buildPayload(golden);
      const contributors = golden.contributors.map(c => ({
        walletAddress: c.walletAddress,
        weight: c.weight,
      }));

      await expect(
        deltaVerifier.connect(submitter).submitMintRequest(
          modelId, payload, contributors, knownAnswer.signatures
        )
      ).to.emit(deltaVerifier, "DeltaOneAccepted");
    });
  });

  describe("assertion C — parameterized mutation matrix", function () {
    const signedFields = enumerateSignedFields(MINT_REQUEST_EIP712_TYPES, buildEip712Value(golden));

    for (const { path: fieldPath, type: solidityType } of signedFields) {
      it(`rejects mutation of ${fieldPath} (${solidityType})`, async function () {
        const { deltaVerifier, submitter } = await loadFixture(deployConformanceFixture);
        const eip712Value = buildEip712Value(golden);

        const currentValue = deepGet(eip712Value, fieldPath);
        const mutated = mutateValue(currentValue, solidityType);
        const tampered = deepSet(eip712Value, fieldPath, mutated);

        const tx = deltaVerifier.connect(submitter).submitMintRequest(
          tampered.modelId, tampered.payload, tampered.contributors, knownAnswer.signatures
        );

        // Every mutation — including modelId, whose mutated value is pre-registered in the
        // fixture — must reach signature verification and revert with SignerNotAttester.
        await expect(tx).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
      });
    }
  });
});
