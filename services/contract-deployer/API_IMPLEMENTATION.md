# Contract Deployment API Implementation

This document describes the implementation of the POST `/api/deployments` and GET `/api/deployments/:id/status` endpoints for the Hokusai contract deployment service.

## Overview

The API provides endpoints for creating and monitoring smart contract deployments for ML models. The implementation includes:

- **Authentication**: Simple API key authentication (temporary, JWT coming later)
- **Validation**: Comprehensive request validation using Joi schemas
- **Background Processing**: Asynchronous deployment using Redis queues
- **Status Tracking**: Real-time deployment status in Redis
- **Error Handling**: Structured error responses with proper HTTP status codes

## Architecture

### Components

1. **Authentication Middleware** (`src/middleware/auth.ts`)
   - API key validation
   - User extraction from tokens
   - Address validation

2. **Deployment Service** (`src/services/deployment.service.ts`)
   - Orchestrates deployment process
   - Manages deployment status in Redis
   - Integrates with ContractDeployer

3. **Deployment Routes** (`src/routes/deployments.ts`)
   - POST `/api/deployments` - Create deployment
   - GET `/api/deployments/:id/status` - Get status

4. **Background Processor** (`src/services/deployment-processor.ts`)
   - Processes deployment queue
   - Handles deployment lifecycle

## API Endpoints

### POST `/api/deployments`

Creates a new token deployment request.

**Authentication**: Required (API key or JWT)

**Request Body**:
```json
{
  "token": "jwt-token-or-ignored-for-api-key",
  "modelId": "sentiment-analysis-v1",
  "userAddress": "0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9",
  "tokenName": "Sentiment Analysis Token",
  "tokenSymbol": "SAT",
  "initialSupply": "1000000",
  "metadata": {
    "description": "Token for sentiment analysis model",
    "website": "https://example.com",
    "tags": {
      "model-type": "nlp"
    }
  }
}
```

**Response** (202 Accepted):
```json
{
  "success": true,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "pending",
    "estimatedCompletionTime": 300,
    "message": "Deployment request queued successfully",
    "links": {
      "status": "/api/deployments/550e8400-e29b-41d4-a716-446655440000/status",
      "cancel": "/api/deployments/550e8400-e29b-41d4-a716-446655440000/cancel"
    }
  },
  "meta": {
    "requestId": "req_1234567890",
    "timestamp": "2024-01-15T10:00:00Z",
    "version": "1.0"
  }
}
```

### GET `/api/deployments/:id/status`

Retrieves the current status of a deployment.

**Authentication**: Required (API key or JWT)

**Response** (200 OK):
```json
{
  "success": true,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "deployed",
    "progress": 100,
    "currentStep": "Deployment completed",
    "lastUpdated": "2024-01-15T10:05:00Z",
    "tokenDetails": {
      "tokenAddress": "0x1234567890123456789012345678901234567890",
      "tokenName": "Sentiment Analysis Token",
      "tokenSymbol": "SAT",
      "transactionHash": "0xabcdef...",
      "registryTransactionHash": "0xfedcba...",
      "blockNumber": 19123456,
      "gasUsed": "2500000",
      "gasPrice": "20000000000",
      "deploymentTime": "2024-01-15T10:05:00Z",
      "network": "ethereum"
    }
  },
  "meta": {
    "requestId": "req_1234567890",
    "timestamp": "2024-01-15T10:00:00Z",
    "version": "1.0"
  }
}
```

## Authentication

### API Key Authentication (Current)

Add `X-API-Key` header:
```
X-API-Key: your-api-key-here
```

Configure valid API keys in environment:
```env
VALID_API_KEYS=dev-key-1,dev-key-2,admin-key
```

### JWT Authentication (Future)

Add `Authorization` header:
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

## Status Flow

Deployments go through the following states:

1. **pending** - Request received and queued
2. **processing** - Contract deployment in progress
3. **deployed** - Successfully deployed
4. **failed** - Deployment failed

## Error Handling

All errors follow a consistent format:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": "Model ID is required",
    "timestamp": "2024-01-15T10:00:00Z",
    "retryable": false,
    "suggestions": [
      "Check the request format and required fields"
    ]
  }
}
```

### Common Error Codes

- `INVALID_TOKEN` (401) - Authentication failed
- `VALIDATION_ERROR` (400) - Request validation failed
- `TOKEN_ALREADY_EXISTS` (409) - Token already deployed for model
- `DEPLOYMENT_NOT_FOUND` (404) - Deployment ID not found
- `RATE_LIMIT_EXCEEDED` (429) - Too many requests
- `INTERNAL_ERROR` (500) - System error

## Configuration

### Required Environment Variables

```env
# Application
NODE_ENV=development
PORT=3001

# Blockchain
RPC_URL=https://ethereum-rpc-url.com
CHAIN_ID=1
NETWORK_NAME=mainnet
MODEL_REGISTRY_ADDRESS=0x1234567890123456789012345678901234567890
TOKEN_MANAGER_ADDRESS=0x0987654321098765432109876543210987654321
DEPLOYER_PRIVATE_KEY=0x1234567890abcdef...

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Authentication
VALID_API_KEYS=dev-key-1,dev-key-2,admin-key

# Gas Settings
GAS_PRICE_MULTIPLIER=1.2
MAX_GAS_PRICE_GWEI=100
CONFIRMATION_BLOCKS=3
```

## Usage Examples

### Deploy a Token

```bash
curl -X POST http://localhost:3001/api/deployments \
  -H "Content-Type: application/json" \
  -H "X-API-Key: dev-key-1" \
  -d '{
    "token": "ignored-for-api-key",
    "modelId": "sentiment-analysis-v1",
    "userAddress": "0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9",
    "tokenName": "Sentiment Analysis Token",
    "tokenSymbol": "SAT"
  }'
```

### Check Deployment Status

```bash
curl -X GET http://localhost:3001/api/deployments/550e8400-e29b-41d4-a716-446655440000/status \
  -H "X-API-Key: dev-key-1"
```

## Running the Service

### Development

```bash
npm run dev:api
```

### Production

```bash
npm run build
npm run start:api
```

### With Docker

```bash
docker build -t hokusai-contract-deployer .
docker run -p 3001:3001 --env-file .env hokusai-contract-deployer
```

## Testing

The implementation includes comprehensive tests:

```bash
# Run all tests
npm test

# Run API tests only
npm test tests/api/deployments.test.ts

# Run with coverage
npm run test:coverage
```

## Redis Data Structure

### Deployment Status
```
Key: deployment:status:{requestId}
TTL: 86400 seconds (24 hours)
Value: JSON deployment status object
```

### Model Mapping
```
Key: model:deployment:{modelId}
TTL: 86400 seconds
Value: requestId
```

### User Deployments
```
Key: user:deployments:{userId}
Value: Set of requestIds
```

## Future Enhancements

1. **JWT Authentication**: Replace API key auth with proper JWT validation
2. **Rate Limiting**: Per-user rate limiting
3. **Webhook Notifications**: Deploy completion webhooks
4. **Deployment Cancellation**: Cancel pending deployments
5. **Deployment History**: List user's past deployments
6. **Real-time Updates**: WebSocket status updates
7. **Multi-network Support**: Deploy to different blockchains
8. **Gas Optimization**: Dynamic gas price estimation

## Security Considerations

- API keys should be rotated regularly
- Private keys must be stored securely (use vault in production)
- Input validation prevents injection attacks
- Rate limiting prevents abuse
- CORS configured for allowed origins only
- Request logging for audit trails

## Monitoring

- Health checks available at `/health`
- Structured logging with correlation IDs
- Error tracking and alerting
- Deployment metrics and analytics