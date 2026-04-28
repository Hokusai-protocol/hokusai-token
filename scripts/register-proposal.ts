import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Configuration for proposal registration
 */
interface ProposalConfig {
  modelId: string;
  tokenName: string;
  tokenSymbol: string;
  initialSupply: bigint;
  proposalDeadline?: bigint;
  tokensPerDeltaOne?: bigint;
  infrastructureAccrualBps?: number;
  initialOraclePricePerThousandUsd?: bigint;
  licenseHash?: string;
  licenseURI?: string;
  governor?: string;
  performanceMetric?: string;
}

/**
 * Default configuration values
 */
const DEFAULTS = {
  proposalDeadlineOffsetSeconds: BigInt(86400 * 30),
  tokensPerDeltaOne: BigInt(1000),
  infrastructureAccrualBps: 5000, // 50%
  initialOraclePricePerThousandUsd: BigInt(0),
  performanceMetric: "accuracy",
  licenseHash: ethers.keccak256(ethers.toUtf8Bytes("default-license")),
  licenseURI: "https://hokusai.ai/licenses/default"
};

/**
 * Register a proposal: deploy token, register in ModelRegistry, register in FundingVault
 *
 * Note: The caller must have DEFAULT_ADMIN_ROLE on the FundingVault contract to register proposals.
 */
async function registerProposal(
  config: ProposalConfig,
  tokenManagerAddress: string,
  modelRegistryAddress: string,
  fundingVaultAddress: string,
  signer?: HardhatEthersSigner
) {
  // Get signer
  if (!signer) {
    const signers = await ethers.getSigners();
    signer = signers[0];
  }

  console.log(`Registering proposal for model: ${config.modelId}`);
  console.log(`Using deployer: ${signer.address}`);

  // Get contract instances
  const tokenManager = await ethers.getContractAt("TokenManager", tokenManagerAddress);
  const modelRegistry = await ethers.getContractAt("ModelRegistry", modelRegistryAddress);
  const fundingVault = await ethers.getContractAt("FundingVault", fundingVaultAddress);

  // Verify caller has DEFAULT_ADMIN_ROLE on FundingVault
  const DEFAULT_ADMIN_ROLE = await fundingVault.DEFAULT_ADMIN_ROLE();
  const hasRole = await fundingVault.hasRole(DEFAULT_ADMIN_ROLE, signer.address);
  if (!hasRole) {
    throw new Error(`Deployer ${signer.address} does not have DEFAULT_ADMIN_ROLE on FundingVault`);
  }

  // Prepare parameters with defaults
  const latestBlock = await ethers.provider.getBlock("latest");
  const proposalDeadline =
    config.proposalDeadline ?? BigInt(latestBlock!.timestamp) + DEFAULTS.proposalDeadlineOffsetSeconds;
  const tokensPerDeltaOne = config.tokensPerDeltaOne || DEFAULTS.tokensPerDeltaOne;
  const infrastructureAccrualBps = config.infrastructureAccrualBps || DEFAULTS.infrastructureAccrualBps;
  const initialOraclePricePerThousandUsd = config.initialOraclePricePerThousandUsd || DEFAULTS.initialOraclePricePerThousandUsd;
  const licenseHash = config.licenseHash || DEFAULTS.licenseHash;
  const licenseURI = config.licenseURI || DEFAULTS.licenseURI;
  const governor = config.governor || signer.address;
  const performanceMetric = config.performanceMetric || DEFAULTS.performanceMetric;

  console.log("\nStep 1: Deploying token via TokenManager...");
  const initialParams = {
    tokensPerDeltaOne,
    infrastructureAccrualBps,
    initialOraclePricePerThousandUsd,
    licenseHash,
    licenseURI,
    governor
  };

  try {
    const deployTx = await tokenManager.deployTokenWithParams(
      config.modelId,
      config.tokenName,
      config.tokenSymbol,
      config.initialSupply,
      initialParams
    );

    console.log(`Transaction hash: ${deployTx.hash}`);
    const receipt = await deployTx.wait();
    console.log(`✓ Token deployed (gas used: ${receipt?.gasUsed.toString()})`);

    // Get the deployed token address from the event
    const tokenAddress = await tokenManager.getTokenAddress(config.modelId);
    console.log(`Token address: ${tokenAddress}`);

    console.log("\nStep 2: Registering model in ModelRegistry...");
    const registerTx = await modelRegistry.registerStringModel(
      config.modelId,
      tokenAddress,
      performanceMetric
    );

    console.log(`Transaction hash: ${registerTx.hash}`);
    const registerReceipt = await registerTx.wait();
    console.log(`✓ Model registered (gas used: ${registerReceipt?.gasUsed.toString()})`);

    console.log("\nStep 3: Registering proposal in FundingVault...");
    const vaultTx = await fundingVault.registerProposal(
      config.modelId,
      tokenAddress,
      proposalDeadline
    );

    console.log(`Transaction hash: ${vaultTx.hash}`);
    const vaultReceipt = await vaultTx.wait();
    console.log(`✓ Proposal registered (gas used: ${vaultReceipt?.gasUsed.toString()})`);

    console.log("\n=== Registration Complete ===");
    console.log(`Model ID: ${config.modelId}`);
    console.log(`Token Address: ${tokenAddress}`);
    console.log(`Proposal Deadline: ${proposalDeadline}`);

    return {
      modelId: config.modelId,
      tokenAddress,
      success: true
    };
  } catch (error: any) {
    console.error("\n❌ Registration failed:");
    console.error(error.message);

    // Check partial state to help with recovery
    try {
      const tokenAddress = await tokenManager.getTokenAddress(config.modelId);
      if (tokenAddress !== ethers.ZeroAddress) {
        console.log("\n⚠️  Token was deployed but registration incomplete.");
        console.log(`Token address: ${tokenAddress}`);
        console.log("You may need to manually complete steps 2 and/or 3.");
      }
    } catch {
      console.log("\n⚠️  Token deployment may have failed or not completed.");
    }

    throw error;
  }
}

/**
 * Main script execution
 */
async function main() {
  // Example usage - can be customized via command line args
  const config: ProposalConfig = {
    modelId: "test-model-" + Date.now(),
    tokenName: "Test Model Token",
    tokenSymbol: "TMT",
    initialSupply: ethers.parseEther("1000000"), // 1M tokens
    tokensPerDeltaOne: BigInt(1000),
    infrastructureAccrualBps: 5000,
    initialOraclePricePerThousandUsd: BigInt(0)
  };

  // These would typically be loaded from deployment addresses
  // For now, using placeholder values - update with actual deployed addresses
  const tokenManagerAddress = process.env.TOKEN_MANAGER_ADDRESS || "";
  const modelRegistryAddress = process.env.MODEL_REGISTRY_ADDRESS || "";
  const fundingVaultAddress = process.env.FUNDING_VAULT_ADDRESS || "";

  if (!tokenManagerAddress || !modelRegistryAddress || !fundingVaultAddress) {
    console.error("Error: Contract addresses not provided");
    console.error("Set TOKEN_MANAGER_ADDRESS, MODEL_REGISTRY_ADDRESS, and FUNDING_VAULT_ADDRESS");
    process.exit(1);
  }

  await registerProposal(
    config,
    tokenManagerAddress,
    modelRegistryAddress,
    fundingVaultAddress
  );
}

// Export for use as a module
export { registerProposal, ProposalConfig, DEFAULTS };

// Run if executed directly
if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
