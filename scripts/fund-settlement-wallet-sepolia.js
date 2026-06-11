const hre = require("hardhat");

const {
  EXPECTED_ADDRESSES,
  assertExpectedAddress,
  formatError,
  loadDeployment,
  parseArgs,
  parseDecimalToUnits,
  printJson,
  requireChecksummedAddress,
  requireDeploymentAddress,
  requireSepolia,
} = require("./lib/sepolia-fee-ops");

const DEFAULT_ETH_AMOUNT = "0.05";
const DEFAULT_USDC_AMOUNT = "100";
const DEFAULT_USDC_MAX = 1000n * 10n ** 6n;

async function getFundingSigner() {
  if (process.env.FUNDING_PRIVATE_KEY) {
    return new hre.ethers.Wallet(process.env.FUNDING_PRIVATE_KEY, hre.ethers.provider);
  }

  const [signer] = await hre.ethers.getSigners();
  return signer;
}

async function main() {
  requireSepolia();

  const args = parseArgs(process.argv.slice(2));
  const wallet = requireChecksummedAddress(
    args.wallet || process.env.SETTLEMENT_WALLET_ADDRESS,
    "SETTLEMENT_WALLET_ADDRESS",
  );
  const targetEth = hre.ethers.parseEther(args.eth || process.env.FUND_ETH_AMOUNT || DEFAULT_ETH_AMOUNT);
  const targetUsdc = parseDecimalToUnits(
    args.usdc || process.env.FUND_USDC_AMOUNT || DEFAULT_USDC_AMOUNT,
    6,
    "USDC amount",
  );
  const usdcMax = parseDecimalToUnits(
    args["usdc-max"] || process.env.FUND_USDC_MAX || "1000",
    6,
    "USDC max",
  );

  if (targetUsdc > usdcMax || targetUsdc > DEFAULT_USDC_MAX) {
    throw new Error(
      `Requested USDC target ${targetUsdc} exceeds allowed cap ${targetUsdc > usdcMax ? usdcMax : DEFAULT_USDC_MAX}.`,
    );
  }

  const { deployment } = loadDeployment(args["deployment-file"]);
  const usdcAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "MockUSDC"),
    EXPECTED_ADDRESSES.MockUSDC,
    "MockUSDC",
  );
  const signer = await getFundingSigner();
  const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress, signer);

  const ethBefore = await hre.ethers.provider.getBalance(wallet);
  const usdcBefore = await usdc.balanceOf(wallet);

  let ethTxHash = null;
  let usdcMintTxHash = null;

  if (ethBefore < targetEth) {
    const deficit = targetEth - ethBefore;
    const signerBalance = await hre.ethers.provider.getBalance(signer.address);
    if (signerBalance < deficit) {
      throw new Error(`insufficient funds in funding account ${signer.address}`);
    }

    const tx = await signer.sendTransaction({ to: wallet, value: deficit });
    ethTxHash = tx.hash;
    const receipt = await tx.wait();
    if (receipt.status !== 1 && receipt.status !== 1n) {
      throw new Error(`ETH funding transaction failed: ${tx.hash}`);
    }
  }

  if (usdcBefore < targetUsdc) {
    const deficit = targetUsdc - usdcBefore;
    const tx = await usdc.mint(wallet, deficit);
    usdcMintTxHash = tx.hash;
    const receipt = await tx.wait();
    if (receipt.status !== 1 && receipt.status !== 1n) {
      throw new Error(`USDC mint transaction failed: ${tx.hash}`);
    }
  }

  const ethAfter = await hre.ethers.provider.getBalance(wallet);
  const usdcAfter = await usdc.balanceOf(wallet);

  if (ethAfter < targetEth) {
    throw new Error(`ETH post-check failed for ${wallet}.`);
  }

  if (usdcAfter < targetUsdc) {
    throw new Error(`USDC post-check failed for ${wallet}.`);
  }

  printJson({
    wallet,
    fundedBy: signer.address,
    ethBefore,
    ethAfter,
    usdcBefore,
    usdcAfter,
    ethTxHash,
    usdcMintTxHash,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
