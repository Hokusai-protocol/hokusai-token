const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { parseEther, TypedDataEncoder } = require("ethers");

const { deployTestToken } = require("../helpers/tokenDeployment");
const {
  attestMintRequest,
  configureLaunchAttester,
  configureMintBudget,
  configureLineageGenesis,
  eip712Domain,
  MINT_REQUEST_EIP712_TYPES,
} = require("../helpers/mintRequest");
const { MUTATIONS } = require("./mutations");

const GOLDEN_FIXTURE_PATH = path.resolve(__dirname, "../fixtures/deltaverifier-mint-request.golden.json");
const MIN_IMPROVEMENT_BPS = 100;
const MAX_REWARD = parseEther("1000000");

function loadGoldenFixture() {
  return JSON.parse(fs.readFileSync(GOLDEN_FIXTURE_PATH, "utf8"));
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

describe("DeltaVerifier golden fixture conformance", function () {
  async function deployFixture() {
    const [owner, submitter, attester] = await ethers.getSigners();
    const golden = loadGoldenFixture();
    const modelId = BigInt(golden.modelId);
    const modelIdStr = golden.modelId;
    const alternateModelId = modelId + 1n;
    const alternateModelIdStr = alternateModelId.toString();

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
    await tokenManager.setDeltaVerifier(await deltaVerifier.getAddress());
    await contributionRegistry.grantRole(await contributionRegistry.RECORDER_ROLE(), await deltaVerifier.getAddress());
    await deltaVerifier.grantRole(await deltaVerifier.SUBMITTER_ROLE(), submitter.address);
    await configureLaunchAttester(deltaVerifier, owner, attester);
    await configureMintBudget(deltaVerifier, owner, modelId);
    await configureLineageGenesis(modelRegistry, owner, modelId, golden.baselineCommitment);
    await deployTestToken(
      tokenManager,
      alternateModelIdStr,
      "Golden Fixture Token Alt",
      "GLD2",
      parseEther("10000"),
      owner.address
    );
    await modelRegistry.registerModel(
      alternateModelId,
      await tokenManager.getTokenAddress(alternateModelIdStr),
      golden.metricName
    );
    await configureMintBudget(deltaVerifier, owner, alternateModelId);
    await configureLineageGenesis(modelRegistry, owner, alternateModelId, golden.baselineCommitment);

    return { attester, deltaVerifier, golden, modelId, submitter };
  }

  it("accepts the canonical golden payload when signed by the attester", async function () {
    const { attester, deltaVerifier, golden, modelId, submitter } = await deployFixture();
    const payload = buildPayload(golden);
    const contributors = golden.contributors;
    const signatures = await attestMintRequest(deltaVerifier, attester, modelId, payload, contributors);
    const domain = await eip712Domain(deltaVerifier);
    const expectedDigest = TypedDataEncoder.hash(domain, MINT_REQUEST_EIP712_TYPES, {
      modelId,
      payload,
      contributors,
    });

    expect(await deltaVerifier.hashMintRequest(modelId, payload, contributors)).to.equal(expectedDigest);
    await expect(
      deltaVerifier.connect(submitter).submitMintRequest(modelId, payload, contributors, signatures)
    ).to.emit(deltaVerifier, "DeltaOneAccepted");
  });

  MUTATIONS.forEach(({ name, mutate }) => {
    it(`rejects a signed-field mutation for ${name} with SignerNotAttester`, async function () {
      const { attester, deltaVerifier, golden, modelId, submitter } = await deployFixture();
      const payload = buildPayload(golden);
      const contributors = golden.contributors.map((contributor) => ({ ...contributor }));
      const signatures = await attestMintRequest(deltaVerifier, attester, modelId, payload, contributors);
      const tampered = mutate({ modelId, payload, contributors });

      await expect(
        deltaVerifier
          .connect(submitter)
          .submitMintRequest(tampered.modelId, tampered.payload, tampered.contributors, signatures)
      ).to.be.revertedWithCustomError(deltaVerifier, "SignerNotAttester");
    });
  });
});
