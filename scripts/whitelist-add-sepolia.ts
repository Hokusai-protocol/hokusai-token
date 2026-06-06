const hre = require("hardhat");
const {
  add,
  addBatch,
  getWhitelistContract,
  loadBatchAddresses,
  parseArgs,
} = require("./lib/purchaser-whitelist");

async function main() {
  if (hre.network.name !== "sepolia") {
    throw new Error(`This script only runs on sepolia, got ${hre.network.name}`);
  }

  const args = parseArgs(process.argv.slice(2));
  const contractInfo = await getWhitelistContract(hre);
  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        whitelist: contractInfo.address,
        source: contractInfo.source,
      },
      null,
      2
    )
  );

  if (args.batchFile) {
    const addresses = loadBatchAddresses(hre, args.batchFile);
    const result = await addBatch(hre, addresses);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (!args.address) {
    throw new Error("Usage: <address> or --batch <file.json>");
  }

  const result = await add(hre, args.address);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
