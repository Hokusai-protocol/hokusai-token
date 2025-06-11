# PRD: Add Registration and Lookup Functions to ModelRegistry

## Objectives

Enhance the existing ModelRegistry contract with core registration and lookup functionality. Add registerModel() function to create new model-token mappings and getToken() function to retrieve token addresses by model ID. These functions establish the foundational registry operations that other contracts depend on for model-token lookups.

## Success Criteria

- ModelRegistry contract successfully stores and manages model metadata including tokens and metrics
- Other contracts can reliably query model information using model IDs
- Registry supports both registration and lookup operations with proper access control
- Implementation includes comprehensive event logging for monitoring and analytics
- Gas-efficient storage patterns that scale with multiple models
- Full test coverage for all registry operations and edge cases

## Personas

### Smart Contract Developer
- Needs to integrate TokenManager and other contracts with the ModelRegistry
- Requires predictable interfaces for model-token-metric lookups
- Values gas efficiency and reliable contract interactions
- Needs clear documentation for integration patterns

### System Administrator
- Manages model registrations and updates model configurations
- Needs visibility into all registered models and their status
- Requires ability to deactivate or update model information
- Values admin controls and audit trails

### DApp Developer
- Building frontend applications that interact with Hokusai models
- Needs to query model metadata for UI display
- Requires consistent data format for model information
- Values standardized API patterns for model discovery

## Technical Requirements

### Core Registry Structure
- Implement comprehensive ModelInfo struct containing name, token address, performance metric, and status
- Support auto-incrementing model ID assignment starting from 1
- Include mapping for efficient model data retrieval
- Provide reverse lookup capabilities where needed

### Model Management Functions
- registerModel() function for adding new model-token-metric associations
- updateMetric() function for modifying performance metrics
- deactivateModel() function for managing model lifecycle
- Proper access control restricting admin functions to authorized addresses

### Query Interface
- getModel() function returning complete model information
- getTokenAddress() function for token address lookup
- getMetric() function for performance metric retrieval
- Efficient view functions with consistent return patterns

### Event System
- ModelRegistered event for new model additions
- ModelUpdated event for model modifications
- Indexed parameters for efficient off-chain filtering and monitoring

## Implementation Tasks

### 1. Define Core Contract Structure
- Create ModelInfo struct with name, tokenAddress, performanceMetric, dataFormat, and active fields
- Implement mapping(uint256 => ModelInfo) for model storage
- Add nextModelId counter starting at 1
- Define admin address and onlyAdmin modifier

### 2. Implement Registration Functions
- Create registerModel() function accepting model metadata parameters
- Add proper validation for token addresses (non-zero check)
- Implement auto-incrementing model ID assignment
- Emit ModelRegistered event with indexed modelId and tokenAddress

### 3. Add Model Management Functions
- Implement updateMetric() for modifying performance metrics
- Create deactivateModel() for lifecycle management
- Add proper access control to all admin functions
- Emit appropriate events for all state changes

### 4. Create Query Interface
- Implement getModel() returning complete ModelInfo struct
- Add getTokenAddress() for efficient token address lookup
- Create getMetric() for performance metric queries
- Ensure consistent return patterns for not found scenarios

### 5. Write Comprehensive Tests
- Test model registration with valid and invalid inputs
- Verify proper access control for admin functions
- Test all query functions with registered and unregistered models
- Validate event emissions and parameter indexing
- Test edge cases including zero addresses and inactive models
- Verify gas efficiency of storage operations

### 6. Integration Testing
- Test TokenManager integration with ModelRegistry
- Verify proper model-token resolution in realistic scenarios
- Test admin operations in deployment context
- Validate contract interactions match expected patterns

## Non-Goals

- Token creation or ERC20 implementation (handled by HokusaiToken)
- Complex model versioning or migration logic
- Off-chain metadata synchronization
- Multi-network registry coordination
- Governance or decentralized admin controls (future enhancement)

## Dependencies

- Existing contract architecture (HokusaiToken, TokenManager)
- Hardhat testing and deployment framework
- Access control patterns established in other contracts
- Event logging standards for the Hokusai ecosystem