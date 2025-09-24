# Implementation Tasks: Add Params Model to Hokusai Tokens

## 1. Create Parameter Interface
- [ ] Create contracts/interfaces/IHokusaiParams.sol
  a. [ ] Define tokensPerDeltaOne() view function returning uint256
  b. [ ] Define infraMarkupBps() view function returning uint16
  c. [ ] Define licenseHash() view function returning bytes32
  d. [ ] Define licenseURI() view function returning string
  e. [ ] Define setter functions with proper signatures
  f. [ ] Add comprehensive NatSpec documentation

## 2. Implement HokusaiParams Contract
- [ ] Create contracts/HokusaiParams.sol implementing IHokusaiParams
  a. [ ] Import OpenZeppelin AccessControl for governance
  b. [ ] Define GOV_ROLE constant for parameter updates
  c. [ ] Implement storage variables for all parameters
  d. [ ] Create constructor accepting initial values and governance address
  e. [ ] Implement tokensPerDeltaOne getter and setter with bounds (100-100000)
  f. [ ] Implement infraMarkupBps getter and setter with max 1000 bps
  g. [ ] Implement licenseRef getters and setters
  h. [ ] Add events for all parameter changes
  i. [ ] Implement role-based access control on all setters

## 3. Modify HokusaiToken Contract
- [ ] Update contracts/HokusaiToken.sol to include params pointer
  a. [ ] Import IHokusaiParams interface
  b. [ ] Add immutable params variable of type IHokusaiParams
  c. [ ] Modify constructor to accept params address parameter
  d. [ ] Add public getter function for params address
  e. [ ] Ensure no other functionality is affected

## 4. Update TokenManager Deployment Logic
- [ ] Modify contracts/TokenManager.sol to deploy params contracts
  a. [ ] Import HokusaiParams contract
  b. [ ] Add struct for initial parameter values
  c. [ ] Modify deployToken function signature to accept initial params
  d. [ ] Deploy HokusaiParams before HokusaiToken
  e. [ ] Pass params address to HokusaiToken constructor
  f. [ ] Add mapping to track modelId to params address (optional)
  g. [ ] Emit ParamsDeployed event with details
  h. [ ] Update existing deployment fee logic to work with new flow

## 5. Integrate DeltaVerifier with Dynamic Parameters
- [ ] Update contracts/DeltaVerifier.sol to read from params
  a. [ ] Import IHokusaiParams and HokusaiToken interfaces
  b. [ ] Remove hardcoded baseRewardRate constant
  c. [ ] Modify calculateRewards to fetch token address from registry
  d. [ ] Get params address from token.params()
  e. [ ] Read tokensPerDeltaOne from params module
  f. [ ] Update reward calculation to use dynamic value
  g. [ ] Maintain existing validation and security checks

## 6. Write Unit Tests for HokusaiParams
- [ ] Create test/HokusaiParams.test.js
  a. [ ] Test initial parameter values set correctly
  b. [ ] Test GOV_ROLE can update parameters
  c. [ ] Test non-GOV_ROLE cannot update parameters
  d. [ ] Test parameter bounds validation
  e. [ ] Test event emission for all updates
  f. [ ] Test getter functions return correct values
  g. [ ] Test multiple parameter updates in sequence

## 7. Update HokusaiToken Tests (Dependent on Task 3)
- [ ] Modify test/HokusaiToken.test.js
  a. [ ] Update deployment to include params address
  b. [ ] Test params address is set correctly
  c. [ ] Test params address is immutable
  d. [ ] Ensure existing tests still pass

## 8. Update TokenManager Tests (Dependent on Task 4)
- [ ] Modify test/TokenManager.test.js
  a. [ ] Test params contract deployment alongside token
  b. [ ] Test ParamsDeployed event emission
  c. [ ] Test initial parameter values are set
  d. [ ] Test GOV_ROLE is granted correctly
  e. [ ] Verify gas costs remain reasonable
  f. [ ] Test deployment with invalid parameters fails

## 9. Update DeltaVerifier Tests (Dependent on Task 5)
- [ ] Modify test/DeltaVerifier.test.js
  a. [ ] Mock params contract for testing
  b. [ ] Test reward calculation with dynamic parameters
  c. [ ] Test parameter changes affect future rewards
  d. [ ] Test handling of invalid params address
  e. [ ] Verify gas costs for parameter reading

## 10. Create Integration Tests
- [ ] Create test/integration/ParamsIntegration.test.js
  a. [ ] Test full deployment flow with params
  b. [ ] Test governance parameter updates
  c. [ ] Test minting with dynamic parameters
  d. [ ] Test multiple tokens with different params
  e. [ ] Test parameter update effects on rewards
  f. [ ] Test edge cases and error conditions

## 11. Update Deployment Scripts
- [ ] Modify scripts/deploy.js
  a. [ ] Add initial parameter configuration
  b. [ ] Deploy params contracts alongside tokens
  c. [ ] Set governance address appropriately
  d. [ ] Log params addresses for verification

## 12. Create Parameter Management Script
- [ ] Create scripts/manage-params.js
  a. [ ] Function to read current parameters
  b. [ ] Function to update tokensPerDeltaOne
  c. [ ] Function to update infraMarkupBps
  d. [ ] Function to update license references
  e. [ ] Include role verification before updates

## 13. Gas Optimization Analysis
- [ ] Profile gas usage for parameter operations
  a. [ ] Measure gas for parameter reading
  b. [ ] Measure gas for parameter updates
  c. [ ] Optimize storage layout if needed
  d. [ ] Consider EIP-1167 proxy pattern if beneficial
  e. [ ] Document gas costs for each operation

## 14. Documentation Updates
- [ ] Update README.md with params module information
  a. [ ] Explain parameter system architecture
  b. [ ] Document deployment changes
  c. [ ] Add governance parameter guide
  d. [ ] Include migration instructions

## 15. Security Review Preparation
- [ ] Prepare security documentation
  a. [ ] Document access control implementation
  b. [ ] List all parameter bounds and validations
  c. [ ] Create threat model for params system
  d. [ ] Document upgrade and migration paths
  e. [ ] Prepare for external audit if required

## 16. End-to-End Testing on Testnet
- [ ] Deploy complete system to testnet
  a. [ ] Deploy all contracts with params
  b. [ ] Test governance parameter updates
  c. [ ] Verify minting with dynamic parameters
  d. [ ] Test parameter effects over time
  e. [ ] Document any issues found

## 17. Migration Guide for Existing Tokens
- [ ] Create migration documentation
  a. [ ] Document current token limitations
  b. [ ] Explain benefits of params system
  c. [ ] Provide step-by-step migration process
  d. [ ] Include rollback procedures
  e. [ ] Add FAQ for common concerns