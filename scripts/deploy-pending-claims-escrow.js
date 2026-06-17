/*
 * HOK-2246 — Deploy PendingClaimsEscrow.
 *
 * Holds DeltaOne reward shares for contributors who earn before registering a verified
 * payout wallet; the auth settler (RELEASER_ROLE) releases tranches once a wallet is
 * verified. Admin (DEFAULT_ADMIN_ROLE + PAUSER_ROLE) = the governance admin (0xAfA9 Safe
 * for now). RELEASER_ROLE is granted separately to the auth settler identity.
 *
 * Run:
 *   SEPOLIA_RPC_URL=... AWS_REGION=us-east-1 node scripts/deploy-pending-claims-escrow.js
 *   DEPLOY_ADMIN=0x... to override the admin.
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { KMSClient } = require("@aws-sdk/client-kms");

const ADMIN = process.env.DEPLOY_ADMIN || "0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da";
const OUT = path.resolve(__dirname, "..", "deployments", "pending-claims-escrow.json");

async function main() {
  const p = new ethers.JsonRpcProvider(process.env.RPC_URL || process.env.SEPOLIA_RPC_URL);
  const { KmsSigner } = require("../services/contract-deployer/dist/blockchain/kms-signer");
  const signer = await KmsSigner.fromKeyId({
    client: new KMSClient({ region: process.env.AWS_REGION || "us-east-1" }),
    keyId: "alias/hokusai/development/ethereum/sepolia/deployer",
    provider: p,
  });
  const deployer = ethers.getAddress(await signer.getAddress());
  if (deployer !== ethers.getAddress("0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da")) {
    throw new Error(`deployer KMS pin mismatch: ${deployer}`);
  }
  const admin = ethers.getAddress(ADMIN);
  console.log("deployer:", deployer, "| admin:", admin);

  const art = require("../artifacts/contracts/PendingClaimsEscrow.sol/PendingClaimsEscrow.json");
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const escrow = await factory.deploy(admin);
  console.log("deploy tx:", escrow.deploymentTransaction().hash);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log("PendingClaimsEscrow deployed:", address);

  // verify wiring
  const c = new ethers.Contract(address, art.abi, p);
  const net = await p.getNetwork();
  console.log("admin has DEFAULT_ADMIN_ROLE:", await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), admin));
  console.log("admin has PAUSER_ROLE       :", await c.hasRole(await c.PAUSER_ROLE(), admin));
  console.log("RELEASER_ROLE granted to none yet:", !(await c.hasRole(await c.RELEASER_ROLE(), admin)));

  const record = {
    contract: "PendingClaimsEscrow",
    network: "sepolia",
    chainId: Number(net.chainId),
    address,
    admin,
    deployTx: escrow.deploymentTransaction().hash,
    note: "RELEASER_ROLE granted separately to the auth settler. Add address to deltaone_system_sinks (HOK-2223).",
  };
  fs.writeFileSync(OUT, JSON.stringify(record, null, 2));
  console.log("recorded ->", OUT);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exit(1);
});
