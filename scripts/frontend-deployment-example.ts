// Example: Frontend Direct Deployment (User Pays Gas)
// This would run in the browser with user's connected wallet

import { ethers } from 'ethers';

// Deployed contract addresses on Sepolia
const CONTRACTS = {
  TokenManager: '0x9793FAc5ab7DE93367Ddf38748e56E49386473BC',
  ModelRegistry: '0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f',
  HokusaiToken: '0x9aFd572772483F8B86643A85FFa9bc36D7A16E92'
};

// TokenManager ABI (only the functions we need)
const TOKEN_MANAGER_ABI = [
  'function deployToken(string memory name, string memory symbol, uint256 modelId) external returns (address)',
  'function registerModel(uint256 modelId, address tokenAddress, string memory metric) external',
  'event TokenDeployed(uint256 indexed modelId, address indexed tokenAddress, string name, string symbol)'
];

// ModelRegistry ABI
const MODEL_REGISTRY_ABI = [
  'function registerModel(uint256 modelId, address token, string memory performanceMetric) external',
  'function models(uint256) external view returns (address tokenAddress, string memory performanceMetric, bool active)',
  'function isModelRegistered(uint256) external view returns (bool)'
];

// HokusaiToken ABI
const HOKUSAI_TOKEN_ABI = [
  'function name() external view returns (string)',
  'function symbol() external view returns (string)',
  'function totalSupply() external view returns (uint256)',
  'function controller() external view returns (address)',
  'function mint(address to, uint256 amount) external',
  'function burn(address from, uint256 amount) external'
];

interface DeploymentParams {
  modelId: string;
  tokenName: string;
  tokenSymbol: string;
  performanceMetric?: string;
}

export class FrontendDeployer {
  private provider: ethers.BrowserProvider;
  private signer: ethers.Signer | null = null;
  private tokenManager: ethers.Contract;
  private modelRegistry: ethers.Contract;

  constructor() {
    // In a real app, this would be window.ethereum from MetaMask
    this.provider = new ethers.BrowserProvider(window.ethereum);
    this.tokenManager = new ethers.Contract(
      CONTRACTS.TokenManager,
      TOKEN_MANAGER_ABI,
      this.provider
    );
    this.modelRegistry = new ethers.Contract(
      CONTRACTS.ModelRegistry,
      MODEL_REGISTRY_ABI,
      this.provider
    );
  }

  /**
   * Connect user's wallet
   */
  async connectWallet(): Promise<string> {
    // Request account access
    await this.provider.send("eth_requestAccounts", []);
    
    // Get the signer
    this.signer = await this.provider.getSigner();
    const address = await this.signer.getAddress();
    
    console.log('Connected wallet:', address);
    return address;
  }

  /**
   * Check if model already has a token
   */
  async checkModelToken(modelId: string): Promise<boolean> {
    const isRegistered = await this.modelRegistry.isModelRegistered(modelId);
    if (isRegistered) {
      const model = await this.modelRegistry.models(modelId);
      console.log('Model already has token:', model.tokenAddress);
      return true;
    }
    return false;
  }

  /**
   * Estimate gas for deployment
   */
  async estimateDeploymentCost(params: DeploymentParams): Promise<{
    estimatedGas: bigint;
    gasPrice: bigint;
    totalCostWei: bigint;
    totalCostEth: string;
  }> {
    if (!this.signer) throw new Error('Wallet not connected');

    // Get gas price
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice || 0n;

    // Estimate gas for deployment
    // Note: Since TokenManager deploys a new contract, this is expensive (~2-3M gas)
    const tokenManagerWithSigner = this.tokenManager.connect(this.signer);
    
    try {
      const estimatedGas = await tokenManagerWithSigner.deployToken.estimateGas(
        params.tokenName,
        params.tokenSymbol,
        params.modelId
      );

      const totalCostWei = estimatedGas * gasPrice;
      const totalCostEth = ethers.formatEther(totalCostWei);

      return {
        estimatedGas,
        gasPrice,
        totalCostWei,
        totalCostEth
      };
    } catch (error) {
      console.error('Gas estimation failed:', error);
      throw error;
    }
  }

  /**
   * Deploy token (USER PAYS GAS)
   */
  async deployToken(params: DeploymentParams): Promise<{
    tokenAddress: string;
    transactionHash: string;
    blockNumber: number;
    gasUsed: string;
  }> {
    if (!this.signer) throw new Error('Wallet not connected');

    console.log('🚀 Deploying token with user wallet...');
    console.log('Parameters:', params);

    // Check if model already has token
    const hasToken = await this.checkModelToken(params.modelId);
    if (hasToken) {
      throw new Error('Model already has a token deployed');
    }

    // Estimate gas cost
    const gasCost = await this.estimateDeploymentCost(params);
    console.log(`💰 Estimated cost: ${gasCost.totalCostEth} ETH`);

    // Get user confirmation (in a real app, show this in UI)
    const userConfirmed = confirm(
      `Deployment will cost approximately ${gasCost.totalCostEth} ETH. Continue?`
    );
    
    if (!userConfirmed) {
      throw new Error('User cancelled deployment');
    }

    // Connect contract with signer (user's wallet)
    const tokenManagerWithSigner = this.tokenManager.connect(this.signer);

    // Send transaction (USER PAYS GAS HERE)
    console.log('📝 Sending transaction...');
    const tx = await tokenManagerWithSigner.deployToken(
      params.tokenName,
      params.tokenSymbol,
      params.modelId
    );

    console.log('Transaction hash:', tx.hash);
    console.log('⏳ Waiting for confirmation...');

    // Wait for transaction confirmation
    const receipt = await tx.wait(2); // Wait for 2 confirmations

    // Get token address from events
    const deployEvent = receipt.logs.find(
      (log: any) => log.topics[0] === ethers.id('TokenDeployed(uint256,address,string,string)')
    );

    if (!deployEvent) {
      throw new Error('Token deployment event not found');
    }

    // Decode the event
    const tokenAddress = ethers.getAddress('0x' + deployEvent.topics[2].slice(26));

    console.log('✅ Token deployed successfully!');
    console.log('Token address:', tokenAddress);
    console.log('Gas used:', receipt.gasUsed.toString());

    return {
      tokenAddress,
      transactionHash: receipt.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString()
    };
  }

  /**
   * Register model in registry (if TokenManager doesn't do it)
   */
  async registerModel(
    modelId: string, 
    tokenAddress: string, 
    performanceMetric: string
  ): Promise<void> {
    if (!this.signer) throw new Error('Wallet not connected');

    const registryWithSigner = this.modelRegistry.connect(this.signer);
    
    const tx = await registryWithSigner.registerModel(
      modelId,
      tokenAddress,
      performanceMetric
    );

    await tx.wait(2);
    console.log('✅ Model registered in registry');
  }
}

// Example usage in React/Next.js component
export async function deployFromFrontend() {
  const deployer = new FrontendDeployer();
  
  try {
    // 1. Connect wallet
    const userAddress = await deployer.connectWallet();
    console.log('User address:', userAddress);

    // 2. Prepare deployment parameters
    const params: DeploymentParams = {
      modelId: '12345',
      tokenName: 'My Model Token',
      tokenSymbol: 'MMT',
      performanceMetric: '95.5% accuracy'
    };

    // 3. Estimate cost
    const cost = await deployer.estimateDeploymentCost(params);
    console.log(`Deployment will cost: ${cost.totalCostEth} ETH`);

    // 4. Deploy token (USER PAYS GAS)
    const result = await deployer.deployToken(params);
    
    // 5. Show success
    console.log('Token deployed!', result);
    alert(`Token deployed at: ${result.tokenAddress}\nView on Etherscan: https://sepolia.etherscan.io/address/${result.tokenAddress}`);

  } catch (error) {
    console.error('Deployment failed:', error);
    alert('Deployment failed: ' + error.message);
  }
}

// Comparison with backend deployment
const DEPLOYMENT_COMPARISON = {
  backend_deployment: {
    who_pays: "Hokusai's deployer wallet",
    gas_payment: "Service pays upfront",
    user_cost: "Charged separately (credits, subscription, etc.)",
    advantages: [
      "User doesn't need ETH",
      "Simpler UX",
      "Can batch deployments",
      "Hide blockchain complexity"
    ],
    disadvantages: [
      "Service pays gas costs",
      "Need cost recovery mechanism",
      "Centralized control"
    ]
  },
  
  frontend_deployment: {
    who_pays: "User's connected wallet",
    gas_payment: "User pays directly",
    user_cost: "Direct ETH payment for gas",
    advantages: [
      "User pays gas directly",
      "Fully decentralized",
      "No cost recovery needed",
      "User has full control"
    ],
    disadvantages: [
      "User needs ETH",
      "More complex UX",
      "User needs wallet",
      "Can't help users without ETH"
    ]
  },

  hybrid_approach: {
    description: "Meta-transactions or Account Abstraction",
    who_pays: "User pays, but indirectly",
    mechanism: [
      "User signs message (no gas)",
      "Service submits transaction",
      "Cost deducted from user's token balance",
      "Or paid in stablecoins"
    ]
  }
};