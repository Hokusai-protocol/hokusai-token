// Read-only post-launch verifier for the supplier distribution + deployer role cleanup.
// Run after each 48h timelock execute (and after the immediate VERIFIER Safe tx):
//
//   HARDHAT_NETWORK=mainnet node scripts/verify-post-launch-distribution.js
//
// Checks (each printed PASS/PENDING so it's safe to run before the executes land):
//  - supplier distribution: modelSupplierDistributed, 10% immediate at recipient, 90% in vesting vault
//  - VERIFIER  -> relayer, not deployer  (DataContributionRegistry)
//  - PAYER     -> admin Safe, not deployer  (InfrastructureReserve)
//  - FEE_DEPOSITOR -> relayer, not deployer  (UsageFeeRouter)
const hre = require("hardhat");
const path = require("path");
const { ethers } = hre;

const DEPLOYER = "0x56cA22006d67e14AA1b7820cE02c6B6205Df0c9e";
const RELAYER = "0xc18D0B6eE049B2B113eE4671cB9C8109192e29E2";
const ADMIN_SAFE = "0x158B985CC667b4E022AD05B99E89007790da66E2";

function mark(ok) {
  return ok ? "PASS" : "PENDING/FAIL";
}

async function main() {
  const d = require(path.resolve(process.cwd(), "deployments/mainnet-latest.json"));
  const C = d.contracts;

  // --- supplier distribution ---
  console.log("=== Supplier distribution ===");
  const tokenAbi = [
    "function symbol() view returns(string)",
    "function modelSupplierDistributed() view returns(bool)",
    "function modelSupplierRecipient() view returns(address)",
    "function modelSupplierAllocation() view returns(uint256)",
    "function balanceOf(address) view returns(uint256)",
    "function totalSupply() view returns(uint256)",
  ];
  const vestingVault = await (
    new ethers.Contract(C.TokenManager, ["function vestingVault() view returns(address)"], ethers.provider)
  ).vestingVault();
  for (const t of d.tokens) {
    const c = new ethers.Contract(t.address, tokenAbi, ethers.provider);
    const [sym, distributed, recipient, alloc] = await Promise.all([
      c.symbol(), c.modelSupplierDistributed(), c.modelSupplierRecipient(), c.modelSupplierAllocation(),
    ]);
    const immediate = (alloc * 1000n) / 10000n; // 10% immediateUnlockBps
    const vested = alloc - immediate;
    const [recipBal, vaultBal] = await Promise.all([c.balanceOf(recipient), c.balanceOf(vestingVault)]);
    const ok = distributed && recipBal >= immediate && vaultBal >= vested;
    console.log(`  ${sym}: ${mark(ok)} distributed=${distributed}`);
    console.log(`    recipient ${recipient} balance ${ethers.formatEther(recipBal)} (expect >= ${ethers.formatEther(immediate)} immediate)`);
    console.log(`    vesting vault balance ${ethers.formatEther(vaultBal)} (expect >= ${ethers.formatEther(vested)} vested)`);
  }

  // --- role cleanup ---
  console.log("\n=== Deployer role cleanup ===");
  const roleAbi = [
    "function hasRole(bytes32,address) view returns(bool)",
    "function VERIFIER_ROLE() view returns(bytes32)",
    "function PAYER_ROLE() view returns(bytes32)",
    "function FEE_DEPOSITOR_ROLE() view returns(bytes32)",
  ];
  const dc = new ethers.Contract(C.DataContributionRegistry, roleAbi, ethers.provider);
  const ir = new ethers.Contract(C.InfrastructureReserve, roleAbi, ethers.provider);
  const ur = new ethers.Contract(C.UsageFeeRouter, roleAbi, ethers.provider);
  const VER = await dc.VERIFIER_ROLE();
  const PAY = await ir.PAYER_ROLE();
  const FEE = await ur.FEE_DEPOSITOR_ROLE();

  const check = async (label, contract, role, wanted) => {
    const wantedHas = await contract.hasRole(role, wanted);
    const deployerHas = await contract.hasRole(role, DEPLOYER);
    console.log(`  ${label}: ${mark(wantedHas && !deployerHas)} wanted(${wanted.slice(0, 8)})=${wantedHas} deployer=${deployerHas}`);
  };
  await check("VERIFIER->relayer", dc, VER, RELAYER);
  await check("PAYER->adminSafe", ir, PAY, ADMIN_SAFE);
  await check("FEE_DEPOSITOR->relayer", ur, FEE, RELAYER);
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR", e.message); process.exit(1); });
