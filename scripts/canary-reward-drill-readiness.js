/*
 * HOK-2248 — read-only readiness check for the live contributor-reward drill on canary 930.
 * Verifies (no signing, no writes) that the chain is set up for both reward cases:
 *   (a) registered-wallet contributor mint, (b) no-wallet -> escrow -> release.
 *
 * Run: node scripts/canary-reward-drill-readiness.js   (reads RPC_URL from env/.env.sepolia)
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// Load RPC_URL from .env.sepolia without printing secrets.
function loadEnv() {
  const p = path.resolve(__dirname, "..", ".env.sepolia");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
loadEnv();

const MODEL_UINT = 930n;
const MODEL_STR = "930";
const ATTESTER = "0x07bf9b22f516d2D464511219488F019c5dFF5335";
const RELEASER = "0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c";
const ESCROW = "0x46779C8eA22A9554cD53346bE382558F0d7EdEC0";

const dep = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "..", "deployments", "sepolia-latest.json"), "utf8"),
);
const C = dep.contracts;

const ABI = {
  ModelRegistry: [
    "function getTokenAddress(uint256) view returns (address)",
    "function weightGenesis(uint256) view returns (bytes32)",
    "function isRegistered(uint256) view returns (bool)",
    "function isModelActive(uint256) view returns (bool)",
  ],
  DeltaVerifier: [
    "function modelWeightHead(uint256) view returns (bytes32)",
    "function mintBudgetRemaining(uint256) view returns (uint256)",
    "function isAttester(address) view returns (bool)",
    "function attesterThreshold() view returns (uint256)",
  ],
  TokenManager: [
    "function vestingVault() view returns (address)",
    "function hasToken(string) view returns (bool)",
  ],
  Escrow: [
    "function RELEASER_ROLE() view returns (bytes32)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function paused() view returns (bool)",
  ],
};

const ok = (b) => (b ? "OK  " : "FAIL");

async function main() {
  const rpc = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL;
  if (!rpc) throw new Error("RPC_URL not set (env or .env.sepolia)");
  const p = new ethers.JsonRpcProvider(rpc);

  const mr = new ethers.Contract(C.ModelRegistry, ABI.ModelRegistry, p);
  const dv = new ethers.Contract(C.DeltaVerifier, ABI.DeltaVerifier, p);
  const tm = new ethers.Contract(C.TokenManager, ABI.TokenManager, p);
  const escrow = new ethers.Contract(ESCROW, ABI.Escrow, p);

  const results = [];
  const add = (label, pass, detail) => results.push({ label, pass, detail });

  // Canary 930 set up
  const token = await mr.getTokenAddress(MODEL_UINT).catch(() => ethers.ZeroAddress);
  add("canary token registered (930)", token !== ethers.ZeroAddress, token);
  add("canary token in TokenManager", await tm.hasToken(MODEL_STR).catch(() => false), MODEL_STR);
  add("model 930 registered+active", (await mr.isRegistered(MODEL_UINT).catch(() => false)) && (await mr.isModelActive(MODEL_UINT).catch(() => false)), "");
  const genesis = await mr.weightGenesis(MODEL_UINT).catch(() => ethers.ZeroHash);
  add("weight genesis seeded", genesis !== ethers.ZeroHash, genesis);
  const head = await dv.modelWeightHead(MODEL_UINT).catch(() => ethers.ZeroHash);
  add("current model head (head or genesis used as baseline)", true, head === ethers.ZeroHash ? `${genesis} (genesis)` : head);
  const budget = await dv.mintBudgetRemaining(MODEL_UINT).catch(() => 0n);
  add("mint budget remaining > 0", budget > 0n, ethers.formatUnits(budget, 18) + " tokens");

  // Attester
  add("Ledger attester registered", await dv.isAttester(ATTESTER).catch(() => false), ATTESTER);
  const threshold = await dv.attesterThreshold().catch(() => 0n);
  add("attester threshold >= 1", threshold >= 1n, threshold.toString());

  // Vesting vault wired (case a/b 90% leg)
  const vault = await tm.vestingVault().catch(() => ethers.ZeroAddress);
  add("vesting vault wired on TokenManager", vault !== ethers.ZeroAddress, vault);
  add("vault matches sepolia-latest", vault.toLowerCase() === (C.RewardVestingVault || "").toLowerCase(), C.RewardVestingVault);

  // Escrow + releaser (case b release leg)
  const code = await p.getCode(ESCROW);
  add("escrow deployed", code && code !== "0x", ESCROW);
  let releaserOk = false;
  try {
    const role = await escrow.RELEASER_ROLE();
    releaserOk = await escrow.hasRole(role, RELEASER);
  } catch (e) {
    /* leave false */
  }
  add("backend key has RELEASER_ROLE", releaserOk, RELEASER);
  add("escrow not paused", !(await escrow.paused().catch(() => true)), "");

  console.log(`\nCanary-930 reward-drill readiness (chain id ${(await p.getNetwork()).chainId}):\n`);
  for (const r of results) {
    console.log(`  [${ok(r.pass)}] ${r.label}${r.detail ? `  — ${r.detail}` : ""}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${failed.length === 0 ? "ALL READY" : `${failed.length} BLOCKER(S)`}\n`);
}

main().catch((e) => {
  console.error("readiness check failed:", e.message);
  process.exit(1);
});
