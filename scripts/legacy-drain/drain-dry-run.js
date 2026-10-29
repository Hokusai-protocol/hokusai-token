// HOK-3287: mainnet-FORK dry run of draining a legacy AMM pool by selling the
// supplier wallet's tokens back into it.
//
// The legacy pools have no reserve sweep (withdrawTreasury only releases
// surplus and is unreachable through the factory), so the only exit is sell().
// Each sell is capped at maxTradeBps of the *current* reserve, so the drain is
// a geometric loop. This script runs that loop on a fork with the seller
// impersonated: no real transaction is signed and nothing on mainnet changes.
//
//   FORK_MAINNET=1 MAINNET_RPC_URL=https://mainnet.gateway.tenderly.co \
//     FORK_BLOCK=<inventory block> npx hardhat run scripts/legacy-drain/drain-dry-run.js
//
//   (optional) DRAIN_MODELS=30,28,27  STOP_AT_USDC=1  MAX_SELLS=200
//              GAS_PRICE_GWEI=<override>  SELLER=<address>
//
// Writes deployments/legacy-drain/dry-run-<block>.json and exits non-zero on any
// failed check.

const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "..", "..", ".env.mainnet") });
const hre = require("hardhat");
const { ethers } = hre;

const ROOT = path.resolve(__dirname, "..", "..");
const addresses = require(path.join(ROOT, "deployments", "legacy-2026-07", "mainnet.addresses.json"));
const OUT_DIR = path.join(ROOT, "deployments", "legacy-drain");

const DRAIN_MODELS = (process.env.DRAIN_MODELS || "30,28,27").split(",");
const STOP_AT = ethers.parseUnits(process.env.STOP_AT_USDC || "1", 6);
const MAX_SELLS = Number(process.env.MAX_SELLS || "200");

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const checks = [];
function record(name, ok, details) {
  checks.push({ name, ok, details: details || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${details ? "  " + details : ""}`);
}

const usd = (v) => ethers.formatUnits(v, 6);
const tok = (v) => ethers.formatUnits(v, 18);

async function impersonate(addr) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [addr] });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [addr, "0x3635C9ADC5DEA00000"] });
  return ethers.getSigner(addr);
}

// Largest token amount whose sell quote fits under the per-trade cap.
// getSellQuote is monotonic in tokensIn, so binary search is exact.
async function maxSellable(pool, balance, cap) {
  let lo = 0n;
  let hi = balance;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if ((await pool.getSellQuote(mid)) <= cap) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

async function drainPool(entry, seller, gasPrice) {
  console.log(`\n=== ${entry.symbol} (model ${entry.modelId}) pool ${entry.ammPool} ===`);
  const pool = await ethers.getContractAt("HokusaiAMM", entry.ammPool);
  const token = await ethers.getContractAt("HokusaiToken", entry.token);
  const usdc = new ethers.Contract(addresses.reserveToken.address, ERC20_ABI, ethers.provider);
  const treasury = await pool.treasury();
  const maxTradeBps = await pool.maxTradeBps();

  record(`${entry.symbol}: pool not paused`, !(await pool.paused()));
  record(`${entry.symbol}: sells enabled`, await pool.isSellEnabled());

  const before = {
    poolUsdc: await usdc.balanceOf(entry.ammPool),
    reserve: await pool.reserveBalance(),
    sellerUsdc: await usdc.balanceOf(seller.address),
    treasuryUsdc: await usdc.balanceOf(treasury),
    sellerTokens: await token.balanceOf(seller.address),
    totalSupply: await token.totalSupply(),
    investorMinted: await token.investorMinted(),
    rewardMinted: await token.rewardMinted(),
    graduated: await pool.hasGraduated(),
  };
  console.log(`  reserve ${usd(before.reserve)} USDC, seller holds ${tok(before.sellerTokens)} tokens, graduated=${before.graduated}`);

  // Pin the fee cap to the costing gas price: ethers' estimate trails the
  // fork's base fee once a long run has mined many blocks.
  const fees = { maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n };
  const approveTx = await token.connect(seller).approve(entry.ammPool, before.sellerTokens, fees);
  let gasUsed = (await approveTx.wait()).gasUsed;

  const steps = [];
  let sellerTokens = before.sellerTokens;
  const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 3600n;

  while (steps.length < MAX_SELLS) {
    const reserve = await pool.reserveBalance();
    if (reserve <= STOP_AT || sellerTokens === 0n) break;

    const cap = (reserve * maxTradeBps) / 10000n;
    const tokensIn = await maxSellable(pool, sellerTokens, cap);
    if (tokensIn === 0n) break;
    const quote = await pool.getSellQuote(tokensIn);
    if (quote === 0n) break;
    const phase = reserve < (await pool.FLAT_CURVE_THRESHOLD()) ? "flat" : "curve";

    const receipt = await (await pool.connect(seller).sell(tokensIn, quote, seller.address, deadline, fees)).wait();
    gasUsed += receipt.gasUsed;
    sellerTokens -= tokensIn;
    steps.push({
      step: steps.length + 1,
      pricing: phase,
      reserveBefore: reserve,
      tokensIn,
      reserveOut: quote,
      gasUsed: receipt.gasUsed,
    });
  }

  const after = {
    poolUsdc: await usdc.balanceOf(entry.ammPool),
    reserve: await pool.reserveBalance(),
    sellerUsdc: await usdc.balanceOf(seller.address),
    treasuryUsdc: await usdc.balanceOf(treasury),
    sellerTokens: await token.balanceOf(seller.address),
    totalSupply: await token.totalSupply(),
    investorMinted: await token.investorMinted(),
    rewardMinted: await token.rewardMinted(),
    graduated: await pool.hasGraduated(),
  };

  const toSeller = after.sellerUsdc - before.sellerUsdc;
  const toTreasury = after.treasuryUsdc - before.treasuryUsdc;
  const leftPool = before.poolUsdc - after.poolUsdc;
  const curveSteps = steps.filter((s) => s.pricing === "curve").length;
  const gasCostEth = gasUsed * gasPrice;

  console.log(`  ${steps.length} sells (${curveSteps} curve-priced, ${steps.length - curveSteps} flat-priced) + 1 approve`);
  console.log(`  seller +${usd(toSeller)} USDC, treasury +${usd(toTreasury)} USDC (sell fees)`);
  console.log(`  stranded in pool ${usd(after.poolUsdc)} USDC, seller keeps ${tok(after.sellerTokens)} unbacked tokens`);
  console.log(`  gas ${gasUsed} ≈ ${ethers.formatEther(gasCostEth)} ETH @ ${ethers.formatUnits(gasPrice, "gwei")} gwei`);

  record(`${entry.symbol}: USDC conserved (pool out == seller + treasury in)`, leftPool === toSeller + toTreasury,
    `${usd(leftPool)} == ${usd(toSeller)} + ${usd(toTreasury)}`);
  record(`${entry.symbol}: tracked reserve still equals pool balance`, after.reserve === after.poolUsdc);
  record(`${entry.symbol}: burned supply equals tokens sold`,
    before.totalSupply - after.totalSupply === before.sellerTokens - after.sellerTokens);
  record(`${entry.symbol}: drained to stop threshold`, after.reserve <= STOP_AT || after.sellerTokens === 0n,
    `reserve ${usd(after.reserve)} stop ${usd(STOP_AT)}`);

  return {
    symbol: entry.symbol,
    modelId: entry.modelId,
    pool: entry.ammPool,
    seller: seller.address,
    treasury,
    maxTradeBps,
    before,
    after,
    totals: {
      sells: steps.length,
      curveSells: curveSteps,
      usdcToSeller: toSeller,
      usdcToTreasury: toTreasury,
      usdcStranded: after.poolUsdc,
      tokensSold: before.sellerTokens - after.sellerTokens,
      tokensLeftUnbacked: after.sellerTokens,
      investorMintedDelta: before.investorMinted - after.investorMinted,
      rewardMintedDelta: before.rewardMinted - after.rewardMinted,
      gasUsed,
      gasPriceWei: gasPrice,
      gasCostWei: gasCostEth,
    },
    steps,
  };
}

// Exported for the HOK-3290 fork rehearsal, which drains the legacy pools and
// then deploys the new stack in the same forked process.
async function runDrainDryRun() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 1n) {
    throw new Error(`Not on a mainnet fork (chainId ${net.chainId}). Run with FORK_MAINNET=1.`);
  }
  const block = await ethers.provider.getBlock("latest");
  console.log(`Forked mainnet at block ${block.number} — impersonated, no real transactions\n`);

  const gasPrice = process.env.GAS_PRICE_GWEI
    ? ethers.parseUnits(process.env.GAS_PRICE_GWEI, "gwei")
    : block.baseFeePerGas + ethers.parseUnits("1", "gwei");

  const results = [];
  for (const modelId of DRAIN_MODELS) {
    const entry = addresses.tokens.find((t) => t.modelId === modelId);
    if (!entry) throw new Error(`Model ${modelId} not in mainnet.addresses.json`);
    const token = await ethers.getContractAt("HokusaiToken", entry.token);
    const seller = await impersonate(process.env.SELLER || (await token.modelSupplierRecipient()));
    results.push(await drainPool(entry, seller, gasPrice));
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    forkBlock: block.number,
    stopAtUsdc: STOP_AT,
    results,
    checks,
    ok: failed.length === 0,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `dry-run-${block.number}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
  console.log("(mainnet fork — no real funds moved, live deployment untouched)");
  return { report, outPath };
}

module.exports = { runDrainDryRun };

if (require.main === module) {
  runDrainDryRun()
    .then(({ report }) => {
      if (!report.ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.stack || err.message : err);
      process.exit(1);
    });
}
