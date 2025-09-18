# Frontend Token Deployment Guide

## Overview

The updated TokenManager contract now supports direct token deployment where users pay gas fees from their own wallets. This eliminates the need for Hokusai to maintain and fund deployer wallets.

## Contract Changes

### TokenManager Contract Updates

The TokenManager contract (contracts/TokenManager.sol) now includes:

1. **deployToken() Function**
   - Allows any user to deploy a token for their model
   - User pays gas fees directly from their wallet
   - Returns the deployed token address

2. **Internal Token Tracking**
   - `modelTokens` mapping: tracks token address by model ID
   - `tokenToModel` mapping: reverse lookup from token to model
   - No longer depends on ModelRegistry for token lookups

3. **Optional Deployment Fee**
   - Platform can charge a deployment fee (currently set to 0)
   - Fee recipient address configurable by owner

## Frontend Implementation

### 1. Connect User Wallet

```javascript
import { ethers } from 'ethers';

// Connect to MetaMask or other wallet
async function connectWallet() {
  if (!window.ethereum) {
    throw new Error('Please install MetaMask');
  }
  
  await window.ethereum.request({ method: 'eth_requestAccounts' });
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();
  
  return { provider, signer };
}
```

### 2. Deploy Token Function

```javascript
// Contract addresses on Sepolia
const TOKEN_MANAGER_ADDRESS = '0x[NEW_ADDRESS_AFTER_DEPLOYMENT]'; // Updated contract with fixed interface

// TokenManager ABI (corrected interface)
const TOKEN_MANAGER_ABI = [
  'function deployToken(string memory modelId, string memory name, string memory symbol, uint256 totalSupply) external payable returns (address)',
  'function modelTokens(string) external view returns (address)',
  'function deploymentFee() external view returns (uint256)',
  'event TokenDeployed(string indexed modelId, address indexed tokenAddress, address indexed deployer, string name, string symbol, uint256 totalSupply)'
];

async function deployToken(modelId, tokenName, tokenSymbol, totalSupply) {
  const { signer } = await connectWallet();
  
  // Create contract instance
  const tokenManager = new ethers.Contract(
    TOKEN_MANAGER_ADDRESS,
    TOKEN_MANAGER_ABI,
    signer
  );
  
  // Check if token already exists
  const existingToken = await tokenManager.modelTokens(modelId);
  if (existingToken !== ethers.ZeroAddress) {
    throw new Error(`Token already deployed at ${existingToken}`);
  }
  
  // Check deployment fee
  const deploymentFee = await tokenManager.deploymentFee();
  
  // Deploy token with correct parameter order (user pays gas)
  const tx = await tokenManager.deployToken(
    modelId,        // string
    tokenName,      // string
    tokenSymbol,    // string
    totalSupply,    // uint256
    { value: deploymentFee }
  );
  
  // Wait for confirmation
  const receipt = await tx.wait();
  
  // Get token address from event
  const event = receipt.logs.find(
    log => log.topics[0] === ethers.id('TokenDeployed(string,address,address,string,string,uint256)')
  );
  
  const tokenAddress = ethers.getAddress('0x' + event.topics[2].slice(26));
  
  return {
    tokenAddress,
    transactionHash: receipt.hash,
    blockNumber: receipt.blockNumber
  };
}
```

### 3. Complete Integration Example

```javascript
// Example React component
function DeployTokenButton({ modelId, modelName }) {
  const [loading, setLoading] = useState(false);
  const [tokenAddress, setTokenAddress] = useState(null);
  const [error, setError] = useState(null);
  
  const handleDeploy = async () => {
    setLoading(true);
    setError(null);
    
    try {
      // Generate token parameters from model
      const tokenName = `${modelName} Token`;
      const tokenSymbol = modelName.substring(0, 3).toUpperCase();
      const totalSupply = ethers.parseEther('1000000'); // 1M tokens default

      // Deploy token
      const result = await deployToken(modelId, tokenName, tokenSymbol, totalSupply);
      
      setTokenAddress(result.tokenAddress);
      
      // Save to your backend
      await fetch('/api/models/token-deployed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          modelId,
          tokenAddress: result.tokenAddress,
          transactionHash: result.transactionHash
        })
      });
      
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };
  
  if (tokenAddress) {
    return (
      <div>
        <p>Token deployed successfully!</p>
        <a 
          href={`https://sepolia.etherscan.io/address/${tokenAddress}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View on Etherscan
        </a>
      </div>
    );
  }
  
  return (
    <div>
      <button onClick={handleDeploy} disabled={loading}>
        {loading ? 'Deploying...' : 'Deploy Token'}
      </button>
      {error && <p style={{ color: 'red' }}>{error}</p>}
    </div>
  );
}
```

## Gas Cost Estimation

```javascript
async function estimateDeploymentCost(modelId, tokenName, tokenSymbol, totalSupply) {
  const { provider, signer } = await connectWallet();
  
  const tokenManager = new ethers.Contract(
    TOKEN_MANAGER_ADDRESS,
    TOKEN_MANAGER_ABI,
    signer
  );
  
  // Get current gas price
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.gasPrice;
  
  // Estimate gas for deployment (typically 2-3M gas units)
  const estimatedGas = await tokenManager.deployToken.estimateGas(
    modelId,
    tokenName,
    tokenSymbol,
    totalSupply,
    { value: deploymentFee }
  );
  
  const totalCostWei = estimatedGas * gasPrice;
  const totalCostEth = ethers.formatEther(totalCostWei);
  
  return {
    estimatedGas: estimatedGas.toString(),
    gasPrice: ethers.formatGwei(gasPrice) + ' Gwei',
    totalCostEth
  };
}
```

## Error Handling

Common errors and how to handle them:

```javascript
try {
  await deployToken(modelId, tokenName, tokenSymbol, totalSupply);
} catch (error) {
  if (error.code === 'ACTION_REJECTED') {
    // User rejected transaction
    console.log('User cancelled transaction');
  } else if (error.message.includes('Token already deployed')) {
    // Token exists
    console.log('This model already has a token');
  } else if (error.message.includes('insufficient funds')) {
    // Not enough ETH
    console.log('Please add ETH to your wallet');
  } else {
    // Other error
    console.error('Deployment failed:', error);
  }
}
```

## Network Configuration

### Sepolia Testnet
- Chain ID: 11155111
- RPC URL: https://ethereum-sepolia-rpc.publicnode.com
- TokenManager: 0x[NEW_ADDRESS_AFTER_DEPLOYMENT] (Fixed interface - deployed [DATE])
- ModelRegistry: 0x1F534d24c0156C3B699632C34bc8C6b77c43DF3f

### Adding Sepolia to MetaMask

```javascript
async function addSepoliaNetwork() {
  await window.ethereum.request({
    method: 'wallet_addEthereumChain',
    params: [{
      chainId: '0xaa36a7', // 11155111 in hex
      chainName: 'Sepolia Testnet',
      nativeCurrency: {
        name: 'SepoliaETH',
        symbol: 'ETH',
        decimals: 18
      },
      rpcUrls: ['https://ethereum-sepolia-rpc.publicnode.com'],
      blockExplorerUrls: ['https://sepolia.etherscan.io']
    }]
  });
}
```

## Testing Checklist

1. **Wallet Connection**
   - [ ] MetaMask connects successfully
   - [ ] Correct network (Sepolia) selected
   - [ ] User has sufficient ETH for gas

2. **Pre-deployment Checks**
   - [ ] Verify model doesn't already have token
   - [ ] Display estimated gas costs
   - [ ] Show clear deployment fee (if any)

3. **Deployment Process**
   - [ ] Transaction submitted successfully
   - [ ] Loading state shown during deployment
   - [ ] Transaction hash displayed/logged
   - [ ] Wait for sufficient confirmations

4. **Post-deployment**
   - [ ] Token address retrieved from event
   - [ ] Token address saved to backend
   - [ ] Etherscan link provided
   - [ ] UI updated to show token deployed

5. **Error Handling**
   - [ ] User rejection handled gracefully
   - [ ] Insufficient funds message clear
   - [ ] Network errors caught and displayed
   - [ ] Duplicate deployment prevented

## Security Considerations

1. **Input Validation**
   - Validate model ID format
   - Sanitize token name and symbol
   - Check for special characters

2. **Transaction Safety**
   - Always show gas estimates before sending
   - Implement transaction timeout handling
   - Add confirmation step for deployment

3. **State Management**
   - Track pending transactions
   - Prevent double-submissions
   - Handle page refreshes gracefully

## Support and Troubleshooting

### Common Issues

1. **"Token already deployed"**
   - Check modelTokens mapping for existing token
   - Display existing token address to user

2. **"Insufficient funds"**
   - Direct user to faucet for testnet ETH
   - Show required amount clearly

3. **Transaction stuck**
   - Provide option to speed up with higher gas
   - Show transaction status from mempool

### Getting Testnet ETH

Direct users to Sepolia faucets:
- https://sepoliafaucet.com
- https://www.alchemy.com/faucets/ethereum-sepolia

## Migration Path

For existing deployments:
1. Deploy updated TokenManager contract
2. Update frontend to use new contract address
3. Migrate existing token mappings if needed
4. Test with small batch before full rollout

## Contact

For technical support or questions about the deployment process, contact the Hokusai development team.