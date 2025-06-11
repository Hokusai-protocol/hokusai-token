# Hokusai Token Loop

Prototype for a model-linked ERC20 token with controlled mint/burn logic.

## Overview

The Hokusai Token system implements a token ecosystem where ERC20 tokens are linked to ML models. Each model has its own token that can only be minted or burned by an authorized controller contract (TokenManager).

## Architecture

### Core Contracts

#### HokusaiToken
- Standard ERC20 token with controller-based access control
- Only the designated controller can mint and burn tokens
- Metadata: "Hokusai Token" (HOKU), 18 decimals
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

#### AuctionBurner
- Minimal contract for burning tokens to simulate model/API access consumption
- Users burn tokens through a clean interface with proper validation
- Maintains reference to a single HokusaiToken contract
- Provides foundation for future auction-based access mechanisms

## Development

### Prerequisites
- Node.js (v18+ recommended)
- Hardhat development environment

### Installation
```bash
npm install
```

### Testing
```bash
npm test
```

### Deployment
```bash
npx hardhat run scripts/deploy.js --network localhost
```

## Contract Interactions

1. **Token Minting Flow**:
   - TokenManager receives mint request with model ID
   - Looks up token address from ModelRegistry
   - Mints tokens to recipient address

2. **Token Burning Flow**:
   - User interacts with AuctionBurner contract
   - User approves AuctionBurner to spend their tokens
   - AuctionBurner transfers tokens and burns them
   - Tokens are removed from circulation

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

## AuctionBurner API

### Core Functions

#### burn(uint256 amount)
Burns tokens from the caller's balance to simulate model access consumption.
```solidity
function burn(uint256 amount) external
```

**Requirements:**
- `amount` must be greater than zero
- Caller must have sufficient token balance
- Caller must have approved this contract to spend their tokens

#### setToken(address _token)
Updates the token contract reference (admin only).
```solidity
function setToken(address _token) external onlyOwner
```

### Usage Examples

```javascript
// Deploy AuctionBurner with token reference
const auctionBurner = await AuctionBurner.deploy(tokenAddress);

// User approves tokens for burning
await token.connect(user).approve(auctionBurnerAddress, burnAmount);

// User burns tokens to access model
await auctionBurner.connect(user).burn(burnAmount);

// Admin updates token reference
await auctionBurner.setToken(newTokenAddress);
```

### AuctionBurner Events

#### TokensBurned
```solidity
event TokensBurned(address indexed user, uint256 amount);
```
Emitted when tokens are burned by a user.
- `user`: The address that initiated the burn (indexed for filtering)
- `amount`: The number of tokens burned

#### TokenContractUpdated
```solidity
event TokenContractUpdated(address indexed newToken);
```
Emitted when the token contract reference is updated.
- `newToken`: The new token contract address (indexed for filtering)