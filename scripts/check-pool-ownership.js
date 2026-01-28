const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const deployment = JSON.parse(fs.readFileSync("deployments/sepolia-latest.json", "utf8"));
  const [deployer] = await ethers.getSigners();

  console.log("Checking pool ownership...\n");
  console.log("Deployer address:", deployer.address);

  for (const poolInfo of deployment.pools) {
    const pool = await ethers.getContractAt("HokusaiAMM", poolInfo.ammAddress);
    const owner = await pool.owner();
    console.log(`\n${poolInfo.configKey} pool (${poolInfo.ammAddress}):`);
    console.log("  Owner:", owner);
    console.log("  Is deployer:", owner === deployer.address);
  }
}

main().catch(console.error);
