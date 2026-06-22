/*
 * HOK-1694 — Hand off DeltaVerifier PAUSER_ROLE to the dedicated KMS pauser key.
 *
 * Grants PAUSER_ROLE to the new dedicated hot pauser address and (with --revoke-deployer) revokes
 * it from the deployer, so the kill-switch lives on a pause-only key that cannot mint, while the
 * minter/submitter cannot pause. unpause() stays with DEFAULT_ADMIN_ROLE (the admin/Safe).
 *
 * Signed by the governance admin (DEFAULT_ADMIN_ROLE = 0xAfA9 KMS deployer). The pauser identity
 * must be supplied explicitly (PAUSER_ADDRESS) — never defaulted. Idempotent; read-only until run.
 *
 * SAFE SEQUENCE (no no-pauser window):
 *   1) grant first (deployer keeps PAUSER for now):
 *        SEPOLIA_RPC_URL=... AWS_REGION=us-east-1 PAUSER_ADDRESS=0x11EA... \
 *          node scripts/grant-pauser-role.js
 *   2) prove the new key can actually pause/unpause (assume the pause-operator role first):
 *        KMS_PAUSER_KEY_ID=alias/hokusai/development/ethereum/sepolia/pauser \
 *        KMS_PAUSER_EXPECTED_ADDRESS=0x11EA... node scripts/drills/pause-drill.js
 *   3) only then revoke the deployer:
 *        PAUSER_ADDRESS=0x11EA... node scripts/grant-pauser-role.js --revoke-deployer
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const ADMIN = ethers.getAddress("0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da");
const DEPLOYMENT = path.resolve(__dirname, "..", "deployments", "sepolia-latest.json");

function requirePauserAddress() {
  const raw = process.env.PAUSER_ADDRESS || process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a));
  if (!raw || !raw.trim()) {
    throw new Error("PAUSER_ADDRESS is required (the dedicated pauser address to grant PAUSER_ROLE)");
  }
  const pauser = ethers.getAddress(raw.trim());
  if (pauser === ethers.ZeroAddress) throw new Error("PAUSER_ADDRESS must not be the zero address");
  return pauser;
}

async function main() {
  const revokeDeployer = process.argv.includes("--revoke-deployer");
  const pauser = requirePauserAddress();
  const dvAddress = ethers.getAddress(JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8")).contracts.DeltaVerifier);

  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: process.env.KMS_DEPLOYER_KEY_ID || "alias/hokusai/development/ethereum/sepolia/deployer",
    provider,
  });
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== ADMIN) throw new Error(`deployer KMS pin mismatch: ${deployer} != ${ADMIN}`);

  const abi = [
    "function PAUSER_ROLE() view returns (bytes32)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function grantRole(bytes32,address)",
    "function revokeRole(bytes32,address)",
    "function hasRole(bytes32,address) view returns (bool)",
  ];
  const dv = new ethers.Contract(dvAddress, abi, signer);
  const PAUSER_ROLE = await dv.PAUSER_ROLE();

  if (!(await dv.hasRole(await dv.DEFAULT_ADMIN_ROLE(), deployer))) {
    throw new Error(`signer ${deployer} is not DEFAULT_ADMIN_ROLE on DeltaVerifier ${dvAddress}`);
  }
  console.log("admin/deployer:", deployer, "| DeltaVerifier:", dvAddress, "| new pauser:", pauser);

  // 1) Grant the new pauser (idempotent).
  if (await dv.hasRole(PAUSER_ROLE, pauser)) {
    console.log("PAUSER_ROLE already held by", pauser, "- skip grant");
  } else {
    const tx = await dv.grantRole(PAUSER_ROLE, pauser);
    console.log("grant tx:", tx.hash);
    await tx.wait();
    if (!(await dv.hasRole(PAUSER_ROLE, pauser))) throw new Error("grant did not take effect");
    console.log("PAUSER_ROLE granted to", pauser);
  }

  // 2) Optionally revoke the deployer (only after the new key is proven to pause).
  if (revokeDeployer) {
    if (!(await dv.hasRole(PAUSER_ROLE, pauser))) {
      throw new Error("refusing to revoke deployer: new pauser does not hold PAUSER_ROLE");
    }
    if (await dv.hasRole(PAUSER_ROLE, deployer)) {
      const tx = await dv.revokeRole(PAUSER_ROLE, deployer);
      console.log("revoke tx:", tx.hash);
      await tx.wait();
      console.log("PAUSER_ROLE revoked from deployer", deployer);
    } else {
      console.log("deployer does not hold PAUSER_ROLE - nothing to revoke");
    }
  } else {
    console.log("(deployer PAUSER_ROLE left intact; re-run with --revoke-deployer after proving the new key pauses)");
  }

  // Final state.
  console.log("\nPAUSER_ROLE holders now:");
  console.log("  new pauser", pauser, ":", await dv.hasRole(PAUSER_ROLE, pauser));
  console.log("  deployer  ", deployer, ":", await dv.hasRole(PAUSER_ROLE, deployer));
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
