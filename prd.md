# PRD: Define mapping of modelId → token address

## Objectives

Build a simple storage mapping in the ModelRegistry contract to link model identifiers (e.g., hash or slug) with their ERC20 token contracts. This mapping serves as the foundation for the token ecosystem, enabling other contracts to dynamically resolve which token belongs to which model.

## Success Criteria

- ModelRegistry contract successfully stores modelId to token address mappings
- Storage mapping is accessible and queryable by other contracts
- Implementation supports both string-based and uint256-based model identifiers
- Gas-efficient storage pattern that scales with multiple models
- Clear separation between mapping storage and access control functions

## Personas

### Smart Contract Developer
- Needs to integrate with the ModelRegistry to resolve token addresses
- Requires predictable interface for model-token lookups
- Values gas efficiency and reliable contract interactions

### System Administrator
- Manages model registrations and token associations
- Needs clear visibility into registered mappings
- Requires ability to validate model-token relationships

### Integration Partner
- Building on top of the Hokusai ecosystem
- Needs standardized way to discover model tokens
- Values consistent API patterns across contracts

## Technical Requirements

### Core Mapping Structure
- Implement storage mapping from model identifier to token address
- Support both string and uint256 model identifier types
- Ensure mapping can handle zero addresses for unregistered models
- Include reverse lookup capability (token address to model ID)

### Data Integrity
- Prevent duplicate model registrations
- Validate token addresses before storage
- Handle edge cases like zero addresses appropriately
- Ensure mapping consistency across operations

### Interface Design
- Public view functions for reading mappings
- Clear function naming conventions (getTokenAddress, etc.)
- Consistent return patterns for found/not found scenarios
- Events for mapping changes to support external monitoring

## Implementation Tasks

### 1. Define Storage Structure
- Create mapping(uint256 => address) for modelId to token address
- Create mapping(string => address) for string-based model identifiers (if needed)
- Create mapping(address => uint256) for reverse lookups
- Define nextModelId counter for auto-incrementing IDs

### 2. Implement Core Mapping Functions
- Add internal _setMapping function for updating storage
- Implement getTokenAddress(uint256 modelId) view function
- Add exists(uint256 modelId) check function
- Create getAllRegisteredModels() enumeration function

### 3. Add Data Validation
- Validate token addresses are not zero address
- Prevent overwriting existing mappings without explicit update
- Add checks for valid model ID ranges
- Implement duplicate prevention logic

### 4. Create Events and Monitoring
- Define ModelMapped event for new registrations
- Add ModelUpdated event for mapping changes
- Include indexed parameters for efficient filtering
- Emit events in all mapping modification functions

### 5. Write Comprehensive Tests
- Test basic mapping storage and retrieval
- Verify edge cases (zero addresses, non-existent models)
- Test gas efficiency of mapping operations
- Validate event emissions and data integrity
- Test integration scenarios with mock token contracts

## Non-Goals

- Complex model metadata storage (handled separately)
- Access control for mapping modifications (separate feature)
- Token creation or management logic
- Off-chain data synchronization
- Multi-network model registry synchronization

## Dependencies

- Existing ModelRegistry contract structure
- ERC20 token interface compatibility
- Hardhat testing framework setup
- Integration with TokenManager contract expectations