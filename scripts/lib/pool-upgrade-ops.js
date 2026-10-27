// HOK-3290: the calls behind a timelocked pool upgrade, pause, unpause and
// freeze, and the on-chain records (bytecode hashes, EIP-1967 slots) the
// rehearsal attaches as evidence.
//
// The factory owns every pool, so a reinitializer cannot run through
// ProxyAdmin.upgradeAndCall (msg.sender would be the ProxyAdmin, not the
// owner). An upgrade that needs one is a batch: ProxyAdmin.upgrade, then
// factory.callPool(modelId, reinitializer).

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";

const PROXY_ADMIN_ABI = [
  "function upgrade(address proxy, address implementation)",
  "function freezeUpgrades(address proxy)",
  "function canExit(address pool) view returns (bool)",
  "function isPaused(address pool) view returns (bool)",
];
const FACTORY_ABI = [
  "function callPool(string modelId, bytes data)",
  "function pausePool(string modelId)",
  "function unpausePool(string modelId)",
];
const V2_ABI = ["function initializeV2(uint256 marker)"];

function upgradeCalls(ethers, { proxyAdmin, factory, modelId, pool, implementation, v2Marker }) {
  const admin = new ethers.Interface(PROXY_ADMIN_ABI);
  const calls = [{
    to: proxyAdmin,
    data: admin.encodeFunctionData("upgrade", [pool, implementation]),
    label: `ProxyAdmin.upgrade(${modelId})`,
  }];
  if (v2Marker !== undefined) {
    const init = new ethers.Interface(V2_ABI).encodeFunctionData("initializeV2", [v2Marker]);
    calls.push({
      to: factory,
      data: new ethers.Interface(FACTORY_ABI).encodeFunctionData("callPool", [modelId, init]),
      label: `factory.callPool(${modelId}, initializeV2)`,
    });
  }
  return calls;
}

function freezeCall(ethers, { proxyAdmin, modelId, pool }) {
  return {
    to: proxyAdmin,
    data: new ethers.Interface(PROXY_ADMIN_ABI).encodeFunctionData("freezeUpgrades", [pool]),
    label: `ProxyAdmin.freezeUpgrades(${modelId})`,
  };
}

function pauseCall(ethers, { factory, modelId }) {
  return {
    to: factory,
    data: new ethers.Interface(FACTORY_ABI).encodeFunctionData("pausePool", [modelId]),
    label: `factory.pausePool(${modelId})`,
  };
}

function unpauseCall(ethers, { factory, modelId }) {
  return {
    to: factory,
    data: new ethers.Interface(FACTORY_ABI).encodeFunctionData("unpausePool", [modelId]),
    label: `factory.unpausePool(${modelId})`,
  };
}

async function readSlotAddress(provider, address, slot) {
  const raw = await provider.getStorage(address, slot);
  return "0x" + raw.slice(26);
}

/** EIP-1967 implementation and admin of a proxy. */
async function proxySlots(provider, proxy) {
  return {
    implementation: await readSlotAddress(provider, proxy, IMPLEMENTATION_SLOT),
    admin: await readSlotAddress(provider, proxy, ADMIN_SLOT),
  };
}

/**
 * Bytecode hashes for every deployed contract, and proxy slots for every pool.
 */
async function deploymentRecords(ethers, deployment) {
  const provider = ethers.provider;
  const codeHashes = {};
  for (const [name, address] of Object.entries(deployment.contracts || {})) {
    if (!ethers.isAddress(address)) continue;
    const code = await provider.getCode(address);
    codeHashes[name] = { address, codeHash: ethers.keccak256(code), bytes: (code.length - 2) / 2 };
  }
  const pools = [];
  for (const pool of deployment.pools || []) {
    const slots = await proxySlots(provider, pool.ammAddress);
    const implCode = await provider.getCode(slots.implementation);
    pools.push({
      modelId: pool.modelId,
      configKey: pool.configKey,
      proxy: pool.ammAddress,
      proxyCodeHash: ethers.keccak256(await provider.getCode(pool.ammAddress)),
      ...slots,
      implementationCodeHash: ethers.keccak256(implCode),
    });
  }
  return { codeHashes, pools };
}

module.exports = {
  ADMIN_SLOT,
  IMPLEMENTATION_SLOT,
  deploymentRecords,
  freezeCall,
  pauseCall,
  proxySlots,
  unpauseCall,
  upgradeCalls,
};
