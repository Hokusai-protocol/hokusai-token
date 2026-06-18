/*
 * HOK-2246 — Grant RELEASER_ROLE on PendingClaimsEscrow to the auth settler.
 *
 * The auth settlement service (RELEASER_ROLE) releases an escrowed tranche to a contributor's
 * wallet once it has verified account<->wallet ownership (canonical wallet_verification,
 * HOK-2243). This is the single privileged seam in the mirror model, so the releaser identity
 * must be supplied explicitly (RELEASER_ADDRESS) — never defaulted or guessed.
 *
 * Signed by the governance admin (DEFAULT_ADMIN_ROLE = 0xAfA9 KMS deployer). Idempotent:
 * skips if the role is already held. Read-only until you run it.
 *
 * Run:
 *   SEPOLIA_RPC_URL=... AWS_REGION=us-east-1 RELEASER_ADDRESS=0x... \
 *     node scripts/grant-releaser-role.js
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const ADMIN = ethers.getAddress("0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da");
const DEPLOYMENT = path.resolve(__dirname, "..", "deployments", "pending-claims-escrow.json");

function requireReleaserAddress() {
  const raw = process.env.RELEASER_ADDRESS;
  if (!raw || !raw.trim()) {
    throw new Error(
      "RELEASER_ADDRESS is required (the auth settler identity to grant RELEASER_ROLE)",
    );
  }
  const releaser = ethers.getAddress(raw.trim());
  if (releaser === ethers.ZeroAddress) {
    throw new Error("RELEASER_ADDRESS must not be the zero address");
  }
  return releaser;
}

async function main() {
  const releaser = requireReleaserAddress();
  const deployment = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const escrowAddress = ethers.getAddress(deployment.address);

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: "alias/hokusai/development/ethereum/sepolia/deployer",
    provider,
  });
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== ADMIN) {
    throw new Error(`deployer KMS pin mismatch: ${deployer} != ${ADMIN}`);
  }
  console.log("admin/deployer:", deployer, "| escrow:", escrowAddress, "| releaser:", releaser);

  const art = require("../artifacts/contracts/PendingClaimsEscrow.sol/PendingClaimsEscrow.json");
  const escrow = new ethers.Contract(escrowAddress, art.abi, signer);
  const releaserRole = await escrow.RELEASER_ROLE();

  if (!(await escrow.hasRole(await escrow.DEFAULT_ADMIN_ROLE(), deployer))) {
    throw new Error(`signer ${deployer} is not DEFAULT_ADMIN_ROLE on the escrow`);
  }
  if (await escrow.hasRole(releaserRole, releaser)) {
    console.log("RELEASER_ROLE already granted to", releaser, "- nothing to do");
    return;
  }

  const tx = await escrow.grantRole(releaserRole, releaser);
  console.log("grant tx:", tx.hash);
  await tx.wait();
  const granted = await escrow.hasRole(releaserRole, releaser);
  if (!granted) {
    throw new Error("grant did not take effect");
  }
  console.log("RELEASER_ROLE granted to", releaser);

  deployment.releaser = releaser;
  deployment.releaserGrantTx = tx.hash;
  deployment.note =
    "RELEASER_ROLE granted to the auth settler. Add address to deltaone_system_sinks (HOK-2223).";
  fs.writeFileSync(DEPLOYMENT, JSON.stringify(deployment, null, 2));
  console.log("recorded ->", DEPLOYMENT);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
