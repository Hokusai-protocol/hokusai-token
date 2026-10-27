// HOK-3290: end-to-end rehearsal of the upgradeable-AMM redeploy on a pinned
// mainnet fork, in one process so every phase sees the previous one's state.
//
//   FORK_MAINNET=1 FORK_BLOCK=<block> \
//     TREASURY_ADDRESS=<addr> VERIFIER_ADDRESS=<addr> BACKEND_SERVICE_ADDRESS=<addr> \
//     npx hardhat run scripts/rehearsal/fork-redeploy.js
//
// TREASURY/VERIFIER/BACKEND default to the admin Safe / MAINNET_BACKEND_ADDRESS
// for the rehearsal only; the production values are a HOK-3291 decision.
//
// Phases (the cutover order):
//   1. legacy drain dry run (HOK-3287) on the July pools
//   2. deploy the full stack (deploy-mainnet config, real deploy-stack code)
//   3. reuse the July 48h timelock (production delay, never shortened)
//   4. create the launch-token pools (create-mainnet-pools code)
//   5. launch posture executed by the deployer, then the pre-handoff gate
//   6. governance handoff to the timelock, verify-governance, post-handoff gate
//   7. trading: whitelist via the admin Safe, buys through graduation, sells
//      after the IBR, fee settlement through the router
//   8. upgrade flow through the timelock as the admin Safe: queue -> cancel,
//      pause -> requeue -> execute rejected while paused -> unpause ->
//      execute, second pool untouched, direct ProxyAdmin call rejected,
//      freeze -> upgrade rejected
//   9. records: bytecode hashes, EIP-1967 slots, gas, verifier output
//
// Nothing here signs a real transaction: the deployer is a local fork account
// and the Safe, backend and buyers are impersonated.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env.mainnet") });
const hre = require("hardhat");
const { ethers } = hre;

const { deployFullStack } = require("../lib/deploy-stack");
const { getMainnetConfig, MAINNET_USDC } = require("../deploy-mainnet");
const { runDrainDryRun } = require("../legacy-drain/drain-dry-run");
const { DEFAULT_CONFIG_PATH, runLaunchDeploy } = require("../create-mainnet-pools");
const { loadLaunchTokensConfig } = require("../lib/launch-tokens");
const {
  assertLaunchPosture,
  executeLaunchPosturePlan,
  formatDiff,
  loadLaunchPostureConfig,
  planLaunchPostureInit,
} = require("../lib/launch-posture");
const { loadPolicy, runGovernanceTransfer, verifyGovernance } = require("../governance/lib");
const tl = require("../lib/timelock-ops");
const ops = require("../lib/pool-upgrade-ops");

const ROOT = path.resolve(__dirname, "..", "..");
const ADMIN_SAFE = process.env.ADMIN_SAFE_ADDRESS || "0x158B985CC667b4E022AD05B99E89007790da66E2";
const MAINNET_TIMELOCK = process.env.TIMELOCK_ADDRESS || "0xcd8076D7a15E97946fAD0baA32Bf358be3D927C8";
const POSTURE_CONFIG = "scripts/configs/mainnet-launch-posture.json";
const UPGRADE_MODEL = "28"; // HMESS: traded, graduated, then upgraded and frozen
const UNTOUCHED_MODEL = "27"; // HLEAD: must keep the original implementation
const USDC_BALANCE_SLOT = 9n; // FiatTokenV2_2 balanceAndBlacklistStates
const DEADLINE = 9999999999n;

const checks = [];
const gas = {};
function check(name, ok, details) {
  checks.push({ name, ok: Boolean(ok), details: details === undefined ? "" : String(details) });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${details === undefined ? "" : "  " + details}`);
}
const usd = (v) => ethers.formatUnits(v, 6);
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2);
function save(dir, name, data) {
  fs.writeFileSync(path.join(dir, name), json(data) + "\n");
}

async function fundUsdc(address, amount) {
  const slot = ethers.solidityPackedKeccak256(["uint256", "uint256"], [address, USDC_BALANCE_SLOT]);
  await hre.network.provider.request({
    method: "hardhat_setStorageAt",
    params: [MAINNET_USDC, slot, ethers.toBeHex(amount, 32)],
  });
}

async function expectRevert(promise) {
  try {
    await promise;
    return { reverted: false };
  } catch (error) {
    return { reverted: true, reason: error.shortMessage || error.reason || error.message };
  }
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 1n || hre.network.name !== "hardhat") {
    throw new Error("Run on an in-process mainnet fork: FORK_MAINNET=1 npx hardhat run ...");
  }
  const forkBlock = await ethers.provider.getBlockNumber();
  const outDir = path.join(ROOT, "deployments", "rehearsal", `fork-${forkBlock}`);
  fs.mkdirSync(outDir, { recursive: true });
  const deploymentPath = path.join(outDir, "deployment.json");
  console.log(`HOK-3290 fork rehearsal at mainnet block ${forkBlock} -> ${path.relative(ROOT, outDir)}`);

  process.env.TREASURY_ADDRESS ||= ADMIN_SAFE;
  process.env.VERIFIER_ADDRESS ||= process.env.MAINNET_BACKEND_ADDRESS;
  process.env.BACKEND_SERVICE_ADDRESS ||= process.env.MAINNET_BACKEND_ADDRESS;

  const [deployer, buyerA, buyerB, buyerC, buyerD] = await ethers.getSigners();
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [deployer.address, "0x3635C9ADC5DEA00000"],
  });

  // 1. Legacy drain dry run ---------------------------------------------
  console.log("\n== 1. Legacy drain dry run (HOK-3287) ==");
  // A fixed price well above the fork's base fee, which rises as blocks are mined.
  process.env.GAS_PRICE_GWEI ||= "50";
  const drain = await runDrainDryRun();
  check("legacy drain dry run passes", drain.report.ok, path.relative(ROOT, drain.outPath));

  // 2. Deploy ------------------------------------------------------------
  console.log("\n== 2. Deploy full stack ==");
  const config = { ...getMainnetConfig(deployer.address), confirmationPauseSeconds: 0 };
  const stack = await deployFullStack(config, { hre, deployer, skipArtifactWrite: true, logger: console });
  const deployment = await stack.artifact();
  gas.deploy = deployment.gasUsed;
  check("PoolProxyAdmin owned by deployer before handoff",
    (await (await ethers.getContractAt("HokusaiPoolProxyAdmin", deployment.contracts.PoolProxyAdmin)).owner()) === deployer.address);

  // 3. Timelock (reuse the July 48h timelock) -----------------------------
  console.log("\n== 3. Timelock ==");
  const timelock = new ethers.Contract(MAINNET_TIMELOCK, tl.TIMELOCK_ABI, ethers.provider);
  const minDelay = await timelock.getMinDelay();
  check("reused timelock has the 48h production delay", minDelay === 172800n, `${minDelay}s`);
  deployment.governance = {
    timelock: MAINNET_TIMELOCK,
    adminSafe: ADMIN_SAFE,
    emergencySafe: process.env.EMERGENCY_SAFE_ADDRESS || ADMIN_SAFE,
    minDelay: Number(minDelay),
    reused: true,
  };
  save(outDir, "deployment.json", deployment);

  // 4. Pools ---------------------------------------------------------------
  console.log("\n== 4. Launch tokens and pools ==");
  const launchConfig = loadLaunchTokensConfig(DEFAULT_CONFIG_PATH);
  const seed = launchConfig.tokens.reduce((sum, t) => sum + ethers.parseUnits(t.pool.initialReserveUsdc, 6), 0n);
  await fundUsdc(deployer.address, seed);
  await runLaunchDeploy({
    deployment,
    launchConfig,
    deployer,
    confirmationDelayMs: 0,
    datedDeploymentPath: path.join(outDir, "deployment-pools.json"),
    latestDeploymentPath: deploymentPath,
    pendingActionsPath: path.join(outDir, "pending-actions.json"),
  });
  check("all launch pools created", deployment.pools.length === launchConfig.tokens.length,
    deployment.pools.map((p) => `${p.configKey}:${p.ammAddress}`).join(" "));

  // 5. Posture -----------------------------------------------------------
  console.log("\n== 5. Launch posture ==");
  const loadPosture = () => loadLaunchPostureConfig({
    networkName: "mainnet",
    configPath: POSTURE_CONFIG,
    deploymentArtifactPath: deploymentPath,
  });
  const posture = loadPosture();
  const plan = await planLaunchPostureInit({ hre, config: posture.config, deployment });
  save(outDir, "posture-plan.json", plan.plan);
  await executeLaunchPosturePlan({ signer: deployer, hre, plan });
  const pre = loadPosture();
  for (const key of ["expectedTokenOwner", "expectedParamsAdmin", "roleAudit", "ownershipAudit"]) {
    delete pre.config[key];
  }
  const postureReportPre = await assertLaunchPosture({ hre, config: pre.config, deployment });
  save(outDir, "posture-pre.json", postureReportPre);
  check("posture gate (pre-handoff)", postureReportPre.failures.length === 0, formatDiff(postureReportPre).split("\n")[0]);

  // 6. Handoff ------------------------------------------------------------
  console.log("\n== 6. Governance handoff ==");
  const policy = loadPolicy();
  const handoff = await runGovernanceTransfer({ hre, deployment, policy, logger: console });
  Object.assign(deployment, handoff.deployment);
  save(outDir, "deployment.json", deployment);
  save(outDir, "handoff-actions.json", handoff.actions);
  const govReport = await verifyGovernance({ hre, deployment, policy });
  save(outDir, "verify-governance.json", govReport);
  const govFails = govReport.checks.filter((c) => c.status === "fail");
  check("verify-governance", govFails.length === 0,
    `${govReport.checks.length - govFails.length}/${govReport.checks.length}` +
    (govFails.length ? " " + govFails.map((f) => `${f.contract}.${f.check}`).join(", ") : ""));
  const post = loadPosture();
  const postureReportPost = await assertLaunchPosture({ hre, config: post.config, deployment });
  save(outDir, "posture-post.json", postureReportPost);
  // Known gap (HOK-3291): the July posture config predates PoolProxyAdmin
  // and hard-codes the July deployer, so this is recorded, not gated.
  console.log(`  posture post-handoff (July config, informational): ${postureReportPost.failures.length} failure(s)`);

  // 7. Trading and fees --------------------------------------------------
  console.log("\n== 7. Trading and fee settlement ==");
  const safe = await tl.impersonate(hre, ADMIN_SAFE);
  const emergency = await tl.impersonate(hre, deployment.governance.emergencySafe);
  const poolOf = (modelId) => deployment.pools.find((p) => p.modelId === modelId);
  const upgradePool = await ethers.getContractAt("HokusaiAMM", poolOf(UPGRADE_MODEL).ammAddress);
  const untouchedPool = await ethers.getContractAt("HokusaiAMM", poolOf(UNTOUCHED_MODEL).ammAddress);
  const token = await ethers.getContractAt("HokusaiToken", poolOf(UPGRADE_MODEL).tokenAddress);
  const usdc = await ethers.getContractAt("IERC20", MAINNET_USDC);
  const buyers = [buyerA, buyerB, buyerC, buyerD];

  const whitelist = await ethers.getContractAt("PurchaserWhitelist", deployment.contracts.PurchaserWhitelist, safe);
  await (await whitelist.addBatch(buyers.map((b) => b.address))).wait();
  check("admin Safe whitelists buyers after handoff", await whitelist.isWhitelisted(buyerA.address));

  for (const b of buyers) {
    await fundUsdc(b.address, ethers.parseUnits("100000", 6));
    await (await usdc.connect(b).approve(await upgradePool.getAddress(), ethers.MaxUint256)).wait();
    await (await usdc.connect(b).approve(await untouchedPool.getAddress(), ethers.MaxUint256)).wait();
    await (await token.connect(b).approve(await upgradePool.getAddress(), ethers.MaxUint256)).wait();
  }
  const flatPrice = await upgradePool.FLAT_CURVE_PRICE();
  const paid = {};
  for (const [i, b] of [buyerA, buyerB, buyerC].entries()) {
    const amount = ethers.parseUnits("9000", 6);
    const receipt = await (await upgradePool.connect(b).buy(amount, 0, b.address, DEADLINE)).wait();
    gas[`buy${i + 1}`] = receipt.gasUsed;
    paid[b.address] = amount;
  }
  check("pool graduated by buys", await upgradePool.hasGraduated(), `reserve $${usd(await upgradePool.reserveBalance())}`);
  const spotAfterGrad = await upgradePool.spotPrice();
  check("spot after graduation is at or above the flat price", spotAfterGrad >= flatPrice, `$${usd(spotAfterGrad)}`);
  await (await untouchedPool.connect(buyerD).buy(ethers.parseUnits("1000", 6), 0, buyerD.address, DEADLINE)).wait();

  check("sells blocked during IBR", !(await upgradePool.isSellEnabled()));
  const ibr = BigInt(poolOf(UPGRADE_MODEL).ibrDuration);
  await tl.increaseTime(hre, ibr + 1n);
  check("sells enabled after IBR", await upgradePool.isSellEnabled());

  // Exits in chunks under the trade cap after graduation (HOK-3270).
  const exit = async (seller) => {
    const before = await usdc.balanceOf(seller.address);
    let sells = 0;
    while ((await token.balanceOf(seller.address)) > 0n && sells < 50) {
      let chunk = await token.balanceOf(seller.address);
      const cap = await upgradePool.maxTradeSize();
      while ((await upgradePool.getSellQuote(chunk)) > cap) chunk /= 2n;
      const receipt = await (await upgradePool.connect(seller).sell(chunk, 0, seller.address, DEADLINE)).wait();
      gas.sell ||= receipt.gasUsed;
      sells++;
    }
    return { proceeds: (await usdc.balanceOf(seller.address)) - before, sells };
  };
  // Buyer C crossed the threshold: selling straight back must not pay it out
  // of the flat-phase holders (AMM-H1).
  const exitC = await exit(buyerC);
  check("threshold-crossing buyer exits without profit", exitC.proceeds <= paid[buyerC.address],
    `paid $${usd(paid[buyerC.address])}, got $${usd(exitC.proceeds)} in ${exitC.sells} sells`);
  // Buyer A bought flat before C; C's curve premium legitimately raises A's
  // backing, so A's result is recorded, not gated.
  const exitA = await exit(buyerA);
  check("graduated pool sells back below the threshold",
    (await upgradePool.hasGraduated()) && (await upgradePool.reserveBalance()) < (await upgradePool.FLAT_CURVE_THRESHOLD()),
    `reserve $${usd(await upgradePool.reserveBalance())}`);
  console.log(`  info: flat-phase buyer A paid $${usd(paid[buyerA.address])}, exited with $${usd(exitA.proceeds)} in ${exitA.sells} sells`);

  const backend = await tl.impersonate(hre, deployment.backendService);
  const router = await ethers.getContractAt("UsageFeeRouter", deployment.contracts.UsageFeeRouter, backend);
  const reserve = await ethers.getContractAt("InfrastructureReserve", deployment.contracts.InfrastructureReserve);
  const fee = ethers.parseUnits("1000", 6);
  await fundUsdc(backend.address, fee);
  await (await usdc.connect(backend).approve(await router.getAddress(), fee)).wait();
  const poolReserveBefore = await upgradePool.reserveBalance();
  const accruedBefore = await reserve.accrued(UPGRADE_MODEL);
  const treasuryBefore = await usdc.balanceOf(deployment.treasury);
  const feeReceipt = await (await router.depositFee(UPGRADE_MODEL, fee, 100)).wait();
  gas.depositFee = feeReceipt.gasUsed;
  const toPool = (await upgradePool.reserveBalance()) - poolReserveBefore;
  const toInfra = (await reserve.accrued(UPGRADE_MODEL)) - accruedBefore;
  const toTreasury = (await usdc.balanceOf(deployment.treasury)) - treasuryBefore;
  check("fee settlement conserves the deposit (pool + infra + treasury)", toPool + toInfra + toTreasury === fee,
    `pool $${usd(toPool)} infra $${usd(toInfra)} treasury $${usd(toTreasury)}`);
  check("router holds no USDC after settlement", (await usdc.balanceOf(await router.getAddress())) === 0n);

  // 8. Upgrade flow --------------------------------------------------------
  console.log("\n== 8. Timelocked upgrade flow ==");
  const proxyAdmin = await ethers.getContractAt("HokusaiPoolProxyAdmin", deployment.contracts.PoolProxyAdmin);
  check("PoolProxyAdmin owned by the timelock", (await proxyAdmin.owner()) === MAINNET_TIMELOCK);
  const factoryAddress = deployment.contracts.HokusaiAMMFactory;
  const upgradeAddr = await upgradePool.getAddress();
  const untouchedAddr = await untouchedPool.getAddress();
  const originalImpl = (await ops.proxySlots(ethers.provider, upgradeAddr)).implementation;
  const untouchedImplBefore = (await ops.proxySlots(ethers.provider, untouchedAddr)).implementation;

  const v2 = await (await ethers.getContractFactory("HokusaiAMMV2Mock", deployer)).deploy();
  await v2.waitForDeployment();
  const v2Address = await v2.getAddress();
  const snapshot = async () => ({
    reserve: await upgradePool.reserveBalance(),
    graduationSupply: await upgradePool.graduationSupply(),
    anchorBasisSupply: await upgradePool.anchorBasisSupply(),
    treasury: await upgradePool.treasury(),
    owner: await upgradePool.owner(),
    spot: await upgradePool.spotPrice(),
  });
  const stateBefore = await snapshot();

  const upgradeArgs = {
    proxyAdmin: deployment.contracts.PoolProxyAdmin,
    factory: factoryAddress,
    modelId: UPGRADE_MODEL,
    pool: upgradeAddr,
    implementation: v2Address,
    v2Marker: 3290,
  };
  const bundles = {};
  const asSafe = async (name, calls) => {
    bundles[name] = tl.safeBundle({ chainId: 1, safe: ADMIN_SAFE, name, description: "HOK-3290 fork rehearsal", calls });
    return tl.sendAs(hre, safe, calls);
  };

  // Queue, then cancel.
  const op1 = tl.batchOp(ethers, { calls: ops.upgradeCalls(ethers, upgradeArgs), salt: "HOK-3290 upgrade #1" });
  const id1 = tl.operationId(ethers, op1);
  await asSafe("01-schedule-upgrade", [tl.scheduleCall(ethers, MAINNET_TIMELOCK, op1, minDelay)]);
  check("upgrade queued", await timelock.isOperationPending(id1), id1);
  check("queued upgrade id matches the timelock's hash",
    (await timelock.hashOperationBatch(op1.targets, op1.values, op1.payloads, op1.predecessor, op1.salt)) === id1);
  await asSafe("02-cancel-upgrade", [tl.cancelCall(ethers, MAINNET_TIMELOCK, op1)]);
  check("upgrade cancelled", !(await timelock.isOperationPending(id1)));

  // Pause, requeue, and confirm the paused pool cannot be upgraded.
  await tl.sendAs(hre, emergency, [ops.pauseCall(ethers, { factory: factoryAddress, modelId: UPGRADE_MODEL })]);
  check("emergency Safe pauses the pool without delay", await upgradePool.paused());
  const op2 = tl.batchOp(ethers, { calls: ops.upgradeCalls(ethers, upgradeArgs), salt: "HOK-3290 upgrade #2" });
  const op3 = tl.batchOp(ethers, {
    calls: [ops.unpauseCall(ethers, { factory: factoryAddress, modelId: UPGRADE_MODEL })],
    salt: "HOK-3290 unpause",
  });
  await asSafe("03-schedule-upgrade-and-unpause", [
    tl.scheduleCall(ethers, MAINNET_TIMELOCK, op2, minDelay),
    tl.scheduleCall(ethers, MAINNET_TIMELOCK, op3, minDelay),
  ]);
  const early = await expectRevert(safe.sendTransaction(tl.executeCall(ethers, MAINNET_TIMELOCK, op2)));
  check("execute before the 48h delay is rejected", early.reverted, early.reason);
  await tl.increaseTime(hre, minDelay + 1n);
  const timelockSigner = await tl.impersonate(hre, MAINNET_TIMELOCK);
  const pausedSim = await expectRevert(proxyAdmin.connect(timelockSigner).upgrade.staticCall(upgradeAddr, v2Address));
  check("ProxyAdmin refuses to upgrade a paused pool", pausedSim.reverted && /exit is closed/i.test(pausedSim.reason), pausedSim.reason);
  const pausedExec = await expectRevert(safe.sendTransaction(tl.executeCall(ethers, MAINNET_TIMELOCK, op2)));
  check("timelock execution of the upgrade fails while paused", pausedExec.reverted, pausedExec.reason);
  const direct = await expectRevert(proxyAdmin.connect(safe).upgrade(upgradeAddr, v2Address));
  check("admin Safe cannot upgrade directly (bypassing the timelock)", direct.reverted, direct.reason);

  // Unpause through the timelock, then execute the same queued upgrade.
  await asSafe("04-execute-unpause", [tl.executeCall(ethers, MAINNET_TIMELOCK, op3)]);
  check("timelock unpauses the pool", !(await upgradePool.paused()));
  const [exec] = await asSafe("05-execute-upgrade", [tl.executeCall(ethers, MAINNET_TIMELOCK, op2)]);
  gas.upgradeExecute = exec.gasUsed;
  const execReceipt = await ethers.provider.getTransactionReceipt(exec.hash);
  const upgradedTopic = ethers.id("Upgraded(address)");
  const upgradedLog = execReceipt.logs.find((l) => l.address.toLowerCase() === upgradeAddr.toLowerCase() && l.topics[0] === upgradedTopic);
  check("proxy emitted Upgraded(V2)", upgradedLog && ethers.getAddress("0x" + upgradedLog.topics[1].slice(26)) === v2Address);
  const slotsAfter = await ops.proxySlots(ethers.provider, upgradeAddr);
  check("upgraded pool points at V2", ethers.getAddress(slotsAfter.implementation) === v2Address);
  const v2Pool = await ethers.getContractAt("HokusaiAMMV2Mock", upgradeAddr);
  check("V2 reinitializer ran through factory.callPool", (await v2Pool.v2Marker()) === 3290n, await v2Pool.version());
  const stateAfter = await snapshot();
  check("pool state preserved across the upgrade", json(stateAfter) === json(stateBefore));
  check("untouched pool keeps its implementation",
    (await ops.proxySlots(ethers.provider, untouchedAddr)).implementation === untouchedImplBefore);
  await (await upgradePool.connect(buyerB).buy(ethers.parseUnits("500", 6), 0, buyerB.address, DEADLINE)).wait();
  check("upgraded pool still trades", true);

  // Freeze, then confirm no further upgrade can execute.
  const op4 = tl.batchOp(ethers, {
    calls: [ops.freezeCall(ethers, { proxyAdmin: deployment.contracts.PoolProxyAdmin, modelId: UPGRADE_MODEL, pool: upgradeAddr })],
    salt: "HOK-3290 freeze",
  });
  const op5 = tl.batchOp(ethers, {
    calls: ops.upgradeCalls(ethers, { ...upgradeArgs, implementation: originalImpl, v2Marker: undefined }),
    salt: "HOK-3290 upgrade after freeze",
  });
  await asSafe("06-schedule-freeze", [tl.scheduleCall(ethers, MAINNET_TIMELOCK, op4, minDelay)]);
  await tl.increaseTime(hre, minDelay + 1n);
  const [freezeExec] = await asSafe("07-execute-freeze", [tl.executeCall(ethers, MAINNET_TIMELOCK, op4)]);
  const frozenLog = (await ethers.provider.getTransactionReceipt(freezeExec.hash)).logs
    .find((l) => l.topics[0] === ethers.id("UpgradesFrozen(address)"));
  check("freeze executed (UpgradesFrozen)", Boolean(frozenLog));
  await asSafe("08-schedule-upgrade-after-freeze", [tl.scheduleCall(ethers, MAINNET_TIMELOCK, op5, minDelay)]);
  await tl.increaseTime(hre, minDelay + 1n);
  const frozenSim = await expectRevert(proxyAdmin.connect(timelockSigner).upgrade.staticCall(upgradeAddr, originalImpl));
  check("ProxyAdmin refuses to upgrade a frozen pool", frozenSim.reverted, frozenSim.reason);
  const frozenExec = await expectRevert(safe.sendTransaction(tl.executeCall(ethers, MAINNET_TIMELOCK, op5)));
  check("timelock execution of an upgrade fails after freeze", frozenExec.reverted, frozenExec.reason);

  // The upgraded implementation is approved in the artifact; governance passes again.
  deployment.upgrades = { approvedPoolImplementations: [v2Address] };
  const govAfter = await verifyGovernance({ hre, deployment, policy });
  save(outDir, "verify-governance-after-upgrade.json", govAfter);
  const govAfterFails = govAfter.checks.filter((c) => c.status === "fail");
  check("verify-governance after the upgrade (V2 approved)", govAfterFails.length === 0,
    `${govAfter.checks.length - govAfterFails.length}/${govAfter.checks.length}`);

  // 9. Records ------------------------------------------------------------
  console.log("\n== 9. Records ==");
  const records = await ops.deploymentRecords(ethers, deployment);
  records.v2Implementation = { address: v2Address, codeHash: ethers.keccak256(await ethers.provider.getCode(v2Address)) };
  save(outDir, "deployment.json", deployment);
  save(outDir, "records.json", records);
  save(outDir, "safe-bundles.json", bundles);

  const failed = checks.filter((c) => !c.ok);
  const report = {
    issue: "HOK-3290",
    kind: "mainnet-fork rehearsal",
    generatedAt: new Date().toISOString(),
    forkBlock,
    git: deployment.git,
    timelock: { address: MAINNET_TIMELOCK, minDelay },
    inputs: {
      treasury: deployment.treasury,
      verifier: process.env.VERIFIER_ADDRESS,
      backendService: deployment.backendService,
      adminSafe: ADMIN_SAFE,
    },
    gas,
    checks,
    ok: failed.length === 0,
  };
  save(outDir, "report.json", report);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed -> ${path.relative(ROOT, outDir)}`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
