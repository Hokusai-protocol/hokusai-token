import { ethers } from 'ethers';

async function checkKeys() {
  // The private key currently in SSM
  const currentSSMKey = '0x17c32d32fd7615ec65760d6f39e3047870791f793fe80d497569e8dc7273221a';
  
  // The address you want to use
  const targetAddress = '0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B';
  
  try {
    // Check what address the current SSM key generates
    const wallet1 = new ethers.Wallet(currentSSMKey);
    console.log('Current SSM Private Key:', currentSSMKey);
    console.log('Generates Address:', wallet1.address);
    console.log('');
    
    console.log('Target Address:', targetAddress);
    console.log('');
    
    if (wallet1.address.toLowerCase() === targetAddress.toLowerCase()) {
      console.log('✅ The SSM key matches the target address!');
    } else {
      console.log('❌ The SSM key does NOT match the target address');
      console.log('');
      console.log('🔍 Searching for the private key...');
      console.log('');
      console.log('Possible locations to check:');
      console.log('1. AWS Secrets Manager (not just SSM)');
      console.log('2. Previous deployment logs in CloudWatch');
      console.log('3. Local .env files in other Hokusai repos');
      console.log('4. Team password manager or secure notes');
      console.log('5. Check with team member who created the wallet 2 days ago');
    }
    
  } catch (error) {
    console.error('Error:', error);
  }
}

checkKeys();