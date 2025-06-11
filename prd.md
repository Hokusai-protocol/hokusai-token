# PRD: Deploy TokenManager and Link to ModelRegistry

## Project Summary

Deploy a TokenManager contract that accepts a reference to the ModelRegistry in its constructor. This allows the TokenManager to retrieve the correct token contract dynamically when performing minting and burning operations. The manager should act as the centralized controller for all model-specific tokens, using the ModelRegistry to resolve which token contract to interact with for each model ID.

## Objectives

Enable dynamic token management across multiple models by establishing a proper architectural connection between TokenManager and ModelRegistry. This creates a scalable foundation where new models can be registered in the ModelRegistry and immediately be managed by the existing TokenManager without requiring contract updates.

## Background

The current TokenManager contract needs to be enhanced to work with the ModelRegistry system. Instead of being hardcoded to work with a single token, the TokenManager should dynamically resolve token addresses through the ModelRegistry, allowing it to manage tokens for any registered model.

## Success Criteria

- TokenManager constructor accepts ModelRegistry address as parameter
- TokenManager can resolve token addresses dynamically using ModelRegistry
- Deployment script properly deploys and links both contracts
- Integration tests verify end-to-end functionality from model registration to token operations
- All existing TokenManager functionality remains intact
- Gas costs for operations remain reasonable

## Target Personas

**Smart Contract Developer**: Needs a clean integration pattern between TokenManager and ModelRegistry for managing multiple model tokens

**DevOps Engineer**: Requires reliable deployment scripts that properly configure contract relationships

**Protocol Administrator**: Can register new models and immediately use TokenManager to manage their tokens

**Integration Developer**: Can build applications that work with any registered model through consistent TokenManager interface

## Technical Requirements

### TokenManager Enhancement
- Constructor accepts ModelRegistry address parameter
- Store ModelRegistry reference as state variable
- Use ModelRegistry.getTokenAddress(modelId) to resolve token contracts
- Maintain existing mint/burn function signatures for backward compatibility

### ModelRegistry Integration
- TokenManager calls ModelRegistry.getTokenAddress() before token operations
- Proper error handling when model is not registered
- Validation that resolved token address is not zero

### Deployment Configuration
- Deploy ModelRegistry first to get its address
- Deploy TokenManager with ModelRegistry address in constructor
- Set TokenManager as controller for any deployed HokusaiTokens
- Register model-token mappings in ModelRegistry

### Security Considerations
- Validate that ModelRegistry address is not zero in constructor
- Ensure only registered models can have tokens managed
- Maintain proper access controls on both contracts
- Prevent unauthorized model registration or token operations

## Tasks

1. **Analyze Current Implementation**
   - Review existing TokenManager contract structure
   - Review existing ModelRegistry contract interface
   - Identify integration points and dependencies
   - Document current deployment process

2. **Enhance TokenManager Contract**
   - Add ModelRegistry address parameter to constructor
   - Store ModelRegistry reference as state variable
   - Update mintTokens function to use ModelRegistry.getTokenAddress()
   - Add proper error handling for unregistered models
   - Maintain backward compatibility with existing interfaces

3. **Create Deployment Script**
   - Deploy ModelRegistry contract first
   - Deploy TokenManager with ModelRegistry address
   - Configure initial model-token mappings if needed
   - Set proper access controls and controller relationships

4. **Implement Integration Tests**
   - Test TokenManager deployment with ModelRegistry reference
   - Test dynamic token resolution through ModelRegistry
   - Test end-to-end flow: register model → mint tokens → verify balances
   - Test error cases: unregistered models, zero addresses
   - Test gas costs for enhanced operations

5. **Update Documentation**
   - Document new deployment process
   - Update contract interface documentation
   - Add examples of TokenManager-ModelRegistry integration
   - Update README with new architecture details

## Implementation Notes

The integration should maintain the existing TokenManager API while adding ModelRegistry-based token resolution. This ensures existing integrations continue to work while enabling the dynamic multi-model functionality. The deployment process becomes slightly more complex but provides significantly more flexibility for managing multiple model tokens.