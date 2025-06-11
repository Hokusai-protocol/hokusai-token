# Implementation Tasks: ModelRegistry to map modelId → token + metric

## Core Implementation

1. [x] Examine existing ModelRegistry contract structure
   a. [x] Review current ModelRegistry.sol implementation - uses bytes32 mapping
   b. [x] Identify existing storage patterns and conventions - OpenZeppelin Ownable, event emissions
   c. [x] Document current interface and access patterns - 55 tests passing, full integration working
   d. [x] **Decision: Refactor from bytes32 to uint256 for better gas efficiency and simpler API**

2. [x] Define storage mapping structure
   a. [x] Create mapping(uint256 => address) for modelId to token address
   b. [x] Add mapping(address => uint256) for reverse lookups 
   c. [x] Define nextModelId counter for auto-incrementing IDs
   d. [x] Add mapping for checking if modelId exists

3. [x] Implement core mapping functions
   a. [x] Refactored existing functions to use uint256 instead of bytes32
   b. [x] Implement getTokenAddress(uint256 modelId) view function
   c. [x] Add exists(uint256 modelId) check function
   d. [x] Create getModelId(address tokenAddress) reverse lookup function
   e. [x] Add registerModelAutoId() for auto-incrementing registration

4. [x] Add data validation (Dependent on Core Implementation)
   a. [x] Validate token addresses are not zero address
   b. [x] Prevent overwriting existing mappings without explicit update
   c. [x] Prevent duplicate token registrations with reverse mapping checks
   d. [x] Implement duplicate prevention logic

5. [x] Create events and monitoring (Dependent on Core Implementation)
   a. [x] Updated ModelRegistered event to use uint256 indexed modelId
   b. [x] Updated ModelUpdated event to use uint256 indexed modelId
   c. [x] Include indexed parameters for efficient filtering
   d. [x] Emit events in all mapping modification functions

## Testing (Dependent on Core Implementation)

6. [x] Write and implement comprehensive tests
   a. [x] Test basic mapping storage and retrieval
   b. [x] Verify edge cases (zero addresses, non-existent models)
   c. [x] Test gas efficiency of mapping operations
   d. [x] Validate event emissions and data integrity
   e. [x] Test integration scenarios with mock token contracts
   f. [x] Test reverse lookup functionality
   g. [x] Test duplicate prevention logic
   h. [x] Test mapping update scenarios
   i. [x] Test auto-increment functionality
   j. [x] Test comprehensive reverse mapping edge cases
   k. [x] **69 total tests passing (up from 65 with new metric functionality)**
   l. [x] Test metric validation (empty strings, update functions)
   m. [x] Test deactivateModel functionality
   n. [x] Test getModel() complete struct return
   o. [x] Test updateMetric() with event emission

## Integration Testing (Dependent on Testing)

7. [x] Verify integration with existing contracts
   a. [x] Test TokenManager integration with new mapping functions
   b. [x] Verify compatibility with existing HokusaiToken contracts
   c. [x] Test end-to-end flow: register model → lookup token → verify functionality
   d. [x] Validate gas costs are reasonable for production use (mint: ~90k gas, burn: ~56k gas)

## Documentation (Dependent on Integration Testing)

8. [x] Update technical documentation
   a. [x] Document new mapping functions in README.md
   b. [x] Add code comments explaining storage structure
   c. [x] Create usage examples for getTokenAddress function
   d. [x] Update architecture section with mapping details
   e. [x] Document event specifications and filtering examples

## Performance Metric Enhancement (Enhancement to original spec)

9. [x] Add performance metric storage to ModelRegistry
   a. [x] Update ModelInfo struct to include performanceMetric field
   b. [x] Modify registerModel() to accept performance metric parameter
   c. [x] Modify registerModelAutoId() to accept performance metric parameter
   d. [x] Add getMetric() function for querying performance metrics
   e. [x] Add updateMetric() function for modifying metrics
   f. [x] Add deactivateModel() function for lifecycle management
   g. [x] Add getModel() function returning complete ModelInfo struct
   h. [x] Update events to include performance metric information
   i. [x] Add validation for empty performance metrics
   j. [x] Update all test cases to include performance metrics
   k. [x] Add comprehensive tests for new metric functionality

## Deployment Preparation (Dependent on Documentation)

10. [x] Prepare for deployment
   a. [x] Verify all tests pass (69/69 tests passing)
   b. [x] Run gas optimization analysis (mint: 90k gas, burn: 56k gas)
   c. [x] Review security considerations (all validations in place)
   d. [x] Deployment scripts already exist and work with new contracts
   e. [x] Validate contract compilation and deployment readiness