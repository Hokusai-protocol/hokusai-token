const fs = require("fs");
const path = require("path");
const { resolveArtifactPaths } = require("../lib/deployment-artifact");

const DEFAULT_POLICY_PATH = path.resolve(__dirname, "governance-policy.json");
const DEFAULT_ADMIN_SAFE = "0x158B985CC667b4E022AD05B99E89007790da66E2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAddress(value) {
  if (!value) {
    return null;
  }

  return value.toLowerCase();
}

function addressesEqual(a, b) {
  return normalizeAddress(a) === normalizeAddress(b);
}

function uniqAddresses(values) {
  return [...new Set(values.filter(Boolean).map((value) => normalizeAddress(value)))];
}

function getByPath(obj, dottedPath) {
  return dottedPath.split(".").reduce((current, segment) => current?.[segment], obj);
}

function resolveDeploymentPath(networkName) {
  return path.resolve(process.cwd(), "deployments", `${networkName}-latest.json`);
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return loadJson(policyPath);
}

function loadDeployment(deploymentPath) {
  return loadJson(path.resolve(process.cwd(), deploymentPath));
}

function writeDeployment(deploymentPath, deployment) {
  saveJson(path.resolve(process.cwd(), deploymentPath), deployment);
}

function getMinDelay(policy, networkName) {
  if (networkName === "mainnet") {
    return policy.defaults.mainnetMinDelay;
  }

  return policy.defaults.sepoliaMinDelay;
}

function getGovernanceContext({ deployment, policy, deployer }) {
  const adminSafe =
    process.env.ADMIN_SAFE_ADDRESS ||
    deployment.governance?.adminSafe ||
    policy.defaults.adminSafe ||
    DEFAULT_ADMIN_SAFE;
  const emergencySafe =
    process.env.EMERGENCY_SAFE_ADDRESS ||
    deployment.governance?.emergencySafe ||
    adminSafe;
  const timelock =
    process.env.TIMELOCK_ADDRESS ||
    deployment.governance?.timelock ||
    null;
  const minDelay =
    process.env.TIMELOCK_MIN_DELAY !== undefined
      ? Number(process.env.TIMELOCK_MIN_DELAY)
      : deployment.governance?.minDelay ?? getMinDelay(policy, deployment.network);

  return {
    adminSafe,
    emergencySafe,
    timelock,
    minDelay,
    deployer: deployer || deployment.deployer || null,
  };
}

function resolveExpectedValue(symbol, context) {
  if (Array.isArray(symbol)) {
    return symbol.flatMap((entry) => resolveExpectedValue(entry, context));
  }

  if (typeof symbol !== "string") {
    return symbol;
  }

  if (symbol === "TIMELOCK") {
    return context.timelock;
  }

  if (symbol === "ADMIN_SAFE") {
    return context.adminSafe;
  }

  if (symbol === "EMERGENCY_SAFE") {
    return context.emergencySafe;
  }

  if (symbol === "DEPLOYER") {
    return context.deployer;
  }

  if (symbol === "TREASURY") {
    return context.deployment.treasury;
  }

  if (symbol === "BACKEND_SERVICE") {
    return context.deployment.backendService;
  }

  if (symbol.startsWith("CONTRACT:")) {
    return context.deployment.contracts?.[symbol.slice("CONTRACT:".length)] || null;
  }

  if (symbol.startsWith("DEPLOYMENT_ROLE:")) {
    const [, contractName, roleName] = symbol.split(":");
    return context.deployment.roles?.[contractName]?.[roleName] || [];
  }

  if (symbol.startsWith("FIELD:")) {
    return getByPath(context.deployment, symbol.slice("FIELD:".length));
  }

  return symbol;
}

function resolveAddressSpec(spec, baseItem, context) {
  if (!spec) {
    return null;
  }

  if (spec.includes(".")) {
    return getByPath(baseItem, spec);
  }

  return baseItem?.[spec];
}

function expandContractSpecs(policy, deployment, governance) {
  const context = { deployment, ...governance };

  return policy.contracts.flatMap((entry) => {
    const collection = entry.collection ? deployment[entry.collection] || [] : [deployment];
    return collection
      .map((item, index) => {
        const address = resolveAddressSpec(entry.addressFrom, item, deployment);
        if (!address) {
          if (entry.optional) {
            return null;
          }

          throw new Error(`Missing address for ${entry.name} from ${entry.addressFrom}`);
        }

        return {
          policy: entry,
          instanceKey: entry.collection ? `${entry.name}[${index}]` : entry.name,
          address,
          abiName: entry.abiFrom ? getByPath(deployment, entry.abiFrom) : entry.abi,
          item,
          owner: entry.owner ? resolveExpectedValue(entry.owner, context) : null,
          roles: Object.fromEntries(
            Object.entries(entry.roles || {}).map(([roleName, holders]) => [
              roleName,
              uniqAddresses(resolveExpectedValue(holders, context)),
            ])
          ),
          setters: Object.fromEntries(
            Object.entries(entry.setters || {}).map(([field, setter]) => [
              field,
              {
                ...setter,
                expected: resolveExpectedValue(setter.expected, context),
              },
            ])
          ),
          checks: (entry.checks || []).map((check) => ({
            ...check,
            expected: resolveExpectedValue(check.expected, context),
            args: (check.args || []).map((arg) => resolveExpectedValue(arg, context)),
          })),
        };
      })
      .filter(Boolean);
  });
}

async function getRoleId(contract, roleName) {
  if (roleName === "DEFAULT_ADMIN_ROLE") {
    return ZERO_ROLE;
  }

  return contract[roleName]();
}

async function ensureHasRole({ contract, roleId, roleName, holder, dryRun, logger, actions }) {
  const hasRole = await contract.hasRole(roleId, holder);
  if (hasRole) {
    actions.push({ type: "grantRole", role: roleName, holder, status: "already-set" });
    return;
  }

  actions.push({ type: "grantRole", role: roleName, holder, status: dryRun ? "planned" : "sent" });
  if (!dryRun) {
    const tx = await contract.grantRole(roleId, holder);
    await tx.wait();
    logger.log(`Granted ${roleName} to ${holder}`);
  }
}

async function ensureSetter({ contract, field, method, expected, dryRun, logger, actions }) {
  const current = await contract[field]();
  if (addressesEqual(current, expected)) {
    actions.push({ type: "setter", field, expected, status: "already-set" });
    return;
  }

  actions.push({ type: "setter", field, expected, status: dryRun ? "planned" : "sent" });
  if (!dryRun) {
    const tx = await contract[method](expected);
    await tx.wait();
    logger.log(`Updated ${field} to ${expected}`);
  }
}

async function ensureOwner({ contract, targetOwner, dryRun, logger, actions }) {
  const currentOwner = await contract.owner();
  if (addressesEqual(currentOwner, targetOwner)) {
    actions.push({ type: "transferOwnership", targetOwner, status: "already-set" });
    return;
  }

  actions.push({ type: "transferOwnership", targetOwner, status: dryRun ? "planned" : "sent" });
  if (!dryRun) {
    const tx = await contract.transferOwnership(targetOwner);
    await tx.wait();
    logger.log(`Transferred ownership to ${targetOwner}`);
  }
}

async function renounceRoleIfHeld({ contract, roleId, roleName, deployer, dryRun, logger, actions }) {
  const hasRole = await contract.hasRole(roleId, deployer);
  if (!hasRole) {
    actions.push({ type: "renounceRole", role: roleName, status: "not-held" });
    return;
  }

  actions.push({ type: "renounceRole", role: roleName, status: dryRun ? "planned" : "sent" });
  if (!dryRun) {
    const tx = await contract.renounceRole(roleId, deployer);
    await tx.wait();
    logger.log(`Renounced ${roleName} from ${deployer}`);
  }
}

async function verifyTimelockRoles(timelock, governance) {
  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const adminRole = await timelock.TIMELOCK_ADMIN_ROLE();

  const checks = [
    {
      check: "adminSafe proposer",
      pass: await timelock.hasRole(proposerRole, governance.adminSafe),
    },
    {
      check: "adminSafe executor",
      pass: await timelock.hasRole(executorRole, governance.adminSafe),
    },
    {
      check: "adminSafe canceller",
      pass: await timelock.hasRole(cancellerRole, governance.adminSafe),
    },
    {
      check: "deployer timelock admin revoked",
      pass: !(await timelock.hasRole(adminRole, governance.deployer)),
    },
  ];

  const failures = checks.filter((entry) => !entry.pass);
  if (failures.length > 0) {
    throw new Error(`Timelock pre-flight failed: ${failures.map((entry) => entry.check).join(", ")}`);
  }
}

async function runGovernanceTransfer({ hre, deployment, policy, dryRun = false, logger = console }) {
  const [signer] = await hre.ethers.getSigners();
  const governance = getGovernanceContext({
    deployment,
    policy,
    deployer: signer.address,
  });

  if (!governance.timelock) {
    throw new Error("Missing governance.timelock in deployment or TIMELOCK_ADDRESS env");
  }

  const code = await hre.ethers.provider.getCode(governance.timelock);
  if (code === "0x") {
    throw new Error(`No contract deployed at timelock address ${governance.timelock}`);
  }

  const timelock = await hre.ethers.getContractAt("HokusaiTimelockController", governance.timelock);
  await verifyTimelockRoles(timelock, governance);

  const specs = expandContractSpecs(policy, deployment, governance);
  const actions = [];

  for (const spec of specs) {
    const contract = await hre.ethers.getContractAt(spec.abiName, spec.address);

    for (const [roleName, holders] of Object.entries(spec.roles)) {
      const roleId = await getRoleId(contract, roleName);
      for (const holder of holders) {
        await ensureHasRole({
          contract,
          roleId,
          roleName,
          holder,
          dryRun,
          logger,
          actions,
        });
      }
    }

    for (const [field, setter] of Object.entries(spec.setters)) {
      await ensureSetter({
        contract,
        field,
        method: setter.method,
        expected: setter.expected,
        dryRun,
        logger,
        actions,
      });
    }

    if (spec.owner) {
      await ensureOwner({
        contract,
        targetOwner: spec.owner,
        dryRun,
        logger,
        actions,
      });
    }

    for (const revoked of spec.policy.revokedFromDeployer || []) {
      if (revoked === "owner") {
        continue;
      }

      const roleId = await getRoleId(contract, revoked);
      await renounceRoleIfHeld({
        contract,
        roleId,
        roleName: revoked,
        deployer: governance.deployer,
        dryRun,
        logger,
        actions,
      });
    }
  }

  deployment.governance = {
    ...(deployment.governance || {}),
    adminSafe: governance.adminSafe,
    emergencySafe: governance.emergencySafe,
    timelock: governance.timelock,
    minDelay: governance.minDelay,
    transferredAt: nowIso(),
    dryRun,
    actionCount: actions.length,
  };

  return { governance, actions, deployment };
}

async function verifyGovernance({ hre, deployment, policy }) {
  const signers = await hre.ethers.getSigners();
  const governance = getGovernanceContext({
    deployment,
    policy,
    deployer: signers[0]?.address || deployment.deployer,
  });
  const checks = [];
  const pushCheck = (entry) => {
    checks.push(entry);
  };

  if (!governance.timelock) {
    throw new Error("Missing governance.timelock in deployment or TIMELOCK_ADDRESS env");
  }

  const timelock = await hre.ethers.getContractAt("HokusaiTimelockController", governance.timelock);
  const proposerRole = await timelock.PROPOSER_ROLE();
  const executorRole = await timelock.EXECUTOR_ROLE();
  const cancellerRole = await timelock.CANCELLER_ROLE();
  const adminRole = await timelock.TIMELOCK_ADMIN_ROLE();
  const timelockChecks = [
    ["Timelock", "PROPOSER_ROLE", governance.adminSafe, await timelock.hasRole(proposerRole, governance.adminSafe)],
    ["Timelock", "EXECUTOR_ROLE", governance.adminSafe, await timelock.hasRole(executorRole, governance.adminSafe)],
    ["Timelock", "CANCELLER_ROLE", governance.adminSafe, await timelock.hasRole(cancellerRole, governance.adminSafe)],
    ["Timelock", "TIMELOCK_ADMIN_ROLE", governance.deployer, !(await timelock.hasRole(adminRole, governance.deployer))],
  ];

  for (const [contractName, check, expected, pass] of timelockChecks) {
    pushCheck({
      contract: contractName,
      check,
      expected,
      actual: pass ? expected : "missing",
      status: pass ? "pass" : "fail",
    });
  }

  const specs = expandContractSpecs(policy, deployment, governance);
  for (const spec of specs) {
    const contract = await hre.ethers.getContractAt(spec.abiName, spec.address);
    if (spec.owner) {
      const actualOwner = await contract.owner();
      pushCheck({
        contract: spec.instanceKey,
        check: "owner",
        expected: spec.owner,
        actual: actualOwner,
        status: addressesEqual(actualOwner, spec.owner) ? "pass" : "fail",
      });
    }

    for (const [roleName, holders] of Object.entries(spec.roles)) {
      const roleId = await getRoleId(contract, roleName);
      for (const holder of holders) {
        const hasRole = await contract.hasRole(roleId, holder);
        pushCheck({
          contract: spec.instanceKey,
          check: roleName,
          expected: holder,
          actual: hasRole ? holder : ZERO_ADDRESS,
          status: hasRole ? "pass" : "fail",
        });
      }
    }

    for (const [field, setter] of Object.entries(spec.setters)) {
      const actual = await contract[field]();
      pushCheck({
        contract: spec.instanceKey,
        check: field,
        expected: setter.expected,
        actual,
        status: addressesEqual(actual, setter.expected) ? "pass" : "fail",
      });
    }

    for (const check of spec.checks) {
      if (check.type === "equals") {
        const actual = await contract[check.method]();
        pushCheck({
          contract: spec.instanceKey,
          check: check.method,
          expected: check.expected,
          actual,
          status: addressesEqual(actual, check.expected) ? "pass" : "fail",
        });
      } else if (check.type === "mappingBool") {
        const actual = await contract[check.method](...check.args);
        pushCheck({
          contract: spec.instanceKey,
          check: `${check.method}(${check.args.join(",")})`,
          expected: String(check.expected),
          actual: String(actual),
          status: actual === check.expected ? "pass" : "fail",
        });
      }
    }

    for (const revoked of spec.policy.revokedFromDeployer || []) {
      if (revoked === "owner") {
        if (!spec.owner) {
          continue;
        }

        const actualOwner = await contract.owner();
        pushCheck({
          contract: spec.instanceKey,
          check: "deployer-owner-revoked",
          expected: `not ${governance.deployer}`,
          actual: actualOwner,
          status: !addressesEqual(actualOwner, governance.deployer) ? "pass" : "fail",
        });
        continue;
      }

      const roleId = await getRoleId(contract, revoked);
      const hasRole = await contract.hasRole(roleId, governance.deployer);
      pushCheck({
        contract: spec.instanceKey,
        check: `deployer-${revoked}-revoked`,
        expected: "false",
        actual: String(hasRole),
        status: hasRole ? "fail" : "pass",
      });
    }
  }

  const overall = checks.every((check) => check.status === "pass") ? "pass" : "fail";
  return {
    network: deployment.network,
    timestamp: nowIso(),
    overall,
    checks,
  };
}

function buildGovernanceReportPaths(network, timestamp) {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const baseDir = path.resolve(process.cwd(), "deployments");
  return {
    datedPath: path.join(baseDir, `governance-verification-${network}-${safeTimestamp}.json`),
    latestPath: path.join(baseDir, `governance-verification-${network}-latest.json`),
  };
}

function buildTimelockArtifactPaths(network, timestamp) {
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const baseDir = path.resolve(process.cwd(), "deployments");
  return {
    datedPath: path.join(baseDir, `${network}-timelock-${safeTimestamp}.json`),
    latestDeploymentPath: resolveDeploymentPath(network),
  };
}

module.exports = {
  DEFAULT_ADMIN_SAFE,
  DEFAULT_POLICY_PATH,
  ZERO_ROLE,
  addressesEqual,
  buildGovernanceReportPaths,
  buildTimelockArtifactPaths,
  expandContractSpecs,
  getGovernanceContext,
  getMinDelay,
  loadDeployment,
  loadPolicy,
  nowIso,
  resolveDeploymentPath,
  runGovernanceTransfer,
  saveJson,
  verifyGovernance,
  writeDeployment,
};
