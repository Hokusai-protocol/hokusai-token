const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { getDeploySigner } = require("./lib/get-deploy-signer");
const {
  add,
  addBatch,
  buildSafeTransaction,
  getRoleStatus,
  getWhitelistContract,
  loadBatchAddresses,
  parseArgs,
  remove,
  removeBatch,
} = require("./lib/purchaser-whitelist");

function writeJson(filePath, data) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(data, null, 2)}\n`);
  return resolved;
}

async function collectAddresses(args) {
  if (args.batchFile) {
    return loadBatchAddresses(hre, args.batchFile);
  }

  if (!args.address) {
    throw new Error("Usage: add|remove|check|roles <address> [--use-deploy-signer] [--safe-tx --out <file>] or add|remove --batch <file.json> [--use-deploy-signer] [--safe-tx --out <file>]");
  }

  return [args.address];
}

async function main() {
  if (hre.network.name !== "mainnet") {
    throw new Error(`This script only runs on mainnet, got ${hre.network.name}`);
  }

  const [command, ...rest] = process.argv.slice(2);
  if (!["add", "remove", "check", "roles"].includes(command)) {
    throw new Error("Usage: add|remove|check|roles <address> [--batch <file.json>] [--safe-tx --out <file>]");
  }

  const args = parseArgs(rest);
  const signer = args.useDeploySigner ? await getDeploySigner(hre) : null;
  const contractInfo = await getWhitelistContract(hre, signer ? { signer } : {});
  const roleStatus = await getRoleStatus(hre, signer ? { signer } : {});
  console.log(
    JSON.stringify(
      {
        network: hre.network.name,
        whitelist: contractInfo.address,
        source: contractInfo.source,
        adminSafe: roleStatus.adminSafe,
        adminSafeHasWhitelistAdminRole: roleStatus.adminSafeHasWhitelistAdminRole,
        signer: roleStatus.signer,
        signerHasWhitelistAdminRole: roleStatus.signerHasWhitelistAdminRole,
      },
      null,
      2
    )
  );

  if (command === "roles") {
    console.log(JSON.stringify(roleStatus, null, 2));
    return;
  }

  const addresses = await collectAddresses(args);

  if (command === "check") {
    if (addresses.length !== 1) {
      throw new Error("check accepts exactly one address");
    }
    const normalized = hre.ethers.getAddress(addresses[0]);
    const isWhitelisted = await contractInfo.whitelist.isWhitelisted(normalized);
    console.log(JSON.stringify({ address: normalized, isWhitelisted }, null, 2));
    return;
  }

  if (args.safeTx) {
    const method = command === "add" ? "addBatch" : "removeBatch";
    const safeTx = buildSafeTransaction({
      runtime: hre,
      deployment: contractInfo.deployment,
      whitelistAddress: contractInfo.address,
      method,
      addresses,
    });
    const defaultOut = `deployments/mainnet-purchaser-whitelist-${command}-safe.json`;
    const outPath = writeJson(args.outFile || defaultOut, safeTx);
    console.log(JSON.stringify({ safeTx: outPath, transactions: safeTx.transactions.length }, null, 2));
    if (!roleStatus.adminSafeHasWhitelistAdminRole) {
      console.warn("Warning: admin Safe does not currently have WHITELIST_ADMIN_ROLE; this Safe bundle will revert unless that role is granted first.");
    }
    return;
  }

  if (!roleStatus.signerHasWhitelistAdminRole) {
    throw new Error("Signer does not have WHITELIST_ADMIN_ROLE. Use --safe-tx if the admin Safe has the role, or grant the role first.");
  }

  const result =
    command === "add"
      ? args.batchFile
        ? await addBatch(hre, addresses, signer ? { signer } : {})
        : await add(hre, addresses[0], signer ? { signer } : {})
      : args.batchFile
        ? await removeBatch(hre, addresses, signer ? { signer } : {})
        : await remove(hre, addresses[0], signer ? { signer } : {});
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
