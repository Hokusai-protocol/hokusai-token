const { expect } = require("chai");
const { KMSClient } = require("@aws-sdk/client-kms");
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
const WRITE_MODEL_ID = process.env.E2E_MODEL_ID || "30";
const FIXED_SECOND_CONTRIBUTOR = "0x742d35cc6634c0532925a3b844bc9e7595f62341";
const WRITE_KMS_ENV_VARS = [
  "KMS_DEPLOYER_KEY_ID",
  "KMS_DEPLOYER_EXPECTED_ADDRESS",
  "KMS_BACKEND_KEY_ID",
  "KMS_BACKEND_EXPECTED_ADDRESS",
];

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
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors,bytes32 baselineCommitment,bytes32 candidateCommitment) payload,(address walletAddress,uint256 weight)[] contributors,bytes[] attesterSignatures) returns (uint256)",
    "function currentModelHead(uint256 modelId) view returns (bytes32)",
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
    { name: "baselineCommitment", type: "bytes32" },
    { name: "candidateCommitment", type: "bytes32" },
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
  if (RUN_WRITE && !hasRequiredWriteKmsEnv()) {
    console.warn(
      `Skipping ${name}: missing required KMS env (${missingWriteKmsEnv().join(", ")})`
    );
  }
  return RUN_WRITE && hasRequiredWriteKmsEnv() ? describe(name, fn) : describe.skip(name, fn);
}

function loadDeployment() {
  return JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), DEPLOYMENT_FILE), "utf8")
  );
}

function hash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

function loadKmsSignerClass() {
  try {
    return require("../../services/contract-deployer/dist/blockchain/kms-signer").KmsSigner;
  } catch (error) {
    throw new Error(
      "KMS signer support requires services/contract-deployer to be built first: run npm --prefix services/contract-deployer run build"
    );
  }
}

function missingWriteKmsEnv() {
  return WRITE_KMS_ENV_VARS.filter((name) => !process.env[name]);
}

function hasRequiredWriteKmsEnv() {
  return missingWriteKmsEnv().length === 0;
}

async function loadKmsSigner({ keyIdEnv, expectedAddressEnv }) {
  const keyId = process.env[keyIdEnv];
  const expectedAddress = process.env[expectedAddressEnv];
  if (!keyId || !expectedAddress) {
    throw new Error(`Missing ${keyIdEnv} or ${expectedAddressEnv}`);
  }

  const KmsSigner = loadKmsSignerClass();
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId,
    provider: ethers.provider,
  });
  const derivedAddress = ethers.getAddress(await signer.getAddress());
  const expected = ethers.getAddress(expectedAddress);
  if (derivedAddress !== expected) {
    throw new Error(
      `KMS signer address pin mismatch for ${keyIdEnv}: derived=${derivedAddress}, expected=${expected}, alias=${keyId}`
    );
  }

  return signer;
}

async function loadKmsAttesterSigner() {
  return loadKmsSigner({
    keyIdEnv: "KMS_DEPLOYER_KEY_ID",
    expectedAddressEnv: "KMS_DEPLOYER_EXPECTED_ADDRESS",
  });
}

async function loadKmsSubmitterSigner() {
  return loadKmsSigner({
    keyIdEnv: "KMS_BACKEND_KEY_ID",
    expectedAddressEnv: "KMS_BACKEND_EXPECTED_ADDRESS",
  });
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
      // HOK-2133: read-only/static fixture; lineage commitments are placeholders. Real values
      // come from the pipeline message in HOK-2134/HOK-2136.
      baselineCommitment: ethers.ZeroHash,
      candidateCommitment: hash(`candidate:${modelId}:${Date.now()}`),
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
  baselineCommitment,
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
      // HOK-2133: write-mode lineage requires baselineCommitment == the model's current on-chain
      // head (read via DeltaVerifier.currentModelHead) and a fresh unique candidateCommitment. This
      // also requires the deployed contract to have a genesis seeded
      // (ModelRegistry.setWeightGenesis); without it submitMintRequest fail-closes — the same safe
      // pre-launch state noted for the attester/budget preconditions.
      baselineCommitment,
      candidateCommitment: ethers.id(`candidate-${Date.now()}`),
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
  let attesterSigner;
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
    attesterSigner = hasRequiredWriteKmsEnv()
      ? await loadKmsAttesterSigner()
      : signer;

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
        attester: attesterSigner,
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
  let attesterSigner;
  let submitterSigner;
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
    chainId = (await ethers.provider.getNetwork()).chainId;
    attesterSigner = await loadKmsAttesterSigner();
    submitterSigner = await loadKmsSubmitterSigner();

    expect(await attesterSigner.getAddress()).to.not.equal(
      await submitterSigner.getAddress()
    );

    tokenManager = new ethers.Contract(
      contracts.TokenManager,
      ABIS.tokenManager,
      submitterSigner
    );
    deltaVerifier = new ethers.Contract(
      contracts.DeltaVerifier,
      ABIS.deltaVerifier,
      submitterSigner
    );

    const tokenAddress = await tokenManager.getTokenAddress(WRITE_MODEL_ID);
    token = new ethers.Contract(tokenAddress, ABIS.erc20, submitterSigner);
  });

  it(`submits a live MintRequest for model ${WRITE_MODEL_ID} and burns on-chain idempotency`, async function () {
    const blockNumber = await ethers.provider.getBlockNumber();
    const runSeed =
      process.env.GITHUB_RUN_ID ||
      process.env.GITHUB_SHA?.slice(0, 12) ||
      process.env.CI_PIPELINE_ID ||
      `local-${process.pid}`;

    // HOK-2133: write-mode baselineCommitment must equal the model's current on-chain head.
    const baselineCommitment = await deltaVerifier.currentModelHead(
      BigInt(WRITE_MODEL_ID)
    );

    fixture = buildWriteMintRequestFixture({
      modelId: WRITE_MODEL_ID,
      signerAddress: await submitterSigner.getAddress(),
      blockNumber,
      runSeed,
      baselineCommitment,
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
      attester: attesterSigner,
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
