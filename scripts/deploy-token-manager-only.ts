import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

dotenv.config();

async function main() {
  console.log('🚀 Deploying updated TokenManager to Sepolia...\n');

  // Initialize SSM client
  const ssmClient = new SSMClient({ region: 'us-east-1' });

  // Get deployment credentials from SSM
  console.log('📥 Fetching deployment credentials from SSM...');
  
  const [deployerKeyParam, rpcUrlParam, registryParam] = await Promise.all([
    ssmClient.send(new GetParameterCommand({
      Name: '/hokusai/contracts/sepolia/deployerKey',
      WithDecryption: true
    })),
    ssmClient.send(new GetParameterCommand({
      Name: '/hokusai/contracts/sepolia/rpcUrl',
      WithDecryption: false
    })),
    ssmClient.send(new GetParameterCommand({
      Name: '/hokusai/contracts/sepolia/modelRegistry',
      WithDecryption: false
    }))
  ]);

  const deployerKey = deployerKeyParam.Parameter?.Value;
  const rpcUrl = rpcUrlParam.Parameter?.Value || 'https://eth-sepolia.g.alchemy.com/v2/d-BuRfrIEzvXxIXOW5mA3XZVVjkOx-7P';
  const modelRegistryAddress = registryParam.Parameter?.Value;

  if (!deployerKey) {
    throw new Error('Deployer key not found in SSM');
  }

  if (!modelRegistryAddress) {
    throw new Error('ModelRegistry address not found in SSM');
  }

  console.log(`Using RPC URL: ${rpcUrl}`);
  console.log(`Using ModelRegistry at: ${modelRegistryAddress}`);

  // Create provider and wallet
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(deployerKey, provider);
  console.log(`Deployer address: ${wallet.address}`);

  // Check balance
  const balance = await provider.getBalance(wallet.address);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

  if (balance === 0n) {
    console.error('❌ Deployer has no ETH! Please fund the account.');
    process.exit(1);
  }

  // Deploy TokenManager
  console.log('\n📝 Deploying TokenManager with new features...');
  
  // Load contract artifacts
  const TokenManagerArtifact = require('../artifacts/contracts/TokenManager.sol/TokenManager.json');
  
  const TokenManagerFactory = new ethers.ContractFactory(
    TokenManagerArtifact.abi,
    TokenManagerArtifact.bytecode,
    wallet
  );

  const tokenManager = await TokenManagerFactory.deploy(modelRegistryAddress);
  console.log(`Transaction hash: ${tokenManager.deploymentTransaction()?.hash}`);
  console.log('⏳ Waiting for confirmation...');
  
  await tokenManager.waitForDeployment();
  const tokenManagerAddress = await tokenManager.getAddress();
  console.log(`✅ TokenManager deployed to: ${tokenManagerAddress}`);

  // Update SSM parameter
  console.log('\n🔄 Updating SSM parameter...');
  await ssmClient.send(
    new PutParameterCommand({
      Name: '/hokusai/contracts/sepolia/tokenManager',
      Value: tokenManagerAddress,
      Type: 'String',
      Overwrite: true,
      Description: 'TokenManager contract address on Sepolia (with deployToken support)'
    })
  );
  console.log('✅ SSM parameter updated');

  // Verify deployment
  console.log('\n🔍 Verifying deployment...');
  const deployedCode = await provider.getCode(tokenManagerAddress);
  if (deployedCode === '0x') {
    console.error('❌ Contract not deployed properly!');
    process.exit(1);
  }
  console.log('✅ Contract code verified');

  console.log('\n✨ TokenManager update complete!');
  console.log('\n📊 Deployment Summary:');
  console.log('=======================');
  console.log(`TokenManager: ${tokenManagerAddress}`);
  console.log(`ModelRegistry: ${modelRegistryAddress}`);
  console.log(`View on Etherscan: https://sepolia.etherscan.io/address/${tokenManagerAddress}`);
  console.log('\n🎯 New Features:');
  console.log('- deployToken() function for direct user deployment');
  console.log('- Internal token tracking via modelTokens mapping');
  console.log('- Optional deployment fee mechanism');
  console.log('- Users pay gas fees directly when deploying');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Deployment failed:', error);
    process.exit(1);
  });