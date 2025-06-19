# Product Requirements Document: Support ETH Address from JSON

## Objectives

Enable the Hokusai smart contracts to read and utilize Ethereum wallet addresses from the data pipeline JSON output to automatically distribute token rewards to the correct contributors. The system must support both single and multiple contributor scenarios as defined in the JSON schema.

## Personas

**Data Contributor**: Individual or entity providing data to improve ML models, identified by an Ethereum wallet address where they expect to receive token rewards.

**Smart Contract Developer**: Engineer implementing the contract updates to parse contributor information and distribute tokens accordingly.

**System Administrator**: Person managing the TokenManager contract and triggering token distributions based on pipeline outputs.

## Success Criteria

1. TokenManager contract successfully extracts wallet addresses from both single contributor (`contributor_info.wallet_address`) and multiple contributor (`contributors[].wallet_address`) JSON formats
2. Tokens are minted to the correct Ethereum addresses as specified in the JSON
3. Contract handles multiple contributors with appropriate weight-based token distribution
4. All existing functionality remains intact with backward compatibility
5. Comprehensive test coverage for new wallet address extraction logic
6. Gas-efficient implementation that scales with contributor count

## Tasks

### Task 1: Update DeltaVerifier Contract
- Add struct to represent contributor data including wallet address
- Create function to parse single contributor info with wallet_address field
- Create function to parse multiple contributors array with wallet addresses
- Implement weight-based token calculation for multiple contributors
- Add validation for Ethereum address format (0x followed by 40 hex characters)

### Task 2: Modify TokenManager Integration
- Update mintTokens function to accept contributor addresses array
- Implement batch minting functionality for multiple recipients
- Add function overload to maintain backward compatibility
- Ensure proper access control (onlyAdmin modifier) remains in place

### Task 3: Write Unit Tests
- Test single contributor wallet address extraction
- Test multiple contributors with different weights
- Test invalid wallet address format rejection
- Test edge cases (empty contributors, zero weights, missing addresses)
- Test gas consumption for various contributor counts

### Task 4: Write Integration Tests
- Create mock JSON payloads matching the schema for testing
- Test end-to-end flow from JSON input to token distribution
- Verify correct token amounts based on delta scores and weights
- Test both contributor_info and contributors array formats

### Task 5: Update Documentation
- Document new function signatures in contract comments
- Add examples of JSON inputs with wallet addresses
- Update deployment scripts if needed
- Document gas costs for different contributor scenarios

### Task 6: Security Review
- Ensure no reentrancy vulnerabilities in batch minting
- Validate all address inputs to prevent zero address minting
- Review access control for new functions
- Consider implementing daily minting limits if needed

## Technical Specifications

### JSON Input Formats

The contract must support two formats:

1. Single contributor:
```json
{
  "contributor_info": {
    "wallet_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f1234",
    "contributor_weights": 1.0,
    ...
  }
}
```

2. Multiple contributors:
```json
{
  "contributors": [
    {
      "wallet_address": "0x742d35Cc6634C0532925a3b844Bc9e7595f1234",
      "weight": 0.6,
      ...
    },
    {
      "wallet_address": "0x5aAeb6053f3E94C9b9A09f33669435E7Ef1BeAed",
      "weight": 0.4,
      ...
    }
  ]
}
```

### Token Distribution Formula

For each contributor:
```
tokens_to_mint = total_reward * contributor_weight * delta_one_score
```

Where:
- total_reward is determined by the contract configuration
- contributor_weight is from the JSON (0-1)
- delta_one_score represents the model improvement metric