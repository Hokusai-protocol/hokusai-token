const { ethers } = require("hardhat");

// Pools run as TransparentUpgradeableProxy instances over a HokusaiAMM
// implementation. Deploys a fresh implementation, ProxyAdmin and proxy, runs
// initialize(...args) in the proxy constructor (so the factory's signer becomes
// owner, as with the old constructor), and returns the AMM bound to the proxy.
async function deployAMMProxyWithAdmin(ammFactory, ...args) {
  const runner = ammFactory.runner;
  const implementation = await ammFactory.deploy();
  const proxyAdmin = await (await ethers.getContractFactory("ProxyAdmin", runner)).deploy();
  const proxy = await (await ethers.getContractFactory("TransparentUpgradeableProxy", runner)).deploy(
    await implementation.getAddress(),
    await proxyAdmin.getAddress(),
    ammFactory.interface.encodeFunctionData("initialize", args)
  );
  await proxy.waitForDeployment();
  return { amm: ammFactory.attach(await proxy.getAddress()), proxyAdmin, implementation };
}

async function deployAMMProxy(ammFactory, ...args) {
  return (await deployAMMProxyWithAdmin(ammFactory, ...args)).amm;
}

// HOK-3283: a pool's only TokenManager mint/burn authorization is its
// ModelRegistry binding (registry.getPool(modelId) == pool). Registers the
// pool's model (if needed) and binds the pool, as the factory does on create.
// Signs as the registry owner (default signer unless `signer` is given).
async function bindPool(tokenManager, pool, signer) {
  const poolAddress = typeof pool === "string" ? pool : await pool.getAddress();
  const modelId = await (await ethers.getContractAt("HokusaiAMM", poolAddress)).modelId();
  const registry = await ethers.getContractAt("ModelRegistry", await tokenManager.registry(), signer);
  if ((await registry.getPool(modelId)) === poolAddress) {
    return;
  }
  if (!(await registry.isStringRegistered(modelId))) {
    await registry.registerStringModel(modelId, await tokenManager.getTokenAddress(modelId), "accuracy");
  }
  await registry.registerPool(modelId, poolAddress);
}

module.exports = { deployAMMProxy, deployAMMProxyWithAdmin, bindPool };
