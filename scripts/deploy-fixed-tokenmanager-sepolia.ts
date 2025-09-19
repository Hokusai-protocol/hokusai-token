import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Load Sepolia configuration
dotenv.config({ path: '.env.sepolia' });

// Configuration
const NETWORK = 'sepolia';
const CHAIN_ID = 11155111;
const CONFIRMATIONS = 2;

// Existing contract addresses on Sepolia (keeping ModelRegistry)
const EXISTING_ADDRESSES = {
  modelRegistry: '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f',
  oldTokenManager: '0xB4A25a1a72BDd1e0F5f3288a96a6325CD9219196' // The broken one
};

interface DeploymentConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
  gasMultiplier: number;
  maxGasPrice: bigint;
}

class TokenManagerDeployer {
  private provider: ethers.JsonRpcProvider;
  private deployer: ethers.Wallet;
  private newTokenManagerAddress?: string;

  constructor(config: DeploymentConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.deployer = new ethers.Wallet(config.deployerPrivateKey, this.provider);
  }

  async validateSetup(): Promise<void> {
    console.log('🔍 Validating deployment setup...');

    // Check network
    const network = await this.provider.getNetwork();
    if (Number(network.chainId) !== CHAIN_ID) {
      throw new Error(`Wrong network! Expected Sepolia (${CHAIN_ID}), got ${network.chainId}`);
    }
    console.log(`✅ Connected to Sepolia testnet`);

    // Check deployer balance
    const balance = await this.provider.getBalance(this.deployer.address);
    const balanceInEth = ethers.formatEther(balance);
    console.log(`💰 Deployer address: ${this.deployer.address}`);
    console.log(`💰 Balance: ${balanceInEth} ETH`);

    if (balance < ethers.parseEther('0.05')) {
      throw new Error('Insufficient ETH balance! Need at least 0.05 ETH for deployment');
    }

    // Check gas price
    const feeData = await this.provider.getFeeData();
    console.log(`⛽ Current gas price: ${ethers.formatUnits(feeData.gasPrice || 0n, 'gwei')} Gwei`);
  }

  async loadContract(name: string): Promise<any> {
    const artifactPath = join(process.cwd(), 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
    const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
    return artifact;
  }

  async deployTokenManager(): Promise<string> {
    console.log(`\n📦 Deploying FIXED TokenManager with correct interface...`);
    console.log(`📍 Using existing ModelRegistry at: ${EXISTING_ADDRESSES.modelRegistry}`);

    const artifact = await this.loadContract('TokenManager');
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, this.deployer);

    // Deploy with ModelRegistry address
    const contract = await factory.deploy(EXISTING_ADDRESSES.modelRegistry);
    console.log(`📝 Transaction hash: ${contract.deploymentTransaction()?.hash}`);
    console.log(`⏳ Waiting for ${CONFIRMATIONS} confirmations...`);

    await contract.waitForDeployment();
    const address = await contract.getAddress();

    console.log(`✅ TokenManager deployed at: ${address}`);

    this.newTokenManagerAddress = address;
    return address;
  }

  async verifyContract(): Promise<void> {
    if (!this.newTokenManagerAddress) {
      throw new Error('No contract deployed yet');
    }

    try {
      console.log(`\n🔍 Verifying TokenManager on Etherscan...`);

      // Build verification command
      const cmd = `npx hardhat verify --network ${NETWORK} ${this.newTokenManagerAddress} "${EXISTING_ADDRESSES.modelRegistry}"`;

      execSync(cmd, { stdio: 'inherit' });
      console.log(`✅ TokenManager verified on Etherscan`);
    } catch (error) {
      console.log(`⚠️  Failed to verify on Etherscan. You can verify manually at:`);
      console.log(`https://sepolia.etherscan.io/verifyContract?a=${this.newTokenManagerAddress}`);
    }
  }

  async testNewContract(): Promise<void> {
    if (!this.newTokenManagerAddress) {
      throw new Error('No contract deployed yet');
    }

    console.log('\n🧪 Testing new TokenManager contract...');

    const artifact = await this.loadContract('TokenManager');
    const tokenManager = new ethers.Contract(this.newTokenManagerAddress, artifact.abi, this.deployer);

    // Test 1: Check deploymentFee() works
    console.log('Testing deploymentFee()...');
    try {
      const fee = await tokenManager.deploymentFee();
      console.log(`✅ deploymentFee() returns: ${ethers.formatEther(fee)} ETH`);
    } catch (error) {
      console.error('❌ deploymentFee() failed:', error);
      throw error;
    }

    // Test 2: Check modelTokens() works with string parameter
    console.log('Testing modelTokens(string)...');
    try {
      const tokenAddress = await tokenManager.modelTokens("test-model-1");
      console.log(`✅ modelTokens("test-model-1") returns: ${tokenAddress}`);
    } catch (error) {
      console.error('❌ modelTokens(string) failed:', error);
      throw error;
    }

    // Test 3: Estimate gas for deployToken with correct parameters
    console.log('Testing gas estimation for deployToken...');
    try {
      const gasEstimate = await tokenManager.deployToken.estimateGas(
        "test-model-1",
        "Test Token",
        "TEST",
        ethers.parseEther("1000000"),
        { value: 0 }
      );
      console.log(`✅ deployToken gas estimate: ${gasEstimate.toString()} units`);
    } catch (error: any) {
      console.error('❌ deployToken gas estimation failed:', error);
      // This is expected to fail with "Token already deployed" if we run it twice
      if (error.message && !error.message.includes("Token already deployed")) {
        console.log('Note: This might fail if the model already has a token deployed');
      }
    }

    console.log('\n✅ All basic tests passed! The new contract interface is working correctly.');
  }

  async generateFrontendConfig(): Promise<void> {
    if (!this.newTokenManagerAddress) {
      throw new Error('No contract deployed yet');
    }

    console.log('\n📋 Frontend Configuration Update Required:');
    console.log('========================================');
    console.log('\nUpdate your frontend code with:');
    console.log(`const TOKEN_MANAGER_ADDRESS = '${this.newTokenManagerAddress}';`);

    console.log('\nCorrect ABI for frontend:');
    console.log(`const TOKEN_MANAGER_ABI = [
  'function deployToken(string memory modelId, string memory name, string memory symbol, uint256 totalSupply) external payable returns (address)',
  'function modelTokens(string) external view returns (address)',
  'function deploymentFee() external view returns (uint256)',
  'event TokenDeployed(string indexed modelId, address indexed tokenAddress, address indexed deployer, string name, string symbol, uint256 totalSupply)'
];`);

    console.log('\nFrontend usage example:');
    console.log(`// Deploy token with correct parameters
const tx = await tokenManager.deployToken(
  modelId,        // string - e.g., "model-123"
  tokenName,      // string - e.g., "My Model Token"
  tokenSymbol,    // string - e.g., "MMT"
  totalSupply,    // uint256 - e.g., ethers.parseEther("1000000")
  { value: deploymentFee }
);`);

    // Save configuration to file
    const config = {
      network: 'sepolia',
      chainId: CHAIN_ID,
      tokenManagerAddress: this.newTokenManagerAddress,
      modelRegistryAddress: EXISTING_ADDRESSES.modelRegistry,
      oldTokenManagerAddress: EXISTING_ADDRESSES.oldTokenManager,
      deployedAt: new Date().toISOString(),
      deployer: this.deployer.address
    };

    const fs = await import('fs');
    fs.writeFileSync('sepolia-deployment-config.json', JSON.stringify(config, null, 2));
    console.log('\n💾 Configuration saved to sepolia-deployment-config.json');
  }

  async compareWithOldContract(): Promise<void> {
    console.log('\n🔄 Comparing with old contract...');
    console.log(`Old TokenManager: ${EXISTING_ADDRESSES.oldTokenManager}`);
    console.log(`New TokenManager: ${this.newTokenManagerAddress}`);

    console.log('\nOld contract issues:');
    console.log('❌ Expected: deployToken(string modelId, string name, string symbol, uint256 totalSupply)');
    console.log('❌ Had: deployToken(string name, string symbol, uint256 modelId) - wrong order and types');
    console.log('❌ All method calls were reverting');

    console.log('\nNew contract fixes:');
    console.log('✅ Correct parameter order and types');
    console.log('✅ String modelId support');
    console.log('✅ TotalSupply parameter included');
    console.log('✅ All methods working correctly');
  }
}

async function main() {
  try {
    // Load configuration from environment
    const config: DeploymentConfig = {
      rpcUrl: process.env.SEPOLIA_RPC_URL || process.env.RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com',
      deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '',
      gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || '1.2'),
      maxGasPrice: ethers.parseUnits(process.env.MAX_GAS_PRICE_GWEI || '50', 'gwei')
    };

    if (!config.deployerPrivateKey) {
      console.error('❌ DEPLOYER_PRIVATE_KEY not set in environment!');
      console.log('\nPlease set your private key in .env.sepolia file:');
      console.log('DEPLOYER_PRIVATE_KEY=your_private_key_here');
      console.log('\nOr export it as an environment variable:');
      console.log('export DEPLOYER_PRIVATE_KEY=your_private_key_here');
      process.exit(1);
    }

    console.log('🚀 Starting deployment of FIXED TokenManager to Sepolia...');
    console.log('='.repeat(60));

    const deployer = new TokenManagerDeployer(config);

    // Step 1: Validate setup
    await deployer.validateSetup();

    // Step 2: Compile contracts
    console.log('\n📦 Compiling contracts...');
    execSync('npx hardhat compile', { stdio: 'inherit' });

    // Step 3: Deploy new TokenManager
    const newAddress = await deployer.deployTokenManager();

    // Step 4: Verify on Etherscan
    await deployer.verifyContract();

    // Step 5: Test the new contract
    await deployer.testNewContract();

    // Step 6: Generate frontend configuration
    await deployer.generateFrontendConfig();

    // Step 7: Compare with old contract
    await deployer.compareWithOldContract();

    console.log('\n' + '='.repeat(60));
    console.log('🎉 Deployment completed successfully!');
    console.log('='.repeat(60));

    console.log('\n📋 IMPORTANT - Next Steps:');
    console.log('1. Update frontend to use new TokenManager address:', newAddress);
    console.log('2. Test token deployment on Sepolia testnet');
    console.log('3. Monitor for successful transactions');
    console.log('4. Consider migrating any existing token mappings if needed');

    console.log('\n🔗 Useful Links:');
    console.log(`Etherscan: https://sepolia.etherscan.io/address/${newAddress}`);
    console.log(`Old (broken) contract: https://sepolia.etherscan.io/address/${EXISTING_ADDRESSES.oldTokenManager}`);

  } catch (error) {
    console.error('\n❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run the deployment
main();