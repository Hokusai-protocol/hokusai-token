import * as dotenv from 'dotenv';

dotenv.config({ path: '.env.sepolia' });

const API_BASE_URL = 'https://contracts.hokus.ai';
const API_KEY = 'hk_live_A6RDj8Mlmex33o7G7dJtNEO9uYBOGmiT'; // From the deployed service config

interface DeploymentRequest {
  token: string; // JWT token
  modelId: string;
  userAddress: string;
  tokenName?: string;
  tokenSymbol?: string;
  initialSupply?: string;
  metadata?: {
    description?: string;
    website?: string;
    whitepaper?: string;
    tags?: Record<string, string>;
  };
}

async function testDeployment() {
  try {
    console.log('🚀 Testing Token Deployment via API\n');
    
    // Generate a test JWT token (in production, this would come from auth service)
    // For testing, we'll use a dummy token
    const jwtToken = 'test-jwt-token'; // This will likely fail auth, but let's see the response
    
    const deploymentRequest: DeploymentRequest = {
      token: jwtToken,
      modelId: `api-test-model-${Date.now()}`,
      userAddress: '0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B', // Our deployer address
      tokenName: 'API Test Token',
      tokenSymbol: 'ATT',
      initialSupply: '1000000000000000000000', // 1000 tokens
      metadata: {
        description: 'Token deployed via API test',
        website: 'https://hokus.ai',
        tags: {
          environment: 'sepolia',
          type: 'test'
        }
      }
    };

    console.log('📋 Deployment Request:');
    console.log(JSON.stringify(deploymentRequest, null, 2));
    console.log('');

    // Send deployment request
    console.log('📤 Sending request to:', `${API_BASE_URL}/api/deployments`);
    
    const response = await fetch(`${API_BASE_URL}/api/deployments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
        'Accept': 'application/json'
      },
      body: JSON.stringify(deploymentRequest)
    });

    const responseData: any = await response.json();

    console.log('\n📥 Response:');
    console.log('Status:', response.status, response.statusText);
    console.log('Body:', JSON.stringify(responseData, null, 2));

    if (response.status === 202 && responseData?.success) {
      const { requestId, status, links } = responseData.data;
      console.log('\n✅ Deployment initiated successfully!');
      console.log('Request ID:', requestId);
      console.log('Status:', status);
      console.log('Check status at:', `${API_BASE_URL}${links.status}`);
      
      // Poll for status
      await pollDeploymentStatus(requestId, API_KEY);
    } else {
      console.log('\n❌ Deployment request failed');
      if (responseData.error) {
        console.log('Error:', responseData.error);
      }
    }

  } catch (error) {
    console.error('\n❌ Error:', error);
  }
}

async function pollDeploymentStatus(requestId: string, apiKey: string) {
  console.log('\n⏳ Polling deployment status...');
  
  const statusUrl = `${API_BASE_URL}/api/deployments/${requestId}/status`;
  let attempts = 0;
  const maxAttempts = 30; // Poll for up to 5 minutes (30 * 10 seconds)
  
  while (attempts < maxAttempts) {
    attempts++;
    
    try {
      const response = await fetch(statusUrl, {
        headers: {
          'X-API-Key': apiKey,
          'Accept': 'application/json'
        }
      });
      
      const responseData: any = await response.json();
      
      if (response.status === 200 && responseData?.success) {
        const status = responseData.data;
        console.log(`[${new Date().toISOString()}] Status: ${status.status} - ${status.message}`);
        
        if (status.status === 'deployed') {
          console.log('\n🎉 Token deployed successfully!');
          console.log('Token Details:');
          console.log(JSON.stringify(status.tokenDetails, null, 2));
          
          console.log('\n📊 View on Sepolia Etherscan:');
          console.log(`https://sepolia.etherscan.io/token/${status.tokenDetails.tokenAddress}`);
          console.log(`https://sepolia.etherscan.io/tx/${status.tokenDetails.transactionHash}`);
          break;
        } else if (status.status === 'failed') {
          console.log('\n❌ Deployment failed:', status.message);
          if (status.error) {
            console.log('Error details:', status.error);
          }
          break;
        }
        
        // Wait 10 seconds before next poll
        await new Promise(resolve => setTimeout(resolve, 10000));
      } else {
        console.log('Failed to get status:', response.status, responseData);
        break;
      }
    } catch (error) {
      console.error('Error polling status:', error);
      break;
    }
  }
  
  if (attempts >= maxAttempts) {
    console.log('\n⚠️  Timeout: Deployment is still processing. Check status manually.');
  }
}

// Test the API
console.log('='.repeat(60));
console.log('Contract Deployment API Test');
console.log('='.repeat(60));
console.log('');
console.log('API Endpoint:', API_BASE_URL);
console.log('API Key:', API_KEY.substring(0, 10) + '...');
console.log('');

testDeployment();