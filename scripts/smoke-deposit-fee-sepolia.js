const hre = require("hardhat");

const {
  EXPECTED_ADDRESSES,
  assertExpectedAddress,
  formatError,
  getPoolConfigByModelId,
  loadDeployment,
  parseArgs,
  parseEventLogs,
  parseInteger,
  printJson,
  requireChecksummedAddress,
  requireDeploymentAddress,
  requireSepolia,
  sameAddress,
} = require("./lib/sepolia-fee-ops");

const COST_BASIS = Object.freeze({
  ORACLE: 0n,
  PERCENTAGE_FALLBACK: 1n,
});

async function main() {
  requireSepolia();

  const args = parseArgs(process.argv.slice(2));
  const modelId = args["model-id"] || process.env.SMOKE_MODEL_ID || "30";
  const amount = parseInteger(args.amount || process.env.SMOKE_AMOUNT || "1000000", "SMOKE_AMOUNT");
  const callCount = parseInteger(
    args["call-count"] || process.env.SMOKE_CALL_COUNT || "1",
    "SMOKE_CALL_COUNT",
  );
  const walletAddress = args.wallet || process.env.SETTLEMENT_WALLET_ADDRESS;
  const privateKey = args["private-key"] || process.env.SETTLEMENT_WALLET_PRIVATE_KEY;

  if (!privateKey || !privateKey.trim()) {
    throw new Error("SETTLEMENT_WALLET_PRIVATE_KEY is required.");
  }

  const { deployment } = loadDeployment(args["deployment-file"]);
  const routerAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "UsageFeeRouter"),
    EXPECTED_ADDRESSES.UsageFeeRouter,
    "UsageFeeRouter",
  );
  const usdcAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "MockUSDC"),
    EXPECTED_ADDRESSES.MockUSDC,
    "MockUSDC",
  );
  const reserveAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "InfrastructureReserve"),
    EXPECTED_ADDRESSES.InfrastructureReserve,
    "InfrastructureReserve",
  );
  const oracleAddress = assertExpectedAddress(
    requireDeploymentAddress(deployment, "InfrastructureCostOracle"),
    EXPECTED_ADDRESSES.InfrastructureCostOracle,
    "InfrastructureCostOracle",
  );

  const signer = new hre.ethers.Wallet(privateKey, hre.ethers.provider);
  if (walletAddress) {
    const checksummedWallet = requireChecksummedAddress(walletAddress, "SETTLEMENT_WALLET_ADDRESS");
    if (!sameAddress(checksummedWallet, signer.address)) {
      throw new Error(
        `SETTLEMENT_WALLET_PRIVATE_KEY does not match SETTLEMENT_WALLET_ADDRESS (${signer.address} != ${checksummedWallet}).`,
      );
    }
  }

  const router = await hre.ethers.getContractAt("UsageFeeRouter", routerAddress, signer);
  const usdc = await hre.ethers.getContractAt("MockUSDC", usdcAddress, signer);
  const reserve = await hre.ethers.getContractAt("InfrastructureReserve", reserveAddress, signer);
  const oracle = await hre.ethers.getContractAt("InfrastructureCostOracle", oracleAddress, signer);
  const factoryAddress = await router.factory();
  const factory = await hre.ethers.getContractAt("HokusaiAMMFactory", factoryAddress, signer);
  const poolAddress = await factory.getPool(modelId);

  if (!poolAddress || sameAddress(poolAddress, hre.ethers.ZeroAddress)) {
    throw new Error(`No AMM pool found for model ${modelId}.`);
  }

  if (modelId === "30") {
    const deploymentPool = getPoolConfigByModelId(deployment, "30");
    assertExpectedAddress(poolAddress, deploymentPool.ammAddress, "Model 30 pool");
    assertExpectedAddress(poolAddress, EXPECTED_ADDRESSES.Model30Pool, "Model 30 pool");
  }

  if (!(await router.isDepositor(signer.address))) {
    throw new Error(`Settlement wallet ${signer.address} is not a FEE_DEPOSITOR_ROLE holder.`);
  }

  const costPerThousand = await oracle.getEstimatedCost(modelId);
  const expectedSplit = await router.calculateFeeSplit(modelId, amount, callCount);
  const accruedBefore = await reserve.accrued(modelId);
  const pool = await hre.ethers.getContractAt("HokusaiAMM", poolAddress, signer);
  const reserveBefore = await pool.reserveBalance();
  const usdcBefore = await usdc.balanceOf(signer.address);
  const ethBefore = await hre.ethers.provider.getBalance(signer.address);

  if (usdcBefore < amount) {
    throw new Error(
      `Settlement wallet ${signer.address} has insufficient USDC (${usdcBefore} < ${amount}).`,
    );
  }

  const allowance = await usdc.allowance(signer.address, routerAddress);
  let approvalTxHash = null;
  if (allowance < amount) {
    const approvalTx = await usdc.approve(routerAddress, amount);
    approvalTxHash = approvalTx.hash;
    const approvalReceipt = await approvalTx.wait();
    if (approvalReceipt.status !== 1 && approvalReceipt.status !== 1n) {
      throw new Error(`approve transaction failed: ${approvalTx.hash}`);
    }
  }

  const depositTx = await router.depositFee(modelId, amount, callCount);
  const receipt = await depositTx.wait();
  if (receipt.status !== 1 && receipt.status !== 1n) {
    throw new Error(`depositFee transaction failed: ${depositTx.hash}`);
  }

  const feeDepositedEvents = parseEventLogs(receipt, router.interface, "FeeDeposited");
  const feeSplitEvents = parseEventLogs(receipt, router.interface, "FeeSplitCalculated");

  if (feeDepositedEvents.length !== 1) {
    throw new Error(`Expected exactly 1 FeeDeposited event, found ${feeDepositedEvents.length}.`);
  }

  if (feeSplitEvents.length !== 1) {
    throw new Error(
      `Expected exactly 1 FeeSplitCalculated event, found ${feeSplitEvents.length}.`,
    );
  }

  const deposited = feeDepositedEvents[0].args;
  const split = feeSplitEvents[0].args;

  if (
    deposited.infrastructureAmount !== expectedSplit[0] ||
    deposited.profitAmount !== expectedSplit[1] ||
    split.infraShare !== expectedSplit[0] ||
    split.profitShare !== expectedSplit[1] ||
    split.costBasis !== expectedSplit[2]
  ) {
    throw new Error("Observed fee split did not match calculateFeeSplit().");
  }

  const accruedAfter = await reserve.accrued(modelId);
  const reserveAfter = await pool.reserveBalance();
  const usdcAfter = await usdc.balanceOf(signer.address);
  const ethAfter = await hre.ethers.provider.getBalance(signer.address);
  const infraDelta = accruedAfter - accruedBefore;
  const ammDelta = reserveAfter - reserveBefore;

  if (infraDelta !== deposited.infrastructureAmount) {
    throw new Error(`InfrastructureReserve delta mismatch (${infraDelta} != ${deposited.infrastructureAmount}).`);
  }

  if (ammDelta !== deposited.profitAmount) {
    throw new Error(`AMM reserve delta mismatch (${ammDelta} != ${deposited.profitAmount}).`);
  }

  if (modelId === "30" && costPerThousand === 0n && split.costBasis !== COST_BASIS.PERCENTAGE_FALLBACK) {
    throw new Error(`Expected percentage fallback for model 30, got cost basis ${split.costBasis}.`);
  }

  printJson({
    wallet: signer.address,
    modelId,
    amount,
    callCount,
    approvalTxHash,
    depositTxHash: depositTx.hash,
    costPerThousand,
    costBasis: split.costBasis,
    infraDelta,
    ammDelta,
    accruedBefore,
    accruedAfter,
    reserveBefore,
    reserveAfter,
    usdcBefore,
    usdcAfter,
    ethBefore,
    ethAfter,
    blockNumber: receipt.blockNumber,
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(formatError(error));
    process.exit(1);
  });
