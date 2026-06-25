/*
 * Fix model-30 vesting config to match design-locked economics.
 *
 * Issue: the live model-30 HokusaiParams was deployed with 20% immediate / 30-day
 * vesting, violating scripts/configs/locked-economics.json (10% immediate / 1-year
 * linear / no cliff). This script calls setVestingConfig() to correct it.
 *
 * Authorization: setVestingConfig is onlyRole(GOV_ROLE). GOV_ROLE for the model-30
 * params (0x08eEB0...) is held by the launch wallet 0x3018Cf81... (an EOA). You must
 * run this with THAT wallet's key.
 *
 * NOTE: This only affects FUTURE mints. Vesting schedules already created by the
 * test mint (ids 7,8,9, at 20%/30d) are immutable and unchanged.
 *
 * Usage:
 *   RPC_URL=<sepolia rpc> GOVERNOR_PRIVATE_KEY=0x... node scripts/fix-model-30-vesting.js
 *   (dry-run by default; set APPLY=true to broadcast)
 */
const { ethers } = require("ethers");

const PARAMS = "0x08eEB0ec97055Fb7Acb53FdDB955233b64b947fa"; // model-30 HokusaiParams
const EXPECTED_GOVERNOR = "0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B";

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
  if (!rpc) throw new Error("set RPC_URL");
  if (!pk) throw new Error("set GOVERNOR_PRIVATE_KEY (the 0x3018... launch wallet)");

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : "0x" + pk, provider);
  if (wallet.address.toLowerCase() !== EXPECTED_GOVERNOR.toLowerCase()) {
    throw new Error(`signer ${wallet.address} is not the governor ${EXPECTED_GOVERNOR}`);
  }

  const params = new ethers.Contract(PARAMS, ABI, wallet);
  const GOV_ROLE = ethers.id("GOV_ROLE");
  if (!(await params.hasRole(GOV_ROLE, wallet.address))) {
    throw new Error(`${wallet.address} does not hold GOV_ROLE on ${PARAMS}`);
  }

  const before = await params.vestingConfig();
  console.log("current:", {
    enabled: before[0],
    immediateUnlockBps: before[1].toString(),
    vestingDurationSeconds: before[2].toString(),
    cliffSeconds: before[3].toString(),
  });
  console.log("target: ", TARGET);

  if (process.env.APPLY !== "true") {
    const data = params.interface.encodeFunctionData("setVestingConfig", [TARGET]);
    console.log("\nDRY RUN (set APPLY=true to broadcast).");
    console.log("to:  ", PARAMS);
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
  if (after[1] !== 1000n || after[2] !== 31536000n || after[3] !== 0n || after[0] !== true) {
    throw new Error("post-update verification FAILED");
  }
  console.log("✅ vesting config now matches locked-economics.json");
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
