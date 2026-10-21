// HOK-3287: LIVE drain of a legacy AMM pool by selling the supplier wallet's
// tokens back into it, signed on a Ledger. Same loop as drain-dry-run.js.
//
// Each sell is capped at maxTradeBps of the *current* reserve, so the drain is
// a geometric loop of ~45 sells for HROUT. Every step re-reads chain state, so
// the script is safe to Ctrl-C and re-run: it resumes from wherever it stopped.
//
// Plan only (reads, no signing):
//   MAINNET_RPC_URL=<rpc> LEDGER_ACCOUNT=0xD1Eb…8136 \
//     npx hardhat run --network mainnet scripts/legacy-drain/drain-live.js
//
// Execute (one Ledger confirmation per tx; enable "Blind signing" in the
// Ethereum app — sell() is not clear-signable):
//   EXECUTE=1 MAINNET_RPC_URL=<rpc> LEDGER_ACCOUNT=0xD1Eb…8136 \
//     npx hardhat run --network mainnet scripts/legacy-drain/drain-live.js
//
// Fork rehearsal of this exact code path (seller impersonated, no Ledger):
//   FORK_MAINNET=1 MAINNET_RPC_URL=<rpc> EXECUTE=1 \
//     npx hardhat run scripts/legacy-drain/drain-live.js
//
//   (optional) DRAIN_MODELS=30  STOP_AT_USDC=1  MAX_SELLS=200  MAX_BASE_FEE_GWEI=10
//
// Appends every confirmed tx to deployments/legacy-drain/live-<model>.jsonl.

const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const ROOT = path.resolve(__dirname, "..", "..");
const addresses = require(path.join(ROOT, "deployments", "mainnet.addresses.json"));
const OUT_DIR = path.join(ROOT, "deployments", "legacy-drain");

const DRAIN_MODELS = (process.env.DRAIN_MODELS || "30").split(",");
const STOP_AT = ethers.parseUnits(process.env.STOP_AT_USDC || "1", 6);
const MAX_SELLS = Number(process.env.MAX_SELLS || "200");
const MAX_BASE_FEE = ethers.parseUnits(process.env.MAX_BASE_FEE_GWEI || "10", "gwei");
const EXECUTE = process.env.EXECUTE === "1";
const IS_FORK = hre.network.name === "hardhat";

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const usd = (v) => ethers.formatUnits(v, 6);
const tok = (v) => ethers.formatUnits(v, 18);

async function sellerSigner(expected) {
  if (IS_FORK) {
    await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [expected] });
    return ethers.getSigner(expected);
  }
  const ledger = process.env.LEDGER_ACCOUNT;
  if (!ledger) throw new Error("LEDGER_ACCOUNT is not set.");
  if (ethers.getAddress(ledger) !== ethers.getAddress(expected)) {
    throw new Error(`LEDGER_ACCOUNT ${ledger} is not the supplier recipient ${expected}.`);
  }
  return ethers.getSigner(ledger);
}

// Largest token amount whose sell quote fits under the per-trade cap, to within
// 1e-6 of the amount (wei-exact search would cost ~60 RPC calls per step).
async function maxSellable(pool, balance, cap) {
  if ((await pool.getSellQuote(balance)) <= cap) return balance;
  let lo = 0n;
  let hi = balance;
  while (hi - lo > hi / 1000000n + 1n) {
    const mid = (lo + hi) / 2n;
    if ((await pool.getSellQuote(mid)) <= cap) lo = mid;
    else hi = mid;
  }
  return lo;
}

async function checkBaseFee() {
  const { baseFeePerGas } = await ethers.provider.getBlock("latest");
  if (baseFeePerGas > MAX_BASE_FEE) {
    throw new Error(`Base fee ${ethers.formatUnits(baseFeePerGas, "gwei")} gwei exceeds MAX_BASE_FEE_GWEI; re-run later.`);
  }
}

async function drainPool(entry) {
  console.log(`\n=== ${entry.symbol} (model ${entry.modelId}) pool ${entry.ammPool} ===`);
  const pool = await ethers.getContractAt("HokusaiAMM", entry.ammPool);
  const token = await ethers.getContractAt("HokusaiToken", entry.token);
  const usdc = new ethers.Contract(addresses.reserveToken.address, ERC20_ABI, ethers.provider);
  const seller = await sellerSigner(await token.modelSupplierRecipient());
  const maxTradeBps = await pool.maxTradeBps();
  const logPath = path.join(OUT_DIR, `live-${entry.modelId}${IS_FORK ? "-fork" : ""}.jsonl`);
  const log = (row) => fs.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...row }) + "\n");

  if (await pool.paused()) throw new Error("Pool is paused.");
  if (!(await pool.isSellEnabled())) throw new Error("Sells are not enabled.");

  const startUsdc = await usdc.balanceOf(seller.address);
  let sellerTokens = await token.balanceOf(seller.address);
  const reserve0 = await pool.reserveBalance();
  console.log(`  seller ${seller.address}`);
  console.log(`  reserve ${usd(reserve0)} USDC, seller holds ${tok(sellerTokens)} tokens, stop at ${usd(STOP_AT)} USDC`);

  if (!EXECUTE) {
    const cap = (reserve0 * maxTradeBps) / 10000n;
    const tokensIn = await maxSellable(pool, sellerTokens, cap);
    console.log(`  next sell: ${tok(tokensIn)} tokens -> ${usd(await pool.getSellQuote(tokensIn))} USDC (cap ${usd(cap)})`);
    console.log("  plan only — set EXECUTE=1 to sign and send.");
    return;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const allowance = await token.allowance(seller.address, entry.ammPool);
  if (allowance < sellerTokens) {
    await checkBaseFee();
    console.log(`  approve ${tok(sellerTokens)} tokens — confirm on Ledger`);
    const receipt = await (await token.connect(seller).approve(entry.ammPool, sellerTokens)).wait();
    log({ kind: "approve", tx: receipt.hash, block: receipt.blockNumber, amount: sellerTokens.toString() });
    console.log(`  approve ${receipt.hash}`);
  }

  let sells = 0;
  while (sells < MAX_SELLS) {
    const reserve = await pool.reserveBalance();
    sellerTokens = await token.balanceOf(seller.address);
    if (reserve <= STOP_AT || sellerTokens === 0n) break;

    const cap = (reserve * maxTradeBps) / 10000n;
    const tokensIn = await maxSellable(pool, sellerTokens, cap);
    if (tokensIn === 0n) break;
    const quote = await pool.getSellQuote(tokensIn);
    if (quote === 0n) break;

    const deadline = BigInt((await ethers.provider.getBlock("latest")).timestamp) + 1200n;
    // Simulate before asking the Ledger to sign, so a revert never costs a confirmation.
    await pool.connect(seller).sell.staticCall(tokensIn, quote, seller.address, deadline);
    await checkBaseFee();

    console.log(`  sell ${sells + 1}: ${tok(tokensIn)} tokens -> ${usd(quote)} USDC (reserve ${usd(reserve)}) — confirm on Ledger`);
    const receipt = await (await pool.connect(seller).sell(tokensIn, quote, seller.address, deadline)).wait();
    sells += 1;
    log({
      kind: "sell", step: sells, tx: receipt.hash, block: receipt.blockNumber,
      reserveBefore: reserve.toString(), tokensIn: tokensIn.toString(), minOut: quote.toString(),
      gasUsed: receipt.gasUsed.toString(),
    });
    console.log(`    ${receipt.hash}`);
  }

  const endReserve = await pool.reserveBalance();
  const endUsdc = await usdc.balanceOf(seller.address);
  console.log(`  done: ${sells} sells this run, seller +${usd(endUsdc - startUsdc)} USDC`);
  console.log(`  reserve left ${usd(endReserve)} USDC, seller keeps ${tok(await token.balanceOf(seller.address))} unbacked tokens`);
  console.log(`  log ${path.relative(ROOT, logPath)}`);
}

async function main() {
  const net = await ethers.provider.getNetwork();
  if (net.chainId !== 1n) throw new Error(`Not mainnet or a mainnet fork (chainId ${net.chainId}).`);
  console.log(IS_FORK ? "MAINNET FORK — impersonated seller, nothing real is sent" : "MAINNET — LIVE");
  console.log(EXECUTE ? "EXECUTE=1: transactions will be sent" : "plan only");

  for (const modelId of DRAIN_MODELS) {
    const entry = addresses.tokens.find((t) => t.modelId === modelId);
    if (!entry) throw new Error(`Model ${modelId} not in mainnet.addresses.json`);
    await drainPool(entry);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
