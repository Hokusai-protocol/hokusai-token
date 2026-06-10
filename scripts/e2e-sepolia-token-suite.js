const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const DEFAULT_HEALTH_BASE_URL = "https://contracts.hokus.ai";
const DEFAULT_TARGET_SYMBOLS = ["HMESS", "HLEAD", "HROUT"];
const DEFAULT_TOKEN_MODELS = "HMESS:28,HLEAD:27,HROUT:30";
const DEFAULT_SCAN_START = 1;
const DEFAULT_SCAN_END = 200;
const DEFAULT_BUY_AMOUNT_USDC = "1";
const DEFAULT_TOKEN_TARGET_BUY_AMOUNT = "30000";
const DEFAULT_GRADUATION_BUFFER_USDC = "10";
const DEFAULT_SELL_AMOUNT_TOKENS = "100";
const REQUEST_TIMEOUT_MS = 10_000;

const ABIS = {
  modelRegistry: [
    "function isRegistered(uint256 modelId) view returns (bool)",
    "function isModelActive(uint256 modelId) view returns (bool)",
    "function getTokenAddress(uint256 modelId) view returns (address)",
    "function getMetric(uint256 modelId) view returns (string)",
    "function isStringRegistered(string modelId) view returns (bool)",
    "function isStringActive(string modelId) view returns (bool)",
    "function getStringToken(string modelId) view returns (address)",
    "function getPool(string modelId) view returns (address)",
  ],
  tokenManager: [
    "event TokenDeployed(string indexed modelId,address indexed tokenAddress,address indexed deployer,string name,string symbol,uint256 totalSupply)",
    "event RewardVestingCreated(string indexed modelId,address indexed contributor,uint256 totalReward,uint256 immediateAmount,uint256 vestedAmount,uint256 vestingStart,uint256 vestingEnd)",
    "function hasToken(string modelId) view returns (bool)",
    "function getTokenAddress(string modelId) view returns (address)",
    "function tokenToModel(address token) view returns (string)",
    "function vestingVault() view returns (address)",
  ],
  deltaVerifier: [
    "event DeltaOneAccepted(uint256 indexed modelId,bytes32 indexed idempotencyKey,bytes32 indexed benchmarkSpecHash,bytes32 attestationHash,bytes32 datasetHash,string metricName,string metricFamily,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 rewardAmount,string pipelineRunId)",
    "event EvaluationSubmitted(string indexed pipelineRunId,uint256 indexed modelId)",
    "function processedIdempotencyKeys(bytes32 idempotencyKey) view returns (bool)",
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors) payload,(address walletAddress,uint256 weight)[] contributors,bytes[] attesterSignatures) returns (uint256)",
  ],
  ammFactory: [
    "function getPool(string modelId) view returns (address)",
    "function getPoolInfo(string modelId) view returns (address poolAddress,address tokenAddress,uint256 crr,uint256 tradeFee,uint256 reserveBalance,uint256 spotPrice)",
    "function poolCount() view returns (uint256)",
  ],
  ammPool: [
    "function hokusaiToken() view returns (address)",
    "function reserveToken() view returns (address)",
    "function FLAT_CURVE_THRESHOLD() view returns (uint256)",
    "function hasGraduated() view returns (bool)",
    "function getCurrentPhase() view returns (uint8)",
    "function getBuyQuote(uint256 reserveIn) view returns (uint256)",
    "function getSellQuote(uint256 tokensIn) view returns (uint256)",
    "function calculateBuyImpact(uint256 reserveIn) view returns (uint256 tokensOut,uint256 priceImpact,uint256 newSpotPrice)",
    "function getPoolState() view returns (uint256 reserve,uint256 supply,uint256 price,uint256 reserveRatio,uint256 tradeFeeRate)",
    "function getTradeInfo() view returns (bool sellsEnabled,uint256 ibrEndTime,bool isPaused)",
    "function buy(uint256 reserveIn,uint256 minTokensOut,address to,uint256 deadline) returns (uint256)",
    "function sell(uint256 tokensIn,uint256 minReserveOut,address to,uint256 deadline) returns (uint256)",
  ],
  erc20: [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function totalSupply() view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
    "function allowance(address owner,address spender) view returns (uint256)",
    "function approve(address spender,uint256 amount) returns (bool)",
  ],
  tokenParams: [
    "function vestingConfig() view returns (bool enabled,uint16 immediateUnlockBps,uint256 vestingDurationSeconds,uint256 cliffSeconds)",
    "function tokensPerDeltaOne() view returns (uint256)",
  ],
  hokusaiToken: [
    "function params() view returns (address)",
  ],
  vestingVault: [
    "function getSchedulesByBeneficiary(address beneficiary) view returns (uint256[])",
    "function getSchedule(uint256 scheduleId) view returns (address token,address beneficiary,string modelId,uint256 totalAmount,uint256 claimed,uint64 start,uint64 cliffSeconds,uint64 duration)",
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
  const signature = await attester.signTypedData(domain, MINT_REQUEST_EIP712_TYPES, {
    modelId,
    payload,
    contributors,
  });
  return [signature];
}

function parseArgs(argv) {
  const options = {
    deploymentFile: process.env.SEPOLIA_E2E_DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE,
    healthBaseUrl: process.env.SEPOLIA_E2E_HEALTH_URL || DEFAULT_HEALTH_BASE_URL,
    targetSymbols: parseCsv(process.env.SEPOLIA_E2E_TOKEN_SYMBOLS) || DEFAULT_TARGET_SYMBOLS,
    configuredModels: parseTokenModels(process.env.SEPOLIA_E2E_TOKEN_MODELS || DEFAULT_TOKEN_MODELS),
    scanStart: Number(process.env.SEPOLIA_E2E_SCAN_START || DEFAULT_SCAN_START),
    scanEnd: Number(process.env.SEPOLIA_E2E_SCAN_END || DEFAULT_SCAN_END),
    buyAmountUsdc: process.env.SEPOLIA_E2E_USDC_BUY_AMOUNT || DEFAULT_BUY_AMOUNT_USDC,
    tokenTargetBuyAmount: process.env.SEPOLIA_E2E_TOKEN_TARGET_BUY_AMOUNT || DEFAULT_TOKEN_TARGET_BUY_AMOUNT,
    graduationBufferUsdc: process.env.SEPOLIA_E2E_GRADUATION_BUFFER_USDC || DEFAULT_GRADUATION_BUFFER_USDC,
    sellAmountTokens: process.env.SEPOLIA_E2E_SELL_AMOUNT_TOKENS || DEFAULT_SELL_AMOUNT_TOKENS,
    liveMint: process.env.SEPOLIA_E2E_LIVE_MINT === "1",
    liveAmmBuy: process.env.SEPOLIA_E2E_LIVE_AMM_BUY === "1",
    liveTokenTargetBuy: process.env.SEPOLIA_E2E_LIVE_30K_BUY === "1",
    liveGraduate: process.env.SEPOLIA_E2E_LIVE_GRADUATE === "1",
    liveSell: process.env.SEPOLIA_E2E_LIVE_SELL === "1",
    skipHealth: process.env.SEPOLIA_E2E_SKIP_HEALTH === "1",
    json: process.env.SEPOLIA_E2E_JSON === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment-file") {
      options.deploymentFile = argv[++i];
    } else if (arg === "--health-url") {
      options.healthBaseUrl = argv[++i];
    } else if (arg === "--symbols") {
      options.targetSymbols = parseCsv(argv[++i]) || DEFAULT_TARGET_SYMBOLS;
    } else if (arg === "--token-models") {
      options.configuredModels = parseTokenModels(argv[++i]);
    } else if (arg === "--scan-start") {
      options.scanStart = Number(argv[++i]);
    } else if (arg === "--scan-end") {
      options.scanEnd = Number(argv[++i]);
    } else if (arg === "--buy-amount-usdc") {
      options.buyAmountUsdc = argv[++i];
    } else if (arg === "--token-target-buy-amount") {
      options.tokenTargetBuyAmount = argv[++i];
    } else if (arg === "--graduation-buffer-usdc") {
      options.graduationBufferUsdc = argv[++i];
    } else if (arg === "--sell-amount-tokens") {
      options.sellAmountTokens = argv[++i];
    } else if (arg === "--live-mint") {
      options.liveMint = true;
    } else if (arg === "--live-amm-buy") {
      options.liveAmmBuy = true;
    } else if (arg === "--live-30k-buy") {
      options.liveTokenTargetBuy = true;
    } else if (arg === "--live-graduate") {
      options.liveGraduate = true;
    } else if (arg === "--live-sell") {
      options.liveSell = true;
    } else if (arg === "--skip-health") {
      options.skipHealth = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }

  options.healthBaseUrl = options.healthBaseUrl.replace(/\/+$/, "");
  options.targetSymbols = options.targetSymbols.map((symbol) => symbol.toUpperCase());
  return options;
}

function printUsage() {
  console.log(`Sepolia three-token integration suite

Safe read-only checks:
  npm run e2e:sepolia:tokens

Mutating checks:
  SEPOLIA_E2E_LIVE_MINT=1 npm run e2e:sepolia:tokens
  SEPOLIA_E2E_LIVE_AMM_BUY=1 npm run e2e:sepolia:tokens
  SEPOLIA_E2E_LIVE_30K_BUY=1 npm run e2e:sepolia:tokens
  SEPOLIA_E2E_LIVE_GRADUATE=1 npm run e2e:sepolia:tokens
  SEPOLIA_E2E_LIVE_SELL=1 npm run e2e:sepolia:tokens
  SEPOLIA_E2E_LIVE_MINT=1 SEPOLIA_E2E_LIVE_AMM_BUY=1 npm run e2e:sepolia:tokens

Useful env:
  SEPOLIA_E2E_TOKEN_SYMBOLS=HMESS,HLEAD,HROUT
  SEPOLIA_E2E_TOKEN_MODELS=HMESS:28,HLEAD:27,HROUT:30
  SEPOLIA_E2E_SCAN_START=1
  SEPOLIA_E2E_SCAN_END=200
  SEPOLIA_E2E_USDC_BUY_AMOUNT=1
  SEPOLIA_E2E_TOKEN_TARGET_BUY_AMOUNT=30000
  SEPOLIA_E2E_GRADUATION_BUFFER_USDC=10
  SEPOLIA_E2E_SELL_AMOUNT_TOKENS=100
  SEPOLIA_E2E_JSON=1
  SEPOLIA_E2E_SKIP_HEALTH=1

Options:
  --symbols <csv>             Target token symbols.
  --token-models <mapping>    Symbol:modelId pairs; skips discovery for those symbols.
  --live-mint                 Submit real DeltaVerifier MintRequests.
  --live-amm-buy              Execute real AMM buys using the signer and MockUSDC.
  --live-30k-buy              Buy at least SEPOLIA_E2E_TOKEN_TARGET_BUY_AMOUNT tokens.
  --live-graduate             Buy enough reserve to cross the AMM graduation threshold.
  --live-sell                 Sell SEPOLIA_E2E_SELL_AMOUNT_TOKENS if IBR has ended.

Note: npm/Hardhat may consume appended flags. Prefer SEPOLIA_E2E_* env vars
when running through npm.
Graduation buys are intentionally expensive on live Sepolia: each pool must cross
the 25,000 USDC reserve threshold.
`);
}

function parseCsv(value) {
  if (!value) return null;
  return value.split(",").map((entry) => entry.trim()).filter(Boolean);
}

function parseTokenModels(value) {
  const models = new Map();
  for (const entry of parseCsv(value) || []) {
    const [symbol, modelId] = entry.split(":").map((part) => part?.trim());
    if (!symbol || !modelId) {
      throw new Error(`Invalid token model mapping "${entry}". Expected SYMBOL:modelId.`);
    }
    models.set(symbol.toUpperCase(), modelId);
  }
  return models;
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

function normalizeAddress(value) {
  if (!value || value === ZERO_ADDRESS) return ZERO_ADDRESS;
  return hre.ethers.getAddress(value);
}

function sameAddress(left, right) {
  return normalizeAddress(left) === normalizeAddress(right);
}

function hash(label) {
  return hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label));
}

function stringify(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(stringify);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, stringify(nested)]));
  }
  return value;
}

function createRecorder() {
  const checks = [];
  return {
    checks,
    pass(name, details) {
      checks.push({ status: "pass", name, details: stringify(details) });
    },
    warn(name, details) {
      checks.push({ status: "warn", name, details: stringify(details) });
    },
    fail(name, details) {
      checks.push({ status: "fail", name, details: stringify(details) });
    },
    assert(name, condition, details) {
      if (condition) this.pass(name, details);
      else this.fail(name, details);
    },
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (error) {
      body = { parseError: error.message, raw: text.slice(0, 500) };
    }
    return { status: response.status, ok: response.ok, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkEndpoint(recorder, baseUrl, pathName) {
  const url = `${baseUrl}${pathName}`;
  try {
    const result = await fetchJson(url);
    recorder.assert(`GET ${pathName} returns 200`, result.status === 200, { url, status: result.status });
    return result.body;
  } catch (error) {
    recorder.fail(`GET ${pathName} returns 200`, {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function safeCall(fn, fallback = null) {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function discoverTokens({ modelRegistry, tokenManager, signer, options }) {
  const found = new Map();

  for (const [symbol, modelId] of options.configuredModels.entries()) {
    const tokenAddress = await safeCall(() => tokenManager.getTokenAddress(modelId), ZERO_ADDRESS);
    if (tokenAddress !== ZERO_ADDRESS) {
      found.set(symbol, { symbol, modelId, tokenAddress: normalizeAddress(tokenAddress), source: "configured" });
    }
  }

  const missingSymbols = () => options.targetSymbols.filter((symbol) => !found.has(symbol));
  for (let id = options.scanStart; id <= options.scanEnd && missingSymbols().length > 0; id += 1) {
    const modelId = String(id);
    const registered = await safeCall(() => modelRegistry.isRegistered(id), false);
    if (!registered) continue;

    const tokenAddress = await safeCall(() => modelRegistry.getTokenAddress(id), ZERO_ADDRESS);
    if (tokenAddress === ZERO_ADDRESS) continue;

    const token = new hre.ethers.Contract(tokenAddress, ABIS.erc20, signer);
    const symbol = (await safeCall(() => token.symbol(), "")).toUpperCase();
    if (missingSymbols().includes(symbol)) {
      found.set(symbol, { symbol, modelId, tokenAddress: normalizeAddress(tokenAddress), source: "scan" });
    }
  }

  if (missingSymbols().length > 0) {
    const tokenDeployedEvents = await safeCall(
      () => tokenManager.queryFilter(tokenManager.filters.TokenDeployed()),
      [],
    );
    for (const event of tokenDeployedEvents) {
      if (missingSymbols().length === 0) break;

      const tokenAddress = event.args?.tokenAddress || event.args?.[1];
      const eventSymbol = (event.args?.symbol || event.args?.[4] || "").toUpperCase();
      if (!tokenAddress || !missingSymbols().includes(eventSymbol)) continue;

      const modelId = await safeCall(() => tokenManager.tokenToModel(tokenAddress), "");
      if (!modelId) continue;

      found.set(eventSymbol, {
        symbol: eventSymbol,
        modelId,
        tokenAddress: normalizeAddress(tokenAddress),
        source: "TokenDeployed event",
        blockNumber: event.blockNumber,
        transactionHash: event.transactionHash,
      });
    }
  }

  return options.targetSymbols.map((symbol) => found.get(symbol) || { symbol, missing: true });
}

function eventCount(receipt, contract, eventName) {
  return receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.name === eventName).length;
}

async function ensureAllowance({ token, owner, spender, amount }) {
  const allowance = await token.allowance(owner, spender);
  if (allowance >= amount) return null;
  const approveTx = await token.approve(spender, amount);
  return approveTx.wait(1);
}

async function executeAmmBuy({ pool, usdc, token, signer, amount, minTokensOut = 1n }) {
  await ensureAllowance({
    token: usdc,
    owner: signer.address,
    spender: await pool.getAddress(),
    amount,
  });

  const beforeTokenBalance = await token.balanceOf(signer.address);
  const beforeUsdcBalance = await usdc.balanceOf(signer.address);
  const beforeState = await pool.getPoolState();
  const beforePhase = await pool.getCurrentPhase();
  const beforeGraduated = await pool.hasGraduated();
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const buyTx = await pool.buy(amount, minTokensOut, signer.address, deadline);
  const receipt = await buyTx.wait(1);

  const afterTokenBalance = await token.balanceOf(signer.address);
  const afterUsdcBalance = await usdc.balanceOf(signer.address);
  const afterState = await pool.getPoolState();
  const afterPhase = await pool.getCurrentPhase();
  const afterGraduated = await pool.hasGraduated();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    reserveIn: amount,
    tokenDelta: afterTokenBalance - beforeTokenBalance,
    usdcDelta: afterUsdcBalance - beforeUsdcBalance,
    beforeReserve: beforeState.reserve ?? beforeState[0],
    afterReserve: afterState.reserve ?? afterState[0],
    beforePhase,
    afterPhase,
    beforeGraduated,
    afterGraduated,
  };
}

async function findBuyAmountForTokenTarget(pool, targetTokens) {
  let low = 1n;
  let high = hre.ethers.parseUnits("1", 6);

  while ((await pool.getBuyQuote(high)) < targetTokens) {
    high *= 2n;
  }

  while (low < high) {
    const mid = (low + high) / 2n;
    if ((await pool.getBuyQuote(mid)) >= targetTokens) {
      high = mid;
    } else {
      low = mid + 1n;
    }
  }

  return high;
}

function makeMintFixture({ modelId, symbol, contributors }) {
  const runId = `${symbol.toLowerCase()}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const idempotencyKey = hash(`hokusai:sepolia:token-suite:${modelId}:${runId}`);
  return {
    modelId: BigInt(modelId),
    payload: {
      pipelineRunId: `sepolia-token-suite-${runId}`,
      baselineScoreBps: 7800,
      candidateScoreBps: 8100,
      maxCostUsdMicro: 5_000_000,
      actualCostUsdMicro: 2_340_000,
      totalSamples: 1000,
      anchors: {
        benchmarkSpecHash: hash(`benchmark-spec:${symbol}:${modelId}`),
        datasetHash: hash(`dataset:${symbol}:${modelId}`),
        attestationHash: hash(`attestation:${symbol}:${runId}`),
        idempotencyKey,
        metricName: `${symbol.toLowerCase()}_quality_score`,
        metricFamily: "proportion",
      },
    },
    contributors,
    idempotencyKey,
    runId,
  };
}

async function checkToken({ tokenInfo, contracts, signer, recorder, options, chainId }) {
  const label = `${tokenInfo.symbol} model ${tokenInfo.modelId}`;

  if (!/^\d+$/.test(tokenInfo.modelId)) {
    recorder.fail(`${label} has no numeric model id for DeltaVerifier`, {
      modelId: tokenInfo.modelId,
      tokenAddress: tokenInfo.tokenAddress,
      source: tokenInfo.source,
    });
    return {
      symbol: tokenInfo.symbol,
      modelId: tokenInfo.modelId,
      tokenAddress: tokenInfo.tokenAddress,
      poolAddress: null,
      mintStaticReward: null,
    };
  }

  const modelIdBigInt = BigInt(tokenInfo.modelId);
  const modelIdString = tokenInfo.modelId;

  const modelRegistry = contracts.modelRegistry;
  const tokenManager = contracts.tokenManager;
  const deltaVerifier = contracts.deltaVerifier;
  const ammFactory = contracts.ammFactory;
  const usdc = contracts.usdc;
  const vestingVaultAddress = await safeCall(() => tokenManager.vestingVault(), ZERO_ADDRESS);
  const vestingVault = vestingVaultAddress === ZERO_ADDRESS
    ? null
    : new hre.ethers.Contract(vestingVaultAddress, ABIS.vestingVault, signer);

  const [
    numericRegistered,
    numericActive,
    numericToken,
    metric,
    stringRegistered,
    stringActive,
    stringToken,
    tokenManagerHasToken,
    tokenManagerToken,
  ] = await Promise.all([
    safeCall(() => modelRegistry.isRegistered(modelIdBigInt), false),
    safeCall(() => modelRegistry.isModelActive(modelIdBigInt), false),
    safeCall(() => modelRegistry.getTokenAddress(modelIdBigInt), ZERO_ADDRESS),
    safeCall(() => modelRegistry.getMetric(modelIdBigInt), null),
    safeCall(() => modelRegistry.isStringRegistered(modelIdString), false),
    safeCall(() => modelRegistry.isStringActive(modelIdString), false),
    safeCall(() => modelRegistry.getStringToken(modelIdString), ZERO_ADDRESS),
    safeCall(() => tokenManager.hasToken(modelIdString), false),
    safeCall(() => tokenManager.getTokenAddress(modelIdString), ZERO_ADDRESS),
  ]);

  recorder.assert(`${label} numeric registry entry is active`, numericRegistered && numericActive, {
    numericRegistered,
    numericActive,
    metric,
  });
  recorder.assert(`${label} string registry entry is active`, stringRegistered && stringActive, {
    stringRegistered,
    stringActive,
  });
  recorder.assert(`${label} TokenManager entry exists`, tokenManagerHasToken, { tokenManagerHasToken });
  recorder.assert(`${label} token addresses align`, (
    numericToken !== ZERO_ADDRESS &&
    stringToken !== ZERO_ADDRESS &&
    tokenManagerToken !== ZERO_ADDRESS &&
    sameAddress(numericToken, stringToken) &&
    sameAddress(numericToken, tokenManagerToken) &&
    sameAddress(numericToken, tokenInfo.tokenAddress)
  ), { discovered: tokenInfo.tokenAddress, numericToken, stringToken, tokenManagerToken });

  if (tokenManagerToken === ZERO_ADDRESS) {
    return {
      symbol: tokenInfo.symbol,
      modelId: modelIdString,
      tokenAddress: ZERO_ADDRESS,
      poolAddress: null,
      mintStaticReward: null,
    };
  }

  const token = new hre.ethers.Contract(tokenManagerToken, ABIS.erc20, signer);
  const [name, symbol, decimals, totalSupply] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
    token.totalSupply(),
  ]);

  recorder.assert(`${label} ERC20 metadata matches expected symbol`, symbol === tokenInfo.symbol, {
    name,
    symbol,
    decimals,
    totalSupply,
  });
  recorder.assert(`${label} ERC20 has nonzero supply`, totalSupply > 0n, { totalSupply });

  const tokenWithParams = new hre.ethers.Contract(tokenManagerToken, ABIS.hokusaiToken, signer);
  const paramsAddress = await safeCall(() => tokenWithParams.params(), ZERO_ADDRESS);
  let vestingConfig = null;
  if (paramsAddress !== ZERO_ADDRESS) {
    const params = new hre.ethers.Contract(paramsAddress, ABIS.tokenParams, signer);
    vestingConfig = await safeCall(() => params.vestingConfig(), null);
    if (vestingConfig) {
      recorder.assert(`${label} vesting params are readable`, true, {
        paramsAddress,
        enabled: vestingConfig.enabled ?? vestingConfig[0],
        immediateUnlockBps: vestingConfig.immediateUnlockBps ?? vestingConfig[1],
        vestingDurationSeconds: vestingConfig.vestingDurationSeconds ?? vestingConfig[2],
        cliffSeconds: vestingConfig.cliffSeconds ?? vestingConfig[3],
      });
    } else {
      recorder.fail(`${label} vesting params are readable`, { paramsAddress });
    }
  }

  const fixture = makeMintFixture({
    modelId: modelIdString,
    symbol: tokenInfo.symbol,
    contributors: [
      { walletAddress: signer.address, weight: 7000 },
      { walletAddress: "0x742d35cc6634c0532925a3b844bc9e7595f62341", weight: 3000 },
    ],
  });

  const alreadyProcessed = await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey);
  recorder.assert(`${label} generated MintRequest idempotency key is unused`, !alreadyProcessed, {
    idempotencyKey: fixture.idempotencyKey,
  });

  // HOK-2132: build the attester signature once; reused for static call and write.
  const attesterSignatures = await signMintRequestAttestation({
    attester: signer,
    deltaVerifierAddress: await deltaVerifier.getAddress(),
    chainId,
    modelId: fixture.modelId,
    payload: fixture.payload,
    contributors: fixture.contributors,
  });

  let staticCallError = null;
  let staticCall = null;
  try {
    staticCall = await deltaVerifier.submitMintRequest.staticCall(
      fixture.modelId,
      fixture.payload,
      fixture.contributors,
      attesterSignatures,
    );
  } catch (error) {
    staticCallError = error instanceof Error ? error.message : String(error);
  }
  const staticReward = typeof staticCall === "bigint" ? staticCall : null;
  recorder.assert(`${label} MintRequest static call succeeds with totalSamples`, staticReward !== null && staticReward > 0n, {
    staticReward,
    totalSamples: fixture.payload.totalSamples,
    error: staticCallError,
  });

  let liveMint = null;
  if (options.liveMint && staticReward !== null) {
    const beforeBalances = await Promise.all(fixture.contributors.map((contributor) => token.balanceOf(contributor.walletAddress)));
    const beforeSchedules = vestingVault
      ? await Promise.all(fixture.contributors.map((contributor) => vestingVault.getSchedulesByBeneficiary(contributor.walletAddress)))
      : [];
    // HOK-2132: requires the redeployed DeltaVerifier with an attester registered (addAttester + setAttesterThreshold). Until then write-mode mints fail-closed.
    const tx = await deltaVerifier.submitMintRequest(fixture.modelId, fixture.payload, fixture.contributors, attesterSignatures);
    const receipt = await tx.wait(1);
    const afterBalances = await Promise.all(fixture.contributors.map((contributor) => token.balanceOf(contributor.walletAddress)));
    const afterSchedules = vestingVault
      ? await Promise.all(fixture.contributors.map((contributor) => vestingVault.getSchedulesByBeneficiary(contributor.walletAddress)))
      : [];
    const processed = await deltaVerifier.processedIdempotencyKeys(fixture.idempotencyKey);
    const deltaOneEvents = eventCount(receipt, deltaVerifier, "DeltaOneAccepted");
    const evaluationEvents = eventCount(receipt, deltaVerifier, "EvaluationSubmitted");
    const vestingEvents = eventCount(receipt, tokenManager, "RewardVestingCreated");
    const vestingEnabled = Boolean(vestingConfig?.enabled ?? vestingConfig?.[0]);
    liveMint = {
      txHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      processed,
      deltaOneEvents,
      evaluationEvents,
      vestingEvents,
      vestingVault: vestingVaultAddress,
      balances: fixture.contributors.map((contributor, index) => ({
        walletAddress: contributor.walletAddress,
        before: beforeBalances[index],
        after: afterBalances[index],
        delta: afterBalances[index] - beforeBalances[index],
        schedulesBefore: beforeSchedules[index]?.length ?? null,
        schedulesAfter: afterSchedules[index]?.length ?? null,
      })),
    };
    recorder.assert(`${label} live MintRequest submits and mints`, receipt.status === 1 && processed, liveMint);
    recorder.assert(`${label} live MintRequest emits DeltaOneAccepted`, deltaOneEvents === 1, {
      txHash: receipt.hash,
      deltaOneEvents,
    });
    recorder.assert(`${label} live MintRequest emits EvaluationSubmitted`, evaluationEvents === 1, {
      txHash: receipt.hash,
      evaluationEvents,
    });
    recorder.assert(`${label} live MintRequest applies vesting policy`, !vestingEnabled || (
      vestingVault !== null &&
      vestingEvents === fixture.contributors.length &&
      liveMint.balances.every((balance) => balance.schedulesAfter === balance.schedulesBefore + 1)
    ), {
      txHash: receipt.hash,
      vestingEnabled,
      vestingEvents,
      schedules: liveMint.balances.map((balance) => ({
        walletAddress: balance.walletAddress,
        before: balance.schedulesBefore,
        after: balance.schedulesAfter,
      })),
    });
  } else if (options.liveMint) {
    recorder.warn(`${label} live MintRequest skipped because static call failed`, { error: staticCallError });
  }

  const [factoryPool, registryPool] = await Promise.all([
    safeCall(() => ammFactory.getPool(modelIdString), ZERO_ADDRESS),
    safeCall(() => modelRegistry.getPool(modelIdString), ZERO_ADDRESS),
  ]);
  recorder.assert(`${label} AMM factory pool exists`, factoryPool !== ZERO_ADDRESS, { factoryPool });
  if (registryPool === ZERO_ADDRESS) {
    recorder.warn(`${label} ModelRegistry pool mapping is empty`, { registryPool });
  } else {
    recorder.assert(`${label} ModelRegistry pool matches factory pool`, sameAddress(registryPool, factoryPool), {
      registryPool,
      factoryPool,
    });
  }

  if (factoryPool === ZERO_ADDRESS) {
    return {
      symbol: tokenInfo.symbol,
      modelId: modelIdString,
      tokenAddress: normalizeAddress(tokenManagerToken),
      poolAddress: ZERO_ADDRESS,
      mintStaticReward: staticReward,
      liveMint,
      liveAmmBuy: null,
    };
  }

  const pool = new hre.ethers.Contract(factoryPool, ABIS.ammPool, signer);
  const buyAmount = hre.ethers.parseUnits(options.buyAmountUsdc, 6);
  const [poolToken, poolReserveToken, poolState, tradeInfo, buyQuote, buyImpact, poolInfo] = await Promise.all([
    pool.hokusaiToken(),
    pool.reserveToken(),
    pool.getPoolState(),
    pool.getTradeInfo(),
    pool.getBuyQuote(buyAmount),
    pool.calculateBuyImpact(buyAmount),
    ammFactory.getPoolInfo(modelIdString),
  ]);

  recorder.assert(`${label} AMM pool is wired to token and reserve`, (
    sameAddress(poolToken, tokenManagerToken) &&
    sameAddress(poolReserveToken, contracts.usdcAddress) &&
    sameAddress(poolInfo.tokenAddress || poolInfo[1], tokenManagerToken)
  ), { poolToken, poolReserveToken, expectedReserve: contracts.usdcAddress, poolInfo });
  recorder.assert(`${label} AMM pool is not paused`, tradeInfo.isPaused === false || tradeInfo[2] === false, {
    sellsEnabled: tradeInfo.sellsEnabled ?? tradeInfo[0],
    ibrEndTime: tradeInfo.ibrEndTime ?? tradeInfo[1],
    isPaused: tradeInfo.isPaused ?? tradeInfo[2],
  });
  recorder.assert(`${label} AMM pool has reserves and positive buy quote`, (
    (poolState.reserve ?? poolState[0]) > 0n &&
    (poolState.supply ?? poolState[1]) > 0n &&
    buyQuote > 0n &&
    (buyImpact.tokensOut ?? buyImpact[0]) > 0n
  ), { poolState, buyAmount, buyQuote, buyImpact });

  let liveAmmBuy = null;
  if (options.liveAmmBuy) {
    const usdcBalance = await usdc.balanceOf(signer.address);
    recorder.assert(`${label} signer has enough MockUSDC for live AMM buy`, usdcBalance >= buyAmount, {
      signer: signer.address,
      usdcBalance,
      buyAmount,
    });
    if (usdcBalance >= buyAmount) {
      liveAmmBuy = await executeAmmBuy({ pool, usdc, token, signer, amount: buyAmount });
      const usdcSpent = -liveAmmBuy.usdcDelta;
      recorder.assert(`${label} live AMM buy executes`, (
        liveAmmBuy.tokenDelta > 0n &&
        usdcSpent > 0n &&
        usdcSpent <= buyAmount
      ), liveAmmBuy);
    }
  }

  let liveTokenTargetBuy = null;
  if (options.liveTokenTargetBuy) {
    const targetTokens = hre.ethers.parseUnits(options.tokenTargetBuyAmount, 18);
    const amountForTarget = await findBuyAmountForTokenTarget(pool, targetTokens);
    const quotedTokens = await pool.getBuyQuote(amountForTarget);
    const usdcBalance = await usdc.balanceOf(signer.address);
    recorder.assert(`${label} signer has enough MockUSDC for token-target AMM buy`, usdcBalance >= amountForTarget, {
      signer: signer.address,
      usdcBalance,
      amountForTarget,
      targetTokens,
      quotedTokens,
    });
    if (usdcBalance >= amountForTarget) {
      liveTokenTargetBuy = await executeAmmBuy({
        pool,
        usdc,
        token,
        signer,
        amount: amountForTarget,
        minTokensOut: targetTokens,
      });
      recorder.assert(`${label} token-target AMM buy mints at least target tokens`, liveTokenTargetBuy.tokenDelta >= targetTokens, {
        ...liveTokenTargetBuy,
        targetTokens,
        quotedTokens,
      });
    }
  }

  let liveGraduate = null;
  let postGraduateBuy = null;
  if (options.liveGraduate) {
    const latestState = await pool.getPoolState();
    const latestReserve = latestState.reserve ?? latestState[0];
    const tradeFeeRate = latestState.tradeFeeRate ?? latestState[4];
    const threshold = await pool.FLAT_CURVE_THRESHOLD();
    const beforeGraduated = await pool.hasGraduated();
    const graduationBuffer = hre.ethers.parseUnits(options.graduationBufferUsdc, 6);
    const netReserveNeeded = latestReserve >= threshold ? 0n : (threshold - latestReserve + graduationBuffer);
    const reserveAfterFeeBps = 10000n - tradeFeeRate;
    const amountToGraduate = netReserveNeeded === 0n
      ? 0n
      : ((netReserveNeeded * 10000n) + (reserveAfterFeeBps - 1n)) / reserveAfterFeeBps;

    if (beforeGraduated) {
      recorder.pass(`${label} AMM is already graduated`, { latestReserve, threshold });
    } else {
      const usdcBalance = await usdc.balanceOf(signer.address);
      recorder.assert(`${label} signer has enough MockUSDC to graduate AMM`, usdcBalance >= amountToGraduate, {
        signer: signer.address,
        usdcBalance,
        amountToGraduate,
        netReserveNeeded,
        tradeFeeRate,
        reserveAfterFeeBps,
        latestReserve,
        threshold,
      });
      if (usdcBalance >= amountToGraduate) {
        liveGraduate = await executeAmmBuy({ pool, usdc, token, signer, amount: amountToGraduate });
        recorder.assert(`${label} AMM graduates to bonding curve phase`, (
          liveGraduate.afterGraduated === true &&
          Number(liveGraduate.afterPhase) === 1 &&
          liveGraduate.afterReserve >= threshold
        ), {
          ...liveGraduate,
          threshold,
        });
      }
    }

    const graduatedAfter = await pool.hasGraduated();
    if (graduatedAfter) {
      const postGraduationBuyAmount = buyAmount;
      const usdcBalance = await usdc.balanceOf(signer.address);
      recorder.assert(`${label} signer has enough MockUSDC for post-graduation AMM buy`, usdcBalance >= postGraduationBuyAmount, {
        signer: signer.address,
        usdcBalance,
        postGraduationBuyAmount,
      });
      if (usdcBalance >= postGraduationBuyAmount) {
        postGraduateBuy = await executeAmmBuy({
          pool,
          usdc,
          token,
          signer,
          amount: postGraduationBuyAmount,
        });
        recorder.assert(`${label} post-graduation AMM buy executes in bonding curve phase`, (
          postGraduateBuy.tokenDelta > 0n &&
          postGraduateBuy.beforeGraduated === true &&
          postGraduateBuy.afterGraduated === true &&
          Number(postGraduateBuy.beforePhase) === 1 &&
          Number(postGraduateBuy.afterPhase) === 1
        ), postGraduateBuy);
      }
    }
  }

  let liveSell = null;
  if (options.liveSell) {
    const sellAmount = hre.ethers.parseUnits(options.sellAmountTokens, 18);
    const latestTradeInfo = await pool.getTradeInfo();
    const sellsEnabled = latestTradeInfo.sellsEnabled ?? latestTradeInfo[0];
    const ibrEndTime = latestTradeInfo.ibrEndTime ?? latestTradeInfo[1];
    if (!sellsEnabled) {
      recorder.warn(`${label} live AMM sell skipped because IBR is active`, { ibrEndTime });
    } else {
      const tokenBalance = await token.balanceOf(signer.address);
      const reserveQuote = await pool.getSellQuote(sellAmount);
      recorder.assert(`${label} signer has enough tokens for live AMM sell`, tokenBalance >= sellAmount && reserveQuote > 0n, {
        tokenBalance,
        sellAmount,
        reserveQuote,
      });
      if (tokenBalance >= sellAmount && reserveQuote > 0n) {
        await ensureAllowance({
          token,
          owner: signer.address,
          spender: factoryPool,
          amount: sellAmount,
        });
        const beforeTokenBalance = await token.balanceOf(signer.address);
        const beforeUsdcBalance = await usdc.balanceOf(signer.address);
        const deadline = Math.floor(Date.now() / 1000) + 600;
        const sellTx = await pool.sell(sellAmount, 1, signer.address, deadline);
        const receipt = await sellTx.wait(1);
        const afterTokenBalance = await token.balanceOf(signer.address);
        const afterUsdcBalance = await usdc.balanceOf(signer.address);
        liveSell = {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          gasUsed: receipt.gasUsed,
          tokenDelta: afterTokenBalance - beforeTokenBalance,
          usdcDelta: afterUsdcBalance - beforeUsdcBalance,
          reserveQuote,
        };
        recorder.assert(`${label} live AMM sell executes`, (
          liveSell.tokenDelta < 0n &&
          liveSell.usdcDelta > 0n
        ), liveSell);
      }
    }
  }

  return {
    symbol: tokenInfo.symbol,
    modelId: modelIdString,
    tokenAddress: normalizeAddress(tokenManagerToken),
    poolAddress: normalizeAddress(factoryPool),
    mintStaticReward: staticReward,
    liveMint,
    liveAmmBuy,
    liveTokenTargetBuy,
    liveGraduate,
    postGraduateBuy,
    liveSell,
  };
}

function printSummary(result) {
  console.log(`Sepolia token integration suite: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`Chain: ${result.chainId}`);
  console.log(`Signer: ${result.signer}`);
  console.log(`Mode: read-only${result.options.liveMint ? " + live MintRequest" : ""}${result.options.liveAmmBuy ? " + live AMM buy" : ""}${result.options.liveTokenTargetBuy ? " + token-target buy" : ""}${result.options.liveGraduate ? " + graduation buy" : ""}${result.options.liveSell ? " + live sell" : ""}`);
  console.log("");

  for (const token of result.tokens) {
    if (token.missing) {
      console.log(`${token.symbol}: missing`);
    } else {
      console.log(`${token.symbol}: model ${token.modelId}`);
      console.log(`  Token: ${token.tokenAddress}`);
      console.log(`  Pool:  ${token.poolAddress || "n/a"}`);
      console.log(`  Mint static reward: ${token.mintStaticReward || "n/a"}`);
      if (token.liveMint) console.log(`  Mint tx: ${token.liveMint.txHash}`);
      if (token.liveAmmBuy) console.log(`  Buy tx:  ${token.liveAmmBuy.txHash}`);
      if (token.liveTokenTargetBuy) console.log(`  Target buy tx: ${token.liveTokenTargetBuy.txHash}`);
      if (token.liveGraduate) console.log(`  Graduate tx: ${token.liveGraduate.txHash}`);
      if (token.postGraduateBuy) console.log(`  Post-graduation buy tx: ${token.postGraduateBuy.txHash}`);
      if (token.liveSell) console.log(`  Sell tx: ${token.liveSell.txHash}`);
    }
  }

  const counts = result.checks.reduce((acc, check) => {
    acc[check.status] = (acc[check.status] || 0) + 1;
    return acc;
  }, {});
  console.log("");
  console.log(`Checks: ${counts.pass || 0} passed, ${counts.warn || 0} warnings, ${counts.fail || 0} failed`);

  for (const check of result.checks) {
    const marker = check.status === "pass" ? "PASS" : check.status === "warn" ? "WARN" : "FAIL";
    console.log(`${marker} ${check.name}`);
    if (check.status !== "pass" && check.details) {
      console.log(`     ${JSON.stringify(check.details)}`);
    }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const recorder = createRecorder();
  const deployment = loadDeployment(options.deploymentFile);
  const deploymentContracts = deployment.contracts || {};
  const [signer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  recorder.assert("connected to Sepolia", chainId === 11155111n, { chainId });

  const addresses = {
    modelRegistry: requireAddress("ModelRegistry", deploymentContracts.ModelRegistry),
    tokenManager: requireAddress("TokenManager", deploymentContracts.TokenManager),
    deltaVerifier: requireAddress("DeltaVerifier", deploymentContracts.DeltaVerifier),
    ammFactory: requireAddress("HokusaiAMMFactory", deploymentContracts.HokusaiAMMFactory),
    usdc: requireAddress("MockUSDC", deploymentContracts.MockUSDC),
  };

  const contracts = {
    modelRegistry: new hre.ethers.Contract(addresses.modelRegistry, ABIS.modelRegistry, signer),
    tokenManager: new hre.ethers.Contract(addresses.tokenManager, ABIS.tokenManager, signer),
    deltaVerifier: new hre.ethers.Contract(addresses.deltaVerifier, ABIS.deltaVerifier, signer),
    ammFactory: new hre.ethers.Contract(addresses.ammFactory, ABIS.ammFactory, signer),
    usdc: new hre.ethers.Contract(addresses.usdc, ABIS.erc20, signer),
    usdcAddress: addresses.usdc,
  };

  if (!options.skipHealth) {
    const ready = await checkEndpoint(recorder, options.healthBaseUrl, "/health/ready");
    recorder.assert("contract service readiness reports Sepolia", ready?.checks?.rpc?.chainId === 11155111, {
      chainId: ready?.checks?.rpc?.chainId,
    });
    await checkEndpoint(recorder, options.healthBaseUrl, "/api/monitoring/pools");
  }

  const discoveredTokens = await discoverTokens({
    modelRegistry: contracts.modelRegistry,
    tokenManager: contracts.tokenManager,
    signer,
    options,
  });

  const tokens = [];
  for (const tokenInfo of discoveredTokens) {
    if (tokenInfo.missing) {
      recorder.fail(`${tokenInfo.symbol} token was not discovered`, {
        scanStart: options.scanStart,
        scanEnd: options.scanEnd,
        configuredModels: Object.fromEntries(options.configuredModels.entries()),
      });
      tokens.push(tokenInfo);
      continue;
    }
    tokens.push(await checkToken({ tokenInfo, contracts, signer, recorder, options, chainId }));
  }

  const result = {
    ok: recorder.checks.every((check) => check.status !== "fail"),
    chainId: chainId.toString(),
    signer: signer.address,
    deploymentFile: options.deploymentFile,
    options: {
      targetSymbols: options.targetSymbols,
      scanStart: options.scanStart,
      scanEnd: options.scanEnd,
      liveMint: options.liveMint,
      liveAmmBuy: options.liveAmmBuy,
      liveTokenTargetBuy: options.liveTokenTargetBuy,
      liveGraduate: options.liveGraduate,
      liveSell: options.liveSell,
    },
    tokens: stringify(tokens),
    checks: recorder.checks,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printSummary(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
});
