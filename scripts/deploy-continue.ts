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

// Already deployed ModelRegistry
const MODEL_REGISTRY_ADDRESS = '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f';

interface DeploymentConfig {
  rpcUrl: string;
  deployerPrivateKey: string;
  gasMultiplier: number;
  maxGasPrice: bigint;
}

interface ContractAddresses {
  modelRegistry: string;
  hokusaiToken?: string;
  tokenManager?: string;
  burnAuction?: string;
}

class SepoliaDeployer {
  private provider: ethers.JsonRpcProvider;
  private deployer: ethers.Wallet;
  private addresses: ContractAddresses = {
    modelRegistry: MODEL_REGISTRY_ADDRESS
  };

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
    
    if (balance < ethers.parseEther('0.1')) {
      throw new Error('Insufficient ETH balance! Need at least 0.1 ETH for deployment');
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

  async deployContract(name: string, args: any[] = []): Promise<string> {
    console.log(`\n📦 Deploying ${name}...`);
    
    const artifact = await this.loadContract(name);
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, this.deployer);
    
    // Deploy contract
    const contract = await factory.deploy(...args);
    console.log(`📝 Transaction hash: ${contract.deploymentTransaction()?.hash}`);
    console.log(`⏳ Waiting for ${CONFIRMATIONS} confirmations...`);
    
    await contract.waitForDeployment();
    const address = await contract.getAddress();
    
    console.log(`✅ ${name} deployed at: ${address}`);
    
    return address;
  }

  async deployRemainingContracts(): Promise<ContractAddresses> {
    console.log('\n🚀 Continuing Sepolia deployment...');
    console.log(`📍 Using existing ModelRegistry at: ${this.addresses.modelRegistry}`);

    // Deploy HokusaiToken
    this.addresses.hokusaiToken = await this.deployContract('HokusaiToken', [
      'Hokusai Token',
      'HOKUSAI',
      this.deployer.address // Initial controller (will be changed to TokenManager)
    ]);

    // Deploy TokenManager
    this.addresses.tokenManager = await this.deployContract('TokenManager', [
      this.addresses.modelRegistry
    ]);

    // Deploy BurnAuction
    this.addresses.burnAuction = await this.deployContract('BurnAuction', [
      this.addresses.hokusaiToken,
      300 // 5 minutes auction duration for testing
    ]);

    // Configure contracts
    await this.configureContracts();

    return this.addresses;
  }

  async configureContracts(): Promise<void> {
    console.log('\n⚙️  Configuring contracts...');

    // Transfer HokusaiToken controller to TokenManager
    const tokenArtifact = await this.loadContract('HokusaiToken');
    const token = new ethers.Contract(this.addresses.hokusaiToken!, tokenArtifact.abi, this.deployer);
    
    console.log('🔄 Transferring token control to TokenManager...');
    const tx1 = await token.setController(this.addresses.tokenManager);
    await tx1.wait(CONFIRMATIONS);
    console.log('✅ Token control transferred');

    // Set TokenManager in ModelRegistry
    const registryArtifact = await this.loadContract('ModelRegistry');
    const registry = new ethers.Contract(this.addresses.modelRegistry!, registryArtifact.abi, this.deployer);
    
    console.log('🔄 Setting TokenManager in ModelRegistry...');
    const tx2 = await registry.setTokenManager(this.addresses.tokenManager);
    await tx2.wait(CONFIRMATIONS);
    console.log('✅ TokenManager set in ModelRegistry');
  }

  async updateSSMParameters(): Promise<void> {
    console.log('\n☁️  Updating AWS SSM Parameters...');

    const updateParam = async (name: string, value: string) => {
      const paramName = `/hokusai/development/contracts/${name}`;
      console.log(`📝 Updating ${paramName}...`);
      
      try {
        execSync(
          `aws ssm put-parameter --name "${paramName}" --value "${value}" --overwrite --type "SecureString"`,
          { stdio: 'pipe' }
        );
        console.log(`✅ Updated ${paramName}`);
      } catch (error) {
        console.error(`❌ Failed to update ${paramName}:`, error);
      }
    };

    await updateParam('model_registry_address', this.addresses.modelRegistry!);
    await updateParam('token_manager_address', this.addresses.tokenManager!);
    
    // Store additional addresses for reference
    await updateParam('hokusai_token_address', this.addresses.hokusaiToken!);
    await updateParam('burn_auction_address', this.addresses.burnAuction!);
  }

  async restartECSService(): Promise<void> {
    console.log('\n🔄 Restarting ECS Service...');
    
    try {
      execSync(
        'aws ecs update-service --cluster hokusai-development --service hokusai-contracts-development --force-new-deployment',
        { stdio: 'inherit' }
      );
      console.log('✅ ECS service restart initiated');
    } catch (error) {
      console.error('❌ Failed to restart ECS service:', error);
    }
  }

  async testDeployment(): Promise<void> {
    console.log('\n🧪 Testing deployment...');

    // Test ModelRegistry
    const registryArtifact = await this.loadContract('ModelRegistry');
    const registry = new ethers.Contract(this.addresses.modelRegistry!, registryArtifact.abi, this.deployer);
    
    const tokenManager = await registry.tokenManager();
    console.log(`✅ ModelRegistry.tokenManager = ${tokenManager}`);
    
    if (tokenManager.toLowerCase() !== this.addresses.tokenManager!.toLowerCase()) {
      throw new Error('TokenManager not properly set in ModelRegistry!');
    }

    // Test HokusaiToken
    const tokenArtifact = await this.loadContract('HokusaiToken');
    const token = new ethers.Contract(this.addresses.hokusaiToken!, tokenArtifact.abi, this.deployer);
    
    const controller = await token.controller();
    console.log(`✅ HokusaiToken.controller = ${controller}`);
    
    if (controller.toLowerCase() !== this.addresses.tokenManager!.toLowerCase()) {
      throw new Error('TokenManager not set as controller of HokusaiToken!');
    }

    console.log('\n✅ All deployment tests passed!');
  }

  async generateTestMessage(): Promise<void> {
    console.log('\n📨 Generating test message for queue...');
    
    const testMessage = {
      modelId: 'test-model-001',
      name: 'Test Model Alpha',
      symbol: 'TMA',
      initialSupply: ethers.parseEther('1000000').toString(),
      metadata: {
        description: 'Test model for Sepolia deployment',
        accuracy: 0.95,
        version: '1.0.0',
        deployedAt: new Date().toISOString()
      }
    };

    console.log('Test message to send to Redis queue:');
    console.log(JSON.stringify(testMessage, null, 2));
    
    // Save to file for easy access
    const fs = await import('fs');
    fs.writeFileSync('test-message.json', JSON.stringify(testMessage, null, 2));
    console.log('\n💾 Test message saved to test-message.json');
  }
}

async function main() {
  try {
    // Load configuration
    const config: DeploymentConfig = {
      rpcUrl: process.env.RPC_URL || 'https://eth-sepolia.g.alchemy.com/v2/YOUR_API_KEY',
      deployerPrivateKey: process.env.DEPLOYER_PRIVATE_KEY || '',
      gasMultiplier: parseFloat(process.env.GAS_MULTIPLIER || '1.2'),
      maxGasPrice: ethers.parseUnits(process.env.MAX_GAS_PRICE_GWEI || '50', 'gwei')
    };

    if (!config.deployerPrivateKey) {
      throw new Error('DEPLOYER_PRIVATE_KEY not set in environment!');
    }

    const deployer = new SepoliaDeployer(config);

    // Validate setup
    await deployer.validateSetup();

    // Deploy remaining contracts
    const addresses = await deployer.deployRemainingContracts();

    // Update SSM parameters
    await deployer.updateSSMParameters();

    // Restart ECS service
    await deployer.restartECSService();

    // Test deployment
    await deployer.testDeployment();

    // Generate test message
    await deployer.generateTestMessage();

    console.log('\n🎉 Deployment completed successfully!');
    console.log('\nDeployed Addresses:');
    console.log('-------------------');
    console.log(`ModelRegistry: ${addresses.modelRegistry}`);
    console.log(`HokusaiToken: ${addresses.hokusaiToken}`);
    console.log(`TokenManager: ${addresses.tokenManager}`);
    console.log(`BurnAuction: ${addresses.burnAuction}`);
    
    console.log('\nNext steps:');
    console.log('1. Monitor ECS service restart: aws ecs describe-services --cluster hokusai-development --services hokusai-contracts-development');
    console.log('2. Check service health: curl https://contracts.hokus.ai/health');
    console.log('3. Send test message to Redis queue using test-message.json');
    console.log('4. Monitor CloudWatch logs: aws logs tail /ecs/hokusai-contracts-task --follow');

  } catch (error) {
    console.error('\n❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run the deployment
main();