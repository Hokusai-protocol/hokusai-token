const hre = require("hardhat");

async function main() {
  const ammAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";
  const tokenManagerAddress = "0x0BA3eCeD140DdD254796b0bC4235309286C38724";

  const tokenManager = await hre.ethers.getContractAt("TokenManager", tokenManagerAddress);

  console.log("🔍 Checking MINTER_ROLE Authorization\n");

  // Get MINTER_ROLE hash
  const MINTER_ROLE = await tokenManager.MINTER_ROLE();
  console.log("MINTER_ROLE:", MINTER_ROLE);
  console.log("");

  // Check if AMM has MINTER_ROLE
  const hasRole = await tokenManager.hasRole(MINTER_ROLE, ammAddress);
  console.log("AMM Address:", ammAddress);
  console.log("Has MINTER_ROLE:", hasRole ? "✓ YES" : "✗ NO");
  console.log("");

  if (!hasRole) {
    console.log("❌ PROBLEM FOUND!");
    console.log("The AMM does not have MINTER_ROLE.");
    console.log("This is why buy() transactions are failing!");
    console.log("");
    console.log("TO FIX:");
    console.log(`npx hardhat run scripts/authorize-amm-pools.js --network sepolia`);
  } else {
    console.log("✓ AMM is properly authorized");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
