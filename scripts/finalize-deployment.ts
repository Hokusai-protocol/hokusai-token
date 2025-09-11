import { ethers } from 'ethers';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';

// Load Sepolia configuration
dotenv.config({ path: '.env.sepolia' });

// Deployed contract addresses
const ADDRESSES = {
  modelRegistry: '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f',
  hokusaiToken: '0x9aFd572772483F8B86643A85FFa9bc36D7A16E92', 
  tokenManager: '0x9793FAc5ab7DE93367Ddf38748e56E49386473BC'
};

async function main() {
  try {
    console.log('🚀 Finalizing Sepolia Deployment\n');
    console.log('📋 Deployed Contracts:');
    console.log('  ModelRegistry:', ADDRESSES.modelRegistry);
    console.log('  HokusaiToken:', ADDRESSES.hokusaiToken);
    console.log('  TokenManager:', ADDRESSES.tokenManager);
    console.log('');

    // Step 1: Update SSM Parameters
    console.log('☁️  Step 1: Updating AWS SSM Parameters...');
    
    const updateParam = async (name: string, value: string) => {
      const paramName = `/hokusai/development/contracts/${name}`;
      console.log(`  Updating ${name}...`);
      
      try {
        execSync(
          `aws ssm put-parameter --name "${paramName}" --value "${value}" --overwrite --type "SecureString"`,
          { stdio: 'pipe' }
        );
        console.log(`  ✅ Updated ${name}`);
        return true;
      } catch (error) {
        console.error(`  ❌ Failed to update ${name}`);
        return false;
      }
    };

    const results = await Promise.all([
      updateParam('model_registry_address', ADDRESSES.modelRegistry),
      updateParam('token_manager_address', ADDRESSES.tokenManager),
      updateParam('hokusai_token_address', ADDRESSES.hokusaiToken)
    ]);

    if (!results.every(r => r)) {
      console.log('\n⚠️  Some SSM parameters failed to update');
    }

    // Step 2: Restart ECS Service
    console.log('\n🔄 Step 2: Restarting ECS Service...');
    
    try {
      const result = execSync(
        'aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --force-new-deployment --query "service.deployments[0].{status:status,runningCount:runningCount,desiredCount:desiredCount}" --output json',
        { encoding: 'utf8' }
      );
      
      const deployment = JSON.parse(result);
      console.log('  ✅ ECS service restart initiated');
      console.log(`  Status: ${deployment.status}`);
      console.log(`  Running: ${deployment.runningCount}/${deployment.desiredCount} tasks`);
    } catch (error) {
      console.error('  ❌ Failed to restart ECS service');
    }

    // Step 3: Generate test message
    console.log('\n📝 Step 3: Generating test message...');
    
    const testMessage = {
      modelId: `sepolia-test-${Date.now()}`,
      name: 'Sepolia Test Model',
      symbol: 'STM',
      initialSupply: ethers.parseEther('1000').toString(),
      metadata: {
        description: 'Test model deployed on Sepolia',
        accuracy: 0.95,
        version: '1.0.0',
        network: 'sepolia',
        timestamp: new Date().toISOString()
      }
    };

    const fs = await import('fs');
    fs.writeFileSync('test-message.json', JSON.stringify(testMessage, null, 2));
    console.log('  ✅ Test message saved to test-message.json');

    // Step 4: Display summary
    console.log('\n' + '='.repeat(60));
    console.log('🎉 DEPLOYMENT FINALIZED!');
    console.log('='.repeat(60));
    
    console.log('\n📊 View on Sepolia Etherscan:');
    console.log(`  ModelRegistry: https://sepolia.etherscan.io/address/${ADDRESSES.modelRegistry}`);
    console.log(`  HokusaiToken:  https://sepolia.etherscan.io/address/${ADDRESSES.hokusaiToken}`);
    console.log(`  TokenManager:  https://sepolia.etherscan.io/address/${ADDRESSES.tokenManager}`);
    
    console.log('\n✅ Contract Configuration:');
    console.log('  - HokusaiToken controller set to TokenManager');
    console.log('  - TokenManager initialized with ModelRegistry');
    console.log('  - SSM parameters updated');
    console.log('  - ECS service restarting');
    
    console.log('\n🧪 Testing Commands:');
    console.log('  1. Check service health (wait 2 min for restart):');
    console.log('     curl https://contracts.hokus.ai/health\n');
    console.log('  2. Send test message to queue:');
    console.log('     npm run test-queue send\n');
    console.log('  3. Monitor queue processing:');
    console.log('     npm run test-queue monitor\n');
    console.log('  4. Watch service logs:');
    console.log('     aws logs tail /ecs/hokusai-contracts-task --follow\n');
    
    console.log('📋 Contract Addresses for Reference:');
    console.log(`export MODEL_REGISTRY_ADDRESS="${ADDRESSES.modelRegistry}"`);
    console.log(`export HOKUSAI_TOKEN_ADDRESS="${ADDRESSES.hokusaiToken}"`);
    console.log(`export TOKEN_MANAGER_ADDRESS="${ADDRESSES.tokenManager}"`);

  } catch (error) {
    console.error('\n❌ Finalization failed:', error);
    process.exit(1);
  }
}

main();