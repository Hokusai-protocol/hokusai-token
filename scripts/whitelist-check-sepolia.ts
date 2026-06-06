const hre = require("hardhat");
const {
  check,
  getWhitelistContract,
  parseArgs,
} = require("./lib/purchaser-whitelist");

async function main() {
  if (hre.network.name !== "sepolia") {
    throw new Error(`This script only runs on sepolia, got ${hre.network.name}`);
  }

  const args = parseArgs(process.argv.slice(2));
  if (!args.address) {
    throw new Error("Usage: <address>");
  }

  const contractInfo = await getWhitelistContract(hre);
  const result = await check(hre, args.address);
  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        whitelist: contractInfo.address,
        source: contractInfo.source,
        ...result,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
