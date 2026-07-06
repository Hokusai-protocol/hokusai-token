// Mainnet-FORK verification of the UsageFeeRouter.depositFee write path.
//
// Forks mainnet at the current block and exercises the real deployed contracts
// (UsageFeeRouter, InfrastructureReserve, the live AMM pool, real USDC). It
// impersonates accounts and mints test USDC in the FORK ONLY — no real
// transaction is signed, no real funds move, and the live deployment is not
// touched in any way. This is the safe way to verify a write path on an
// immutable, in-IBR, governance-owned mainnet release.
//
//   MAINNET_RPC_URL must be an archive/full node (read from .env.mainnet).
//   npm run verify:fee-deposit:mainnet-fork
//   (optional) SMOKE_MODEL_ID=28 SMOKE_AMOUNT_USDC=1 SMOKE_CALL_COUNT=1000 FORK_BLOCK=<n>
//
// What it asserts against the live-deployed router:
//   - depositFee splits `amount` into infrastructureAmount + profitAmount that
//     sum to `amount` (matches the router's own calculateFeeSplit view)
//   - infrastructureAmount lands in InfrastructureReserve (its USDC balance rises)
//   - profitAmount lands in the AMM pool (its USDC balance rises)
//   - the depositor is debited exactly `amount`
//   - the router retains nothing (it forwards everything)

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env.mainnet") });
const hre = require("hardhat");
const { ethers } = hre;

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // mainnet USDC (6 decimals)

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];

const checks = [];
function record(name, ok, details) {
  checks.push({ name, ok, details });
  const marker = ok ? "PASS" : "FAIL";
  console.log(`  ${marker} ${name}${details ? "  " + details : ""}`);
}

async function rpc(method, params) {
  return hre.network.provider.request({ method, params });
}

async function impersonate(addr) {
  await rpc("hardhat_impersonateAccount", [addr]);
  await rpc("hardhat_setBalance", [addr, "0x3635C9ADC5DEA00000"]); // 1000 ETH for gas
  return ethers.getSigner(addr);
}

// Fund `to` with USDC in the fork by impersonating a real holder and transferring.
// EDR does not support storage overrides on forked blocks, so we source USDC from
// an account that already holds it (default: the deployer, which holds USDC on
// mainnet; override with USDC_SOURCE for a richer holder such as a CEX hot wallet).
async function fundUsdc(usdc, sourceAddr, to, amount) {
  const bal = await usdc.balanceOf(sourceAddr);
  if (bal < amount) {
    throw new Error(
      `USDC source ${sourceAddr} holds ${ethers.formatUnits(bal, 6)} USDC < needed ${ethers.formatUnits(amount, 6)}. ` +
        `Set USDC_SOURCE to an address with more USDC at this fork block.`
    );
  }
  const sourceSigner = await impersonate(sourceAddr);
  await (await usdc.connect(sourceSigner).transfer(to, amount)).wait();
}

async function main() {
  // Forking is configured at init via hardhat.config.js (FORK_MAINNET=1); the
  // `hardhat` network is already forked from mainnet when this runs.
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 1n) {
    throw new Error(
      `Not running on a mainnet fork (chainId ${net.chainId}). Run via 'npm run verify:fee-deposit:mainnet-fork' ` +
        `(sets FORK_MAINNET=1 and reads MAINNET_RPC_URL from .env.mainnet).`
    );
  }
  const blockNumber = await ethers.provider.getBlockNumber();
  console.log(`Forked mainnet chainId=1 at block ${blockNumber}\n`);

  const deployment = require(path.resolve(process.cwd(), "deployments/mainnet-latest.json"));
  const C = deployment.contracts;

  const modelId = process.env.SMOKE_MODEL_ID || String(deployment.pools?.[0]?.modelId || "28");
  const amount = ethers.parseUnits(process.env.SMOKE_AMOUNT_USDC || "1", 6); // 1 USDC default
  const callCount = BigInt(process.env.SMOKE_CALL_COUNT || "1000");

  const router = await ethers.getContractAt("UsageFeeRouter", C.UsageFeeRouter);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, ethers.provider);

  // Resolve the pool the router will route to (mirror depositFee's resolution).
  const factoryAddr = await router.factory();
  const factory = await ethers.getContractAt("HokusaiAMMFactory", factoryAddr);
  const poolAddr = await factory.getPool(modelId);
  console.log(`Model ${modelId} -> pool ${poolAddr}`);
  console.log(`Router ${C.UsageFeeRouter} | InfraReserve ${C.InfrastructureReserve}`);
  console.log(`Amount ${ethers.formatUnits(amount, 6)} USDC, callCount ${callCount}\n`);

  console.log("=== Preconditions (mirrors depositFee) ===");
  record("pool exists for model", poolAddr !== ethers.ZeroAddress, poolAddr);
  const modelActive = await factory.modelRegistry().then((mr) =>
    ethers.getContractAt("ModelRegistry", mr).then((m) => m["isModelActive(string)"](modelId))
  );
  record("model is active", modelActive === true);

  // Depositor = a fresh, funded hardhat account (has ETH on the fork). We grant it
  // FEE_DEPOSITOR_ROLE via the router admin, so the test does not depend on which
  // production account currently holds the depositor role.
  const depositor = (await ethers.getSigners())[0];

  const FEE_DEPOSITOR_ROLE = await router.FEE_DEPOSITOR_ROLE();
  const DEFAULT_ADMIN_ROLE = await router.DEFAULT_ADMIN_ROLE();

  console.log("\n=== Grant FEE_DEPOSITOR_ROLE to test depositor (via router admin) ===");
  const adminCandidates = [
    deployment.deployer,
    deployment.governance?.adminSafe,
    deployment.governance?.timelock,
  ].filter(Boolean);
  let admin = null;
  for (const cand of adminCandidates) {
    if (await router.hasRole(DEFAULT_ADMIN_ROLE, cand)) {
      admin = cand;
      break;
    }
  }
  if (!admin) throw new Error("No known DEFAULT_ADMIN_ROLE holder for UsageFeeRouter among artifact accounts.");
  const adminSigner = await impersonate(admin);
  await (await router.connect(adminSigner).grantRole(FEE_DEPOSITOR_ROLE, depositor.address)).wait();
  record("depositor has FEE_DEPOSITOR_ROLE", await router.isDepositor(depositor.address), `admin=${admin}`);

  console.log("\n=== Fund test depositor with USDC (impersonate a real holder) ===");
  const usdcSource = process.env.USDC_SOURCE || deployment.deployer;
  await fundUsdc(usdc, usdcSource, depositor.address, amount);
  record("depositor funded with USDC", (await usdc.balanceOf(depositor.address)) >= amount, `source=${usdcSource}`);

  // Expected split from the router's own view.
  const [expInfra, expProfit] = await router.calculateFeeSplit(modelId, amount, callCount);
  console.log(
    `\nExpected split: infra=${ethers.formatUnits(expInfra, 6)} profit=${ethers.formatUnits(expProfit, 6)} USDC`
  );
  record("split sums to amount", expInfra + expProfit === amount, `${expInfra}+${expProfit}==${amount}`);

  // Before balances.
  const before = {
    depositor: await usdc.balanceOf(depositor.address),
    infra: await usdc.balanceOf(C.InfrastructureReserve),
    pool: await usdc.balanceOf(poolAddr),
    router: await usdc.balanceOf(C.UsageFeeRouter),
  };

  console.log("\n=== Execute depositFee (on the forked live router) ===");
  await (await usdc.connect(depositor).approve(C.UsageFeeRouter, amount)).wait();
  const tx = await router.connect(depositor).depositFee(modelId, amount, callCount);
  const receipt = await tx.wait();
  console.log(`  depositFee mined, gas ${receipt.gasUsed}`);

  const after = {
    depositor: await usdc.balanceOf(depositor.address),
    infra: await usdc.balanceOf(C.InfrastructureReserve),
    pool: await usdc.balanceOf(poolAddr),
    router: await usdc.balanceOf(C.UsageFeeRouter),
  };

  console.log("\n=== Post-conditions ===");
  record("depositor debited exactly amount", before.depositor - after.depositor === amount,
    `${ethers.formatUnits(before.depositor - after.depositor, 6)} USDC`);
  record("InfrastructureReserve credited infra share", after.infra - before.infra === expInfra,
    `+${ethers.formatUnits(after.infra - before.infra, 6)} USDC`);
  record("AMM pool credited profit share", after.pool - before.pool === expProfit,
    `+${ethers.formatUnits(after.pool - before.pool, 6)} USDC`);
  record("router retains nothing", after.router - before.router === 0n,
    `delta ${ethers.formatUnits(after.router - before.router, 6)} USDC`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Summary: ${checks.length - failed.length} passed, ${failed.length} failed`);
  console.log("(mainnet fork — no real funds moved, live deployment untouched)");
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
});
