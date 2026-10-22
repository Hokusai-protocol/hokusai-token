const { ethers } = require("hardhat");

// proxyAdminOwner defaults to the factory's deploying signer (bootstrap owner,
// before a governance handoff).
async function deployFactoryWithPoolDeployer(modelRegistry, tokenManager, reserveToken, treasury, proxyAdminOwner) {
  const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
  const factory = await HokusaiAMMFactory.deploy(
    await modelRegistry.getAddress(),
    await tokenManager.getAddress(),
    await reserveToken.getAddress(),
    treasury.address || treasury
  );
  await factory.waitForDeployment();

  const HokusaiAMMPoolDeployer = await ethers.getContractFactory("HokusaiAMMPoolDeployer");
  const poolDeployer = await HokusaiAMMPoolDeployer.deploy(
    await factory.getAddress(),
    proxyAdminOwner || (await factory.runner.getAddress())
  );
  await poolDeployer.waitForDeployment();

  await factory.setPoolDeployer(await poolDeployer.getAddress());

  return { factory, poolDeployer };
}

module.exports = {
  deployFactoryWithPoolDeployer,
};
