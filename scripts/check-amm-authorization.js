const hre = require("hardhat");

async function main() {
  const ammAddress = "0x935b6e3487607866F47c084442C19706d1c5A738";
  const tokenManagerAddress = "0x0BA3eCeD140DdD254796b0bC4235309286C38724";
  const tokenAddress = "0xd6bFa8A2f85157e8a1D91E2c348c99C6Da86986c";

  const amm = await hre.ethers.getContractAt("HokusaiAMM", ammAddress);
  const tokenManager = await hre.ethers.getContractAt("TokenManager", tokenManagerAddress);
  const token = await hre.ethers.getContractAt("HokusaiToken", tokenAddress);

  console.log("🔍 Checking AMM Authorization\n");
  console.log("AMM Address:", ammAddress);
  console.log("TokenManager Address:", tokenManagerAddress);
  console.log("Token Address:", tokenAddress);
  console.log("");

  // Check if AMM's tokenManager matches
  const ammTokenManager = await amm.tokenManager();
  console.log("AMM's TokenManager:", ammTokenManager);
  console.log("Match:", ammTokenManager.toLowerCase() === tokenManagerAddress.toLowerCase() ? "✓" : "✗");
  console.log("");

  // Check if TokenManager is authorized to mint
  const controller = await token.controller();
  console.log("Token's Controller:", controller);
  console.log("Match TokenManager:", controller.toLowerCase() === tokenManagerAddress.toLowerCase() ? "✓" : "✗");
  console.log("");

  // Check model registration
  const modelId = await amm.modelId();
  console.log("AMM Model ID:", modelId);

  try {
    const registeredToken = await tokenManager.getTokenForModel(modelId);
    console.log("TokenManager registered token:", registeredToken);
    console.log("Match:", registeredToken.toLowerCase() === tokenAddress.toLowerCase() ? "✓" : "✗");
  } catch (e) {
    console.log("✗ Model not registered in TokenManager:", e.message);
  }
  console.log("");

  // Check if AMM is authorized pool
  try {
    const isAuthorized = await tokenManager.isAuthorizedPool(modelId, ammAddress);
    console.log("Is AMM authorized pool:", isAuthorized ? "✓ YES" : "✗ NO");
  } catch (e) {
    console.log("✗ Could not check authorization:", e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
