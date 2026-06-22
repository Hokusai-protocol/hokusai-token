/*
 * HOK-2248 — case (b) release leg of the live contributor-reward drill.
 *
 * After a canary-930 mint whose recipient was the escrow (the no-wallet contributor route),
 * the escrow holds the liquid tranche. This releases it on-chain to a verified wallet using the
 * BACKEND KMS key (RELEASER_ROLE), mirroring what auth's EscrowReleaseService does on wallet
 * verification — proving the release leg end-to-end on Sepolia.
 *
 * In production the trigger is auto-release on wallet verification (auth-service). This script is
 * the operational stand-in for the drill, where there is no auth account behind the escrow mint.
 *
 * Run:
 *   set -a; . ./.env.sepolia; set +a
 *   RELEASE_TO=0x<verified-wallet> node scripts/canary-escrow-release.js
 *   # optional: RELEASE_AMOUNT=<wei> to release a partial amount (default: full escrow balance)
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const ESCROW = "0x46779C8eA22A9554cD53346bE382558F0d7EdEC0";
const BACKEND_EXPECTED = ethers.getAddress(
  process.env.KMS_BACKEND_EXPECTED_ADDRESS || "0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c",
);

function canaryTokenAddress(provider) {
  const dep = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "..", "deployments", "sepolia-latest.json"), "utf8"),
  );
  const mr = new ethers.Contract(
    dep.contracts.ModelRegistry,
    ["function getTokenAddress(uint256) view returns (address)"],
    provider,
  );
  return mr.getTokenAddress(930n);
}

async function main() {
  const target = process.env.RELEASE_TO;
  if (!target) throw new Error("RELEASE_TO is required (the verified wallet to receive the tranche)");
  const to = ethers.getAddress(target.trim());
  if (to === ethers.ZeroAddress) throw new Error("RELEASE_TO must not be the zero address");

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const keyId = process.env.KMS_BACKEND_KEY_ID;
  if (!keyId) throw new Error("KMS_BACKEND_KEY_ID is required (the RELEASER backend key)");

  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId,
    provider,
  });
  const me = ethers.getAddress(await signer.getAddress());
  if (me !== BACKEND_EXPECTED) throw new Error(`backend KMS pin mismatch: ${me} != ${BACKEND_EXPECTED}`);

  const token = ethers.getAddress(await canaryTokenAddress(provider));
  const art = require("../artifacts/contracts/PendingClaimsEscrow.sol/PendingClaimsEscrow.json");
  const escrow = new ethers.Contract(ESCROW, art.abi, signer);

  // Pre-flight: role + funds + not paused.
  const role = await escrow.RELEASER_ROLE();
  if (!(await escrow.hasRole(role, me))) throw new Error(`${me} lacks RELEASER_ROLE on the escrow`);
  if (await escrow.paused()) throw new Error("escrow is paused");
  const available = await escrow.tokenBalance(token);
  const amount = process.env.RELEASE_AMOUNT ? BigInt(process.env.RELEASE_AMOUNT) : available;
  if (amount <= 0n) throw new Error("nothing to release (escrow canary-token balance is 0)");
  if (amount > available) throw new Error(`amount ${amount} exceeds escrow balance ${available}`);

  const ref = ethers.id(`hok2248-canary-release:${to}:${token}`);
  const before = await new ethers.Contract(
    token,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(to);

  console.log("releaser:", me, "| escrow:", ESCROW, "| token:", token);
  console.log("releasing", amount.toString(), "to", to, "ref", ref);

  const tx = await escrow.release(token, to, amount, ref);
  console.log("release tx:", tx.hash);
  const receipt = await tx.wait();

  const after = await new ethers.Contract(
    token,
    ["function balanceOf(address) view returns (uint256)"],
    provider,
  ).balanceOf(to);
  const delta = after - before;
  if (delta !== amount) throw new Error(`balance delta ${delta} != released ${amount}`);

  console.log(`OK — released ${amount} (block ${receipt.blockNumber}); ${to} balance +${delta}`);
  console.log("escrow remaining canary-token balance:", (await escrow.tokenBalance(token)).toString());
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
