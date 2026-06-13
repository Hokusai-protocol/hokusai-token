const fs = require("fs");
const path = require("path");

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const SAFE_TX_BUILDER_VERSION = "1.0";
const DEFAULT_CONFIG_DIR = path.resolve(__dirname, "..", "configs");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify(data, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`
  );
}

function normalizeAddress(value) {
  return value ? value.toLowerCase() : null;
}

function addressesEqual(a, b) {
  return normalizeAddress(a) === normalizeAddress(b);
}

function normalizeSet(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => normalizeAddress(value)))].sort();
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      continue;
    }

    const [key, inlineValue] = arg.slice(2).split("=");
    if (inlineValue !== undefined) {
      parsed[key] = inlineValue;
      continue;
    }

    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
      continue;
    }

    parsed[key] = true;
  }

  return parsed;
}

function resolveConfigPath({ networkName, configPath }) {
  if (configPath) {
    return path.resolve(process.cwd(), configPath);
  }

  return path.join(DEFAULT_CONFIG_DIR, `${networkName}-launch-posture.json`);
}

function resolveArtifactPath(config, explicitPath) {
  if (explicitPath) {
    return path.resolve(process.cwd(), explicitPath);
  }

  if (!config.deploymentArtifactPath) {
    throw new Error("Launch posture config missing deploymentArtifactPath");
  }

  return path.resolve(process.cwd(), config.deploymentArtifactPath);
}

function loadLaunchPostureConfig({ networkName, configPath, deploymentArtifactPath }) {
  const resolvedConfigPath = resolveConfigPath({ networkName, configPath });
  const config = loadJson(resolvedConfigPath);
  const resolvedArtifactPath = resolveArtifactPath(config, deploymentArtifactPath);
  const deployment = loadJson(resolvedArtifactPath);
  return {
    config,
    configPath: resolvedConfigPath,
    deployment,
    deploymentPath: resolvedArtifactPath,
  };
}

function resolveExpectedValue(spec, context) {
  if (Array.isArray(spec)) {
    return spec.flatMap((entry) => resolveExpectedValue(entry, context));
  }

  if (typeof spec !== "string") {
    return spec;
  }

  if (spec === "ADMIN_SAFE") {
    return context.config.adminSafe;
  }

  if (spec === "EMERGENCY_SAFE") {
    return context.config.emergencySafe || context.config.adminSafe;
  }

  if (spec === "DEPLOYER") {
    return context.config.deployerAddress || context.deployment.deployer;
  }

  if (spec === "RELAYER") {
    return context.config.submitterRelayer;
  }

  if (spec.startsWith("CONTRACT:")) {
    return context.deployment.contracts?.[spec.slice("CONTRACT:".length)] || null;
  }

  if (spec.startsWith("FIELD:")) {
    return spec.slice("FIELD:".length).split(".").reduce((cursor, part) => cursor?.[part], context.deployment);
  }

  return spec;
}

function resolveExpectedSet(spec, context) {
  return normalizeSet(resolveExpectedValue(spec, context));
}

function makeAssertion(name, expected, actual, passed, message) {
  return {
    name,
    passed,
    expected,
    actual,
    message,
  };
}

async function getRoleId(contract, roleName) {
  if (roleName === "DEFAULT_ADMIN_ROLE") {
    return ZERO_HASH;
  }

  return contract[roleName]();
}

async function enumerateRoleHolders({
  contract,
  roleName,
  deployment,
  contractName,
  config,
}) {
  const roleId = await getRoleId(contract, roleName);
  const deploymentBlock = deployment.deploymentBlocks?.[contractName];
  const fromBlock = config.roleScanFromBlock ?? deploymentBlock ?? 0;
  const grantedEvents = await contract.queryFilter(contract.filters.RoleGranted(roleId), fromBlock);
  const revokedEvents = await contract.queryFilter(contract.filters.RoleRevoked(roleId), fromBlock);
  const events = [...grantedEvents, ...revokedEvents].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }

    return a.logIndex - b.logIndex;
  });

  const holders = new Set(normalizeSet(deployment.roles?.[contractName]?.[roleName] || []));
  for (const event of events) {
    const holder = normalizeAddress(event.args.account);
    if (event.fragment.name === "RoleGranted") {
      holders.add(holder);
    } else {
      holders.delete(holder);
    }
  }

  const active = [];
  for (const holder of [...holders]) {
    if (await contract.hasRole(roleId, holder)) {
      active.push(holder);
    }
  }

  return normalizeSet(active);
}

async function enumerateAttesters({ deltaVerifier, deployment, config }) {
  const fromBlock = config.roleScanFromBlock ?? deployment.deploymentBlocks?.DeltaVerifier ?? 0;
  const addedEvents = await deltaVerifier.queryFilter(deltaVerifier.filters.AttesterAdded(), fromBlock);
  const removedEvents = await deltaVerifier.queryFilter(deltaVerifier.filters.AttesterRemoved(), fromBlock);
  const events = [...addedEvents, ...removedEvents].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) {
      return a.blockNumber - b.blockNumber;
    }

    return a.logIndex - b.logIndex;
  });

  const attesters = new Set();
  for (const event of events) {
    const holder = normalizeAddress(event.args.attester);
    if (event.fragment.name === "AttesterAdded") {
      attesters.add(holder);
    } else {
      attesters.delete(holder);
    }
  }

  const active = [];
  for (const holder of [...attesters]) {
    if (await deltaVerifier.isAttester(holder)) {
      active.push(holder);
    }
  }

  return normalizeSet(active);
}

async function getContracts(hre, deployment) {
  const managerAbi = deployment.contracts._tokenManagerImpl || "DeployableTokenManager";
  return {
    deltaVerifier: await hre.ethers.getContractAt("DeltaVerifier", deployment.contracts.DeltaVerifier),
    modelRegistry: await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry),
    tokenManager: await hre.ethers.getContractAt(managerAbi, deployment.contracts.TokenManager),
    contributionRegistry: await hre.ethers.getContractAt("DataContributionRegistry", deployment.contracts.DataContributionRegistry),
  };
}

async function assertLaunchPosture({ hre, config, deployment }) {
  const contracts = await getContracts(hre, deployment);
  const context = { config, deployment };
  const assertions = [];

  const legacyMintsDisabled = await contracts.deltaVerifier.legacyMintsDisabled();
  assertions.push(
    makeAssertion(
      "deltaVerifier.legacyMintsDisabled",
      true,
      legacyMintsDisabled,
      legacyMintsDisabled === true,
      legacyMintsDisabled ? "legacy mint entrypoints disabled" : "legacy mint entrypoints still enabled"
    )
  );

  const paused = await contracts.deltaVerifier.paused();
  const expectedPaused = Boolean(config.deltaVerifier?.paused ?? false);
  assertions.push(
    makeAssertion(
      "deltaVerifier.paused",
      expectedPaused,
      paused,
      paused === expectedPaused,
      paused === expectedPaused ? "pause state matches" : "pause state mismatch"
    )
  );

  const threshold = await contracts.deltaVerifier.attesterThreshold();
  const expectedThreshold = BigInt(config.deltaVerifier.attesterThreshold);
  assertions.push(
    makeAssertion(
      "deltaVerifier.attesterThreshold",
      expectedThreshold.toString(),
      threshold.toString(),
      threshold >= 1n && threshold === expectedThreshold,
      threshold >= 1n && threshold === expectedThreshold
        ? "threshold matches"
        : "threshold must be non-zero and match expected"
    )
  );

  const count = await contracts.deltaVerifier.attesterCount();
  assertions.push(
    makeAssertion(
      "deltaVerifier.attesterCount",
      `>= ${threshold.toString()}`,
      count.toString(),
      count >= threshold,
      count >= threshold ? "attester count satisfies threshold" : "attester count below threshold"
    )
  );

  const expectedAttesters = resolveExpectedSet(config.deltaVerifier.expectedAttesters || [], context);
  const actualAttesters = await enumerateAttesters({
    deltaVerifier: contracts.deltaVerifier,
    deployment,
    config,
  });
  const missingAttesters = expectedAttesters.filter((address) => !actualAttesters.includes(address));
  const unexpectedAttesters = actualAttesters.filter((address) => !expectedAttesters.includes(address));
  assertions.push(
    makeAssertion(
      "deltaVerifier.attesterSet",
      { expected: expectedAttesters },
      {
        actual: actualAttesters,
        missing: missingAttesters,
        unexpected: unexpectedAttesters,
      },
      missingAttesters.length === 0 && unexpectedAttesters.length === 0,
      missingAttesters.length === 0 && unexpectedAttesters.length === 0
        ? "attester set matches"
        : "attester set differs"
    )
  );

  for (const [field, name] of [
    ["baseRewardRate", "deltaVerifier.baseRewardRate"],
    ["minImprovementBps", "deltaVerifier.minImprovementBps"],
    ["maxReward", "deltaVerifier.maxReward"],
  ]) {
    const actual = await contracts.deltaVerifier[field]();
    const expected = BigInt(config.deltaVerifier[field]);
    assertions.push(
      makeAssertion(
        name,
        expected.toString(),
        actual.toString(),
        actual === expected,
        actual === expected ? `${field} matches` : `${field} mismatch`
      )
    );
  }

  for (const model of config.models || []) {
    const modelId = BigInt(model.modelId);
    const budgetActual = await contracts.deltaVerifier.mintBudgetRemaining(modelId);
    const budgetExpected = BigInt(model.expectedMintBudgetRemaining);
    assertions.push(
      makeAssertion(
        `model.${model.modelId}.mintBudgetRemaining`,
        budgetExpected.toString(),
        budgetActual.toString(),
        budgetActual === budgetExpected,
        budgetActual === budgetExpected ? "mint budget matches" : "mint budget mismatch"
      )
    );

    const weightActual = await contracts.modelRegistry.weightGenesis(modelId);
    const weightExpected = model.expectedWeightGenesis;
    assertions.push(
      makeAssertion(
        `model.${model.modelId}.weightGenesis`,
        weightExpected,
        weightActual,
        weightActual !== ZERO_HASH && weightActual === weightExpected,
        weightActual !== ZERO_HASH && weightActual === weightExpected
          ? "weight genesis matches"
          : "weight genesis missing or mismatched"
      )
    );

    const tokenAddress = await contracts.modelRegistry.getTokenAddress(modelId);
    const token = await hre.ethers.getContractAt("HokusaiToken", tokenAddress);
    const paramsAddress = await token.params();
    const params = await hre.ethers.getContractAt("HokusaiParams", paramsAddress);
    const tokensPerDeltaOneActual = await params.tokensPerDeltaOne();
    const tokensPerDeltaOneExpected = BigInt(model.expectedTokensPerDeltaOne);
    assertions.push(
      makeAssertion(
        `model.${model.modelId}.tokensPerDeltaOne`,
        tokensPerDeltaOneExpected.toString(),
        tokensPerDeltaOneActual.toString(),
        tokensPerDeltaOneActual === tokensPerDeltaOneExpected,
        tokensPerDeltaOneActual === tokensPerDeltaOneExpected
          ? "tokensPerDeltaOne matches"
          : "tokensPerDeltaOne mismatch"
      )
    );
  }

  for (const [getterPath, expectedSpec] of Object.entries(config.wiring || {})) {
    const [contractName, getter] = getterPath.split(".");
    const contract = await hre.ethers.getContractAt(
      contractName === "TokenManager" ? deployment.contracts._tokenManagerImpl || "DeployableTokenManager" : contractName,
      deployment.contracts[contractName]
    );
    const actual = await contract[getter]();
    const expected = resolveExpectedValue(expectedSpec, context);
    assertions.push(
      makeAssertion(
        `wiring.${getterPath}`,
        expected,
        actual,
        addressesEqual(actual, expected),
        addressesEqual(actual, expected) ? "wiring matches" : "wiring mismatch"
      )
    );
  }

  for (const [contractName, roles] of Object.entries(config.roleAudit || {})) {
    const contract = await hre.ethers.getContractAt(contractName, deployment.contracts[contractName]);
    for (const [roleName, expectation] of Object.entries(roles)) {
      const actualHolders = await enumerateRoleHolders({
        contract,
        roleName,
        deployment,
        contractName,
        config,
      });
      const expectedHolders = resolveExpectedSet(expectation.expected || [], context);
      const missing = expectedHolders.filter((address) => !actualHolders.includes(address));
      const unexpected = actualHolders.filter((address) => !expectedHolders.includes(address));
      assertions.push(
        makeAssertion(
          `roleAudit.${contractName}.${roleName}.expected`,
          expectedHolders,
          { actual: actualHolders, missing, unexpected },
          missing.length === 0 && unexpected.length === 0,
          missing.length === 0 && unexpected.length === 0 ? "role holders match" : "role holders differ"
        )
      );

      const forbidden = resolveExpectedSet(expectation.forbidden || [], context);
      const forbiddenPresent = forbidden.filter((address) => actualHolders.includes(address));
      assertions.push(
        makeAssertion(
          `roleAudit.${contractName}.${roleName}.forbidden`,
          [],
          forbiddenPresent,
          forbiddenPresent.length === 0,
          forbiddenPresent.length === 0 ? "no forbidden holders present" : "forbidden holders still present"
        )
      );
    }
  }

  const failures = assertions.filter((entry) => !entry.passed);
  return {
    timestamp: new Date().toISOString(),
    network: hre.network.name,
    configPath: config.__resolvedConfigPath || null,
    deploymentPath: config.__resolvedDeploymentPath || null,
    overall: failures.length === 0 ? "pass" : "fail",
    assertions,
    failures,
  };
}

function formatDiff(report) {
  if (report.failures.length === 0) {
    return "PASS: launch posture matches expected config";
  }

  return [
    `FAIL: ${report.failures.length} launch posture assertion(s) failed`,
    ...report.failures.map((failure) => (
      `${failure.name}: expected ${JSON.stringify(failure.expected)}, actual ${JSON.stringify(failure.actual)}`
    )),
  ].join("\n");
}

function buildVerifyReportPaths(network, timestamp) {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  return {
    datedPath: path.resolve(process.cwd(), "deployments", `launch-posture-${network}-${safeTimestamp}.json`),
    latestPath: path.resolve(process.cwd(), "deployments", `launch-posture-${network}-latest.json`),
  };
}

function buildInitPlanPath(deploymentPath, network) {
  return path.join(path.dirname(path.resolve(deploymentPath)), `launch-posture-${network}-init-plan.json`);
}

function buildSafeTx(chainId, safeAddress, txs) {
  return {
    version: SAFE_TX_BUILDER_VERSION,
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: {
      name: "Launch posture initialization",
      description: "Generated by scripts/init-launch-posture.js",
    },
    transactions: txs.map((tx) => ({
      to: tx.to,
      value: "0",
      data: tx.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
    safe: safeAddress,
  };
}

async function planLaunchPostureInit({ hre, config, deployment }) {
  const contracts = await getContracts(hre, deployment);
  const context = { config, deployment };
  const plan = [];

  async function addPlanItem({ name, contract, contractName, method, args, skip, reason }) {
    if (skip) {
      return;
    }

    plan.push({
      name,
      contractName,
      to: await contract.getAddress(),
      method,
      args,
      reason,
      data: contract.interface.encodeFunctionData(method, args),
    });
  }

  const expectedAttesters = resolveExpectedSet(config.deltaVerifier.expectedAttesters || [], context);
  const actualAttesters = await enumerateAttesters({
    deltaVerifier: contracts.deltaVerifier,
    deployment,
    config,
  });
  for (const attester of expectedAttesters) {
    await addPlanItem({
      name: `addAttester:${attester}`,
      contractName: "DeltaVerifier",
      contract: contracts.deltaVerifier,
      method: "addAttester",
      args: [attester],
      skip: actualAttesters.includes(attester),
      reason: "Expected attester missing",
    });
  }
  for (const attester of actualAttesters) {
    if (!expectedAttesters.includes(attester)) {
      await addPlanItem({
        name: `removeAttester:${attester}`,
        contractName: "DeltaVerifier",
        contract: contracts.deltaVerifier,
        method: "removeAttester",
        args: [attester],
        skip: false,
        reason: "Unexpected attester present",
      });
    }
  }

  const threshold = await contracts.deltaVerifier.attesterThreshold();
  const expectedThreshold = BigInt(config.deltaVerifier.attesterThreshold);
  await addPlanItem({
    name: "setAttesterThreshold",
    contractName: "DeltaVerifier",
    contract: contracts.deltaVerifier,
    method: "setAttesterThreshold",
    args: [expectedThreshold],
    skip: threshold === expectedThreshold,
    reason: "Attester threshold mismatch",
  });

  for (const model of config.models || []) {
    const modelId = BigInt(model.modelId);
    const currentBudget = await contracts.deltaVerifier.mintBudgetRemaining(modelId);
    const expectedBudget = BigInt(model.expectedMintBudgetRemaining);
    await addPlanItem({
      name: `setMintBudget:${model.modelId}`,
      contractName: "DeltaVerifier",
      contract: contracts.deltaVerifier,
      method: "setMintBudget",
      args: [modelId, expectedBudget],
      skip: currentBudget === expectedBudget,
      reason: "Mint budget mismatch",
    });

    const currentGenesis = await contracts.modelRegistry.weightGenesis(modelId);
    if (currentGenesis !== ZERO_HASH && currentGenesis !== model.expectedWeightGenesis) {
      throw new Error(`Model ${model.modelId} weightGenesis already set to a different value`);
    }
    await addPlanItem({
      name: `setWeightGenesis:${model.modelId}`,
      contractName: "ModelRegistry",
      contract: contracts.modelRegistry,
      method: "setWeightGenesis",
      args: [modelId, model.expectedWeightGenesis],
      skip: currentGenesis === model.expectedWeightGenesis,
      reason: "Weight genesis not seeded",
    });
  }

  for (const [field, method] of [
    ["baseRewardRate", "setBaseRewardRate"],
    ["minImprovementBps", "setMinImprovementBps"],
    ["maxReward", "setMaxReward"],
  ]) {
    const actual = await contracts.deltaVerifier[field]();
    const expected = BigInt(config.deltaVerifier[field]);
    await addPlanItem({
      name: method,
      contractName: "DeltaVerifier",
      contract: contracts.deltaVerifier,
      method,
      args: [expected],
      skip: actual === expected,
      reason: `${field} mismatch`,
    });
  }

  // disableLegacyMints must be the final on-chain action: if any earlier step fails, the
  // canonical signed path (attesters, threshold, budget, genesis) is not yet functional, so
  // leaving legacy paths open keeps the system operational until the full plan succeeds.
  await addPlanItem({
    name: "disableLegacyMints",
    contractName: "DeltaVerifier",
    contract: contracts.deltaVerifier,
    method: "disableLegacyMints",
    args: [],
    skip: await contracts.deltaVerifier.legacyMintsDisabled(),
    reason: "Legacy SUBMITTER-only mint entrypoints must be disabled",
  });

  return {
    network: hre.network.name,
    timestamp: new Date().toISOString(),
    plan,
    deployment,
    config,
  };
}

async function executeLaunchPosturePlan({ signer, hre, plan, logger = console }) {
  const receipts = [];
  for (const step of plan.plan) {
    const contract = await hre.ethers.getContractAt(step.contractName, step.to, signer);
    const tx = await contract[step.method](...step.args);
    const receipt = await tx.wait();
    receipts.push({ step: step.name, hash: receipt.hash, blockNumber: receipt.blockNumber });
    logger.log(`${step.name}: ${receipt.hash}`);
  }
  return receipts;
}

module.exports = {
  ZERO_ADDRESS,
  ZERO_HASH,
  addressesEqual,
  assertLaunchPosture,
  buildInitPlanPath,
  buildSafeTx,
  buildVerifyReportPaths,
  executeLaunchPosturePlan,
  formatDiff,
  loadJson,
  loadLaunchPostureConfig,
  parseArgs,
  planLaunchPostureInit,
  resolveExpectedValue,
  saveJson,
};
