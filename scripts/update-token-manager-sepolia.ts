import { ethers } from 'hardhat';
import dotenv from 'dotenv';
import { SSMClient, PutParameterCommand, GetParameterCommand } from '@aws-sdk/client-ssm';

dotenv.config();

async function main() {
  console.log('🚀 Updating TokenManager on Sepolia...\n');

  // Initialize SSM client
  const ssmClient = new SSMClient({ region: 'us-east-1' });

  // Get the current ModelRegistry address from SSM
  const registryParam = await ssmClient.send(
    new GetParameterCommand({
      Name: '/hokusai/contracts/sepolia/modelRegistry',
      WithDecryption: false
    })
  );
  const modelRegistryAddress = registryParam.Parameter?.Value;
  console.log(`Using ModelRegistry at: ${modelRegistryAddress}`);

  // Deploy new TokenManager
  console.log('\n📝 Deploying new TokenManager...');
  const TokenManager = await ethers.getContractFactory('TokenManager');
  const tokenManager = await TokenManager.deploy(modelRegistryAddress);
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

  // Verify the contract on Etherscan
  console.log('\n🔍 Contract verification info:');
  console.log(`Verify on Etherscan: https://sepolia.etherscan.io/address/${tokenManagerAddress}`);
  console.log(`Constructor argument: ${modelRegistryAddress}`);

  console.log('\n✨ TokenManager update complete!');
  console.log('\nDeployment Summary:');
  console.log('==================');
  console.log(`TokenManager: ${tokenManagerAddress}`);
  console.log(`ModelRegistry: ${modelRegistryAddress}`);
  console.log('\nKey Features Added:');
  console.log('- deployToken() function for direct user deployment');
  console.log('- Internal token tracking via modelTokens mapping');
  console.log('- Optional deployment fee mechanism');
  console.log('- Users pay gas fees directly');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });