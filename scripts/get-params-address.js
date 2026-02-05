const hre = require("hardhat");

async function main() {
  const tokenManagerAddress = "0x0BA3eCeD140DdD254796b0bC4235309286C38724";
  const modelId = "sales-lead-scoring-v2";

  const TokenManager = await ethers.getContractFactory("TokenManager");
  const tokenManager = TokenManager.attach(tokenManagerAddress);

  const paramsAddress = await tokenManager.modelParams(modelId);
  console.log("HokusaiParams address:", paramsAddress);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
