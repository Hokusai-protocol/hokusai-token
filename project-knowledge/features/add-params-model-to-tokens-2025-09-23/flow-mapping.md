# Flow Mapping: Token System with Params Module Integration

## Current Token Deployment Flow

### Sequence: User Deploys New Token
```
User → TokenManager.deployToken(modelId, name, symbol)
    ├── Check deployment fee (0.01 ETH)
    ├── Create new HokusaiToken(name, symbol, TokenManager)
    │   └── Set TokenManager as controller
    ├── Register in ModelRegistry(modelId → tokenAddress)
    ├── Transfer fee to feeRecipient
    └── Emit TokenDeployed event
```

### Key Components
- **TokenManager**: Orchestrates deployment, owns tokens
- **HokusaiToken**: ERC20 with controller-based mint/burn
- **ModelRegistry**: Maintains model-token mappings

## Current Token Minting Flow

### Sequence: Delta Performance Triggers Minting
```
External → DeltaVerifier.submitPerformance(modelId, deltaOne, contributors, weights)
    ├── Validate performance improvement > minImprovementBps
    ├── Calculate rewards: baseRewardRate × deltaOne × weight
    ├── Call TokenManager.mintTokens(modelId, recipients, amounts)
    │   ├── Resolve token via ModelRegistry
    │   └── HokusaiToken.mint(recipient, amount) [controller only]
    ├── Update lastSubmissionTime (rate limiting)
    └── Emit PerformanceSubmitted event
```

### Parameters Currently Hardcoded
- `baseRewardRate`: 1000 tokens per unit
- `minImprovementBps`: 100 (1% minimum improvement)
- `maxReward`: 1,000,000 tokens per submission

## Proposed Params Module Integration

### New Deployment Flow with Params
```
User → TokenManager.deployToken(modelId, name, symbol, initialParams)
    ├── Deploy HokusaiParams(governance, initialParams)
    │   ├── tokensPerDeltaOne: 1000
    │   ├── infraMarkupBps: 250 (2.5%)
    │   └── licenseRef: hash + URI
    ├── Deploy HokusaiToken(name, symbol, controller, paramsAddress)
    │   └── Store immutable params pointer
    ├── Register in ModelRegistry
    │   ├── modelId → tokenAddress
    │   └── modelId → paramsAddress (optional)
    └── Emit TokenDeployed + ParamsDeployed events
```

### Modified Minting Flow with Params
```
External → DeltaVerifier.submitPerformance(modelId, deltaOne, contributors, weights)
    ├── Get token address from ModelRegistry
    ├── Read params: HokusaiToken(token).params()
    ├── Get tokensPerDeltaOne from params module
    ├── Calculate rewards using dynamic params
    └── Continue existing mint flow
```

### Governance Parameter Update Flow
```
Governance → HokusaiParams.setTokensPerDeltaOne(newValue)
    ├── Verify GOV_ROLE or timelock
    ├── Update storage value
    ├── Emit TokensPerDeltaOneSet(oldValue, newValue)
    └── All future mints use new value
```

## Data Structures

### Current State
```solidity
// TokenManager
mapping(uint256 => address) public modelToToken;
uint256 public deploymentFee = 0.01 ether;

// DeltaVerifier (hardcoded params)
uint256 public constant baseRewardRate = 1000;
uint256 public constant minImprovementBps = 100;
uint256 public constant maxReward = 1000000;
```

### With Params Module
```solidity
// HokusaiToken
IHokusaiParams public immutable params;

// HokusaiParams
uint256 private _tokensPerDeltaOne;
uint16 private _infraMarkupBps;
bytes32 private _licenseHash;
string private _licenseURI;

// Access Control
bytes32 public constant GOV_ROLE = keccak256("GOV_ROLE");
```

## Event Flow

### Deployment Events
1. `TokenDeployed(modelId, tokenAddress, deployer)`
2. `ParamsDeployed(modelId, paramsAddress)` [NEW]
3. `ModelRegistered(modelId, tokenAddress)`

### Parameter Update Events [NEW]
1. `TokensPerDeltaOneSet(oldValue, newValue)`
2. `InfraMarkupBpsSet(oldBps, newBps)`
3. `LicenseSet(hash, uri)`

### Minting Events
1. `PerformanceSubmitted(modelId, deltaOne, totalReward)`
2. `Transfer(from=0x0, to=recipient, amount)` (ERC20)

## Integration Points

### Files Requiring Modification

#### Core Contracts
1. **HokusaiToken.sol**
   - Add: `IHokusaiParams public immutable params`
   - Modify: Constructor to accept params address

2. **TokenManager.sol**
   - Add: Deploy HokusaiParams alongside token
   - Modify: deployToken() to include params setup
   - Optional: Track params addresses

3. **DeltaVerifier.sol**
   - Remove: Hardcoded parameters
   - Add: Dynamic params reading from token.params()
   - Modify: calculateRewards() to use dynamic values

#### New Contracts
1. **HokusaiParams.sol**
   - Implement parameter storage and governance
   - Access control for updates
   - View functions for reading

2. **IHokusaiParams.sol**
   - Interface for params module
   - Standard for all parameter contracts

## Security Considerations

### Access Control
- Only governance can update params
- Consider timelock for param changes
- Separate roles for different params

### Validation
- Bounds checking on parameter updates
- Prevent zero/extreme values
- Rate limiting still applies

### Upgradeability
- Params module can be upgraded separately
- Token remains immutable
- Clear migration path for new params

## Testing Requirements

### Unit Tests
- Params module deployment
- Parameter updates with access control
- Integration with existing contracts

### Integration Tests
- Full deployment flow with params
- Minting with dynamic parameters
- Governance updates

### Edge Cases
- Zero/max parameter values
- Access control violations
- Gas optimization