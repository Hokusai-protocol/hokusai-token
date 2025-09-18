import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

// Load Sepolia configuration
dotenv.config({ path: '.env.sepolia' });

// Deployed contract addresses
const ADDRESSES = {
  modelRegistry: '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f',
  hokusaiToken: '0x9aFd572772483F8B86643A85FFa9bc36D7A16E92',
  tokenManager: '0x9793FAc5ab7DE93367Ddf38748e56E49386473BC'
};

const CONFIRMATIONS = 2;

async function main() {
  try {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const deployer = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY!, provider);
    
    console.log('🔧 Configuring deployed contracts...\n');
    console.log('Deployed Addresses:');
    console.log('- ModelRegistry:', ADDRESSES.modelRegistry);
    console.log('- HokusaiToken:', ADDRESSES.hokusaiToken);
    console.log('- TokenManager:', ADDRESSES.tokenManager);
    console.log('');

    // Load contract ABIs
    const loadABI = (name: string) => {
      const artifactPath = join(process.cwd(), 'artifacts', 'contracts', `${name}.sol`, `${name}.json`);
      const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
      return artifact.abi;
    };

    // Step 1: Transfer HokusaiToken controller to TokenManager
    console.log('📝 Step 1: Transferring token control to TokenManager...');
    const token = new ethers.Contract(ADDRESSES.hokusaiToken, loadABI('HokusaiToken'), deployer);
    
    const currentController = await token.controller();
    console.log('  Current controller:', currentController);
    
    if (currentController.toLowerCase() !== ADDRESSES.tokenManager.toLowerCase()) {
      const tx1 = await token.setController(ADDRESSES.tokenManager);
      console.log('  Transaction:', tx1.hash);
      await tx1.wait(CONFIRMATIONS);
      console.log('  ✅ Token control transferred');
    } else {
      console.log('  ✅ Token control already set correctly');
    }

    // Step 2: Set TokenManager in ModelRegistry
    console.log('\n📝 Step 2: Setting TokenManager in ModelRegistry...');
    const registry = new ethers.Contract(ADDRESSES.modelRegistry, loadABI('ModelRegistry'), deployer);
    
    const currentTokenManager = await registry.tokenManager();
    console.log('  Current TokenManager:', currentTokenManager);
    
    if (currentTokenManager.toLowerCase() !== ADDRESSES.tokenManager.toLowerCase()) {
      const tx2 = await registry.setTokenManager(ADDRESSES.tokenManager);
      console.log('  Transaction:', tx2.hash);
      await tx2.wait(CONFIRMATIONS);
      console.log('  ✅ TokenManager set in ModelRegistry');
    } else {
      console.log('  ✅ TokenManager already set correctly');
    }

    // Step 3: Verify configuration
    console.log('\n🔍 Step 3: Verifying configuration...');
    const finalController = await token.controller();
    const finalTokenManager = await registry.tokenManager();
    
    console.log('  HokusaiToken.controller:', finalController);
    console.log('  ModelRegistry.tokenManager:', finalTokenManager);
    
    if (finalController.toLowerCase() === ADDRESSES.tokenManager.toLowerCase() &&
        finalTokenManager.toLowerCase() === ADDRESSES.tokenManager.toLowerCase()) {
      console.log('  ✅ All contracts configured correctly!');
    } else {
      throw new Error('Contract configuration verification failed!');
    }

    // Step 4: Update SSM Parameters
    console.log('\n☁️  Step 4: Updating AWS SSM Parameters...');
    
    const updateParam = async (name: string, value: string) => {
      const paramName = `/hokusai/development/contracts/${name}`;
      console.log(`  Updating ${name}...`);
      
      try {
        execSync(
          `aws ssm put-parameter --name "${paramName}" --value "${value}" --overwrite --type "SecureString"`,
          { stdio: 'pipe' }
        );
        console.log(`  ✅ Updated ${name}`);
      } catch (error) {
        console.error(`  ❌ Failed to update ${name}:`, error);
      }
    };

    await updateParam('model_registry_address', ADDRESSES.modelRegistry);
    await updateParam('token_manager_address', ADDRESSES.tokenManager);
    await updateParam('hokusai_token_address', ADDRESSES.hokusaiToken);

    // Step 5: Restart ECS Service
    console.log('\n🔄 Step 5: Restarting ECS Service...');
    
    try {
      execSync(
        'aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --force-new-deployment --query "service.serviceName" --output text',
        { stdio: 'inherit' }
      );
      console.log('✅ ECS service restart initiated');
    } catch (error) {
      console.error('❌ Failed to restart ECS service:', error);
    }

    // Step 6: Display summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 DEPLOYMENT COMPLETE!');
    console.log('='.repeat(60));
    console.log('\n📋 Contract Addresses:');
    console.log(`  ModelRegistry: ${ADDRESSES.modelRegistry}`);
    console.log(`  HokusaiToken:  ${ADDRESSES.hokusaiToken}`);
    console.log(`  TokenManager:  ${ADDRESSES.tokenManager}`);
    
    console.log('\n📊 View on Sepolia Etherscan:');
    console.log(`  https://sepolia.etherscan.io/address/${ADDRESSES.modelRegistry}`);
    console.log(`  https://sepolia.etherscan.io/address/${ADDRESSES.hokusaiToken}`);
    console.log(`  https://sepolia.etherscan.io/address/${ADDRESSES.tokenManager}`);
    
    console.log('\n🚀 Next Steps:');
    console.log('1. Wait ~2 minutes for ECS service to restart');
    console.log('2. Check service health: curl https://contracts.hokus.ai/health');
    console.log('3. Test queue processing: npm run test-queue send');
    console.log('4. Monitor logs: aws logs tail /ecs/hokusai-contracts-task --follow');

  } catch (error) {
    console.error('\n❌ Configuration failed:', error);
    process.exit(1);
  }
}

main();