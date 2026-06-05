const hre = require("hardhat");
const whitelistOps = require("./lib/whitelist-ops");

async function main(argv = process.argv.slice(2)) {
  const [signer] = await hre.ethers.getSigners();
  const whitelistAddress = whitelistOps.loadWhitelistAddress({ network: "sepolia" });
  const whitelist = await whitelistOps.loadWhitelistContract(whitelistAddress, signer);
  const addresses = whitelistOps.parseAddressesFromArgv(argv);
  const result = await whitelistOps.runAdd({ whitelist, addresses, logger: console });

  console.log(`Whitelist: ${result.address}`);
  for (const entry of result.results) {
    console.log(`${entry.address}: ${entry.whitelisted ? "WHITELISTED" : "NOT_WHITELISTED"}`);
  }

  return result;
}

module.exports = { main, runAdd: whitelistOps.runAdd };

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
