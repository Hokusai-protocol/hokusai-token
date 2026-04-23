import { ethers } from "ethers";
import { readFileSync } from "fs";
import { join } from "path";

type Artifact = {
  abi: any[];
};

function loadArtifact(name: string): Artifact {
  const artifactPath = join(process.cwd(), "artifacts", "contracts", `${name}.sol`, `${name}.json`);
  return JSON.parse(readFileSync(artifactPath, "utf8"));
}

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function formatWholeTokens(value: bigint): string {
  return ethers.formatUnits(value, 18);
}

function assertEqual(label: string, actual: bigint, expected?: bigint): void {
  if (expected === undefined) {
    return;
  }

  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${formatWholeTokens(expected)}, got ${formatWholeTokens(actual)}`);
  }
}

async function main(): Promise<void> {
  const tokenAddress = getArg("--token");
  const modelId = getArg("--model-id");
  const tokenManagerAddress = getArg("--token-manager");
  const rpcUrl = process.env.SEPOLIA_RPC_URL || process.env.RPC_URL;

  if (!rpcUrl) {
    throw new Error("Set SEPOLIA_RPC_URL or RPC_URL before running this script");
  }
  if (!tokenAddress) {
    throw new Error("Missing required --token <address>");
  }

  const expectedSupplier = getArg("--expected-supplier")
    ? ethers.parseUnits(getArg("--expected-supplier")!, 18)
    : undefined;
  const expectedInvestor = getArg("--expected-investor")
    ? ethers.parseUnits(getArg("--expected-investor")!, 18)
    : undefined;
  const expectedTotalSupply = getArg("--expected-total-supply")
    ? ethers.parseUnits(getArg("--expected-total-supply")!, 18)
    : undefined;
  const expectedTokensPerDeltaOne = getArg("--expected-tokens-per-delta-one")
    ? ethers.parseUnits(getArg("--expected-tokens-per-delta-one")!, 18)
    : undefined;

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const tokenArtifact = loadArtifact("HokusaiToken");
  const paramsArtifact = loadArtifact("HokusaiParams");
  const tokenManagerArtifact = loadArtifact("TokenManager");

  const token = new ethers.Contract(tokenAddress, tokenArtifact.abi, provider);
  const paramsAddress = await token.params();
  const params = new ethers.Contract(paramsAddress, paramsArtifact.abi, provider);

  const totalSupply = (await token.totalSupply()) as bigint;
  const maxSupply = (await token.maxSupply()) as bigint;
  const modelSupplierAllocation = (await token.modelSupplierAllocation()) as bigint;
  const modelSupplierDistributed = (await token.modelSupplierDistributed()) as boolean;
  const modelSupplierRecipient = (await token.modelSupplierRecipient()) as string;
  const tokensPerDeltaOne = (await params.tokensPerDeltaOne()) as bigint;

  console.log(`Token: ${tokenAddress}`);
  console.log(`Params: ${paramsAddress}`);
  console.log(`Supplier recipient: ${modelSupplierRecipient}`);
  console.log(`Supplier allocation: ${formatWholeTokens(modelSupplierAllocation)}`);
  console.log(`Supplier distributed: ${modelSupplierDistributed}`);
  console.log(`Total supply: ${formatWholeTokens(totalSupply)}`);
  console.log(`Max supply: ${formatWholeTokens(maxSupply)}`);
  console.log(`Tokens per DeltaOne: ${formatWholeTokens(tokensPerDeltaOne)}`);

  if (tokenManagerAddress && modelId) {
    const tokenManager = new ethers.Contract(tokenManagerAddress, tokenManagerArtifact.abi, provider);
    const chainTokenAddress = (await tokenManager.getTokenAddress(modelId)) as string;
    console.log(`TokenManager token for model ${modelId}: ${chainTokenAddress}`);
    if (chainTokenAddress.toLowerCase() !== tokenAddress.toLowerCase()) {
      throw new Error(`TokenManager mapping mismatch: expected ${tokenAddress}, got ${chainTokenAddress}`);
    }
  }

  assertEqual("supplier allocation", modelSupplierAllocation, expectedSupplier);
  assertEqual("investor allocation", maxSupply - modelSupplierAllocation, expectedInvestor);
  assertEqual("total supply", totalSupply, expectedTotalSupply);
  assertEqual("tokensPerDeltaOne", tokensPerDeltaOne, expectedTokensPerDeltaOne);

  if (expectedSupplier !== undefined && expectedInvestor !== undefined) {
    const expectedMaxSupply = expectedSupplier + expectedInvestor;
    assertEqual("max supply", maxSupply, expectedMaxSupply);
  }

  console.log("Alignment check passed");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
