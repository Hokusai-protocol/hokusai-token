import { ethers } from 'ethers';
import * as dotenv from 'dotenv';

// Load the Sepolia environment
dotenv.config({ path: '.env.sepolia' });

async function checkWallet() {
  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;

  if (!rpcUrl || !privateKey) {
    console.error('❌ Missing RPC_URL or DEPLOYER_PRIVATE_KEY in .env.sepolia');
    process.exit(1);
  }

  try {
    // Connect to Sepolia
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    console.log('🔍 Checking Sepolia wallet...\n');
    console.log('📍 Wallet Address:', wallet.address);
    
    // Check network
    const network = await provider.getNetwork();
    console.log('🌐 Network:', network.name, `(Chain ID: ${network.chainId})`);
    
    // Check balance
    const balance = await provider.getBalance(wallet.address);
    const balanceInEth = ethers.formatEther(balance);
    console.log('💰 Balance:', balanceInEth, 'ETH');
    
    // Check if balance is sufficient
    const minRequired = ethers.parseEther('0.1');
    if (balance < minRequired) {
      console.log('\n⚠️  WARNING: Balance is low for deployment!');
      console.log('   Minimum recommended: 0.1 ETH');
      console.log('   Get Sepolia ETH from: https://sepoliafaucet.com/');
    } else {
      console.log('\n✅ Balance is sufficient for deployment');
    }
    
    // Check gas price
    const feeData = await provider.getFeeData();
    if (feeData.gasPrice) {
      console.log('⛽ Current gas price:', ethers.formatUnits(feeData.gasPrice, 'gwei'), 'Gwei');
    }
    
    // Estimate deployment cost
    const estimatedGasPerContract = 2000000n; // Rough estimate
    const numContracts = 4n; // ModelRegistry, HokusaiToken, TokenManager, BurnAuction
    const totalGas = estimatedGasPerContract * numContracts;
    const estimatedCost = totalGas * (feeData.gasPrice || 20000000000n); // Use 20 Gwei as fallback
    console.log('💸 Estimated deployment cost:', ethers.formatEther(estimatedCost), 'ETH');
    
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

checkWallet();