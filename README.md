# Hokusai Token Loop

Prototype for a model-linked ERC20 token with controlled mint/burn logic.

## Overview

The Hokusai Token system implements a token ecosystem where ERC20 tokens are linked to ML models. Each model has its own token that can only be minted or burned by an authorized controller contract (TokenManager).

The system includes:
- Smart contracts for token management and model registry
- Automated contract deployment service that listens to ML model validation events
- Event-driven architecture for seamless integration with the Hokusai ML Platform

## Architecture

### Core Contracts

#### HokusaiToken
- Standard ERC20 token with controller-based access control
- Only the designated controller can mint and burn tokens
- Dynamic constructor accepts custom name, symbol, and controller address
- Implements OpenZeppelin's ERC20 and Ownable patterns
- Emits custom Minted and Burned events for enhanced observability

#### ModelRegistry
- Maps uint256 model IDs to their corresponding token addresses
- Provides reverse lookup functionality (token address → model ID)
- Admin-controlled registration of new models with manual or auto-incremented IDs
- Prevents duplicate model or token registrations
- Provides lookup functionality for other contracts

#### TokenManager
- Acts as the controller for HokusaiToken instances
- Integrates with ModelRegistry to validate model-token mappings
- Handles minting tokens to contributors based on model performance

#### DeltaVerifier
- Processes off-chain ML model performance metrics to calculate token rewards
- Calculates DeltaOne scores based on performance improvements across multiple metrics
- Validates evaluation data and enforces minimum improvement thresholds
- Integrates with TokenManager to trigger automatic reward distribution
- Includes rate limiting and pause functionality for security

### Backend Services

#### Contract Deploy Listener
- Monitors Redis queue for `model_ready_to_deploy` events from the ML Platform
- Automatically deploys HokusaiToken contracts for validated models
- Registers deployed tokens in the ModelRegistry
- Publishes `token_deployed` events for downstream services
- Implements reliable message processing with retry logic and dead letter queue
- See `/services/contract-deployer` for implementation details

#### Contract Deployment API
- RESTful API for frontend-initiated token deployments
- **POST /api/deployments** - Create new token deployment request
- **GET /api/deployments/:id/status** - Check deployment status
- Authentication via API key (JWT support planned)
- Rate limiting: 5 deployments per user per hour
- Comprehensive error handling and validation
- See API documentation below for detailed usage

## Development

### Prerequisites
- Node.js (v18+ recommended)
- Hardhat development environment

### Installation
```bash
# Install smart contract dependencies
npm install

# Install contract deployer service dependencies
cd services/contract-deployer
npm install
```

### Testing
```bash
# Test smart contracts
npm test

# Test contract deployer service
cd services/contract-deployer
npm test
```

### Running Services

#### Contract Deploy Listener
```bash
cd services/contract-deployer
npm run dev  # Development mode with hot reload
npm start    # Production mode
```

#### Contract Deployment API
```bash
cd services/contract-deployer
npm run dev:api  # Development mode with hot reload
npm run start:api # Production mode
```

### Deployment
```bash
# Deploy smart contracts
npx hardhat run scripts/deploy.js --network localhost

# Deploy contract listener (Docker)
cd services/contract-deployer
docker-compose up -d
```

## Contract Interactions

1. **Automated Token Deployment Flow**:
   - ML Platform validates model and emits `model_ready_to_deploy` message
   - Contract Deploy Listener consumes message from Redis queue
   - Deploys new HokusaiToken contract with model metadata
   - Registers token in ModelRegistry
   - Publishes `token_deployed` event for website/UI updates

2. **Token Minting Flow**:
   - DeltaVerifier receives evaluation data showing performance improvement
   - TokenManager receives mint request with model ID
   - Looks up token address from ModelRegistry
   - Mints tokens to contributor address based on improvement

3. **Token Burning Flow**:
   - Tokens will be burned through integrated AMM mechanism
   - A portion of API fees will be applied to AMM reserves
   - Automated market making provides liquidity and price discovery

## Security Features

- **Access Control**: Only the controller can mint/burn tokens
- **Zero Address Protection**: Cannot set controller to zero address
- **Owner-Only Administration**: Critical functions restricted to contract owner
- **Event Logging**: All major operations emit events for transparency

## ModelRegistry API

### Core Functions

#### registerModel(uint256 modelId, address token)
Registers a new model with a specific ID and token address.
```solidity
function registerModel(uint256 modelId, address token) external onlyOwner
```

#### registerModelAutoId(address token)
Registers a new model with an auto-incremented ID.
```solidity
function registerModelAutoId(address token) external onlyOwner returns (uint256)
```

#### getToken(uint256 modelId)
Gets the token address for a model ID.
```solidity
function getToken(uint256 modelId) external view returns (address)
```

#### getTokenAddress(uint256 modelId)
Alternative function name for getting token address.
```solidity
function getTokenAddress(uint256 modelId) external view returns (address)
```

#### getModelId(address tokenAddress)
Reverse lookup: gets the model ID for a token address.
```solidity
function getModelId(address tokenAddress) external view returns (uint256)
```

#### isRegistered(uint256 modelId)
Checks if a model is registered.
```solidity
function isRegistered(uint256 modelId) external view returns (bool)
```

#### exists(uint256 modelId)
Alias for isRegistered.
```solidity
function exists(uint256 modelId) external view returns (bool)
```

### Usage Examples

```javascript
// Register a model with specific ID
await modelRegistry.registerModel(123, tokenAddress);

// Register a model with auto-incremented ID
const modelId = await modelRegistry.registerModelAutoId(tokenAddress);

// Look up token address
const tokenAddr = await modelRegistry.getToken(123);

// Reverse lookup model ID
const modelId = await modelRegistry.getModelId(tokenAddress);

// Check if model exists
const exists = await modelRegistry.exists(123);
```

## Event Specifications

### ModelRegistry Events

#### ModelRegistered
```solidity
event ModelRegistered(uint256 indexed modelId, address indexed tokenAddress);
```
Emitted when a new model is registered.
- `modelId`: The model identifier (indexed for filtering)
- `tokenAddress`: The token contract address (indexed for filtering)

#### ModelUpdated
```solidity
event ModelUpdated(uint256 indexed modelId, address indexed newTokenAddress);
```
Emitted when a model's token address is updated.
- `modelId`: The model identifier (indexed for filtering)  
- `newTokenAddress`: The new token contract address (indexed for filtering)

### HokusaiToken Events

#### Minted
```solidity
event Minted(address indexed to, uint256 amount);
```
Emitted when tokens are minted to an address.
- `to`: The recipient address (indexed for filtering)
- `amount`: The number of tokens minted

#### Burned
```solidity
event Burned(address indexed from, uint256 amount);
```
Emitted when tokens are burned from an address.
- `from`: The address from which tokens were burned (indexed for filtering)
- `amount`: The number of tokens burned

#### ControllerUpdated
```solidity
event ControllerUpdated(address indexed newController);
```
Emitted when the controller address is updated.
- `newController`: The new controller address (indexed for filtering)

### Event Filtering Examples

```javascript
// Listen for all minting events
const filter = token.filters.Minted();
token.on(filter, (to, amount, event) => {
  console.log(`Minted ${amount} tokens to ${to}`);
});

// Listen for burns from a specific address
const burnFilter = token.filters.Burned(userAddress);
token.on(burnFilter, (from, amount, event) => {
  console.log(`Burned ${amount} tokens from ${from}`);
});
```

## DeltaVerifier API

### Core Functions

#### submitEvaluation(uint256 modelId, EvaluationData calldata data)
Submits ML model evaluation data for reward calculation.
```solidity
function submitEvaluation(
    uint256 modelId,
    EvaluationData calldata data
) external returns (uint256 rewardAmount)
```

**Parameters:**
- `modelId`: The model identifier from ModelRegistry
- `data`: Evaluation data containing metrics and contributor info

**Returns:**
- `rewardAmount`: The calculated token reward amount

#### calculateDeltaOne(Metrics memory baseline, Metrics memory newMetrics)
Calculates the DeltaOne score (average percentage improvement).
```solidity
function calculateDeltaOne(
    Metrics memory baseline,
    Metrics memory newMetrics
) public pure returns (uint256)
```

**Returns:**
- Delta score in basis points (100 = 1%)

#### calculateReward(uint256 deltaInBps, uint256 contributorWeight, uint256 contributedSamples)
Calculates token reward based on performance improvement.
```solidity
function calculateReward(
    uint256 deltaInBps,
    uint256 contributorWeight,
    uint256 contributedSamples
) public view returns (uint256)
```

### Data Structures

```solidity
struct Metrics {
    uint256 accuracy;    // In basis points (10000 = 100%)
    uint256 precision;   // In basis points
    uint256 recall;      // In basis points
    uint256 f1;         // In basis points
    uint256 auroc;      // In basis points
}

struct EvaluationData {
    string pipelineRunId;
    Metrics baselineMetrics;
    Metrics newMetrics;
    address contributor;
    uint256 contributorWeight;  // In basis points (10000 = 100%)
    uint256 contributedSamples;
    uint256 totalSamples;
}
```

### Usage Example

```javascript
// Prepare evaluation data
const evaluationData = {
  pipelineRunId: "run_123",
  baselineMetrics: {
    accuracy: 8540,   // 85.4%
    precision: 8270,  // 82.7%
    recall: 8870,     // 88.7%
    f1: 8390,        // 83.9%
    auroc: 9040      // 90.4%
  },
  newMetrics: {
    accuracy: 8840,   // 88.4%
    precision: 8540,  // 85.4%
    recall: 9130,     // 91.3%
    f1: 8910,        // 89.1%
    auroc: 9350      // 93.5%
  },
  contributor: "0x...",
  contributorWeight: 9100,  // 91%
  contributedSamples: 5000,
  totalSamples: 55000
};

// Submit evaluation
const reward = await deltaVerifier.submitEvaluation(modelId, evaluationData);
```

### DeltaVerifier Events

#### EvaluationSubmitted
```solidity
event EvaluationSubmitted(
    uint256 indexed modelId,
    address indexed contributor,
    uint256 deltaOneScore,
    uint256 rewardAmount
);
```

#### RewardCalculated
```solidity
event RewardCalculated(
    address indexed contributor,
    uint256 deltaInBps,
    uint256 rewardAmount
);
```

## API Documentation

### Contract Deployment API

The Contract Deployment API enables the Vercel frontend to trigger ERC20 token deployments for validated ML models.

#### Authentication

All API endpoints require authentication via API key in the header:
```
X-API-Key: <your-api-key>
```

#### Endpoints

##### POST /api/deployments

Create a new token deployment request.

**Request:**
```json
{
  "modelId": "sentiment-analysis-v1",
  "userAddress": "0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9",
  "tokenName": "Sentiment Token",     // Optional
  "tokenSymbol": "SENT"               // Optional
}
```

**Response (202 Accepted):**
```json
{
  "success": true,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "modelId": "sentiment-analysis-v1",
    "status": "pending",
    "statusUrl": "/api/deployments/550e8400-e29b-41d4-a716-446655440000/status",
    "estimatedConfirmationTime": 120
  }
}
```

##### GET /api/deployments/:id/status

Check the status of a deployment request.

**Response (200 OK):**
```json
{
  "success": true,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "status": "deployed",
    "modelId": "sentiment-analysis-v1",
    "tokenAddress": "0x1234567890abcdef1234567890abcdef12345678",
    "tokenName": "Sentiment Token",
    "tokenSymbol": "SENT",
    "deploymentTxHash": "0xabcd...",
    "registryTxHash": "0xefgh...",
    "blockNumber": 12345678,
    "explorerUrl": "https://etherscan.io/tx/0xabcd...",
    "gasUsed": "500000",
    "gasPrice": "30000000000",
    "totalCost": "0.015"
  }
}
```

#### Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "code": "MODEL_NOT_FOUND",
    "message": "Model with ID 'xyz' not found",
    "details": {},
    "timestamp": "2024-01-15T10:30:00Z",
    "correlationId": "req_123456"
  }
}
```

#### Error Codes

- `AUTH_FAILED` - Authentication failure
- `MODEL_NOT_FOUND` - Model doesn't exist
- `MODEL_NOT_VALIDATED` - Model not yet validated
- `TOKEN_EXISTS` - Token already deployed for model
- `INSUFFICIENT_GAS` - Gas price exceeds limits
- `DEPLOYMENT_FAILED` - Blockchain transaction failed
- `RATE_LIMIT_EXCEEDED` - Too many requests

#### Rate Limiting

- 5 deployments per hour per user
- 20 deployments per day per user
- Rate limit headers included in responses

#### Example Usage

```bash
# Deploy a token
curl -X POST http://localhost:3001/api/deployments \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-api-key" \
  -d '{
    "modelId": "model-123",
    "userAddress": "0x742d35cc6631c0532925a3b8d756d2be8b6c6dd9",
    "tokenName": "My Model Token"
  }'

# Check deployment status
curl -X GET http://localhost:3001/api/deployments/550e8400-e29b-41d4-a716-446655440000/status \
  -H "X-API-Key: your-api-key"
```
