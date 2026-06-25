/*
 * Set a model's HokusaiParams vesting config to the design-locked economics
 * (10% immediate / 1-year linear / no cliff), per scripts/configs/locked-economics.json.
 *
 * Reusable across models. Authorization: setVestingConfig is onlyRole(GOV_ROLE);
 * the signer must hold GOV_ROLE on the target params contract.
 *
 * NOTE: only affects FUTURE mints. Vesting schedules already created are immutable.
 *
 * Usage:
 *   RPC_URL=<sepolia rpc> GOVERNOR_PRIVATE_KEY=0x... PARAMS_ADDRESS=0x... node scripts/fix-vesting-config.js
 *   (dry-run by default; set APPLY=true to broadcast)
 */
const { ethers } = require("ethers");

// Target = scripts/configs/locked-economics.json
const TARGET = {
  enabled: true,
  immediateUnlockBps: 1000, // 10%
  vestingDurationSeconds: 31536000, // 365 days
  cliffSeconds: 0,
};

const ABI = [
  "function vestingConfig() view returns (bool enabled,uint16 immediateUnlockBps,uint64 vestingDurationSeconds,uint64 cliffSeconds)",
  "function setVestingConfig((bool enabled,uint16 immediateUnlockBps,uint64 vestingDurationSeconds,uint64 cliffSeconds) cfg)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
];

async function main() {
  const rpc = process.env.RPC_URL || process.env.SEPOLIA_RPC_URL;
  const pk = process.env.GOVERNOR_PRIVATE_KEY;
  const paramsAddress = (process.env.PARAMS_ADDRESS || "").trim();
  if (!rpc) throw new Error("set RPC_URL");
  if (!pk) throw new Error("set GOVERNOR_PRIVATE_KEY");
  if (!ethers.isAddress(paramsAddress)) throw new Error(`set PARAMS_ADDRESS to a valid address (got ${paramsAddress || "<empty>"})`);

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  const params = new ethers.Contract(paramsAddress, ABI, wallet);

  const GOV_ROLE = ethers.id("GOV_ROLE");
  if (!(await params.hasRole(GOV_ROLE, wallet.address))) {
    throw new Error(`signer ${wallet.address} does not hold GOV_ROLE on ${paramsAddress}`);
  }
  console.log("params: ", paramsAddress);
  console.log("signer: ", wallet.address, "(holds GOV_ROLE ✓)");

  const before = await params.vestingConfig();
  console.log("current:", {
    enabled: before[0],
    immediateUnlockBps: before[1].toString(),
    vestingDurationSeconds: before[2].toString(),
    cliffSeconds: before[3].toString(),
  });
  console.log("target: ", TARGET);

  if (before[0] === TARGET.enabled && before[1] === 1000n && before[2] === 31536000n && before[3] === 0n) {
    console.log("✅ already matches locked economics; nothing to do.");
    return;
  }

  if (process.env.APPLY !== "true") {
    const data = params.interface.encodeFunctionData("setVestingConfig", [TARGET]);
    console.log("\nDRY RUN (set APPLY=true to broadcast).");
    console.log("to:  ", paramsAddress);
    console.log("data:", data);
    return;
  }

  const tx = await params.setVestingConfig(TARGET);
  console.log("\nsubmitted:", tx.hash);
  const rcpt = await tx.wait();
  console.log("mined in block", rcpt.blockNumber, "status", rcpt.status);

  const after = await params.vestingConfig();
  console.log("new config:", {
    enabled: after[0],
    immediateUnlockBps: after[1].toString(),
    vestingDurationSeconds: after[2].toString(),
    cliffSeconds: after[3].toString(),
  });
  if (after[0] !== true || after[1] !== 1000n || after[2] !== 31536000n || after[3] !== 0n) {
    throw new Error("post-update verification FAILED");
  }
  console.log("✅ vesting config now matches locked-economics.json");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
