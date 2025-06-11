# PRD: Add Metadata and Event Logging

## Objectives

Implement name, symbol, and decimals metadata for the HokusaiToken contract. Add comprehensive event logging with Minted and Burned events to support test assertions and future on-chain analytics. This enhancement will make the token contract more compliant with ERC20 standards and provide better observability for contract interactions.

## Personas

**Smart Contract Developer**: Needs proper metadata to integrate with the token contract and events to monitor contract state changes.

**Frontend Developer**: Requires token metadata (name, symbol, decimals) to display token information correctly in user interfaces.

**Analytics Team**: Uses emitted events to track token operations, supply changes, and user behavior for business intelligence.

**Test Engineer**: Relies on events to create comprehensive test assertions and verify contract behavior.

**DApp Users**: See properly formatted token information in wallets and applications through standard metadata.

## Success Criteria

1. HokusaiToken contract implements standard ERC20 metadata functions (name, symbol, decimals)
2. Minted events are emitted with correct parameters when tokens are created
3. Burned events are emitted with correct parameters when tokens are destroyed
4. Events include all necessary indexed fields for efficient filtering and querying
5. Metadata values are consistent across the token ecosystem
6. All events can be successfully captured and verified in tests
7. Gas costs for event emission remain reasonable

## Tasks

### Task 1: Implement Token Metadata
- Add name() function returning "Hokusai Token"
- Add symbol() function returning appropriate token symbol (e.g., "HOKU")
- Add decimals() function returning 18 (standard ERC20 decimals)
- Ensure metadata functions are public view functions
- Test that metadata functions return correct values

### Task 2: Design Event Schema
- Define Minted event with indexed recipient address and token amount
- Define Burned event with indexed account address and token amount
- Include timestamp or block information if needed for analytics
- Ensure events follow Solidity best practices for indexing

### Task 3: Implement Minted Event Logging
- Add Minted event emission to all mint functions
- Include recipient address as indexed parameter
- Include minted amount as parameter
- Verify event is emitted before balance updates for consistency
- Test event emission in all minting scenarios

### Task 4: Implement Burned Event Logging
- Add Burned event emission to all burn functions
- Include account address as indexed parameter
- Include burned amount as parameter
- Verify event is emitted before balance updates for consistency
- Test event emission in all burning scenarios

### Task 5: Update Contract Integration
- Ensure TokenManager contract properly handles new events
- Verify BurnAuction contract can emit events through token burns
- Update any existing contract interfaces if needed

### Task 6: Comprehensive Testing
- Test metadata functions return correct values
- Test Minted events are emitted with correct parameters
- Test Burned events are emitted with correct parameters
- Test event indexing works for filtering
- Verify gas costs for operations with events
- Test event emissions in edge cases (zero amounts, etc.)

### Task 7: Documentation Updates
- Update contract documentation to include event specifications
- Document event parameters and their purposes
- Add examples of how to listen for and filter events
- Update deployment scripts if metadata initialization is needed