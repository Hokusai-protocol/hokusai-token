# JWT Validation Requirements for Contract Deployer API

## Overview
The Contract Deployer API needs to validate JWT tokens issued by auth.hokus.ai to authorize users to deploy smart contracts.

## Current Architecture
- Users authenticate via the Hokusai website and receive JWT tokens from auth.hokus.ai
- When users initiate contract deployments, the frontend sends the JWT in the Authorization header
- The Contract Deployer API needs to validate these tokens before processing deployments

## Required Auth Service Endpoint

The auth service (auth.hokus.ai) needs to provide a token validation endpoint:

### Endpoint: `POST /api/v1/tokens/validate`

**Request:**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIs...",  // JWT token to validate
  "service": "contract-deployer"         // Optional: identify calling service
}
```

**Response (Success - 200 OK):**
```json
{
  "valid": true,
  "user": {
    "id": "user-uuid",
    "email": "user@example.com",
    "wallet_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb7"
  },
  "permissions": {
    "can_deploy_contracts": true,
    "deployment_limit": 10,        // Optional: daily/monthly limits
    "deployments_used": 3
  },
  "token_expires_at": "2024-12-31T23:59:59Z"
}
```

**Response (Invalid Token - 401 Unauthorized):**
```json
{
  "valid": false,
  "error": "Token expired" // or "Invalid signature", "Token not found", etc.
}
```

## Integration Flow

1. **Frontend Request:**
```javascript
POST https://contracts.hokus.ai/api/deployments
Headers:
  Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
  Content-Type: application/json
Body:
  {
    "modelId": "model-123",
    "tokenName": "My Model Token",
    "tokenSymbol": "MMT"
  }
```

2. **Contract API Validates Token:**
```javascript
// Contract API calls auth service
const response = await fetch('https://auth.hokus.ai/api/v1/tokens/validate', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    token: bearerToken,
    service: 'contract-deployer'
  })
});

const validation = await response.json();
if (!validation.valid) {
  return 401; // Unauthorized
}

// Associate deployment with user
const deployment = {
  userId: validation.user.id,
  walletAddress: validation.user.wallet_address,
  ...deploymentParams
};
```

## Alternative: JWT Self-Validation

If the auth service shares the JWT signing secret, the Contract API could validate tokens locally:

1. Auth service provides JWT public key or shared secret via secure channel
2. Contract API validates JWT signature and expiration locally
3. Contract API still needs to check user permissions (might require auth service call)

**Pros:** Faster, reduces auth service load
**Cons:** Requires key rotation strategy, more complex

## Security Considerations

1. **Token Expiration:** Tokens should have reasonable expiration (e.g., 1 hour)
2. **Rate Limiting:** Implement per-user deployment limits
3. **Audit Trail:** Log all deployment requests with user IDs
4. **Wallet Association:** Ensure deployed contracts are associated with the user's wallet
5. **CORS:** Only accept requests from authorized frontend domains

## Temporary Workaround

Until JWT validation is implemented, the Contract API uses API keys:
- Header: `X-API-Key: test-sepolia-key-2024`
- This should be replaced with proper JWT validation before production

## Next Steps

1. Auth team implements `/api/v1/tokens/validate` endpoint
2. Contract API team updates authentication middleware to call validation endpoint
3. Frontend team ensures JWT tokens are sent in Authorization header
4. Test end-to-end flow on Sepolia testnet
5. Add user association and deployment tracking