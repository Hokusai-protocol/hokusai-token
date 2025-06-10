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

#### ModelRegistry
- Maps model IDs to their corresponding token addresses
- Admin-controlled registration of new models
- Provides lookup functionality for other contracts

#### TokenManager
- Acts as the controller for HokusaiToken instances
- Integrates with ModelRegistry to validate model-token mappings
- Handles minting tokens to contributors based on model performance

#### BurnAuction
- Allows users to burn tokens in exchange for model access
- References HokusaiToken contracts for burn operations

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
   - User interacts with BurnAuction
   - BurnAuction calls TokenManager to burn user's tokens
   - Tokens are removed from circulation

## Security Features

- **Access Control**: Only the controller can mint/burn tokens
- **Zero Address Protection**: Cannot set controller to zero address
- **Owner-Only Administration**: Critical functions restricted to contract owner
- **Event Logging**: All major operations emit events for transparency