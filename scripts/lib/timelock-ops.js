// HOK-3290: timelock operations as Safe Transaction Builder bundles, plus a
// fork mode that sends the same calls from an impersonated Safe and skips the
// delay with evm_increaseTime.
//
// Every operation uses the batch form (scheduleBatch / executeBatch /
// hashOperationBatch) so single calls and multi-call upgrades share one shape.
// The admin Safe is the timelock's only proposer, executor and canceller.

const ZERO_HASH = "0x" + "00".repeat(32);

const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) payable",
  "function cancel(bytes32 id)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function getMinDelay() view returns (uint256)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
];

/**
 * A timelock batch operation.
 * @param calls [{ to, data, value?, label }] in execution order
 * @param salt  bytes32, or a string label hashed into one
 */
function batchOp(ethers, { calls, salt, predecessor = ZERO_HASH }) {
  return {
    targets: calls.map((c) => c.to),
    values: calls.map((c) => BigInt(c.value || 0)),
    payloads: calls.map((c) => c.data),
    predecessor,
    salt: ethers.isHexString(salt, 32) ? salt : ethers.id(salt),
    labels: calls.map((c) => c.label || ""),
  };
}

function operationId(ethers, op) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [op.targets, op.values, op.payloads, op.predecessor, op.salt]
    )
  );
}

function timelockInterface(ethers) {
  return new ethers.Interface(TIMELOCK_ABI);
}

// The calls the Safe makes on the timelock for each step.
function scheduleCall(ethers, timelock, op, delay) {
  return {
    to: timelock,
    data: timelockInterface(ethers).encodeFunctionData("scheduleBatch", [
      op.targets, op.values, op.payloads, op.predecessor, op.salt, delay,
    ]),
    label: `scheduleBatch(${op.labels.join(", ")})`,
  };
}

function executeCall(ethers, timelock, op) {
  return {
    to: timelock,
    data: timelockInterface(ethers).encodeFunctionData("executeBatch", [
      op.targets, op.values, op.payloads, op.predecessor, op.salt,
    ]),
    label: `executeBatch(${op.labels.join(", ")})`,
  };
}

function cancelCall(ethers, timelock, op) {
  return {
    to: timelock,
    data: timelockInterface(ethers).encodeFunctionData("cancel", [operationId(ethers, op)]),
    label: `cancel(${operationId(ethers, op)})`,
  };
}

/**
 * Safe Transaction Builder JSON for a list of calls (one Safe transaction,
 * executed as a MultiSend batch when there is more than one call).
 */
function safeBundle({ chainId, safe, name, description, calls }) {
  return {
    version: "1.0",
    chainId: String(chainId),
    createdAt: Date.now(),
    meta: { name, description },
    transactions: calls.map((c) => ({
      to: c.to,
      value: String(c.value || 0),
      data: c.data,
      contractMethod: null,
      contractInputsValues: null,
    })),
    safe,
  };
}

// ------------------------------------------------------------
// Fork mode
// ------------------------------------------------------------

async function impersonate(hre, address) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.request({
    method: "hardhat_setBalance",
    params: [address, "0x3635C9ADC5DEA00000"],
  });
  return hre.ethers.getSigner(address);
}

async function increaseTime(hre, seconds) {
  await hre.network.provider.request({ method: "evm_increaseTime", params: [Number(seconds)] });
  await hre.network.provider.request({ method: "evm_mine", params: [] });
}

/**
 * Send calls from an impersonated account, one transaction each (a Safe
 * would batch them; the effect is the same on a fork). Returns receipts.
 */
async function sendAs(hre, signer, calls) {
  const receipts = [];
  for (const c of calls) {
    const tx = await signer.sendTransaction({ to: c.to, data: c.data, value: c.value || 0 });
    receipts.push({ label: c.label, hash: tx.hash, gasUsed: (await tx.wait()).gasUsed });
  }
  return receipts;
}

module.exports = {
  TIMELOCK_ABI,
  ZERO_HASH,
  batchOp,
  cancelCall,
  executeCall,
  impersonate,
  increaseTime,
  operationId,
  safeBundle,
  scheduleCall,
  sendAs,
  timelockInterface,
};
