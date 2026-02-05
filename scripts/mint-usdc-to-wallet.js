const hre = require("hardhat");

async function main() {
  const usdcAddress = "0xB568cBaaBB76EC2104F830c9D2F3a806d5db4c90";
  const recipientAddress = "0x3937A9B521298D4c6D9d438cEFF396eD18DD7Bb6";
  const amount = hre.ethers.parseUnits("1000", 6); // 1000 USDC (6 decimals)

  console.log(`Minting USDC to ${recipientAddress}...`);

  const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress);
  const tx = await usdc.mint(recipientAddress, amount);

  console.log(`Transaction hash: ${tx.hash}`);
  await tx.wait();

  const balance = await usdc.balanceOf(recipientAddress);
  console.log(`New balance: ${hre.ethers.formatUnits(balance, 6)} USDC`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
