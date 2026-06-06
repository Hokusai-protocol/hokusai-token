const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MODEL_MAPPINGS = (process.env.E2E_TOKEN_MODELS || "HMESS:28,HLEAD:27,HROUT:30")
  .split(",")
  .map((entry) => {
    const [symbol, modelId] = entry.split(":").map((part) => part.trim());
    return { symbol, modelId };
  });
const DEPLOYMENT_FILE = process.env.E2E_DEPLOYMENT_FILE || "deployments/sepolia-latest.json";
const RUN_READ_ONLY = process.env.SEPOLIA_E2E === "1" || process.env.SEPOLIA_E2E_READONLY === "1";

const ABIS = {
  modelRegistry: [
    "function isRegistered(uint256 modelId) view returns (bool)",
    "function isModelActive(uint256 modelId) view returns (bool)",
    "function getTokenAddress(uint256 modelId) view returns (address)",
    "function getMetric(uint256 modelId) view returns (string)",
    "function isStringRegistered(string modelId) view returns (bool)",
    "function isStringActive(string modelId) view returns (bool)",
    "function getStringToken(string modelId) view returns (address)",
  ],
  tokenManager: [
    "function hasToken(string modelId) view returns (bool)",
    "function getTokenAddress(string modelId) view returns (address)",
    "function burnAMMTokens(string modelId, address account, uint256 amount)",
  ],
  deltaVerifier: [
    "function processedIdempotencyKeys(bytes32 idempotencyKey) view returns (bool)",
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors) payload,(address walletAddress,uint256 weight)[] contributors) returns (uint256)",
  ],
  ammFactory: [
    "function getPool(string modelId) view returns (address)",
    "function poolCount() view returns (uint256)",
  ],
  ammPool: [
    "function purchaserWhitelist() view returns (address)",
  ],
  erc20: [
    "function balanceOf(address account) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function symbol() view returns (string)",
  ],
};

function describeSepolia(name, fn) {
  return RUN_READ_ONLY ? describe(name, fn) : describe.skip(name, fn);
}

function loadDeployment() {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), DEPLOYMENT_FILE), "utf8"));
}

function hash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function buildMintRequestFixture(modelId, signerAddress) {
  const idempotencyKey = hash(`hokusai:sepolia:e2e:test:${modelId}:${Date.now()}`);
  return {
    modelId: BigInt(modelId),
    payload: {
      pipelineRunId: `sepolia-e2e-static-${Date.now()}`,
      baselineScoreBps: 7800,
      candidateScoreBps: 8100,
      maxCostUsdMicro: 5_000_000,
      actualCostUsdMicro: 2_340_000,
      totalSamples: 1000,
      anchors: {
        benchmarkSpecHash: hash(`benchmark-spec:${modelId}`),
        datasetHash: hash(`dataset:${modelId}`),
        attestationHash: hash(`attestation:${modelId}:${Date.now()}`),
        idempotencyKey,
        metricName: "sales_lead_scoring_accuracy",
        metricFamily: "proportion",
      },
    },
    contributors: [
      { walletAddress: signerAddress, weight: 7000 },
      { walletAddress: "0x742d35cc6634c0532925a3b844bc9e7595f62341", weight: 3000 },
    ],
    idempotencyKey,
  };
}

describeSepolia("Sepolia end-to-end launch preconditions", function () {
  this.timeout(60_000);

  let deployment;
  let contracts;
  let signer;
  let modelRegistry;
  let tokenManager;
  let deltaVerifier;
  let ammFactory;

  before(async function () {
    deployment = loadDeployment();
    contracts = deployment.contracts;
    [signer] = await ethers.getSigners();

    modelRegistry = new ethers.Contract(contracts.ModelRegistry, ABIS.modelRegistry, signer);
    tokenManager = new ethers.Contract(contracts.TokenManager, ABIS.tokenManager, signer);
    deltaVerifier = new ethers.Contract(contracts.DeltaVerifier, ABIS.deltaVerifier, signer);
    ammFactory = new ethers.Contract(contracts.HokusaiAMMFactory, ABIS.ammFactory, signer);
  });

  MODEL_MAPPINGS.forEach(({ symbol: expectedSymbol, modelId }) => {
    it(`keeps canonical registration aligned for ${expectedSymbol} / ${modelId}`, async function () {
      const numericRegistered = await modelRegistry.isRegistered(modelId);
      const numericActive = await modelRegistry.isModelActive(modelId);
      const stringRegistered = await modelRegistry.isStringRegistered(modelId);
      const stringActive = await modelRegistry.isStringActive(modelId);
      const tokenManagerHasToken = await tokenManager.hasToken(modelId);

      expect(numericRegistered, "numeric ModelRegistry registration").to.equal(true);
      expect(numericActive, "numeric ModelRegistry active flag").to.equal(true);
      expect(stringRegistered, "string ModelRegistry registration").to.equal(true);
      expect(stringActive, "string ModelRegistry active flag").to.equal(true);
      expect(tokenManagerHasToken, "TokenManager token mapping").to.equal(true);

      const numericToken = await modelRegistry.getTokenAddress(modelId);
      const stringToken = await modelRegistry.getStringToken(modelId);
      const managerToken = await tokenManager.getTokenAddress(modelId);

      expect(numericToken).to.not.equal(ZERO_ADDRESS);
      expect(ethers.getAddress(numericToken)).to.equal(ethers.getAddress(managerToken));
      expect(ethers.getAddress(stringToken)).to.equal(ethers.getAddress(managerToken));
    });

    it(`accepts MintRequest static-call shape for ${expectedSymbol} / ${modelId}`, async function () {
      const fixture = buildMintRequestFixture(modelId, signer.address);
      const processed = await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey);
      expect(processed).to.equal(false);

      const reward = await deltaVerifier.submitMintRequest.staticCall(
        fixture.modelId,
        fixture.payload,
        fixture.contributors,
      );
      expect(reward).to.be.greaterThan(0n);
    });

    it(`has an AMM pool and live token for ${expectedSymbol} / ${modelId}`, async function () {
      const pool = await ammFactory.getPool(modelId);
      expect(pool, "AMM pool for model").to.not.equal(ZERO_ADDRESS);

      const poolCount = await ammFactory.poolCount();
      expect(poolCount).to.be.greaterThan(0n);

      const tokenAddress = await tokenManager.getTokenAddress(modelId);
      const token = new ethers.Contract(tokenAddress, ABIS.erc20, signer);
      const [symbol, totalSupply] = await Promise.all([token.symbol(), token.totalSupply()]);

      expect(symbol).to.be.a("string").and.not.equal("");
      expect(totalSupply).to.be.greaterThan(0n);
    });

    it(`uses the shared purchaser whitelist for ${expectedSymbol} / ${modelId}`, async function () {
      const poolAddress = await ammFactory.getPool(modelId);
      const pool = new ethers.Contract(poolAddress, ABIS.ammPool, signer);
      const poolWhitelist = await pool.purchaserWhitelist();

      expect(poolWhitelist).to.not.equal(ZERO_ADDRESS);
      expect(ethers.getAddress(poolWhitelist)).to.equal(ethers.getAddress(contracts.PurchaserWhitelist));
    });
  });
});
