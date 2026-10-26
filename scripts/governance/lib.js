const fs = require("fs");
const path = require("path");
const { getDeploySigner } = require("../lib/get-deploy-signer");

const DEFAULT_POLICY_PATH = path.resolve(__dirname, "governance-policy.json");
const DEFAULT_ADMIN_SAFE = "0x158B985CC667b4E022AD05B99E89007790da66E2";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";
// ERC-1967 storage slots read directly, since a transparent proxy's admin/implementation
// getters are only callable by its admin.
const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ERC1967_ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

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
  // The DeltaVerifier SUBMITTER_ROLE holder (backend delta submitter). Canonical source is the
  // deployment artifact (governance.submitterRelayer); env/backendService are convenience fallbacks
  // for mainnet ops. Resolves the policy "RELAYER" symbol so the handoff grants SUBMITTER to the
  // relayer and revokes the deployer's bootstrap SUBMITTER in one pass (not re-granting the deployer).
  const submitterRelayer =
    process.env.SUBMITTER_RELAYER_ADDRESS ||
    deployment.governance?.submitterRelayer ||
    process.env.MAINNET_BACKEND_ADDRESS ||
    deployment.backendService ||
    null;

  return {
    adminSafe,
    emergencySafe,
    timelock,
    minDelay,
    submitterRelayer,
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

  if (symbol === "RELAYER") {
    return context.submitterRelayer;
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

// Every role the policy names for a contract (expected holders or deployer revocations),
// minus roles the policy deliberately assigns to the deployer. Post-handoff the deployer
// must hold none of these.
function deployerRevokedRoles(spec, deployer) {
  const roleNames = new Set([
    ...Object.keys(spec.roles),
    ...(spec.policy.revokedFromDeployer || []).filter((entry) => entry !== "owner"),
  ]);
  return [...roleNames].filter(
    (roleName) => !(spec.roles[roleName] || []).some((holder) => addressesEqual(holder, deployer))
  );
}

// Roles (and ownership) the policy resolves to the deployer without naming it.
// A symbol such as TREASURY, RELAYER or DEPLOYMENT_ROLE:... that falls back to
// the deployer would exempt it from revocation, so the handoff and the
// verifier both treat that as a failure. Only the literal DEPLOYER symbol may
// hand the deployer a post-handoff role.
function deployerHolderViolations(spec, deployer) {
  if (!deployer) return [];
  const violations = [];
  for (const [roleName, holders] of Object.entries(spec.roles)) {
    const symbols = [spec.policy.roles?.[roleName]].flat();
    if (symbols.includes("DEPLOYER")) continue;
    if (holders.some((holder) => addressesEqual(holder, deployer))) {
      violations.push(`${spec.instanceKey}.${roleName}`);
    }
  }
  if (spec.owner && spec.policy.owner !== "DEPLOYER" && addressesEqual(spec.owner, deployer)) {
    violations.push(`${spec.instanceKey}.owner`);
  }
  return violations;
}

function expectedList(expected) {
  return (Array.isArray(expected) ? expected : [expected]).flat().filter(Boolean);
}

async function readSlotAddress(provider, address, slot) {
  const raw = await provider.getStorage(address, slot);
  return `0x${raw.slice(-40)}`;
}

async function getRoleId(contract, roleName) {
  if (roleName === "DEFAULT_ADMIN_ROLE") {
    return ZERO_ROLE;
  }

  return contract[roleName]();
}

async function ensureHasRole({ contract, roleId, roleName, holder, signerAddress, dryRun, logger, actions }) {
  const hasRole = await contract.hasRole(roleId, holder);
  if (hasRole) {
    actions.push({ type: "grantRole", role: roleName, holder, status: "already-set" });
    return;
  }

  // The deployer can only grant a role it administers. Some contracts' role admin is held by
  // another authority the deployer doesn't control — e.g. HokusaiParams grants DEFAULT_ADMIN_ROLE
  // to the TokenManager (its deployer) and GOV_ROLE to the governor, and TokenManager exposes no
  // params role-management method, so those roles are not the deployer's to grant. Flag instead of
  // reverting ("AccessControl: account ... is missing role"); the post-handoff verify gates confirm
  // the final role assignment.
  if (signerAddress) {
    const adminRole = await contract.getRoleAdmin(roleId);
    const canGrant = await contract.hasRole(adminRole, signerAddress);
    if (!canGrant) {
      actions.push({ type: "grantRole", role: roleName, holder, status: "skipped-not-admin" });
      logger.log(
        `SKIP grantRole ${roleName} -> ${holder}: deployer ${signerAddress} does not administer this role on this contract.`
      );
      return;
    }
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

async function ensureOwner({ contract, targetOwner, signerAddress, dryRun, logger, actions }) {
  const currentOwner = await contract.owner();
  if (addressesEqual(currentOwner, targetOwner)) {
    actions.push({ type: "transferOwnership", targetOwner, status: "already-set" });
    return;
  }

  // The deployer can only transfer ownership of contracts it currently owns. Per-model
  // HokusaiTokens are owned by the governor (the admin Safe on mainnet, set by the factory at
  // creation), NOT the deployer — so the deployer handoff must not attempt to move them
  // (transferOwnership would revert "Ownable: caller is not the owner"). Flag it instead; if a
  // transfer is actually intended it must be done by the current owner (the Safe), and the
  // post-handoff verify-governance / posture gates confirm the final ownership regardless.
  if (signerAddress && !addressesEqual(currentOwner, signerAddress)) {
    actions.push({ type: "transferOwnership", targetOwner, currentOwner, status: "skipped-not-owner" });
    logger.log(
      `SKIP transferOwnership: contract owned by ${currentOwner} (not the deployer ${signerAddress}); ` +
        `expected ${targetOwner}. Must be transferred by the current owner if intended.`
    );
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

async function anyRole(contract, roleIds, account) {
  for (const roleId of roleIds) {
    if (await contract.hasRole(roleId, account)) return true;
  }
  return false;
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
    {
      check: "deployer holds no proposer/executor/canceller role",
      pass: !(await anyRole(timelock, [proposerRole, executorRole, cancellerRole], governance.deployer)),
    },
  ];

  const failures = checks.filter((entry) => !entry.pass);
  if (failures.length > 0) {
    throw new Error(`Timelock pre-flight failed: ${failures.map((entry) => entry.check).join(", ")}`);
  }
}

async function runGovernanceTransfer({ hre, deployment, policy, dryRun = false, logger = console }) {
  // KMS-aware signer: mainnet + sepolia sign via KMS_DEPLOYER_KEY_ID, so the hardhat
  // `accounts` array is empty and ethers.getSigners() returns nothing. getDeploySigner falls
  // back to getSigners()[0] when no KMS key is configured (local/CI with DEPLOYER_PRIVATE_KEY).
  const signer = await getDeploySigner(hre);
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

  const timelock = await hre.ethers.getContractAt("HokusaiTimelockController", governance.timelock, signer);
  await verifyTimelockRoles(timelock, governance);

  const specs = expandContractSpecs(policy, deployment, governance);
  const deployerHeld = specs.flatMap((spec) => deployerHolderViolations(spec, governance.deployer));
  if (deployerHeld.length > 0) {
    throw new Error(`Policy resolves these to the deployer ${governance.deployer}: ${deployerHeld.join(", ")}`);
  }
  const actions = [];

  for (const spec of specs) {
    // Connect each target to the KMS deploy signer so the (irreversible) role/owner transfer
    // transactions are sent by the current admin/owner (the deployer), not a missing default signer.
    const contract = await hre.ethers.getContractAt(spec.abiName, spec.address, signer);

    for (const [roleName, holders] of Object.entries(spec.roles)) {
      const roleId = await getRoleId(contract, roleName);
      for (const holder of holders) {
        await ensureHasRole({
          contract,
          roleId,
          roleName,
          holder,
          signerAddress: governance.deployer,
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
        signerAddress: governance.deployer,
        dryRun,
        logger,
        actions,
      });
    }

    for (const revoked of deployerRevokedRoles(spec, governance.deployer)) {
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
  // The deployer under audit is the one recorded in the artifact, not whichever
  // key happens to be loaded (a Ledger or KMS deploy leaves getSigners() empty
  // or different, which would audit the wrong address).
  const signers = await hre.ethers.getSigners();
  const deployer = deployment.deployer || signers[0]?.address;
  if (!deployer) {
    throw new Error("Missing deployer in deployment artifact");
  }
  const governance = getGovernanceContext({ deployment, policy, deployer });
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
    [
      "Timelock",
      "deployer-proposer/executor/canceller-revoked",
      governance.deployer,
      !(await anyRole(timelock, [proposerRole, executorRole, cancellerRole], governance.deployer)),
    ],
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

  // On mainnet, the policy floor rather than the (env-overridable) configured
  // delay; rehearsal networks may run shorter delays, checked against the
  // recorded one.
  const minDelayFloor = BigInt(
    deployment.network === "mainnet" ? policy.defaults.mainnetMinDelay : governance.minDelay
  );
  const actualMinDelay = await timelock.getMinDelay();
  pushCheck({
    contract: "Timelock",
    check: "minDelay",
    expected: `>= ${minDelayFloor}`,
    actual: String(actualMinDelay),
    status: actualMinDelay >= minDelayFloor ? "pass" : "fail",
  });

  // Pools created after the artifact was written would otherwise go unchecked.
  if (deployment.contracts?.HokusaiAMMFactory && policy.contracts.some((entry) => entry.collection === "pools")) {
    const factory = await hre.ethers.getContractAt("HokusaiAMMFactory", deployment.contracts.HokusaiAMMFactory);
    const onChain = await factory.poolCount();
    const recorded = (deployment.pools || []).length;
    pushCheck({
      contract: "HokusaiAMMFactory",
      check: "poolCount matches deployment.pools",
      expected: String(recorded),
      actual: String(onChain),
      status: onChain === BigInt(recorded) ? "pass" : "fail",
    });
  }

  const specs = expandContractSpecs(policy, deployment, governance);
  for (const spec of specs) {
    for (const violation of deployerHolderViolations(spec, governance.deployer)) {
      pushCheck({
        contract: spec.instanceKey,
        check: "expected holder is not the deployer",
        expected: `not ${governance.deployer}`,
        actual: violation,
        status: "fail",
      });
    }
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
        const expected = expectedList(check.expected);
        pushCheck({
          contract: spec.instanceKey,
          check: check.method,
          expected: expected.join(" | "),
          actual,
          status: expected.some((value) => addressesEqual(actual, value)) ? "pass" : "fail",
        });
      } else if (check.type === "proxyImplementation" || check.type === "proxyAdmin") {
        const slot = check.type === "proxyAdmin" ? ERC1967_ADMIN_SLOT : ERC1967_IMPLEMENTATION_SLOT;
        const actual = await readSlotAddress(hre.ethers.provider, spec.address, slot);
        const expected = expectedList(check.expected);
        pushCheck({
          contract: spec.instanceKey,
          check: check.type,
          expected: expected.join(" | "),
          actual,
          status: expected.some((value) => addressesEqual(actual, value)) ? "pass" : "fail",
        });
      } else if (check.type === "registryPool") {
        // The registry binding is the pool's TokenManager mint/burn authority (HOK-3283).
        const registry = await hre.ethers.getContractAt("ModelRegistry", deployment.contracts.ModelRegistry);
        const actual = await registry.getPool(spec.item.modelId);
        pushCheck({
          contract: spec.instanceKey,
          check: `ModelRegistry.getPool(${spec.item.modelId})`,
          expected: spec.address,
          actual,
          status: addressesEqual(actual, spec.address) ? "pass" : "fail",
        });
      } else if (check.type === "notRoleHolder") {
        const target = await hre.ethers.getContractAt(
          check.abiFrom ? getByPath(deployment, check.abiFrom) : check.contract,
          deployment.contracts[check.contract]
        );
        const hasRole = await target.hasRole(await getRoleId(target, check.role), spec.address);
        pushCheck({
          contract: spec.instanceKey,
          check: `${check.contract}.${check.role} not held`,
          expected: "false",
          actual: String(hasRole),
          status: hasRole ? "fail" : "pass",
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

    if (spec.owner && (spec.policy.revokedFromDeployer || []).includes("owner")) {
      const actualOwner = await contract.owner();
      pushCheck({
        contract: spec.instanceKey,
        check: "deployer-owner-revoked",
        expected: `not ${governance.deployer}`,
        actual: actualOwner,
        status: !addressesEqual(actualOwner, governance.deployer) ? "pass" : "fail",
      });
    }

    for (const revoked of deployerRevokedRoles(spec, governance.deployer)) {
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
