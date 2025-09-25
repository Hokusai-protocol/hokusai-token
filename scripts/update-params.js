const hre = require("hardhat");

async function main() {
  // Configuration - UPDATE THESE WITH YOUR DEPLOYED ADDRESSES
  const PARAMS_ADDRESS = process.env.HOKUSAI_PARAMS_ADDRESS || "YOUR_PARAMS_ADDRESS_HERE";

  console.log("Updating parameters for HokusaiParams at:", PARAMS_ADDRESS);

  const [signer] = await ethers.getSigners();
  console.log("Using account:", signer.address);

  // Get the params contract
  const HokusaiParams = await ethers.getContractFactory("HokusaiParams");
  const params = HokusaiParams.attach(PARAMS_ADDRESS);

  // Check current values
  console.log("\nCurrent Parameters:");
  console.log("- tokensPerDeltaOne:", (await params.tokensPerDeltaOne()).toString());
  console.log("- infraMarkupBps:", (await params.infraMarkupBps()).toString());
  const [hash, uri] = await params.licenseRef();
  console.log("- licenseHash:", hash);
  console.log("- licenseURI:", uri);

  // Example updates (uncomment what you need)

  // Update tokensPerDeltaOne
  // console.log("\nUpdating tokensPerDeltaOne to 1500...");
  // const tx1 = await params.setTokensPerDeltaOne(1500);
  // await tx1.wait();
  // console.log("✅ Updated!");

  // Update infraMarkupBps (300 = 3%)
  // console.log("\nUpdating infraMarkupBps to 300 (3%)...");
  // const tx2 = await params.setInfraMarkupBps(300);
  // await tx2.wait();
  // console.log("✅ Updated!");

  // Update license reference
  // console.log("\nUpdating license reference...");
  // const licenseHash = ethers.keccak256(ethers.toUtf8Bytes("MIT-License-v2"));
  // const licenseURI = "https://opensource.org/licenses/MIT";
  // const tx3 = await params.setLicenseRef(licenseHash, licenseURI);
  // await tx3.wait();
  // console.log("✅ Updated!");

  // Grant GOV_ROLE to another address
  // const GOV_ROLE = await params.GOV_ROLE();
  // const newGovernor = "0x..."; // New governor address
  // console.log("\nGranting GOV_ROLE to:", newGovernor);
  // const tx4 = await params.grantRole(GOV_ROLE, newGovernor);
  // await tx4.wait();
  // console.log("✅ Role granted!");

  console.log("\n✨ Parameters update complete!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });