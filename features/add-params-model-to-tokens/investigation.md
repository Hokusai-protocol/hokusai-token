# Investigation Results: Add Params Model to Tokens

## Critical Files Requiring Modification

### Core Contracts
1. **`contracts/HokusaiToken.sol`**
   - Current: Uses single controller pattern for mint/burn
   - Change: Add immutable params module pointer in constructor

2. **`contracts/TokenManager.sol`**
   - Current: Manages token deployment and minting operations
   - Change: Deploy params module alongside token, read params for operations

3. **`contracts/DeltaVerifier.sol`**
   - Current: Stores baseRewardRate, minImprovementBps, maxReward as state
   - Change: Read tokensPerDeltaOne from params module

### New Contracts to Create
1. **`contracts/HokusaiParams.sol`** - New params module contract
2. **`contracts/interfaces/IHokusaiParams.sol`** - Interface for params module

## Key Architecture Patterns Discovered

### Controller Pattern
- HokusaiToken uses single controller (TokenManager) for all mint/burn operations
- Controller address stored as immutable in token contract
- Clean separation between token logic and management logic

### Access Control Patterns
- Mix of OpenZeppelin Ownable (older contracts) and AccessControl (newer contracts)
- TokenManager uses Ownable2Step for admin operations
- Some contracts use role-based access control

### Parameter Storage (Current State)
- Parameters scattered across multiple contracts:
  - DeltaVerifier: baseRewardRate, minImprovementBps, maxReward
  - TokenManager: deploymentFee, feeRecipient
  - HokusaiToken: No adjustable parameters (good for immutability)
- No centralized parameter management system exists

### Registry Pattern
- ModelRegistry provides bidirectional mapping (modelId ↔ tokenAddress)
- Single source of truth for model-token associations
- Prevents duplicate registrations

## Current Implementation Details

### Token Deployment Flow
1. TokenManager.deployToken() creates new HokusaiToken
2. Sets TokenManager as controller during deployment
3. Registers token in ModelRegistry
4. Emits events for tracking

### Minting Flow
1. DeltaVerifier calculates rewards based on performance metrics
2. TokenManager.mintTokens() called with modelId and recipients
3. TokenManager resolves token address via ModelRegistry
4. Mints tokens through controller privilege

### Test Coverage
- Comprehensive test files exist for all major contracts
- Tests use Hardhat framework with ethers.js
- Good coverage of edge cases and security scenarios

## Implementation Requirements

### Phase 1: Core Infrastructure
1. Create IHokusaiParams interface
2. Implement HokusaiParams contract with AccessControl
3. Add params pointer to HokusaiToken constructor

### Phase 2: Integration
1. Update TokenManager to deploy params module
2. Modify DeltaVerifier to read from params
3. Update deployment scripts

### Phase 3: Testing & Documentation
1. Add comprehensive test coverage
2. Update deployment documentation
3. Add migration guide for existing tokens

## Files to Modify

### Smart Contracts
- `contracts/HokusaiToken.sol` - Add params pointer
- `contracts/TokenManager.sol` - Deploy and manage params
- `contracts/DeltaVerifier.sol` - Read from params
- `contracts/ModelRegistry.sol` - Optionally track params addresses

### Tests
- `test/HokusaiToken.test.js` - Test params integration
- `test/TokenManager.test.js` - Test params deployment
- `test/DeltaVerifier.test.js` - Test params reading
- Create new `test/HokusaiParams.test.js`

### Deployment Scripts
- `scripts/deploy.js` - Include params deployment
- `scripts/deploy-token.js` - Deploy params with token

## Security Considerations
1. Params module must have proper access control
2. Consider timelock for governance operations
3. Emit events for all parameter changes
4. Validate parameter bounds to prevent extreme values