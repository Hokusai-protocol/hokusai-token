// Storage-layout and upgrade-safety gate for proxied contracts (HOK-3281).
// Fails if HokusaiAMM is unsafe as a transparent-proxy implementation (e.g. a
// constructor that writes state, selfdestruct, delegatecall, immutables) or if
// the reference V2 can no longer be laid over it.
const { ethers, upgrades } = require("hardhat");

const IMPLEMENTATIONS = ["HokusaiAMM"];
const UPGRADE_PAIRS = [["HokusaiAMM", "HokusaiAMMV2Mock"]];

async function main() {
  for (const name of IMPLEMENTATIONS) {
    await upgrades.validateImplementation(await ethers.getContractFactory(name), { kind: "transparent" });
    console.log(`ok  ${name} is upgrade-safe`);
  }
  for (const [from, to] of UPGRADE_PAIRS) {
    await upgrades.validateUpgrade(
      await ethers.getContractFactory(from),
      await ethers.getContractFactory(to),
      { kind: "transparent" }
    );
    console.log(`ok  ${to} is a storage-compatible upgrade of ${from}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
