const { ethers } = require("hardhat");

async function deployFactoryWithPoolDeployer(modelRegistry, tokenManager, reserveToken, treasury) {
  const HokusaiAMMFactory = await ethers.getContractFactory("HokusaiAMMFactory");
  const factory = await HokusaiAMMFactory.deploy(
    await modelRegistry.getAddress(),
    await tokenManager.getAddress(),
    await reserveToken.getAddress(),
    treasury.address || treasury
  );
  await factory.waitForDeployment();

  const HokusaiAMMPoolDeployer = await ethers.getContractFactory("HokusaiAMMPoolDeployer");
  const poolDeployer = await HokusaiAMMPoolDeployer.deploy(await factory.getAddress());
  await poolDeployer.waitForDeployment();

  await factory.setPoolDeployer(await poolDeployer.getAddress());

  return { factory, poolDeployer };
}

module.exports = {
  deployFactoryWithPoolDeployer,
};
