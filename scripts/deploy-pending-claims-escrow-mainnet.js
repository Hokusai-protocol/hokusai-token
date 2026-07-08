/*
 * Deploy PendingClaimsEscrow to Ethereum mainnet and hand it to governance (Option A:
 * deployer bootstraps, then transfers DEFAULT_ADMIN + PAUSER to the admin Safe).
 *
 * Holds DeltaOne reward tranches for contributors who earn before registering a verified
 * payout wallet; the auth EscrowReleaseService (RELEASER_ROLE) releases once a wallet is
 * verified. On mainnet the backend/settler identity is the KMS backend key
 * (MAINNET_BACKEND_ADDRESS = 0xc18D0B6eE049B2B113eE4671cB9C8109192e29E2), which also holds
 * DeltaVerifier SUBMITTER_ROLE.
 *
 * End state (verified before the record is written):
 *   - DEFAULT_ADMIN_ROLE, PAUSER_ROLE -> admin Safe (0x158B985CC667b4E022AD05B99E89007790da66E2)
 *   - RELEASER_ROLE                    -> backend key (MAINNET_BACKEND_ADDRESS)
 *   - deployer holds NONE (bootstrap roles renounced)
 *
 * DRY RUN by default. Broadcast only with EXECUTE=1 (or --execute).
 *
 * Run (dry run):
 *   MAINNET_RPC_URL=... AWS_REGION=us-east-1 node scripts/deploy-pending-claims-escrow-mainnet.js
 * Run (broadcast):
 *   EXECUTE=1 MAINNET_RPC_URL=... AWS_REGION=us-east-1 node scripts/deploy-pending-claims-escrow-mainnet.js
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const EXECUTE = process.env.EXECUTE === "1" || process.argv.includes("--execute");
const OUT = path.resolve(__dirname, "..", "deployments", "pending-claims-escrow-mainnet.json");
const LATEST = path.resolve(__dirname, "..", "deployments", "mainnet-latest.json");

// Canonical mainnet identities (env overridable, but pinned by default).
const DEPLOYER_KEY_ID =
  process.env.MAINNET_DEPLOYER_KMS_KEY_ID ||
  process.env.KMS_DEPLOYER_KEY_ID ||
  "alias/hokusai/production/ethereum/mainnet/deployer";
const DEPLOYER_EXPECTED =
  process.env.MAINNET_DEPLOYER_EXPECTED_ADDRESS ||
  process.env.KMS_DEPLOYER_EXPECTED_ADDRESS ||
  "0x56cA22006d67e14AA1b7820cE02c6B6205Df0c9e";
const RELEASER =
  process.env.RELEASER_ADDRESS ||
  process.env.MAINNET_BACKEND_ADDRESS ||
  process.env.KMS_BACKEND_EXPECTED_ADDRESS ||
  "0xc18D0B6eE049B2B113eE4671cB9C8109192e29E2";

function adminSafeFromRecord() {
  try {
    const rec = JSON.parse(fs.readFileSync(LATEST, "utf8"));
    return rec.governance && rec.governance.adminSafe;
  } catch (_) {
    return null;
  }
}
const ADMIN_SAFE = ethers.getAddress(
  process.env.ADMIN_SAFE ||
    process.env.MAINNET_ADMIN_SAFE ||
    adminSafeFromRecord() ||
    "0x158B985CC667b4E022AD05B99E89007790da66E2",
);

async function main() {
  const rpc = process.env.MAINNET_RPC_URL || process.env.RPC_URL;
  if (!rpc) throw new Error("MAINNET_RPC_URL (or RPC_URL) is required");
  const provider = new ethers.JsonRpcProvider(rpc);
  const net = await provider.getNetwork();
  if (net.chainId !== 1n) throw new Error(`refusing to run on chainId ${net.chainId} (expected 1 / mainnet)`);

  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: DEPLOYER_KEY_ID,
    provider,
  });
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== ethers.getAddress(DEPLOYER_EXPECTED)) {
    throw new Error(`deployer KMS pin mismatch: ${deployer} != ${DEPLOYER_EXPECTED}`);
  }
  const releaser = ethers.getAddress(RELEASER);
  if (releaser === ethers.ZeroAddress) throw new Error("RELEASER address must not be zero");

  const art = require("../artifacts/contracts/PendingClaimsEscrow.sol/PendingClaimsEscrow.json");
  const iface = new ethers.Interface(art.abi);
  const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;
  const PAUSER_ROLE = ethers.id("PAUSER_ROLE");
  const RELEASER_ROLE = ethers.id("RELEASER_ROLE");

  const bal = await provider.getBalance(deployer);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const deployTx = await factory.getDeployTransaction(deployer);
  const deployGas = await provider.estimateGas({ ...deployTx, from: deployer });
  const fee = await provider.getFeeData();

  console.log("=== PendingClaimsEscrow mainnet deploy (Option A: deployer -> admin Safe) ===");
  console.log("mode          :", EXECUTE ? "EXECUTE (broadcast)" : "DRY RUN (read-only)");
  console.log("chainId       :", net.chainId.toString());
  console.log("deployer      :", deployer, `(balance ${ethers.formatEther(bal)} ETH)`);
  console.log("constructor   : admin =", deployer, "(bootstrap)");
  console.log("RELEASER_ROLE ->", releaser, "(backend/settler key)");
  console.log("admin Safe    ->", ADMIN_SAFE, "(final DEFAULT_ADMIN + PAUSER)");
  console.log("est deploy gas:", deployGas.toString(), "@", ethers.formatUnits(fee.maxFeePerGas || fee.gasPrice || 0n, "gwei"), "gwei");

  const plan = [
    ["deploy", "PendingClaimsEscrow(deployer)"],
    ["grantRole", `RELEASER_ROLE -> ${releaser}`],
    ["grantRole", `PAUSER_ROLE -> ${ADMIN_SAFE}`],
    ["grantRole", `DEFAULT_ADMIN_ROLE -> ${ADMIN_SAFE}`],
    ["renounceRole", `PAUSER_ROLE (deployer ${deployer})`],
    ["renounceRole", `DEFAULT_ADMIN_ROLE (deployer ${deployer}) [LAST]`],
  ];
  console.log("\nplanned tx sequence:");
  plan.forEach(([op, d], i) => console.log(`  ${i + 1}. ${op.padEnd(13)} ${d}`));

  if (!EXECUTE) {
    console.log("\nDRY RUN complete. No transactions sent. Re-run with EXECUTE=1 to broadcast.");
    return;
  }

  // ---- broadcast ----
  console.log("\nbroadcasting...");
  const escrow = await factory.deploy(deployer);
  console.log("deploy tx :", escrow.deploymentTransaction().hash);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log("escrow    :", address);
  const c = new ethers.Contract(address, art.abi, signer);

  async function send(label, txPromise) {
    const tx = await txPromise;
    console.log(`${label}: ${tx.hash}`);
    await tx.wait();
    return tx.hash;
  }
  const txs = {};
  txs.grantReleaser = await send("grant RELEASER   ", c.grantRole(RELEASER_ROLE, releaser));
  txs.grantPauserSafe = await send("grant PAUSER safe", c.grantRole(PAUSER_ROLE, ADMIN_SAFE));
  txs.grantAdminSafe = await send("grant ADMIN safe ", c.grantRole(DEFAULT_ADMIN_ROLE, ADMIN_SAFE));
  txs.renouncePauser = await send("renounce PAUSER  ", c.renounceRole(PAUSER_ROLE, deployer));
  txs.renounceAdmin = await send("renounce ADMIN   ", c.renounceRole(DEFAULT_ADMIN_ROLE, deployer));

  // ---- verify end state ----
  const cr = new ethers.Contract(address, art.abi, provider);
  const checks = {
    safeIsAdmin: await cr.hasRole(DEFAULT_ADMIN_ROLE, ADMIN_SAFE),
    safeIsPauser: await cr.hasRole(PAUSER_ROLE, ADMIN_SAFE),
    backendIsReleaser: await cr.hasRole(RELEASER_ROLE, releaser),
    deployerNoAdmin: !(await cr.hasRole(DEFAULT_ADMIN_ROLE, deployer)),
    deployerNoPauser: !(await cr.hasRole(PAUSER_ROLE, deployer)),
    deployerNoReleaser: !(await cr.hasRole(RELEASER_ROLE, deployer)),
  };
  console.log("\nend-state verification:", JSON.stringify(checks, null, 2));
  const ok = Object.values(checks).every(Boolean);
  if (!ok) throw new Error("end-state verification FAILED — inspect roles before recording");

  const record = {
    contract: "PendingClaimsEscrow",
    network: "mainnet",
    chainId: Number(net.chainId),
    address,
    admin: ADMIN_SAFE,
    pauser: ADMIN_SAFE,
    releaser,
    deployedBy: deployer,
    deployTx: escrow.deploymentTransaction().hash,
    roleTxs: txs,
    adminModel: "Option A: deployer bootstrap -> admin Safe (DEFAULT_ADMIN+PAUSER); deployer renounced",
    note:
      "RELEASER_ROLE = mainnet backend/settler key (also DeltaVerifier SUBMITTER). " +
      "Add PENDING_CLAIMS_ESCROW_ADDRESS to .env.mainnet and the escrow to deltaone_system_sinks (HOK-2223).",
  };
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  console.log("\nrecorded ->", OUT);
  console.log("PENDING_CLAIMS_ESCROW_ADDRESS=" + address);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
