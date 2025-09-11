const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function main() {
  console.log('🚀 Deploying updated TokenManager to Sepolia...\n');

  // Configuration
  const MODEL_REGISTRY_ADDRESS = '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f';
  const RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
  const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY;

  if (!PRIVATE_KEY) {
    console.error('❌ DEPLOYER_PRIVATE_KEY not found in .env file');
    process.exit(1);
  }

  console.log(`Using RPC: ${RPC_URL}`);
  console.log(`Using ModelRegistry at: ${MODEL_REGISTRY_ADDRESS}`);

  // Connect to network
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  
  console.log(`Deploying with account: ${wallet.address}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error('❌ Account has no ETH balance!');
    process.exit(1);
  }

  // Load contract artifact
  const artifactPath = path.join(__dirname, '../artifacts/contracts/TokenManager.sol/TokenManager.json');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

  // Deploy contract
  console.log('\n📝 Deploying TokenManager...');
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  
  const tokenManager = await factory.deploy(MODEL_REGISTRY_ADDRESS);
  console.log(`Transaction hash: ${tokenManager.deploymentTransaction().hash}`);
  console.log('⏳ Waiting for confirmation...');
  
  await tokenManager.waitForDeployment();
  const tokenManagerAddress = await tokenManager.getAddress();
  
  console.log(`✅ TokenManager deployed to: ${tokenManagerAddress}`);

  // Verify deployment
  const code = await provider.getCode(tokenManagerAddress);
  if (code === '0x') {
    console.error('❌ Contract not deployed!');
    process.exit(1);
  }
  console.log('✅ Contract verified on chain');

  console.log('\n✨ Deployment complete!');
  console.log('\n📊 Summary:');
  console.log('==========');
  console.log(`TokenManager: ${tokenManagerAddress}`);
  console.log(`ModelRegistry: ${MODEL_REGISTRY_ADDRESS}`);
  console.log(`Etherscan: https://sepolia.etherscan.io/address/${tokenManagerAddress}`);
  
  console.log('\n🎯 New Features:');
  console.log('- deployToken() for user-paid deployment');
  console.log('- Internal token tracking');
  console.log('- Optional deployment fees');
  
  console.log('\n📝 Next Steps:');
  console.log(`1. Update SSM: aws ssm put-parameter --name "/hokusai/contracts/sepolia/tokenManager" --value "${tokenManagerAddress}" --overwrite`);
  console.log('2. Update frontend with new address');
  console.log('3. Test deployToken() from frontend');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Error:', error);
    process.exit(1);
  });