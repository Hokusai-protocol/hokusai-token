const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DEFAULT_DEPLOYMENT_FILE = "deployments/sepolia-latest.json";
const DEFAULT_TOKEN_MODELS = "HMESS:28,HLEAD:27,HTASK:30";
const DEFAULT_NEGATIVE_SYMBOL = "HLEAD";

const ABIS = {
  tokenManager: [
    "event RewardVestingCreated(string indexed modelId,address indexed contributor,uint256 totalReward,uint256 immediateAmount,uint256 vestedAmount,uint256 vestingStart,uint256 vestingEnd)",
    "function getTokenAddress(string modelId) view returns (address)",
    "function vestingVault() view returns (address)",
  ],
  deltaVerifier: [
    "event BudgetConstraintViolated(string indexed pipelineRunId,uint256 indexed modelId,uint256 maxCostUsd,uint256 actualCostUsd)",
    "event DeltaOneAccepted(uint256 indexed modelId,bytes32 indexed idempotencyKey,bytes32 indexed benchmarkSpecHash,bytes32 attestationHash,bytes32 datasetHash,string metricName,string metricFamily,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 rewardAmount,string pipelineRunId)",
    "event EvaluationSubmitted(string indexed pipelineRunId,uint256 indexed modelId)",
    "function SUBMITTER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32 role,address account) view returns (bool)",
    "function maxReward() view returns (uint256)",
    "function minImprovementBps() view returns (uint256)",
    "function processedIdempotencyKeys(bytes32 idempotencyKey) view returns (bool)",
    "function submitMintRequest(uint256 modelId,(string pipelineRunId,uint256 baselineScoreBps,uint256 candidateScoreBps,uint256 maxCostUsdMicro,uint256 actualCostUsdMicro,uint256 totalSamples,(bytes32 benchmarkSpecHash,bytes32 datasetHash,bytes32 attestationHash,bytes32 idempotencyKey,string metricName,string metricFamily) anchors) payload,(address walletAddress,uint256 weight)[] contributors) returns (uint256)",
  ],
  contributionRegistry: [
    "event ContributionRecorded(uint256 indexed contributionId,string modelId,address indexed contributor,bytes32 contributionHash,uint256 weightBps,uint256 tokensEarned,string pipelineRunId)",
    "function getContributorContributionCount(address contributor) view returns (uint256)",
    "function getContributionIdsByContributor(address contributor,uint256 offset,uint256 limit) view returns (uint256[])",
    "function getContribution(uint256 contributionId) view returns ((string modelId,address contributor,bytes32 contributionHash,uint256 contributorWeightBps,uint256 contributedSamples,uint256 totalSamples,uint256 tokensEarned,uint256 timestamp,string pipelineRunId,uint8 status))",
  ],
  erc20: [
    "function balanceOf(address account) view returns (uint256)",
    "function symbol() view returns (string)",
  ],
  hokusaiToken: [
    "function maxSupply() view returns (uint256)",
    "function params() view returns (address)",
    "function totalSupply() view returns (uint256)",
    "function rewardRemaining() view returns (uint256)",
  ],
  tokenParams: [
    "function tokensPerDeltaOne() view returns (uint256)",
    "function vestingConfig() view returns (bool enabled,uint16 immediateUnlockBps,uint256 vestingDurationSeconds,uint256 cliffSeconds)",
  ],
  vestingVault: [
    "function getSchedulesByBeneficiary(address beneficiary) view returns (uint256[])",
    "function getSchedule(uint256 scheduleId) view returns ((address token,address beneficiary,string modelId,uint256 totalAmount,uint256 claimed,uint64 start,uint64 cliffSeconds,uint64 duration))",
  ],
};

function parseTokenModels(value) {
  return value.split(",").map((entry) => {
    const [symbol, modelId] = entry.split(":").map((part) => part.trim());
    if (!symbol || !modelId || !/^\d+$/.test(modelId)) {
      throw new Error(`Invalid token mapping "${entry}". Expected SYMBOL:numericModelId.`);
    }
    return { symbol: symbol.toUpperCase(), modelId };
  });
}

function parseArgs(argv) {
  const options = {
    deploymentFile: process.env.DELTAONE_E2E_DEPLOYMENT_FILE || DEFAULT_DEPLOYMENT_FILE,
    tokenModels: parseTokenModels(process.env.DELTAONE_E2E_TOKEN_MODELS || DEFAULT_TOKEN_MODELS),
    negativeSymbol: (process.env.DELTAONE_E2E_NEGATIVE_SYMBOL || DEFAULT_NEGATIVE_SYMBOL).toUpperCase(),
    json: process.env.DELTAONE_E2E_JSON === "1",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--deployment-file") {
      options.deploymentFile = argv[++i];
    } else if (arg === "--token-models") {
      options.tokenModels = parseTokenModels(argv[++i]);
    } else if (arg === "--negative-symbol") {
      options.negativeSymbol = argv[++i].toUpperCase();
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
  console.log(`Direct Sepolia DeltaOne contract suite

Runs live mutating contract checks for DeltaVerifier, TokenManager vesting,
DataContributionRegistry records, idempotency, budget, below-threshold, and
SUBMITTER_ROLE access control.

Usage:
  npm run e2e:sepolia:deltaone

Useful env:
  DELTAONE_E2E_TOKEN_MODELS=HMESS:28,HLEAD:27,HTASK:30
  DELTAONE_E2E_NEGATIVE_SYMBOL=HLEAD
  DELTAONE_E2E_JSON=1
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

function parseEvents(receipt, contract, eventName) {
  return receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .filter((event) => event?.name === eventName);
}

function makePayload({ symbol, modelId, suffix, baselineScoreBps, candidateScoreBps, maxCostUsdMicro, actualCostUsdMicro }) {
  const pipelineRunId = `deltaone-direct-${symbol.toLowerCase()}-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  return {
    pipelineRunId,
    baselineScoreBps,
    candidateScoreBps,
    maxCostUsdMicro,
    actualCostUsdMicro,
    totalSamples: 1000,
    anchors: {
      benchmarkSpecHash: hash(`benchmark:${symbol}:${modelId}:${suffix}`),
      datasetHash: hash(`dataset:${symbol}:${modelId}:${suffix}`),
      attestationHash: hash(`attestation:${symbol}:${modelId}:${suffix}:${pipelineRunId}`),
      idempotencyKey: hash(`idempotency:${symbol}:${modelId}:${suffix}:${pipelineRunId}`),
      metricName: `${symbol.toLowerCase()}_direct_deltaone`,
      metricFamily: "proportion",
    },
  };
}

function contributionIdFromEvent(event) {
  return event.args?.contributionId ?? event.args?.[0];
}

async function tokenContext({ contracts, signer, modelId }) {
  const tokenAddress = requireAddress(`token for model ${modelId}`, await contracts.tokenManager.getTokenAddress(modelId));
  const token = new hre.ethers.Contract(tokenAddress, ABIS.erc20.concat(ABIS.hokusaiToken), signer);
  const paramsAddress = requireAddress(`params for model ${modelId}`, await token.params());
  const params = new hre.ethers.Contract(paramsAddress, ABIS.tokenParams, signer);
  const vestingConfig = await params.vestingConfig();
  return {
    tokenAddress,
    token,
    paramsAddress,
    tokensPerDeltaOne: await params.tokensPerDeltaOne(),
    vestingConfig,
  };
}

function expectedRewards({ deltaBps, tokensPerDeltaOne, maxReward, contributors }) {
  const rawReward = (BigInt(deltaBps) * tokensPerDeltaOne) / 100n;
  const totalReward = rawReward > maxReward ? maxReward : rawReward;
  const rewards = contributors.map((contributor) => (totalReward * BigInt(contributor.weight)) / 10000n);
  const distributed = rewards.reduce((sum, reward) => sum + reward, 0n);
  if (totalReward > distributed) {
    rewards[0] += totalReward - distributed;
  }
  return { rawReward, totalReward, rewards };
}

function chooseCandidateScore({ baselineScoreBps, defaultDeltaBps, minImprovementBps, tokensPerDeltaOne, maxReward, remainingMintable }) {
  const defaultTotalReward = expectedRewards({
    deltaBps: defaultDeltaBps,
    tokensPerDeltaOne,
    maxReward,
    contributors: [{ weight: 10000 }],
  }).totalReward;
  if (remainingMintable >= defaultTotalReward) {
    return baselineScoreBps + defaultDeltaBps;
  }

  const minReward = expectedRewards({
    deltaBps: Number(minImprovementBps),
    tokensPerDeltaOne,
    maxReward,
    contributors: [{ weight: 10000 }],
  }).totalReward;
  if (remainingMintable < minReward) {
    return null;
  }

  const affordableDelta = Number((remainingMintable * 100n) / tokensPerDeltaOne);
  const deltaBps = Math.max(Number(minImprovementBps), Math.min(defaultDeltaBps, affordableDelta));
  return baselineScoreBps + deltaBps;
}

async function runHappyPath({ tokenInfo, contracts, signer, recorder }) {
  const label = `${tokenInfo.symbol} model ${tokenInfo.modelId}`;
  const modelId = BigInt(tokenInfo.modelId);
  const ctx = await tokenContext({ contracts, signer, modelId: tokenInfo.modelId });
  const maxReward = await contracts.deltaVerifier.maxReward();
  const minImprovementBps = await contracts.deltaVerifier.minImprovementBps();
  let remainingMintable;
  try {
    remainingMintable = await ctx.token.rewardRemaining();
  } catch {
    const maxSupply = await ctx.token.maxSupply();
    const totalSupply = await ctx.token.totalSupply();
    remainingMintable = maxSupply > totalSupply ? maxSupply - totalSupply : 0n;
  }
  const baselineScoreBps = 7800;
  const candidateScoreBps = chooseCandidateScore({
    baselineScoreBps,
    defaultDeltaBps: 300,
    minImprovementBps,
    tokensPerDeltaOne: ctx.tokensPerDeltaOne,
    maxReward,
    remainingMintable,
  });
  if (candidateScoreBps === null || candidateScoreBps > 10000) {
    recorder.warn(`${label} happy path skipped because remaining reward headroom cannot cover minimum positive DeltaOne reward`, {
      remainingMintable,
      minImprovementBps,
      tokensPerDeltaOne: ctx.tokensPerDeltaOne,
      maxReward,
    });
    return { skipped: true, reason: "insufficient remaining mintable supply" };
  }

  const secondContributor = "0x742D35cc6634C0532925A3B844BC9E7595f62341";
  const contributors = [
    { walletAddress: signer.address, weight: 7000 },
    { walletAddress: secondContributor, weight: 3000 },
  ];
  const payload = makePayload({
    symbol: tokenInfo.symbol,
    modelId: tokenInfo.modelId,
    suffix: "happy",
    baselineScoreBps,
    candidateScoreBps,
    maxCostUsdMicro: 5_000_000,
    actualCostUsdMicro: 2_340_000,
  });
  const deltaBps = payload.candidateScoreBps - payload.baselineScoreBps;
  const { rawReward, totalReward, rewards } = expectedRewards({
    deltaBps,
    tokensPerDeltaOne: ctx.tokensPerDeltaOne,
    maxReward,
    contributors,
  });
  const immediateUnlockBps = BigInt(ctx.vestingConfig.immediateUnlockBps ?? ctx.vestingConfig[1]);
  const vestingEnabled = Boolean(ctx.vestingConfig.enabled ?? ctx.vestingConfig[0]);

  const beforeBalances = await Promise.all(contributors.map((contributor) => ctx.token.balanceOf(contributor.walletAddress)));
  const beforeContributionCounts = await Promise.all(
    contributors.map((contributor) => contracts.contributionRegistry.getContributorContributionCount(contributor.walletAddress)),
  );
  const beforeSchedules = contracts.vestingVault
    ? await Promise.all(contributors.map((contributor) => contracts.vestingVault.getSchedulesByBeneficiary(contributor.walletAddress)))
    : [];

  const staticReward = await contracts.deltaVerifier.submitMintRequest.staticCall(modelId, payload, contributors);
  recorder.assert(`${label} happy path static reward matches expected total`, staticReward === totalReward, {
    staticReward,
    totalReward,
    rawReward,
    maxReward,
    deltaBps,
    tokensPerDeltaOne: ctx.tokensPerDeltaOne,
  });

  const tx = await contracts.deltaVerifier.submitMintRequest(modelId, payload, contributors);
  const receipt = await tx.wait(1);

  const afterBalances = await Promise.all(contributors.map((contributor) => ctx.token.balanceOf(contributor.walletAddress)));
  const afterContributionCounts = await Promise.all(
    contributors.map((contributor) => contracts.contributionRegistry.getContributorContributionCount(contributor.walletAddress)),
  );
  const afterSchedules = contracts.vestingVault
    ? await Promise.all(contributors.map((contributor) => contracts.vestingVault.getSchedulesByBeneficiary(contributor.walletAddress)))
    : [];

  const deltaOneEvents = parseEvents(receipt, contracts.deltaVerifier, "DeltaOneAccepted");
  const evaluationEvents = parseEvents(receipt, contracts.deltaVerifier, "EvaluationSubmitted");
  const contributionEvents = parseEvents(receipt, contracts.contributionRegistry, "ContributionRecorded");
  const vestingEvents = parseEvents(receipt, contracts.tokenManager, "RewardVestingCreated");

  recorder.assert(`${label} happy path emits DeltaOneAccepted`, deltaOneEvents.length === 1, {
    txHash: receipt.hash,
    count: deltaOneEvents.length,
  });
  recorder.assert(`${label} happy path emits EvaluationSubmitted`, evaluationEvents.length === 1, {
    txHash: receipt.hash,
    count: evaluationEvents.length,
  });
  recorder.assert(`${label} happy path records one contribution per contributor`, contributionEvents.length === contributors.length, {
    txHash: receipt.hash,
    count: contributionEvents.length,
  });
  recorder.assert(`${label} happy path marks idempotency key processed`, await contracts.deltaVerifier.processedIdempotencyKeys(payload.anchors.idempotencyKey), {
    idempotencyKey: payload.anchors.idempotencyKey,
  });

  for (let i = 0; i < contributors.length; i += 1) {
    const expectedImmediate = vestingEnabled ? (rewards[i] * immediateUnlockBps) / 10000n : rewards[i];
    const expectedVested = rewards[i] - expectedImmediate;
    const balanceDelta = afterBalances[i] - beforeBalances[i];
    recorder.assert(`${label} contributor ${i + 1} wallet balance increased by expected liquid reward`, balanceDelta === expectedImmediate, {
      walletAddress: contributors[i].walletAddress,
      balanceDelta,
      expectedImmediate,
      totalReward: rewards[i],
      expectedVested,
    });

    recorder.assert(`${label} contributor ${i + 1} contribution count increased`, afterContributionCounts[i] === beforeContributionCounts[i] + 1n, {
      before: beforeContributionCounts[i],
      after: afterContributionCounts[i],
    });

    const ids = await contracts.contributionRegistry.getContributionIdsByContributor(
      contributors[i].walletAddress,
      beforeContributionCounts[i],
      1,
    );
    const record = await contracts.contributionRegistry.getContribution(ids[0]);
    recorder.assert(`${label} contributor ${i + 1} contribution record matches MintRequest`, (
      record.modelId === tokenInfo.modelId &&
      record.contributor.toLowerCase() === contributors[i].walletAddress.toLowerCase() &&
      record.contributorWeightBps === BigInt(contributors[i].weight) &&
      record.totalSamples === BigInt(payload.totalSamples) &&
      record.contributedSamples === (BigInt(payload.totalSamples) * BigInt(contributors[i].weight)) / 10000n &&
      record.tokensEarned === rewards[i] &&
      record.pipelineRunId === payload.pipelineRunId
    ), {
      contributionId: ids[0],
      record,
      expectedWeight: contributors[i].weight,
      expectedReward: rewards[i],
      expectedPipelineRunId: payload.pipelineRunId,
    });

    if (vestingEnabled) {
      recorder.assert(`${label} contributor ${i + 1} vesting schedule created`, afterSchedules[i].length === beforeSchedules[i].length + 1, {
        before: beforeSchedules[i].length,
        after: afterSchedules[i].length,
      });
      const newScheduleId = afterSchedules[i][afterSchedules[i].length - 1];
      const schedule = await contracts.vestingVault.getSchedule(newScheduleId);
      recorder.assert(`${label} contributor ${i + 1} vesting schedule amount matches vested reward`, (
        schedule.token.toLowerCase() === ctx.tokenAddress.toLowerCase() &&
        schedule.beneficiary.toLowerCase() === contributors[i].walletAddress.toLowerCase() &&
        schedule.modelId === tokenInfo.modelId &&
        schedule.totalAmount === expectedVested
      ), {
        scheduleId: newScheduleId,
        schedule,
        expectedVested,
      });
    }
  }

  recorder.assert(`${label} happy path emits expected vesting events`, !vestingEnabled || vestingEvents.length === contributors.length, {
    count: vestingEvents.length,
    vestingEnabled,
  });

  return { txHash: receipt.hash, totalReward, rewards };
}

async function runNegativeCases({ tokenInfo, contracts, signer, recorder }) {
  const label = `${tokenInfo.symbol} model ${tokenInfo.modelId}`;
  const modelId = BigInt(tokenInfo.modelId);
  const ctx = await tokenContext({ contracts, signer, modelId: tokenInfo.modelId });
  const contributors = [{ walletAddress: signer.address, weight: 10000 }];

  const budgetPayload = makePayload({
    symbol: tokenInfo.symbol,
    modelId: tokenInfo.modelId,
    suffix: "budget-idempotency",
    baselineScoreBps: 7800,
    candidateScoreBps: 8100,
    maxCostUsdMicro: 100,
    actualCostUsdMicro: 125,
  });
  const budgetBalanceBefore = await ctx.token.balanceOf(signer.address);
  const budgetCountBefore = await contracts.contributionRegistry.getContributorContributionCount(signer.address);
  const budgetTx = await contracts.deltaVerifier.submitMintRequest(modelId, budgetPayload, contributors);
  const budgetReceipt = await budgetTx.wait(1);
  const budgetEvents = parseEvents(budgetReceipt, contracts.deltaVerifier, "BudgetConstraintViolated");
  const budgetBalanceAfter = await ctx.token.balanceOf(signer.address);
  const budgetCountAfter = await contracts.contributionRegistry.getContributorContributionCount(signer.address);
  recorder.assert(`${label} budget violation emits event and mints nothing`, (
    budgetEvents.length === 1 &&
    budgetBalanceAfter === budgetBalanceBefore &&
    budgetCountAfter === budgetCountBefore &&
    await contracts.deltaVerifier.processedIdempotencyKeys(budgetPayload.anchors.idempotencyKey)
  ), {
    txHash: budgetReceipt.hash,
    budgetEvents: budgetEvents.length,
    balanceBefore: budgetBalanceBefore,
    balanceAfter: budgetBalanceAfter,
    contributionCountBefore: budgetCountBefore,
    contributionCountAfter: budgetCountAfter,
  });

  let replayRejected = false;
  try {
    await contracts.deltaVerifier.submitMintRequest.staticCall(modelId, budgetPayload, contributors);
  } catch (error) {
    replayRejected = String(error.message || error).includes("Idempotency key already processed");
  }
  const replayCountAfter = await contracts.contributionRegistry.getContributorContributionCount(signer.address);
  const replayBalanceAfter = await ctx.token.balanceOf(signer.address);
  recorder.assert(`${label} idempotency replay is rejected without duplicate contribution`, (
    replayRejected &&
    replayCountAfter === budgetCountAfter &&
    replayBalanceAfter === budgetBalanceAfter
  ), {
    firstTx: budgetReceipt.hash,
    contributionCountBeforeReplay: budgetCountAfter,
    contributionCountAfterReplay: replayCountAfter,
    balanceBeforeReplay: budgetBalanceAfter,
    balanceAfterReplay: replayBalanceAfter,
  });

  const thresholdPayload = makePayload({
    symbol: tokenInfo.symbol,
    modelId: tokenInfo.modelId,
    suffix: "below-threshold",
    baselineScoreBps: 7800,
    candidateScoreBps: 7850,
    maxCostUsdMicro: 5_000_000,
    actualCostUsdMicro: 2_340_000,
  });
  const minImprovementBps = await contracts.deltaVerifier.minImprovementBps();
  const belowDelta = thresholdPayload.candidateScoreBps - thresholdPayload.baselineScoreBps;
  const belowStaticReward = await contracts.deltaVerifier.submitMintRequest.staticCall(modelId, thresholdPayload, contributors);
  const belowBalanceBefore = await ctx.token.balanceOf(signer.address);
  const belowCountBefore = await contracts.contributionRegistry.getContributorContributionCount(signer.address);
  const belowTx = await contracts.deltaVerifier.submitMintRequest(modelId, thresholdPayload, contributors);
  const belowReceipt = await belowTx.wait(1);
  const belowDeltaEvents = parseEvents(belowReceipt, contracts.deltaVerifier, "DeltaOneAccepted");
  const belowBalanceAfter = await ctx.token.balanceOf(signer.address);
  const belowCountAfter = await contracts.contributionRegistry.getContributorContributionCount(signer.address);
  recorder.assert(`${label} below-threshold delta mints nothing and records no contribution`, (
    BigInt(belowDelta) < minImprovementBps &&
    belowStaticReward === 0n &&
    belowDeltaEvents.length === 1 &&
    belowBalanceAfter === belowBalanceBefore &&
    belowCountAfter === belowCountBefore
  ), {
    txHash: belowReceipt.hash,
    belowDelta,
    minImprovementBps,
    belowStaticReward,
    balanceBefore: belowBalanceBefore,
    balanceAfter: belowBalanceAfter,
    contributionCountBefore: belowCountBefore,
    contributionCountAfter: belowCountAfter,
  });

  const unauthorized = hre.ethers.Wallet.createRandom().connect(hre.ethers.provider);
  const unauthorizedDeltaVerifier = contracts.deltaVerifier.connect(unauthorized);
  const unauthorizedPayload = makePayload({
    symbol: tokenInfo.symbol,
    modelId: tokenInfo.modelId,
    suffix: "unauthorized",
    baselineScoreBps: 7800,
    candidateScoreBps: 8100,
    maxCostUsdMicro: 5_000_000,
    actualCostUsdMicro: 2_340_000,
  });
  let unauthorizedRejected = false;
  try {
    await unauthorizedDeltaVerifier.submitMintRequest.staticCall(modelId, unauthorizedPayload, contributors);
  } catch (error) {
    const message = String(error.message || error);
    unauthorizedRejected = message.includes("AccessControl") || message.includes("missing role");
  }
  recorder.assert(`${label} unauthorized wallet cannot submit MintRequest`, unauthorizedRejected, {
    unauthorized: unauthorized.address,
  });
}

function printSummary(result) {
  console.log(`Sepolia DeltaOne direct suite: ${result.ok ? "PASS" : "FAIL"}`);
  console.log(`Chain: ${result.chainId}`);
  console.log(`Signer: ${result.signer}`);
  console.log(`Negative cases model: ${result.negativeSymbol}`);
  console.log("");

  for (const token of result.happyPath) {
    if (token.skipped) {
      console.log(`${token.symbol} model ${token.modelId}: skipped (${token.reason})`);
    } else {
      console.log(`${token.symbol} model ${token.modelId}: ${token.txHash}`);
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
    tokenManager: requireAddress("TokenManager", deploymentContracts.TokenManager),
    deltaVerifier: requireAddress("DeltaVerifier", deploymentContracts.DeltaVerifier),
    contributionRegistry: requireAddress("DataContributionRegistry", deploymentContracts.DataContributionRegistry),
  };
  const tokenManager = new hre.ethers.Contract(addresses.tokenManager, ABIS.tokenManager, signer);
  const vestingVaultAddress = requireAddress("RewardVestingVault", await tokenManager.vestingVault());

  const contracts = {
    tokenManager,
    deltaVerifier: new hre.ethers.Contract(addresses.deltaVerifier, ABIS.deltaVerifier, signer),
    contributionRegistry: new hre.ethers.Contract(addresses.contributionRegistry, ABIS.contributionRegistry, signer),
    vestingVault: new hre.ethers.Contract(vestingVaultAddress, ABIS.vestingVault, signer),
  };

  const submitterRole = await contracts.deltaVerifier.SUBMITTER_ROLE();
  recorder.assert("signer has DeltaVerifier SUBMITTER_ROLE", await contracts.deltaVerifier.hasRole(submitterRole, signer.address), {
    signer: signer.address,
  });

  const happyPath = [];
  for (const tokenInfo of options.tokenModels) {
    const result = await runHappyPath({ tokenInfo, contracts, signer, recorder });
    happyPath.push({ symbol: tokenInfo.symbol, modelId: tokenInfo.modelId, ...stringify(result) });
  }
  recorder.assert("at least one token executed a positive DeltaOne happy path", happyPath.some((result) => !result.skipped), {
    happyPath,
  });

  const negativeToken = options.tokenModels.find((tokenInfo) => tokenInfo.symbol === options.negativeSymbol) || options.tokenModels[0];
  if (negativeToken.symbol !== options.negativeSymbol) {
    recorder.warn("negative test symbol not found; using first configured token", {
      requested: options.negativeSymbol,
      actual: negativeToken.symbol,
    });
  }
  await runNegativeCases({ tokenInfo: negativeToken, contracts, signer, recorder });

  const result = {
    ok: recorder.checks.every((check) => check.status !== "fail"),
    chainId: chainId.toString(),
    signer: signer.address,
    negativeSymbol: negativeToken.symbol,
    happyPath,
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
