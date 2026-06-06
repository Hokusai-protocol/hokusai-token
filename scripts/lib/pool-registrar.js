async function ensureFactoryPoolRegistrar({ modelRegistry, factoryAddress, signerAddress }) {
  if (await modelRegistry.poolRegistrars(factoryAddress)) {
    console.log("✅ Factory already authorized as ModelRegistry pool registrar");
    return;
  }

  const ownerAddress = await modelRegistry.owner();
  if (ownerAddress.toLowerCase() !== signerAddress.toLowerCase()) {
    throw new Error(
      `Factory ${factoryAddress} is not authorized as a ModelRegistry pool registrar, and signer ${signerAddress} is not the registry owner ${ownerAddress}`
    );
  }

  console.log("🔐 Authorizing factory as ModelRegistry pool registrar...");
  const tx = await modelRegistry.setPoolRegistrar(factoryAddress, true);
  await tx.wait();
  console.log("✅ Factory authorized as ModelRegistry pool registrar");
}

module.exports = {
  ensureFactoryPoolRegistrar,
};
