const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const hre = require("hardhat");
const { createClient } = require("redis");

dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.sepolia", override: true });

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const DEFAULT_MODEL_ID = "27";
const DEFAULT_QUEUE = "hokusai:mint_requests";
const DEFAULT_PROCESSING_QUEUE = "hokusai:mint_requests:processing";
const DEFAULT_DLQ = "hokusai:mint_requests:dlq";
const DEFAULT_SETTLEMENT_QUEUE = "hokusai:mint_request_settlements";
const DEFAULT_PROCESSED_SET = "hokusai:mint_requests:processed";
const DEFAULT_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 5_000;

const ABIS = {
  modelRegistry: [
    "function owner() view returns (address)",
    "function registerModel(uint256 modelId,address token,string performanceMetric)",
    "function isRegistered(uint256 modelId) view returns (bool)",
    "function isModelActive(uint256 modelId) view returns (bool)",
    "function getTokenAddress(uint256 modelId) view returns (address)",
    "function getMetric(uint256 modelId) view returns (string)",
    "function modelsByString(string modelId) view returns (address tokenAddress,string performanceMetric,bool active)",
    "function isStringRegistered(string modelId) view returns (bool)",
    "function isStringActive(string modelId) view returns (bool)",
    "function getStringToken(string modelId) view returns (address)",
  ],
  tokenManager: [
    "function hasToken(string modelId) view returns (bool)",
    "function getTokenAddress(string modelId) view returns (address)",
  ],
  erc20: [
    "function balanceOf(address account) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
  ],
  deltaVerifier: [
    "function processedIdempotencyKeys(bytes32 idempotencyKey) view returns (bool)",
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors) payload,(address walletAddress,uint256 weight)[] contributors) returns (uint256)",
  ],
};

function parseArgs(argv) {
  const options = {
    modelId: process.env.E2E_MODEL_ID || DEFAULT_MODEL_ID,
    deploymentFile: process.env.E2E_DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE,
    redisUrl: process.env.REDIS_URL,
    queue: process.env.MINT_REQUEST_QUEUE || DEFAULT_QUEUE,
    processingQueue: process.env.MINT_REQUEST_PROCESSING_QUEUE || DEFAULT_PROCESSING_QUEUE,
    dlq: process.env.MINT_REQUEST_DLQ || DEFAULT_DLQ,
    settlementQueue: process.env.MINT_REQUEST_SETTLEMENT_QUEUE || DEFAULT_SETTLEMENT_QUEUE,
    processedSet: process.env.MINT_REQUEST_PROCESSED_SET || DEFAULT_PROCESSED_SET,
    timeoutMs: Number(process.env.E2E_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    live: process.env.LIVE_SEPOLIA_MINTREQUEST === "1",
    directOnchain: process.env.E2E_DIRECT_ONCHAIN === "1",
    fixNumericRegistration: process.env.E2E_FIX_NUMERIC_REGISTRATION === "1",
    json: process.env.E2E_JSON === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model-id") {
      options.modelId = argv[++i];
    } else if (arg === "--deployment-file") {
      options.deploymentFile = argv[++i];
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[++i]);
    } else if (arg === "--live") {
      options.live = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function printUsage() {
  console.log(`Sepolia MintRequest E2E smoke

Preflight only:
  npm run e2e:sepolia:mintrequest

Live mutating smoke:
  LIVE_SEPOLIA_MINTREQUEST=1 npm run e2e:sepolia:mintrequest

Useful env:
  E2E_MODEL_ID=27
  E2E_JSON=1
  E2E_TIMEOUT_MS=180000
  E2E_DIRECT_ONCHAIN=1
  E2E_FIX_NUMERIC_REGISTRATION=1
  REDIS_URL=rediss://...
`);
}

function loadDeployment(file) {
  return JSON.parse(fs.readFileSync(path.resolve(process.cwd(), file), "utf8"));
}

function requireAddress(label, value) {
  if (!value || !hre.ethers.isAddress(value)) {
    throw new Error(`Missing valid ${label} address`);
  }
  return hre.ethers.getAddress(value);
}

function bytes32(label) {
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label));
}

function makeMintRequest(modelId, runId, contributorAddresses) {
  const idempotencyKey = bytes32(`hokusai:sepolia:e2e:mintrequest:${modelId}:${runId}`);
  const attestationHash = bytes32(`attestation:${runId}`);
  const benchmarkSpecHash = bytes32(`benchmark-spec:${modelId}`);
  const datasetHash = bytes32(`dataset:${modelId}`);
  const [first, second] = contributorAddresses;

  return {
    message_type: "mint_request",
    schema_version: "1.0",
    message_id: `sepolia-e2e-${runId}`,
    timestamp: new Date().toISOString(),
    model_id: modelId,
    model_id_uint: modelId,
    eval_id: `sepolia-e2e-eval-${runId}`,
    attestation_hash: attestationHash,
    idempotency_key: idempotencyKey,
    benchmark_spec_id: benchmarkSpecHash,
    dataset_hash: datasetHash,
    totalSamples: 1000,
    evaluation: {
      metric_name: "sales_lead_scoring_accuracy",
      metric_family: "proportion",
      baseline_score_bps: 7800,
      new_score_bps: 8100,
      max_cost_usd_micro: 5_000_000,
      actual_cost_usd_micro: 2_340_000,
      sample_size_baseline: 1000,
      sample_size_candidate: 1000,
      ci_low_bps: 50,
      ci_high_bps: 550,
      p_value: 0.03,
      effect_size_bps: 300,
      statistical_method: "sepolia_e2e_smoke",
      statistical_reason: "accepted",
    },
    contributors: [
      { wallet_address: first, weight_bps: 7000 },
      { wallet_address: second, weight_bps: 3000 },
    ],
  };
}

function toContractPayload(message) {
  return {
    pipelineRunId: message.eval_id,
    baselineScoreBps: message.evaluation.baseline_score_bps,
    candidateScoreBps: message.evaluation.new_score_bps,
    maxCostUsdMicro: message.evaluation.max_cost_usd_micro,
    actualCostUsdMicro: message.evaluation.actual_cost_usd_micro,
    totalSamples: message.totalSamples,
    anchors: {
      benchmarkSpecHash: message.benchmark_spec_id || bytes32(message.model_id),
      datasetHash: message.dataset_hash || hre.ethers.ZeroHash,
      attestationHash: message.attestation_hash,
      idempotencyKey: message.idempotency_key,
      metricName: message.evaluation.metric_name,
      metricFamily: message.evaluation.metric_family,
    },
  };
}

function toContractContributors(message) {
  return message.contributors.map((contributor) => ({
    walletAddress: contributor.wallet_address,
    weight: contributor.weight_bps,
  }));
}

async function getQueueDepths(redis, options) {
  const entries = await Promise.all([
    options.queue,
    options.processingQueue,
    options.dlq,
    options.settlementQueue,
  ].map(async (queue) => [queue, await redis.lLen(queue)]));
  return Object.fromEntries(entries);
}

async function findSettlement(redis, settlementQueue, idempotencyKey) {
  const messages = await redis.lRange(settlementQueue, 0, 100);
  for (const raw of messages) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.idempotency_key === idempotencyKey) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON queue entries.
    }
  }
  return null;
}

async function findDlqEntry(redis, dlq, idempotencyKey) {
  const messages = await redis.lRange(dlq, 0, 100);
  for (const raw of messages) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed.originalMessage?.idempotency_key === idempotencyKey) {
        return parsed;
      }
    } catch {
      // Ignore non-JSON queue entries.
    }
  }
  return null;
}

async function pollForResult({ redis, deltaVerifier, options, idempotencyKey }) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const [settlement, dlqEntry, onChainProcessed, queueDepths] = await Promise.all([
      findSettlement(redis, options.settlementQueue, idempotencyKey),
      findDlqEntry(redis, options.dlq, idempotencyKey),
      deltaVerifier.processedIdempotencyKeys(idempotencyKey),
      getQueueDepths(redis, options),
    ]);

    if (settlement) {
      return { status: "settled", settlement, onChainProcessed, queueDepths };
    }

    if (dlqEntry) {
      return { status: "dlq", dlqEntry, onChainProcessed, queueDepths };
    }

    if (onChainProcessed) {
      return { status: "processed_without_settlement", onChainProcessed, queueDepths };
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return {
    status: "timeout",
    onChainProcessed: await deltaVerifier.processedIdempotencyKeys(idempotencyKey),
    queueDepths: await getQueueDepths(redis, options),
  };
}

async function connectRedis(options) {
  const redis = createClient({
    url: options.redisUrl,
    socket: {
      connectTimeout: 5_000,
      reconnectStrategy: false,
    },
  });
  redis.on("error", (error) => {
    if (process.env.E2E_VERBOSE_REDIS === "1") {
      console.error("Redis error:", error.message);
    }
  });
  await redis.connect();
  return redis;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const deployment = loadDeployment(options.deploymentFile);
  const contracts = deployment.contracts || {};
  const modelId = BigInt(options.modelId);
  const modelIdString = options.modelId;
  const [signer] = await hre.ethers.getSigners();

  const modelRegistryAddress = requireAddress("ModelRegistry", contracts.ModelRegistry);
  const tokenManagerAddress = requireAddress("TokenManager", contracts.TokenManager);
  const deltaVerifierAddress = requireAddress("DeltaVerifier", contracts.DeltaVerifier);

  const modelRegistry = new hre.ethers.Contract(modelRegistryAddress, ABIS.modelRegistry, signer);
  const tokenManager = new hre.ethers.Contract(tokenManagerAddress, ABIS.tokenManager, signer);
  const deltaVerifier = new hre.ethers.Contract(deltaVerifierAddress, ABIS.deltaVerifier, signer);

  if (options.fixNumericRegistration && !(await modelRegistry.isRegistered(modelId))) {
    const [owner, stringModel, tokenManagerHasToken, tokenManagerToken] = await Promise.all([
      modelRegistry.owner(),
      modelRegistry.modelsByString(modelIdString),
      tokenManager.hasToken(modelIdString),
      tokenManager.getTokenAddress(modelIdString).catch(() => ZERO_ADDRESS),
    ]);
    const stringToken = stringModel.tokenAddress || stringModel[0];
    const stringMetric = stringModel.performanceMetric || stringModel[1] || "sales_lead_scoring_accuracy";
    const stringActive = stringModel.active ?? stringModel[2];

    if (hre.ethers.getAddress(owner) !== hre.ethers.getAddress(signer.address)) {
      throw new Error(`Signer ${signer.address} is not ModelRegistry owner ${owner}`);
    }
    if (!tokenManagerHasToken || tokenManagerToken === ZERO_ADDRESS) {
      throw new Error(`TokenManager has no token for model ${modelIdString}`);
    }
    if (!stringActive || stringToken === ZERO_ADDRESS) {
      throw new Error(`String model ${modelIdString} is not active or has no token`);
    }
    if (hre.ethers.getAddress(stringToken) !== hre.ethers.getAddress(tokenManagerToken)) {
      throw new Error(`String registry token ${stringToken} differs from TokenManager token ${tokenManagerToken}`);
    }

    console.log(`Registering numeric model ${modelIdString} -> ${tokenManagerToken} (${stringMetric})`);
    const tx = await modelRegistry.registerModel(modelId, tokenManagerToken, stringMetric);
    console.log(`Numeric registration tx: ${tx.hash}`);
    await tx.wait(1);
  }

  const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const message = makeMintRequest(modelIdString, runId, [
    signer.address,
    "0x742d35cc6634c0532925a3b844bc9e7595f62341",
  ]);
  const payload = toContractPayload(message);
  const contributors = toContractContributors(message);

  const [
    numericRegistered,
    numericActive,
    numericToken,
    metric,
    stringRegistered,
    stringActive,
    tokenManagerHasToken,
    tokenManagerToken,
    alreadyProcessed,
  ] = await Promise.all([
    modelRegistry.isRegistered(modelId),
    modelRegistry.isModelActive(modelId),
    modelRegistry.getTokenAddress(modelId).catch(() => ZERO_ADDRESS),
    modelRegistry.getMetric(modelId).catch(() => null),
    modelRegistry.isStringRegistered(modelIdString),
    modelRegistry.isStringActive(modelIdString),
    tokenManager.hasToken(modelIdString),
    tokenManager.getTokenAddress(modelIdString).catch(() => ZERO_ADDRESS),
    deltaVerifier.processedIdempotencyKeys(message.idempotency_key),
  ]);

  const preflight = {
    modelId: modelIdString,
    signer: signer.address,
    idempotencyKey: message.idempotency_key,
    numericRegistered,
    numericActive,
    numericToken,
    metric,
    stringRegistered,
    stringActive,
    tokenManagerHasToken,
    tokenManagerToken,
    alreadyProcessed,
  };

  const failures = [];
  if (!numericRegistered) failures.push("numeric model is not registered");
  if (!numericActive) failures.push("numeric model is not active");
  if (!stringRegistered) failures.push("string model is not registered");
  if (!stringActive) failures.push("string model is not active");
  if (!tokenManagerHasToken) failures.push("TokenManager has no token for model");
  if (numericToken === ZERO_ADDRESS) failures.push("numeric registry token is zero");
  if (tokenManagerToken === ZERO_ADDRESS) failures.push("TokenManager token is zero");
  if (numericToken !== ZERO_ADDRESS && tokenManagerToken !== ZERO_ADDRESS) {
    if (hre.ethers.getAddress(numericToken) !== hre.ethers.getAddress(tokenManagerToken)) {
      failures.push("numeric registry token and TokenManager token differ");
    }
  }
  if (alreadyProcessed) failures.push("generated idempotency key is already processed");

  let staticCallReward = null;
  if (failures.length === 0) {
    staticCallReward = await deltaVerifier.submitMintRequest.staticCall(modelId, payload, contributors);
  }

  const result = {
    ok: failures.length === 0,
    mode: options.live ? "live" : options.directOnchain ? "direct-onchain" : "preflight",
    preflight,
    staticCallReward: staticCallReward?.toString() || null,
    failures,
    message,
  };

  if (failures.length > 0) {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("MintRequest preflight failed:");
      failures.forEach((failure) => console.log(`FAIL ${failure}`));
      console.log(JSON.stringify(preflight, null, 2));
    }
    process.exit(1);
  }

  if (!options.live && !options.directOnchain) {
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("MintRequest preflight passed");
      console.log(`Model: ${modelIdString}`);
      console.log(`Token: ${tokenManagerToken}`);
      console.log(`Static reward: ${staticCallReward}`);
      console.log("Set LIVE_SEPOLIA_MINTREQUEST=1 to publish this test to Redis.");
    }
    return;
  }

  const token = new hre.ethers.Contract(tokenManagerToken, ABIS.erc20, signer);
  const beforeBalances = await Promise.all(
    contributors.map((contributor) => token.balanceOf(contributor.walletAddress)),
  );

  if (options.directOnchain) {
    const tx = await deltaVerifier.submitMintRequest(modelId, payload, contributors);
    const receipt = await tx.wait(1);
    const afterBalances = await Promise.all(
      contributors.map((contributor) => token.balanceOf(contributor.walletAddress)),
    );
    const processed = await deltaVerifier.processedIdempotencyKeys(message.idempotency_key);

    result.directOnchain = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      processed,
      token: tokenManagerToken,
      balances: contributors.map((contributor, index) => ({
        walletAddress: contributor.walletAddress,
        before: beforeBalances[index].toString(),
        after: afterBalances[index].toString(),
        delta: (afterBalances[index] - beforeBalances[index]).toString(),
      })),
    };
    result.ok = receipt.status === 1 && processed;

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log("Direct on-chain MintRequest submitted");
      console.log(`Tx: ${receipt.hash}`);
      console.log(`Block: ${receipt.blockNumber}`);
      console.log(`On-chain processed: ${processed}`);
      console.log("Balance deltas:");
      result.directOnchain.balances.forEach((balance) => {
        console.log(`  ${balance.walletAddress}: ${balance.delta}`);
      });
    }

    if (!result.ok) {
      process.exitCode = 1;
    }

    return;
  }

  if (!options.redisUrl) {
    throw new Error("REDIS_URL is required for live MintRequest smoke");
  }

  const redis = await connectRedis(options);

  try {
    const queueDepthsBefore = await getQueueDepths(redis, options);
    await redis.lPush(options.queue, JSON.stringify(message));
    const pollResult = await pollForResult({
      redis,
      deltaVerifier,
      options,
      idempotencyKey: message.idempotency_key,
    });
    const afterBalances = await Promise.all(
      contributors.map((contributor) => token.balanceOf(contributor.walletAddress)),
    );

    result.live = {
      queue: options.queue,
      queueDepthsBefore,
      pollResult,
      token: tokenManagerToken,
      balances: contributors.map((contributor, index) => ({
        walletAddress: contributor.walletAddress,
        before: beforeBalances[index].toString(),
        after: afterBalances[index].toString(),
        delta: (afterBalances[index] - beforeBalances[index]).toString(),
      })),
    };
    result.ok = pollResult.status === "settled" && pollResult.settlement?.status === "minted";

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`MintRequest live result: ${pollResult.status}`);
      if (pollResult.settlement) {
        console.log(`Settlement status: ${pollResult.settlement.status}`);
        console.log(`Tx: ${pollResult.settlement.tx_hash}`);
        console.log(`Reward: ${pollResult.settlement.reward_amount}`);
      }
      if (pollResult.dlqEntry) {
        console.log(`DLQ error: ${pollResult.dlqEntry.error}`);
      }
      console.log(`On-chain processed: ${pollResult.onChainProcessed}`);
      console.log("Balance deltas:");
      result.live.balances.forEach((balance) => {
        console.log(`  ${balance.walletAddress}: ${balance.delta}`);
      });
    }

    if (!result.ok) {
      process.exitCode = 1;
    }
  } finally {
    await redis.quit();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
