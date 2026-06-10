const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MODEL_MAPPINGS = (
  process.env.E2E_TOKEN_MODELS || "HMESS:28,HLEAD:27,HROUT:30"
)
  .split(",")
  .map((entry) => {
    const [symbol, modelId] = entry.split(":").map((part) => part.trim());
    return { symbol, modelId };
  });
const DEPLOYMENT_FILE =
  process.env.E2E_DEPLOYMENT_FILE || "deployments/sepolia-latest.json";
const RUN_READ_ONLY =
  process.env.SEPOLIA_E2E === "1" || process.env.SEPOLIA_E2E_READONLY === "1";
const RUN_WRITE = process.env.SEPOLIA_E2E_WRITE === "1";
const WRITE_MODEL_ID =
  process.env.E2E_MODEL_ID || MODEL_MAPPINGS[0]?.modelId || "27";
const FIXED_SECOND_CONTRIBUTOR = "0x742d35cc6634c0532925a3b844bc9e7595f62341";

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
    "event DeltaOneAccepted(uint256 indexed modelId,bytes32 indexed idempotencyKey,bytes32 indexed benchmarkSpecHash,bytes32 attestationHash,bytes32 datasetHash,string metricName,string metricFamily,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 rewardAmount,string pipelineRunId)",
    "function processedIdempotencyKeys(bytes32 idempotencyKey) view returns (bool)",
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors) payload,(address walletAddress,uint256 weight)[] contributors,bytes[] attesterSignatures) returns (uint256)",
  ],
  ammFactory: [
    "function getPool(string modelId) view returns (address)",
    "function poolCount() view returns (uint256)",
  ],
  ammPool: ["function purchaserWhitelist() view returns (address)"],
  erc20: [
    "function balanceOf(address account) view returns (uint256)",
    "function totalSupply() view returns (uint256)",
    "function symbol() view returns (string)",
  ],
};

// HOK-2132: EIP-712 typed-data definition for the attester signature now required
// by DeltaVerifier.submitMintRequest. Mirrors the contract's struct hashing.
const MINT_REQUEST_EIP712_TYPES = {
  MintRequest: [
    { name: "modelId", type: "uint256" },
    { name: "payload", type: "MintRequestPayload" },
    { name: "contributors", type: "Contributor[]" },
  ],
  MintRequestPayload: [
    { name: "pipelineRunId", type: "string" },
    { name: "baselineScoreBps", type: "uint256" },
    { name: "candidateScoreBps", type: "uint256" },
    { name: "maxCostUsdMicro", type: "uint256" },
    { name: "actualCostUsdMicro", type: "uint256" },
    { name: "totalSamples", type: "uint256" },
    { name: "anchors", type: "BenchmarkAnchors" },
  ],
  BenchmarkAnchors: [
    { name: "benchmarkSpecHash", type: "bytes32" },
    { name: "datasetHash", type: "bytes32" },
    { name: "attestationHash", type: "bytes32" },
    { name: "idempotencyKey", type: "bytes32" },
    { name: "metricName", type: "string" },
    { name: "metricFamily", type: "string" },
  ],
  Contributor: [
    { name: "walletAddress", type: "address" },
    { name: "weight", type: "uint256" },
  ],
};

// HOK-2132: sign the typed MintRequest with a registered attester key and return
// the bytes[] attesterSignatures argument for submitMintRequest (single-key setup).
async function signMintRequestAttestation({
  attester,
  deltaVerifierAddress,
  chainId,
  modelId,
  payload,
  contributors,
}) {
  const domain = {
    name: "HokusaiDeltaVerifier",
    version: "1",
    chainId,
    verifyingContract: deltaVerifierAddress,
  };
  const signature = await attester.signTypedData(
    domain,
    MINT_REQUEST_EIP712_TYPES,
    { modelId, payload, contributors }
  );
  return [signature];
}

function describeSepolia(name, fn) {
  return RUN_READ_ONLY ? describe(name, fn) : describe.skip(name, fn);
}

function describeSepoliaWrite(name, fn) {
  return RUN_WRITE ? describe(name, fn) : describe.skip(name, fn);
}

function loadDeployment() {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), DEPLOYMENT_FILE), "utf8")
  );
}

function hash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function buildMintRequestFixture(modelId, signerAddress) {
  const idempotencyKey = hash(
    `hokusai:sepolia:e2e:test:${modelId}:${Date.now()}`
  );
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
      {
        walletAddress: "0x742d35cc6634c0532925a3b844bc9e7595f62341",
        weight: 3000,
      },
    ],
    idempotencyKey,
  };
}

function buildWriteMintRequestFixture({
  modelId,
  signerAddress,
  blockNumber,
  runSeed,
}) {
  const pipelineRunId = `sepolia-write-${modelId}-${runSeed}-${blockNumber}`;
  const idempotencyKey = ethers.keccak256(
    ethers.solidityPacked(
      ["uint256", "string", "address"],
      [BigInt(blockNumber), pipelineRunId, signerAddress]
    )
  );

  return {
    modelId: BigInt(modelId),
    payload: {
      pipelineRunId,
      baselineScoreBps: 7800,
      candidateScoreBps: 8100,
      maxCostUsdMicro: 5_000_000,
      actualCostUsdMicro: 2_340_000,
      totalSamples: 1000,
      anchors: {
        benchmarkSpecHash: hash(`benchmark-spec:${modelId}`),
        datasetHash: hash(`dataset:${modelId}`),
        attestationHash: hash(`attestation:${pipelineRunId}`),
        idempotencyKey,
        metricName: "sales_lead_scoring_accuracy",
        metricFamily: "proportion",
      },
    },
    contributors: [
      { walletAddress: signerAddress, weight: 7000 },
      { walletAddress: FIXED_SECOND_CONTRIBUTOR, weight: 3000 },
    ],
    idempotencyKey,
  };
}

function parseContractEvents(receipt, contract, eventName) {
  return receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed && parsed.name === eventName);
}

describeSepolia("Sepolia end-to-end launch preconditions", function () {
  this.timeout(60_000);

  let deployment;
  let contracts;
  let signer;
  let chainId;
  let modelRegistry;
  let tokenManager;
  let deltaVerifier;
  let ammFactory;

  before(async function () {
    deployment = loadDeployment();
    contracts = deployment.contracts;
    [signer] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    modelRegistry = new ethers.Contract(
      contracts.ModelRegistry,
      ABIS.modelRegistry,
      signer
    );
    tokenManager = new ethers.Contract(
      contracts.TokenManager,
      ABIS.tokenManager,
      signer
    );
    deltaVerifier = new ethers.Contract(
      contracts.DeltaVerifier,
      ABIS.deltaVerifier,
      signer
    );
    ammFactory = new ethers.Contract(
      contracts.HokusaiAMMFactory,
      ABIS.ammFactory,
      signer
    );
  });

  MODEL_MAPPINGS.forEach(({ symbol: expectedSymbol, modelId }) => {
    it(`keeps canonical registration aligned for ${expectedSymbol} / ${modelId}`, async function () {
      const numericRegistered = await modelRegistry.isRegistered(modelId);
      const numericActive = await modelRegistry.isModelActive(modelId);
      const stringRegistered = await modelRegistry.isStringRegistered(modelId);
      const stringActive = await modelRegistry.isStringActive(modelId);
      const tokenManagerHasToken = await tokenManager.hasToken(modelId);

      expect(numericRegistered, "numeric ModelRegistry registration").to.equal(
        true
      );
      expect(numericActive, "numeric ModelRegistry active flag").to.equal(true);
      expect(stringRegistered, "string ModelRegistry registration").to.equal(
        true
      );
      expect(stringActive, "string ModelRegistry active flag").to.equal(true);
      expect(tokenManagerHasToken, "TokenManager token mapping").to.equal(true);

      const numericToken = await modelRegistry.getTokenAddress(modelId);
      const stringToken = await modelRegistry.getStringToken(modelId);
      const managerToken = await tokenManager.getTokenAddress(modelId);

      expect(numericToken).to.not.equal(ZERO_ADDRESS);
      expect(ethers.getAddress(numericToken)).to.equal(
        ethers.getAddress(managerToken)
      );
      expect(ethers.getAddress(stringToken)).to.equal(
        ethers.getAddress(managerToken)
      );
    });

    it(`accepts MintRequest static-call shape for ${expectedSymbol} / ${modelId}`, async function () {
      const fixture = buildMintRequestFixture(modelId, signer.address);
      const processed = await deltaVerifier.processedIdempotencyKeys(
        fixture.idempotencyKey
      );
      expect(processed).to.equal(false);

      const attesterSignatures = await signMintRequestAttestation({
        attester: signer,
        deltaVerifierAddress: contracts.DeltaVerifier,
        chainId,
        modelId: fixture.modelId,
        payload: fixture.payload,
        contributors: fixture.contributors,
      });
      const reward = await deltaVerifier.submitMintRequest.staticCall(
        fixture.modelId,
        fixture.payload,
        fixture.contributors,
        attesterSignatures
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
      const [symbol, totalSupply] = await Promise.all([
        token.symbol(),
        token.totalSupply(),
      ]);

      expect(symbol).to.be.a("string").and.not.equal("");
      expect(totalSupply).to.be.greaterThan(0n);
    });

    it(`uses the shared purchaser whitelist for ${expectedSymbol} / ${modelId}`, async function () {
      const poolAddress = await ammFactory.getPool(modelId);
      const pool = new ethers.Contract(poolAddress, ABIS.ammPool, signer);
      const poolWhitelist = await pool.purchaserWhitelist();

      expect(poolWhitelist).to.not.equal(ZERO_ADDRESS);
      expect(ethers.getAddress(poolWhitelist)).to.equal(
        ethers.getAddress(contracts.PurchaserWhitelist)
      );
    });
  });
});

describeSepoliaWrite("Sepolia live MintRequest write mode", function () {
  this.timeout(180_000);

  let deployment;
  let contracts;
  let signer;
  let chainId;
  let tokenManager;
  let deltaVerifier;
  let token;
  let fixture;
  let attesterSignatures;
  let postMintBalances;

  before(async function () {
    deployment = loadDeployment();
    contracts = deployment.contracts;
    [signer] = await ethers.getSigners();
    chainId = (await ethers.provider.getNetwork()).chainId;

    tokenManager = new ethers.Contract(
      contracts.TokenManager,
      ABIS.tokenManager,
      signer
    );
    deltaVerifier = new ethers.Contract(
      contracts.DeltaVerifier,
      ABIS.deltaVerifier,
      signer
    );

    const tokenAddress = await tokenManager.getTokenAddress(WRITE_MODEL_ID);
    token = new ethers.Contract(tokenAddress, ABIS.erc20, signer);
  });

  it(`submits a live MintRequest for model ${WRITE_MODEL_ID} and burns on-chain idempotency`, async function () {
    const blockNumber = await ethers.provider.getBlockNumber();
    const runSeed =
      process.env.GITHUB_RUN_ID ||
      process.env.GITHUB_SHA?.slice(0, 12) ||
      process.env.CI_PIPELINE_ID ||
      `local-${process.pid}`;

    fixture = buildWriteMintRequestFixture({
      modelId: WRITE_MODEL_ID,
      signerAddress: signer.address,
      blockNumber,
      runSeed,
    });

    const beforeBalances = await Promise.all(
      fixture.contributors.map((contributor) =>
        token.balanceOf(contributor.walletAddress)
      )
    );
    expect(
      await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey)
    ).to.equal(false);

    attesterSignatures = await signMintRequestAttestation({
      attester: signer,
      deltaVerifierAddress: contracts.DeltaVerifier,
      chainId,
      modelId: fixture.modelId,
      payload: fixture.payload,
      contributors: fixture.contributors,
    });

    const staticReward = await deltaVerifier.submitMintRequest.staticCall(
      fixture.modelId,
      fixture.payload,
      fixture.contributors,
      attesterSignatures
    );
    expect(staticReward).to.be.greaterThan(0n);

    // HOK-2132: requires the redeployed DeltaVerifier with an attester registered (addAttester + setAttesterThreshold). Until then write-mode mints fail-closed.
    const tx = await deltaVerifier.submitMintRequest(
      fixture.modelId,
      fixture.payload,
      fixture.contributors,
      attesterSignatures
    );
    const receipt = await tx.wait(1);
    const deltaOneEvents = parseContractEvents(
      receipt,
      deltaVerifier,
      "DeltaOneAccepted"
    );
    postMintBalances = await Promise.all(
      fixture.contributors.map((contributor) =>
        token.balanceOf(contributor.walletAddress)
      )
    );

    expect(receipt.status).to.equal(1);
    expect(deltaOneEvents.length).to.equal(1);
    expect(deltaOneEvents[0].args.idempotencyKey).to.equal(
      fixture.idempotencyKey
    );
    expect(deltaOneEvents[0].args.rewardAmount).to.be.greaterThan(0n);
    expect(
      await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey)
    ).to.equal(true);

    postMintBalances.forEach((balance, index) => {
      expect(
        balance,
        `contributor ${index + 1} balance should increase after mint`
      ).to.be.greaterThan(beforeBalances[index]);
    });
  });

  it(`rejects replay for live MintRequest model ${WRITE_MODEL_ID}`, async function () {
    expect(
      fixture,
      "live MintRequest fixture must be created by the happy-path test"
    ).to.exist;
    expect(
      postMintBalances,
      "post-mint balances must be captured by the happy-path test"
    ).to.exist;

    let replayError = null;
    try {
      await deltaVerifier.submitMintRequest.estimateGas(
        fixture.modelId,
        fixture.payload,
        fixture.contributors,
        attesterSignatures
      );
    } catch (error) {
      replayError = error;
    }

    if (replayError !== null) {
      expect(String(replayError.message || replayError)).to.include(
        "Idempotency key already processed"
      );
    } else {
      // HOK-2132: requires the redeployed DeltaVerifier with an attester registered (addAttester + setAttesterThreshold). Until then write-mode mints fail-closed.
      const tx = await deltaVerifier.submitMintRequest(
        fixture.modelId,
        fixture.payload,
        fixture.contributors,
        attesterSignatures
      );
      const receipt = await tx.wait(1);
      const replayEvents = parseContractEvents(
        receipt,
        deltaVerifier,
        "DeltaOneAccepted"
      );
      const replayBalances = await Promise.all(
        fixture.contributors.map((contributor) =>
          token.balanceOf(contributor.walletAddress)
        )
      );

      expect(receipt.status).to.equal(1);
      expect(replayEvents.length).to.equal(0);
      replayBalances.forEach((balance, index) => {
        expect(balance).to.equal(postMintBalances[index]);
      });
    }

    expect(
      await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey)
    ).to.equal(true);
  });
});
