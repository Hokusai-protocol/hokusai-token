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

module.exports = { deployAMMProxy, deployAMMProxyWithAdmin };
