const hre = require("hardhat");

async function main() {
  console.log("🔍 Verifying Params Module on Sepolia...\n");

  const PARAMS_ADDRESS = "0xBbED47149FDA720e22e3029Bf9A197985711D823";
  const TOKEN_ADDRESS = "0x39c60AaC840AAd357edfdED3772e4134B2e04d8C";

  // Get contracts
  const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
  const params = HokusaiParams.attach(PARAMS_ADDRESS);

  const HokusaiToken = await ethers.getContractFactory("HokusaiToken");
  const token = HokusaiToken.attach(TOKEN_ADDRESS);

  console.log("📊 Current Parameters:");
  console.log("=======================");

  // Check token details
  console.log("\n🪙 Token Info:");
  console.log("  Name:", await token.name());
  console.log("  Symbol:", await token.symbol());
  console.log("  Total Supply:", ethers.formatEther(await token.totalSupply()), "HOKU");
  console.log("  Params Address:", await token.params());

  // Check parameters
  console.log("\n⚙️ Governance Parameters:");
  console.log("  tokensPerDeltaOne:", (await params.tokensPerDeltaOne()).toString());
  console.log("  infraMarkupBps:", (await params.infraMarkupBps()).toString(), "(",
    Number(await params.infraMarkupBps()) / 100, "%)");

  const [licenseHash, licenseURI] = await params.licenseRef();
  console.log("  licenseHash:", licenseHash);
  console.log("  licenseURI:", licenseURI || "(empty)");

  // Check governance role
  const GOV_ROLE = await params.GOV_ROLE();
  const [signer] = await ethers.getSigners();
  const hasGovRole = await params.hasRole(GOV_ROLE, signer.address);
  console.log("\n👤 Governance Status:");
  console.log("  Your address:", signer.address);
  console.log("  Has GOV_ROLE:", hasGovRole);

  console.log("\n✅ Verification complete!");
  console.log("\n📝 To update parameters, use:");
  console.log("  npx hardhat run scripts/update-params.js --network sepolia");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });