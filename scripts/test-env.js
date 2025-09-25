require("dotenv").config({ path: '.env.sepolia' });

console.log("Testing environment variables...\n");

console.log("RPC_URL exists:", !!process.env.RPC_URL);
console.log("SEPOLIA_RPC_URL exists:", !!process.env.SEPOLIA_RPC_URL);
console.log("DEPLOYER_PRIVATE_KEY exists:", !!process.env.DEPLOYER_PRIVATE_KEY);

if (process.env.RPC_URL) {
  console.log("\nRPC_URL starts with:", process.env.RPC_URL.substring(0, 30) + "...");
}

if (process.env.DEPLOYER_PRIVATE_KEY) {
  console.log("DEPLOYER_PRIVATE_KEY starts with:", process.env.DEPLOYER_PRIVATE_KEY.substring(0, 6) + "...");
}

const hre = require("hardhat");
console.log("\nHardhat Sepolia network config:");
console.log("URL:", hre.config.networks.sepolia.url.substring(0, 30) + "...");
console.log("Has accounts:", hre.config.networks.sepolia.accounts.length > 0);