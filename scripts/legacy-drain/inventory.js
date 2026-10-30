// HOK-3287: read-only inventory of the legacy (July 2026) mainnet AMM pools.
//
// Pins a block, reads every pool/token/holder fact the drain depends on, and
// fails closed if anything contradicts the "protocol is the sole liquid holder"
// assumption. No transactions, no signer.
//
//   node scripts/legacy-drain/inventory.js
//   (optional) LEGACY_RPC_URL=<archive rpc> BLOCK=<n> ALLOWED_HOLDERS=0xabc,0xdef
//
// LEGACY_RPC_URL must serve historical eth_getLogs from the July 2026 deploy
// block. The Tenderly public gateway does; publicnode does not.
//
// Writes deployments/legacy-drain/inventory-<block>.json and exits non-zero on
// any failed check.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const ROOT = path.resolve(__dirname, "..", "..");
const addresses = require(path.join(ROOT, "deployments", "legacy-2026-07", "mainnet.addresses.json"));
const abi = (name) =>
  require(path.join(ROOT, "artifacts", "contracts", `${name}.sol`, `${name}.json`)).abi;

const RPC_URL = process.env.LEGACY_RPC_URL || "https://mainnet.gateway.tenderly.co";
const OUT_DIR = path.join(ROOT, "deployments", "legacy-drain");
const CONFIRMATIONS = 12;

const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const MINTER_ROLE = ethers.id("MINTER_ROLE");

const checks = [];
function record(name, ok, details) {
  checks.push({ name, ok, details: details || "" });
  console.log(`  ${ok ? "PASS" : "FAIL"} ${name}${details ? "  " + details : ""}`);
}

const usd = (v) => ethers.formatUnits(v, 6);
const tok = (v) => ethers.formatUnits(v, 18);

// Public gateways rate-limit bursts, so issue reads one at a time.
async function sequential(thunks) {
  const results = [];
  for (const thunk of thunks) results.push(await thunk());
  return results;
}

// Rebuild holder balances from Transfer logs, then confirm each against balanceOf.
async function holderBalances(provider, token, fromBlock, blockTag) {
  const logs = await provider.getLogs({
    address: await token.getAddress(),
    topics: [ethers.id("Transfer(address,address,uint256)")],
    fromBlock,
    toBlock: blockTag,
  });
  const balances = new Map();
  for (const log of logs) {
    const { args } = token.interface.parseLog(log);
    const [from, to, value] = args;
    if (from !== ethers.ZeroAddress) balances.set(from, (balances.get(from) || 0n) - value);
    if (to !== ethers.ZeroAddress) balances.set(to, (balances.get(to) || 0n) + value);
  }
  const holders = [];
  for (const [holder, replayed] of balances) {
    if (replayed === 0n) continue;
    const onChain = await token.balanceOf(holder, { blockTag });
    holders.push({ holder, balance: onChain, replayed });
  }
  return { holders, transferCount: logs.length };
}

async function poolEvents(pool, fromBlock, blockTag) {
  const [buys, sells, fees] = await sequential([
    () => pool.queryFilter(pool.filters.Buy(), fromBlock, blockTag),
    () => pool.queryFilter(pool.filters.Sell(), fromBlock, blockTag),
    () => pool.queryFilter(pool.filters.FeesDeposited(), fromBlock, blockTag),
  ]);
  const sum = (events, i) => events.reduce((s, e) => s + e.args[i], 0n);
  return {
    buys: buys.length,
    buyers: [...new Set(buys.map((e) => e.args[0]))],
    usdcIn: sum(buys, 1),
    sells: sells.length,
    sellers: [...new Set(sells.map((e) => e.args[0]))],
    usdcOut: sum(sells, 2),
    feeDeposits: fees.length,
    feeDepositors: [...new Set(fees.map((e) => e.args[0]))],
    feesDeposited: sum(fees, 1),
  };
}

async function inventoryPool(provider, entry, ctx) {
  const { blockTag, fromBlock, tokenManager, vault, escrow, allowed } = ctx;
  const pool = new ethers.Contract(entry.ammPool, abi("HokusaiAMM"), provider);
  const token = new ethers.Contract(entry.token, abi("HokusaiToken"), provider);
  const usdc = new ethers.Contract(addresses.reserveToken.address, ERC20_ABI, provider);
  const at = { blockTag };

  console.log(`\n${entry.symbol} (model ${entry.modelId}) pool ${entry.ammPool}`);

  const [
    reserveBalance, usdcBalance, hasGraduated, paused, buyOnlyUntil, threshold, flatPrice,
    crr, tradeFee, maxTradeBps, owner, treasury, whitelist, reserves,
    totalSupply, investorMinted, rewardMinted, maxSupply, supplierRecipient,
    vaultBalance, escrowBalance, poolIsMinter,
  ] = await sequential([
    () => pool.reserveBalance(at), () => usdc.balanceOf(entry.ammPool, at),
    () => pool.hasGraduated(at), () => pool.paused(at), () => pool.buyOnlyUntil(at),
    () => pool.FLAT_CURVE_THRESHOLD(at), () => pool.FLAT_CURVE_PRICE(at), () => pool.crr(at),
    () => pool.tradeFee(at), () => pool.maxTradeBps(at), () => pool.owner(at),
    () => pool.treasury(at), () => pool.purchaserWhitelist(at), () => pool.getReserves(at),
    () => token.totalSupply(at), () => token.investorMinted(at), () => token.rewardMinted(at),
    () => token.maxSupply(at), () => token.modelSupplierRecipient(at),
    () => token.balanceOf(vault, at), () => token.balanceOf(escrow, at),
    () => tokenManager.hasRole(MINTER_ROLE, entry.ammPool, at),
  ]);
  const redeemableSupply = reserves[1];

  const { holders, transferCount } = await holderBalances(provider, token, fromBlock, blockTag);
  const events = await poolEvents(pool, fromBlock, blockTag);

  const system = new Set([vault, escrow, entry.ammPool].map((a) => a.toLowerCase()));
  const expected = new Set([supplierRecipient, ...allowed].map((a) => a.toLowerCase()));
  const classify = (h) =>
    system.has(h.toLowerCase()) ? "system" : expected.has(h.toLowerCase()) ? "expected" : "unexpected";
  const classified = holders.map((h) => ({ ...h, kind: classify(h.holder) }));

  const prefix = entry.symbol;
  record(`${prefix}: tracked reserve == pool USDC balance`, reserveBalance === usdcBalance,
    `reserve ${usd(reserveBalance)} usdc ${usd(usdcBalance)}`);
  record(`${prefix}: replayed holder balances match balanceOf`,
    classified.every((h) => h.balance === h.replayed), `${transferCount} transfers`);
  const holderSum = classified.reduce((s, h) => s + h.balance, 0n);
  record(`${prefix}: holder balances sum to totalSupply`, holderSum === totalSupply,
    `sum ${tok(holderSum)} supply ${tok(totalSupply)}`);
  record(`${prefix}: redeemable supply == totalSupply - vesting vault`,
    redeemableSupply === totalSupply - vaultBalance, tok(redeemableSupply));
  const unexpected = classified.filter((h) => h.kind === "unexpected");
  record(`${prefix}: no unexpected liquid holders`, unexpected.length === 0,
    unexpected.map((h) => `${h.holder}=${tok(h.balance)}`).join(", "));
  record(`${prefix}: no reward mints`, rewardMinted === 0n, tok(rewardMinted));
  record(`${prefix}: escrow holds no claims`, escrowBalance === 0n, tok(escrowBalance));
  const foreignTraders = [...events.buyers, ...events.sellers].filter(
    (a) => !expected.has(a.toLowerCase()),
  );
  record(`${prefix}: only expected wallets traded`, foreignTraders.length === 0,
    foreignTraders.join(", "));
  record(`${prefix}: USDC flow reconciles`,
    events.usdcIn - events.usdcOut + events.feesDeposited >= reserveBalance,
    `buys ${usd(events.usdcIn)} sells ${usd(events.usdcOut)} fees ${usd(events.feesDeposited)}`);

  for (const h of classified) console.log(`    ${h.kind.padEnd(10)} ${h.holder} ${tok(h.balance)}`);

  return {
    symbol: entry.symbol,
    modelId: entry.modelId,
    pool: entry.ammPool,
    token: entry.token,
    poolState: {
      reserveBalance, usdcBalance, hasGraduated, paused, buyOnlyUntil, threshold, flatPrice,
      crr, tradeFee, maxTradeBps, owner, treasury, purchaserWhitelist: whitelist,
      redeemableSupply, poolIsMinter,
    },
    tokenState: { totalSupply, investorMinted, rewardMinted, maxSupply, supplierRecipient, vaultBalance, escrowBalance },
    holders: classified.map(({ replayed, ...h }) => h),
    events,
  };
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, 1, { staticNetwork: true, batchMaxCount: 1 });
  const head = await provider.getBlockNumber();
  const blockTag = process.env.BLOCK ? Number(process.env.BLOCK) : head - CONFIRMATIONS;
  const block = await provider.getBlock(blockTag);
  const fromBlock = addresses.deploymentBlocks.TokenManager;
  const allowed = (process.env.ALLOWED_HOLDERS || "").split(",").filter(Boolean);

  console.log(`Legacy pool inventory @ block ${blockTag} (${block.hash})`);

  const ctx = {
    blockTag,
    fromBlock,
    allowed,
    vault: addresses.contracts.RewardVestingVault,
    escrow: addresses.settlement.PendingClaimsEscrow,
    tokenManager: new ethers.Contract(addresses.contracts.TokenManager, abi("TokenManager"), provider),
  };

  const pools = [];
  for (const entry of addresses.tokens) pools.push(await inventoryPool(provider, entry, ctx));

  const failed = checks.filter((c) => !c.ok);
  const report = {
    generatedAt: new Date().toISOString(),
    chainId: 1,
    block: blockTag,
    blockHash: block.hash,
    blockTimestamp: block.timestamp,
    rpcHost: new URL(RPC_URL).host,
    pools,
    checks,
    ok: failed.length === 0,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `inventory-${blockTag}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));

  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`Wrote ${path.relative(ROOT, outPath)}`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
