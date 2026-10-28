// HOK-3290: Sepolia rehearsal of the upgradeable-AMM redeploy, run in phases
// because the timelock steps need the admin Safe (2-of-3, signed by people).
//
// The launch itself runs through the conductor (see docs/redeploy-rehearsal-runbook.md);
// this driver covers what comes around it:
//
//   HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js <phase>
//
//   trade       deployer whitelists itself, buys HMESS through graduation and
//               HLEAD below it (before the handoff, while it holds the
//               whitelist admin role)
//   fees        backend key settles a fee through UsageFeeRouter
//   sell        after the 1-day IBR: deployer sells HMESS back below the threshold
//   upgrade-1   deploy the V2 mock; Safe bundle: schedule the upgrade
//   upgrade-2   check it is queued; Safe bundle: cancel it
//   upgrade-3   check it is cancelled; Safe bundle: pause HMESS, schedule the
//               upgrade again and an unpause
//   upgrade-4   after the delay: show the upgrade cannot execute while paused
//               (simulated from the timelock and the Safe, and a direct Safe
//               call); Safe bundle: execute unpause then upgrade
//   upgrade-5   check V2, state, Upgraded event, untouched HLEAD, a trade;
//               Safe bundle: schedule freeze
//   upgrade-6   after the delay; Safe bundle: execute freeze
//   final       check the freeze and that a further upgrade cannot execute,
//               approve V2 in the artifact, verify-governance, records, report
//
// Safe bundles are written to the run directory for the Transaction Builder.
// Each phase checks the previous one's on-chain result before continuing.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const { getDeploySigner, getKmsSigner } = require("../lib/get-deploy-signer");
const { loadPolicy, verifyGovernance } = require("../governance/lib");
const tl = require("../lib/timelock-ops");
const ops = require("../lib/pool-upgrade-ops");

const ROOT = path.resolve(__dirname, "..", "..");
const DEPLOYMENT_PATH = path.join(ROOT, "deployments", "sepolia-latest.json");
const RUN_DIR = path.join(ROOT, "deployments", "rehearsal", process.env.REHEARSAL_RUN || "sepolia");
const STATE_PATH = path.join(RUN_DIR, "state.json");
const UPGRADE_MODEL = "28"; // HMESS
const UNTOUCHED_MODEL = "27"; // HLEAD
const V2_MARKER = 3290;
const DEADLINE = 9999999999n;

const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const usd = (v) => ethers.formatUnits(v, 6);

function loadState() {
  return fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) : { checks: [], txs: [], gas: {} };
}
function saveState(state) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(STATE_PATH, json(state) + "\n");
}

function makeCheck(state, phase) {
  return (name, ok, details) => {
    // A rerun of a phase replaces its earlier result for the same check.
    state.checks = state.checks.filter((c) => c.phase !== phase || c.name !== name);
    state.checks.push({ phase, name, ok: Boolean(ok), details: details === undefined ? "" : String(details) });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${details === undefined ? "" : "  " + details}`);
    if (!ok) throw new Error(`Check failed: ${name}`);
  };
}

async function sendTx(state, label, txPromise) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  state.txs.push({ label, hash: receipt.hash, block: receipt.blockNumber, gasUsed: receipt.gasUsed });
  console.log(`  tx ${label}: ${receipt.hash}`);
  return receipt;
}

async function simulateRevert({ from, to, data }) {
  try {
    await ethers.provider.call({ from, to, data });
    return { reverted: false };
  } catch (error) {
    return { reverted: true, reason: error.shortMessage || error.reason || error.message };
  }
}

function writeBundle(state, chainId, name, calls) {
  const bundle = tl.safeBundle({
    chainId,
    safe: state.adminSafe,
    name: `HOK-3290 ${name}`,
    description: calls.map((c) => c.label).join("; "),
    calls,
  });
  const file = path.join(RUN_DIR, `safe-${name}.json`);
  fs.writeFileSync(file, json(bundle) + "\n");
  console.log(`\n  Safe bundle: ${path.relative(ROOT, file)}`);
  for (const c of calls) console.log(`    - ${c.label}`);
  console.log("  Load it in the Safe Transaction Builder, sign 2-of-3 and execute, then run the next phase.");
}

async function context() {
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT_PATH, "utf8"));
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 11155111n) throw new Error(`Expected Sepolia, got chain ${net.chainId}`);
  const governance = deployment.governance || {};
  const timelockAddress = governance.timelock || process.env.TIMELOCK_ADDRESS;
  if (!timelockAddress) throw new Error("No timelock in the Sepolia artifact or TIMELOCK_ADDRESS");
  const poolOf = (modelId) => {
    const pool = deployment.pools.find((p) => p.modelId === modelId);
    if (!pool) throw new Error(`No pool for model ${modelId} in ${DEPLOYMENT_PATH}`);
    return pool;
  };
  const upgradeEntry = poolOf(UPGRADE_MODEL);
  const untouchedEntry = poolOf(UNTOUCHED_MODEL);
  const timelock = new ethers.Contract(timelockAddress, tl.TIMELOCK_ABI, ethers.provider);
  return {
    deployment,
    chainId: net.chainId,
    timelockAddress,
    timelock,
    minDelay: await timelock.getMinDelay(),
    adminSafe: governance.adminSafe || process.env.ADMIN_SAFE_ADDRESS,
    factory: deployment.contracts.HokusaiAMMFactory,
    proxyAdminAddress: deployment.contracts.PoolProxyAdmin,
    upgradeEntry,
    untouchedEntry,
    usdc: await ethers.getContractAt("MockUSDC", deployment.config.reserveToken),
  };
}

function ops2(ctx, state) {
  const upgradeArgs = {
    proxyAdmin: ctx.proxyAdminAddress,
    factory: ctx.factory,
    modelId: UPGRADE_MODEL,
    pool: ctx.upgradeEntry.ammAddress,
    implementation: state.v2Implementation,
    v2Marker: V2_MARKER,
  };
  return {
    upgradeArgs,
    op1: tl.batchOp(ethers, { calls: ops.upgradeCalls(ethers, upgradeArgs), salt: `${state.saltPrefix} upgrade #1` }),
    op2: tl.batchOp(ethers, { calls: ops.upgradeCalls(ethers, upgradeArgs), salt: `${state.saltPrefix} upgrade #2` }),
    op3: tl.batchOp(ethers, {
      calls: [ops.unpauseCall(ethers, { factory: ctx.factory, modelId: UPGRADE_MODEL })],
      salt: `${state.saltPrefix} unpause`,
    }),
    op4: tl.batchOp(ethers, {
      calls: [ops.freezeCall(ethers, { proxyAdmin: ctx.proxyAdminAddress, modelId: UPGRADE_MODEL, pool: ctx.upgradeEntry.ammAddress })],
      salt: `${state.saltPrefix} freeze`,
    }),
  };
}

const PHASES = {
  async trade(ctx, state, check) {
    const deployer = await getDeploySigner(hre);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress, deployer);
    const other = await ethers.getContractAt("HokusaiAMM", ctx.untouchedEntry.ammAddress, deployer);
    const whitelist = await ethers.getContractAt("PurchaserWhitelist", ctx.deployment.contracts.PurchaserWhitelist, deployer);
    const usdc = ctx.usdc.connect(deployer);
    if (!(await whitelist.isWhitelisted(await deployer.getAddress()))) {
      await sendTx(state, "whitelist deployer", whitelist.addToWhitelist(await deployer.getAddress()));
    }
    await sendTx(state, "mint MockUSDC", usdc.mint(await deployer.getAddress(), ethers.parseUnits("40000", 6)));
    await sendTx(state, "approve HMESS pool", usdc.approve(ctx.upgradeEntry.ammAddress, ethers.MaxUint256));
    await sendTx(state, "approve HLEAD pool", usdc.approve(ctx.untouchedEntry.ammAddress, ethers.MaxUint256));
    for (let i = 1; i <= 3; i++) {
      const receipt = await sendTx(state, `buy HMESS $9000 #${i}`, pool.buy(ethers.parseUnits("9000", 6), 0, await deployer.getAddress(), DEADLINE));
      state.gas[`buy${i}`] = receipt.gasUsed;
    }
    check("HMESS graduated by buys", await pool.hasGraduated(), `reserve $${usd(await pool.reserveBalance())}`);
    check("spot after graduation is at or above the flat price",
      (await pool.spotPrice()) >= (await pool.FLAT_CURVE_PRICE()), `$${usd(await pool.spotPrice())}`);
    await sendTx(state, "buy HLEAD $1000", other.buy(ethers.parseUnits("1000", 6), 0, await deployer.getAddress(), DEADLINE));
    check("HLEAD stays in the flat phase", !(await other.hasGraduated()));
    check("sells blocked during the IBR", !(await pool.isSellEnabled()));
  },

  async fees(ctx, state, check) {
    const backend = await getKmsSigner(hre, "BACKEND");
    const router = await ethers.getContractAt("UsageFeeRouter", ctx.deployment.contracts.UsageFeeRouter, backend);
    const reserve = await ethers.getContractAt("InfrastructureReserve", ctx.deployment.contracts.InfrastructureReserve);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress);
    const fee = ethers.parseUnits("1000", 6);
    await sendTx(state, "mint MockUSDC to backend", ctx.usdc.connect(backend).mint(await backend.getAddress(), fee));
    await sendTx(state, "backend approves router", ctx.usdc.connect(backend).approve(await router.getAddress(), fee));
    const before = {
      pool: await pool.reserveBalance(),
      infra: await reserve.accrued(UPGRADE_MODEL),
      treasury: await ctx.usdc.balanceOf(ctx.deployment.treasury),
    };
    const receipt = await sendTx(state, "router.depositFee HMESS $1000", router.depositFee(UPGRADE_MODEL, fee, 100));
    state.gas.depositFee = receipt.gasUsed;
    const toPool = (await pool.reserveBalance()) - before.pool;
    const toInfra = (await reserve.accrued(UPGRADE_MODEL)) - before.infra;
    const toTreasury = (await ctx.usdc.balanceOf(ctx.deployment.treasury)) - before.treasury;
    check("fee settlement conserves the deposit", toPool + toInfra + toTreasury === fee,
      `pool $${usd(toPool)} infra $${usd(toInfra)} treasury $${usd(toTreasury)}`);
    check("router holds no USDC", (await ctx.usdc.balanceOf(await router.getAddress())) === 0n);
  },

  async sell(ctx, state, check) {
    const deployer = await getDeploySigner(hre);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress, deployer);
    const token = await ethers.getContractAt("HokusaiToken", ctx.upgradeEntry.tokenAddress, deployer);
    check("sells enabled after the IBR", await pool.isSellEnabled());
    await sendTx(state, "approve HMESS tokens", token.approve(ctx.upgradeEntry.ammAddress, ethers.MaxUint256));
    const threshold = await pool.FLAT_CURVE_THRESHOLD();
    let sells = 0;
    while ((await pool.reserveBalance()) >= threshold && sells < 20) {
      let chunk = await token.balanceOf(await deployer.getAddress());
      const cap = await pool.maxTradeSize();
      while ((await pool.getSellQuote(chunk)) > cap) chunk /= 2n;
      const receipt = await sendTx(state, `sell HMESS #${sells + 1}`, pool.sell(chunk, 0, await deployer.getAddress(), DEADLINE));
      state.gas.sell ||= receipt.gasUsed;
      sells++;
    }
    check("graduated pool sells back below the threshold",
      (await pool.hasGraduated()) && (await pool.reserveBalance()) < threshold,
      `${sells} sells, reserve $${usd(await pool.reserveBalance())}`);
  },

  async "upgrade-1"(ctx, state, check) {
    const deployer = await getDeploySigner(hre);
    check("PoolProxyAdmin is owned by the timelock",
      (await (await ethers.getContractAt("HokusaiPoolProxyAdmin", ctx.proxyAdminAddress)).owner()) === ctx.timelockAddress);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress);
    const proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", ctx.proxyAdminAddress);
    const pauseReader = await ethers.getContractAt("PoolPauseReader", await proxyAdmin.pauseReader());
    check("HMESS exit is open (unpaused, IBR over)", await pauseReader.canExit(await pool.getAddress()));
    if (!state.v2Implementation) {
      const v2 = await (await ethers.getContractFactory("HokusaiAMMV2Mock", deployer)).deploy();
      await v2.waitForDeployment();
      state.v2Implementation = await v2.getAddress();
      state.txs.push({ label: "deploy HokusaiAMMV2Mock", hash: v2.deploymentTransaction().hash });
    }
    state.saltPrefix ||= `HOK-3290 sepolia ${new Date().toISOString()}`;
    state.originalImplementation = (await ops.proxySlots(ethers.provider, ctx.upgradeEntry.ammAddress)).implementation;
    state.untouchedImplementation = (await ops.proxySlots(ethers.provider, ctx.untouchedEntry.ammAddress)).implementation;
    state.stateBeforeUpgrade = {
      reserve: await pool.reserveBalance(),
      graduationSupply: await pool.graduationSupply(),
      anchorBasisSupply: await pool.anchorBasisSupply(),
      treasury: await pool.treasury(),
      owner: await pool.owner(),
    };
    const { op1 } = ops2(ctx, state);
    writeBundle(state, ctx.chainId, "01-schedule-upgrade", [tl.scheduleCall(ethers, ctx.timelockAddress, op1, ctx.minDelay)]);
  },

  async "upgrade-2"(ctx, state, check) {
    const { op1 } = ops2(ctx, state);
    const id = tl.operationId(ethers, op1);
    check("upgrade queued by the Safe", await ctx.timelock.isOperationPending(id), id);
    writeBundle(state, ctx.chainId, "02-cancel-upgrade", [tl.cancelCall(ethers, ctx.timelockAddress, op1)]);
  },

  async "upgrade-3"(ctx, state, check) {
    const { op1, op2, op3 } = ops2(ctx, state);
    check("upgrade cancelled", !(await ctx.timelock.isOperationPending(tl.operationId(ethers, op1))));
    writeBundle(state, ctx.chainId, "03-pause-and-requeue", [
      ops.pauseCall(ethers, { factory: ctx.factory, modelId: UPGRADE_MODEL }),
      tl.scheduleCall(ethers, ctx.timelockAddress, op2, ctx.minDelay),
      tl.scheduleCall(ethers, ctx.timelockAddress, op3, ctx.minDelay),
    ]);
  },

  async "upgrade-4"(ctx, state, check) {
    const { op2, op3 } = ops2(ctx, state);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress);
    const proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", ctx.proxyAdminAddress);
    check("HMESS paused by the Safe", await pool.paused());
    if (!(await ctx.timelock.isOperationReady(tl.operationId(ethers, op3)))) {
      const early = await simulateRevert({ from: state.adminSafe, ...tl.executeCall(ethers, ctx.timelockAddress, op3) });
      check("timelock rejects execution before the delay", early.reverted && /not ready/i.test(early.reason), early.reason);
      const readyAt = await ctx.timelock.getTimestamp(tl.operationId(ethers, op3));
      console.log(`\n  Delay not over: ready at ${new Date(Number(readyAt) * 1000).toISOString()}. Rerun upgrade-4 then.`);
      return;
    }
    check("requeued upgrade is ready", await ctx.timelock.isOperationReady(tl.operationId(ethers, op2)));
    check("unpause is ready", await ctx.timelock.isOperationReady(tl.operationId(ethers, op3)));
    const upgradeData = proxyAdmin.interface.encodeFunctionData("upgrade", [ctx.upgradeEntry.ammAddress, state.v2Implementation]);
    const fromTimelock = await simulateRevert({ from: ctx.timelockAddress, to: ctx.proxyAdminAddress, data: upgradeData });
    check("ProxyAdmin refuses to upgrade a paused pool", fromTimelock.reverted && /exit is closed/i.test(fromTimelock.reason), fromTimelock.reason);
    const execPaused = await simulateRevert({ from: state.adminSafe, ...tl.executeCall(ethers, ctx.timelockAddress, op2) });
    check("timelock execution of the upgrade fails while paused", execPaused.reverted, execPaused.reason);
    const direct = await simulateRevert({ from: state.adminSafe, to: ctx.proxyAdminAddress, data: upgradeData });
    check("admin Safe cannot upgrade directly", direct.reverted, direct.reason);
    writeBundle(state, ctx.chainId, "04-execute-unpause-then-upgrade", [
      tl.executeCall(ethers, ctx.timelockAddress, op3),
      tl.executeCall(ethers, ctx.timelockAddress, op2),
    ]);
  },

  async "upgrade-5"(ctx, state, check) {
    const { op4 } = ops2(ctx, state);
    const pool = await ethers.getContractAt("HokusaiAMM", ctx.upgradeEntry.ammAddress);
    const v2Pool = await ethers.getContractAt("HokusaiAMMV2Mock", ctx.upgradeEntry.ammAddress);
    const slots = await ops.proxySlots(ethers.provider, ctx.upgradeEntry.ammAddress);
    check("HMESS unpaused by the timelock", !(await pool.paused()));
    check("HMESS points at V2", ethers.getAddress(slots.implementation) === state.v2Implementation);
    check("V2 reinitializer ran through factory.callPool", (await v2Pool.v2Marker()) === BigInt(V2_MARKER), await v2Pool.version());
    const logs = await ethers.provider.getLogs({
      address: ctx.upgradeEntry.ammAddress,
      topics: [ethers.id("Upgraded(address)")],
      fromBlock: ctx.deployment.deploymentBlocks?.HokusaiAMMFactory || 0,
    });
    const upgraded = logs.map((l) => ethers.getAddress("0x" + l.topics[1].slice(26)));
    check("proxy emitted Upgraded(V2)", upgraded.includes(state.v2Implementation), upgraded.join(","));
    const after = {
      reserve: await pool.reserveBalance(),
      graduationSupply: await pool.graduationSupply(),
      anchorBasisSupply: await pool.anchorBasisSupply(),
      treasury: await pool.treasury(),
      owner: await pool.owner(),
    };
    check("pool state preserved across the upgrade", json(after) === json(state.stateBeforeUpgrade));
    check("HLEAD keeps its implementation",
      (await ops.proxySlots(ethers.provider, ctx.untouchedEntry.ammAddress)).implementation === state.untouchedImplementation);
    const deployer = await getDeploySigner(hre);
    await sendTx(state, "buy HMESS $500 after upgrade",
      pool.connect(deployer).buy(ethers.parseUnits("500", 6), 0, await deployer.getAddress(), DEADLINE));
    check("upgraded pool still trades", true);
    writeBundle(state, ctx.chainId, "05-schedule-freeze", [tl.scheduleCall(ethers, ctx.timelockAddress, op4, ctx.minDelay)]);
  },

  async "upgrade-6"(ctx, state, check) {
    const { op4 } = ops2(ctx, state);
    check("freeze is ready", await ctx.timelock.isOperationReady(tl.operationId(ethers, op4)));
    writeBundle(state, ctx.chainId, "06-execute-freeze", [tl.executeCall(ethers, ctx.timelockAddress, op4)]);
  },

  async final(ctx, state, check) {
    const { op4 } = ops2(ctx, state);
    check("freeze executed", await ctx.timelock.isOperationDone(tl.operationId(ethers, op4)));
    const frozen = await ethers.provider.getLogs({
      address: ctx.proxyAdminAddress,
      topics: [ethers.id("UpgradesFrozen(address)"), ethers.zeroPadValue(ctx.upgradeEntry.ammAddress, 32)],
      fromBlock: ctx.deployment.deploymentBlocks?.HokusaiAMMFactory || 0,
    });
    check("ProxyAdmin emitted UpgradesFrozen(HMESS)", frozen.length === 1);
    const proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", ctx.proxyAdminAddress);
    const data = proxyAdmin.interface.encodeFunctionData("upgrade", [ctx.upgradeEntry.ammAddress, state.originalImplementation]);
    const sim = await simulateRevert({ from: ctx.timelockAddress, to: ctx.proxyAdminAddress, data });
    check("ProxyAdmin refuses to upgrade a frozen pool", sim.reverted && /frozen/i.test(sim.reason), sim.reason);

    const deployment = ctx.deployment;
    deployment.upgrades = {
      ...(deployment.upgrades || {}),
      approvedPoolImplementations: [...new Set([...(deployment.upgrades?.approvedPoolImplementations || []), state.v2Implementation])],
    };
    fs.writeFileSync(DEPLOYMENT_PATH, json(deployment) + "\n");
    const report = await verifyGovernance({ hre, deployment, policy: loadPolicy() });
    fs.writeFileSync(path.join(RUN_DIR, "verify-governance-after-upgrade.json"), json(report) + "\n");
    const fails = report.checks.filter((c) => c.status === "fail");
    check("verify-governance after the upgrade (V2 approved)", fails.length === 0,
      `${report.checks.length - fails.length}/${report.checks.length}`);

    const records = await ops.deploymentRecords(ethers, deployment);
    records.v2Implementation = {
      address: state.v2Implementation,
      codeHash: ethers.keccak256(await ethers.provider.getCode(state.v2Implementation)),
    };
    fs.writeFileSync(path.join(RUN_DIR, "records.json"), json(records) + "\n");
    state.completedAt = new Date().toISOString();
  },
};

async function main() {
  const phase = process.argv[2];
  if (!PHASES[phase]) {
    throw new Error(`Usage: HARDHAT_NETWORK=sepolia node scripts/rehearsal/sepolia-redeploy.js <${Object.keys(PHASES).join("|")}>`);
  }
  const ctx = await context();
  const state = loadState();
  state.adminSafe ||= ctx.adminSafe;
  state.timelock ||= ctx.timelockAddress;
  console.log(`HOK-3290 Sepolia rehearsal: ${phase} (timelock ${ctx.timelockAddress}, delay ${ctx.minDelay}s)`);
  try {
    await PHASES[phase](ctx, state, makeCheck(state, phase));
    state.phasesDone = [...new Set([...(state.phasesDone || []), phase])];
  } finally {
    saveState(state);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
