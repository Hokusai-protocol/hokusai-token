const fs = require("fs");
const hre = require("hardhat");

const {
  EXPECTED_ADDRESSES,
  assertExpectedAddress,
  buildUpdatedDeploymentArtifact,
  formatError,
  loadDeployment,
  parseArgs,
  parseConfirmations,
  parseEventLogs,
  printJson,
  requireChecksummedAddress,
  requireDeploymentAddress,
  requireSepolia,
  sameAddress,
} = require("./lib/sepolia-fee-ops");

async function main() {
  requireSepolia();

  const args = parseArgs(process.argv.slice(2));
  const confirmations = parseConfirmations(args.confirmations);
  const wallet = requireChecksummedAddress(
    args.wallet || process.env.SETTLEMENT_WALLET_ADDRESS,
    "SETTLEMENT_WALLET_ADDRESS",
  );
  const { deployment, fullPath } = loadDeployment(args["deployment-file"]);

  const routerAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "UsageFeeRouter"),
    EXPECTED_ADDRESSES.UsageFeeRouter,
    "UsageFeeRouter",
  );

  const [adminSigner] = await hre.ethers.getSigners();
  const router = await hre.ethers.getContractAt("UsageFeeRouter", routerAddress, adminSigner);
  const feeDepositorRole = await router.FEE_DEPOSITOR_ROLE();
  const defaultAdminRole = await router.DEFAULT_ADMIN_ROLE();
  const signerIsAdmin = await router.hasRole(defaultAdminRole, adminSigner.address);

  if (!signerIsAdmin) {
    throw new Error(
      `signer ${adminSigner.address} is not DEFAULT_ADMIN_ROLE on UsageFeeRouter`,
    );
  }

  const alreadyDepositor = await router.isDepositor(wallet);
  if (alreadyDepositor) {
    const result = {
      network: hre.network.name,
      router: routerAddress,
      settlementWallet: wallet,
      grantTxHash: null,
      grantedBy: adminSigner.address,
      blockNumber: await hre.ethers.provider.getBlockNumber(),
      alreadyDepositor: true,
    };
    const updated = buildUpdatedDeploymentArtifact(deployment, wallet, null);
    fs.writeFileSync(fullPath, JSON.stringify(updated, null, 2) + "\n", "utf8");
    printJson(result);
    return;
  }

  const tx = await router.grantRole(feeDepositorRole, wallet);
  const receipt = await tx.wait(confirmations);
  if (receipt.status !== 1 && receipt.status !== 1n) {
    throw new Error(`grantRole transaction failed: ${tx.hash}`);
  }

  const roleGrantedEvents = parseEventLogs(receipt, router.interface, "RoleGranted");
  if (roleGrantedEvents.length !== 1) {
    throw new Error(`Expected exactly 1 RoleGranted event, found ${roleGrantedEvents.length}.`);
  }

  const event = roleGrantedEvents[0];
  if (
    event.args.role !== feeDepositorRole ||
    !sameAddress(event.args.account, wallet) ||
    !sameAddress(event.args.sender, adminSigner.address)
  ) {
    throw new Error("RoleGranted event fields did not match the expected grant.");
  }

  const postGrantDepositor = await router.isDepositor(wallet);
  if (!postGrantDepositor) {
    throw new Error(`Post-check failed: ${wallet} is not a depositor.`);
  }

  const updated = buildUpdatedDeploymentArtifact(deployment, wallet, tx.hash);
  fs.writeFileSync(fullPath, JSON.stringify(updated, null, 2) + "\n", "utf8");

  printJson({
    network: hre.network.name,
    router: routerAddress,
    settlementWallet: wallet,
    grantTxHash: tx.hash,
    grantedBy: adminSigner.address,
    blockNumber: receipt.blockNumber,
    alreadyDepositor: false,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
