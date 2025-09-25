# Product Requirements Document: Add Params Model to Hokusai Tokens

## Executive Summary

This feature adds a governance-controlled parameter system to Hokusai tokens to enable dynamic adjustment of key operational values without requiring contract upgrades. The implementation maintains the immutable nature of HokusaiToken contracts while providing flexibility for governance to adjust economic parameters like token minting rates, infrastructure markup, and licensing terms.

## Problem Statement

Currently, key operational parameters in the Hokusai token system are hardcoded across multiple contracts:
- Token minting rates are fixed in DeltaVerifier (baseRewardRate: 1000 tokens per unit)
- Infrastructure markup percentages are not configurable
- License references cannot be updated without contract redeployment
- Parameter changes require expensive contract migrations

This inflexibility prevents the system from adapting to changing economic conditions, regulatory requirements, or governance decisions.

## Goals and Objectives

### Primary Goals
1. Enable governance to adjust token economic parameters without contract upgrades
2. Maintain immutability and security of core HokusaiToken contracts
3. Provide standardized parameter management across all model tokens
4. Support efficient parameter reading for gas optimization

### Success Criteria
- Governance can update parameters through role-based access control
- Parameter changes take effect immediately for future operations
- Existing HokusaiToken contracts remain unchanged and secure
- DeltaVerifier reads dynamic parameters instead of hardcoded values
- All parameter changes are logged with comprehensive events

## User Stories and Use Cases

### Governance Users
**As a governance member, I want to:**
- Adjust token minting rates based on model performance metrics
- Set infrastructure markup percentages for cost recovery
- Update license references when legal terms change
- View current parameter values across all model tokens

### Model Operators
**As a model operator, I want to:**
- Know the current minting rate for my model's token
- Understand infrastructure costs through transparent markup
- Access current license terms for compliance

### DeFi Integrators
**As a DeFi protocol, I want to:**
- Query current token parameters programmatically
- Receive events when parameters change for risk management
- Access standardized parameter interfaces across all Hokusai tokens

## Functional Requirements

### REQ-1: HokusaiParams Contract
Create a new contract implementing parameter storage and governance:
- Store tokensPerDeltaOne (uint256) - replaces hardcoded baseRewardRate
- Store infraMarkupBps (uint16) - infrastructure markup in basis points (0-10000)
- Store licenseRef (bytes32 hash + optional string URI) - license reference
- Implement role-based access control with GOV_ROLE
- Provide view functions for parameter reading
- Emit events for all parameter changes

### REQ-2: HokusaiToken Integration
Modify HokusaiToken to reference its parameter contract:
- Add immutable IHokusaiParams params field
- Extend constructor to accept params address
- Maintain backward compatibility with existing deployment flow
- No changes to existing mint/burn/transfer functionality

### REQ-3: TokenManager Deployment Updates
Update TokenManager to deploy parameter contracts:
- Deploy HokusaiParams alongside each HokusaiToken
- Set initial parameter values during deployment
- Grant GOV_ROLE to designated governance address
- Maintain registry tracking for deployed parameter contracts
- Emit ParamsDeployed events

### REQ-4: DeltaVerifier Parameter Reading
Modify DeltaVerifier to use dynamic parameters:
- Replace hardcoded baseRewardRate with params.tokensPerDeltaOne()
- Read parameters from token.params() interface
- Maintain existing reward calculation logic
- Support parameter changes without contract redeployment

### REQ-5: Governance Parameter Updates
Implement secure parameter update functions:
- setTokensPerDeltaOne(uint256) with reasonable bounds (100-100000)
- setInfraMarkupBps(uint16) with maximum 1000 bps (10%)
- setLicenseRef(bytes32, string) for license updates
- Role verification for all update operations
- Comprehensive event emission

## Non-Functional Requirements

### Security Requirements
- Only GOV_ROLE can update parameters
- Parameter bounds validation to prevent extreme values
- Immutable params address in token contracts
- No upgrade paths for deployed parameter contracts
- Comprehensive access control testing

### Performance Requirements
- Parameter reading must be gas-efficient (<5000 gas)
- Consider EIP-1167 minimal proxy pattern for parameter deployment
- Optimize storage layout for frequently accessed parameters
- Single storage slot for infraMarkupBps using uint16

### Scalability Requirements
- Support deployment of thousands of parameter contracts
- Efficient parameter lookup without registry bottlenecks
- Minimal storage footprint per parameter contract
- Support for future parameter additions

## Technical Architecture Overview

### Contract Architecture
```
HokusaiToken
├── immutable params: IHokusaiParams
├── constructor(name, symbol, controller, params)
└── existing ERC20 functionality

HokusaiParams
├── implements IHokusaiParams
├── tokensPerDeltaOne: uint256
├── infraMarkupBps: uint16
├── licenseHash: bytes32
├── licenseURI: string
└── GOV_ROLE access control

TokenManager
├── deployToken() → creates HokusaiParams + HokusaiToken
├── tracks deployed parameter contracts
└── emits ParamsDeployed events

DeltaVerifier
├── reads token.params().tokensPerDeltaOne()
├── calculates rewards using dynamic parameters
└── maintains existing security checks
```

### Interface Design
```solidity
interface IHokusaiParams {
    function tokensPerDeltaOne() external view returns (uint256);
    function infraMarkupBps() external view returns (uint16);
    function licenseRef() external view returns (bytes32, string memory);

    function setTokensPerDeltaOne(uint256 newValue) external;
    function setInfraMarkupBps(uint16 newBps) external;
    function setLicenseRef(bytes32 hash, string memory uri) external;
}
```

## User Flow Diagrams

### Parameter Deployment Flow
1. User calls TokenManager.deployToken(modelId, name, symbol, initialParams)
2. TokenManager deploys HokusaiParams with governance role
3. TokenManager deploys HokusaiToken with params address
4. Both contracts registered in ModelRegistry
5. Events emitted: TokenDeployed, ParamsDeployed

### Parameter Update Flow
1. Governance proposes parameter change
2. GOV_ROLE holder calls HokusaiParams.setTokensPerDeltaOne(newValue)
3. Contract validates bounds and permissions
4. Parameter updated in storage
5. Event emitted: TokensPerDeltaOneSet(oldValue, newValue)
6. Future DeltaVerifier calls use new parameter

### Minting with Dynamic Parameters Flow
1. DeltaVerifier.submitPerformance() called
2. Get token address from ModelRegistry
3. Read params: token.params().tokensPerDeltaOne()
4. Calculate rewards using dynamic parameter
5. Execute existing minting flow

## Success Metrics

### Technical Metrics
- Parameter reading gas cost <5000 gas per call
- Zero failed deployments due to parameter issues
- 100% test coverage for parameter contracts
- Sub-second parameter update confirmation times

### Business Metrics
- Governance parameter updates per month
- Reduction in contract redeployment requests
- DeFi protocol integrations using parameter queries
- Community satisfaction with parameter transparency

## Dependencies and Constraints

### Internal Dependencies
- HokusaiToken contract modifications
- TokenManager deployment logic updates
- DeltaVerifier parameter reading integration
- ModelRegistry optional parameter tracking

### External Dependencies
- OpenZeppelin AccessControl for governance
- Hardhat testing framework updates
- Deployment script modifications
- Documentation updates

### Technical Constraints
- Solidity 0.8.x compatibility requirements
- Gas optimization for parameter reading
- Immutable params address requirement
- Backward compatibility with existing tokens

## Timeline and Milestones

### Phase 1: Core Infrastructure (Week 1)
- Create IHokusaiParams interface
- Implement HokusaiParams contract with access control
- Add params pointer to HokusaiToken constructor
- Comprehensive unit tests for parameter contract

### Phase 2: Integration (Week 2)
- Update TokenManager deployment logic
- Modify DeltaVerifier parameter reading
- Integration tests for full deployment flow
- Update deployment scripts and documentation

### Phase 3: Testing & Validation (Week 3)
- End-to-end testing with governance scenarios
- Gas optimization analysis and improvements
- Security audit preparation
- Migration testing for existing deployments

## Risks and Mitigation Strategies

### Security Risks
**Risk**: Unauthorized parameter updates
**Mitigation**: Comprehensive role-based access control testing, timelock consideration for sensitive parameters

**Risk**: Parameter bounds exploitation
**Mitigation**: Strict validation with reasonable bounds, extensive edge case testing

**Risk**: Gas exhaustion in parameter reading
**Mitigation**: Gas optimization testing, efficient storage layout

### Technical Risks
**Risk**: Integration complexity with existing contracts
**Mitigation**: Phased implementation with thorough testing at each stage

**Risk**: Deployment failures due to contract size
**Mitigation**: Optimize contract size, consider proxy patterns if needed

### Operational Risks
**Risk**: Governance parameter mismanagement
**Mitigation**: Clear governance procedures, parameter change documentation, event monitoring

## Implementation Tasks

### Smart Contract Development
1. Create contracts/interfaces/IHokusaiParams.sol interface
2. Implement contracts/HokusaiParams.sol with governance
3. Modify contracts/HokusaiToken.sol constructor
4. Update contracts/TokenManager.sol deployment logic
5. Modify contracts/DeltaVerifier.sol parameter reading

### Testing Requirements
6. Write comprehensive unit tests for HokusaiParams
7. Update existing contract tests for parameter integration
8. Create integration tests for full deployment flow
9. Add governance scenario tests
10. Perform gas optimization testing

### Deployment and Documentation
11. Update deployment scripts for parameter contracts
12. Modify deployment documentation
13. Create parameter management guide for governance
14. Update API documentation for parameter queries

### Validation and Security
15. Conduct security review of parameter contracts
16. Perform end-to-end testing on testnet
17. Validate backward compatibility with existing deployments
18. Prepare migration guide for existing tokens

Each task includes acceptance criteria for testing, documentation requirements, and integration validation to ensure the parameter system enhances the Hokusai token ecosystem while maintaining security and performance standards.