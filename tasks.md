# Tasks: Support ETH Address from JSON

## 1. [ ] Review and understand existing contracts
   a. [ ] Study DeltaVerifier contract structure and current functionality
   b. [ ] Analyze TokenManager minting logic and access controls
   c. [ ] Review HokusaiToken interface for batch minting capabilities
   d. [ ] Understand current JSON parsing implementation in DeltaVerifier

## 2. [ ] Design contract updates
   a. [ ] Define ContributorData struct with wallet address field
   b. [ ] Design function signatures for single/multiple contributor parsing
   c. [ ] Plan backward compatibility approach
   d. [ ] Document gas optimization strategies for batch operations

## 3. [x] Write unit tests for DeltaVerifier updates
   a. [x] Test parsing single contributor with wallet_address
   b. [x] Test parsing multiple contributors array
   c. [x] Test wallet address validation (correct format)
   d. [x] Test rejection of invalid addresses
   e. [x] Test edge cases (empty arrays, zero weights, missing fields)
   f. [x] Test weight normalization for multiple contributors

## 4. [x] Write integration tests (Dependent on #3)
   a. [x] Create test JSON payloads matching schema
   b. [x] Test full flow from JSON to token distribution
   c. [x] Test token amount calculations with various delta scores
   d. [x] Test gas usage with different contributor counts
   e. [x] Test error handling and revert scenarios

## 5. [x] Implement DeltaVerifier contract changes (Dependent on #3)
   a. [x] Add ContributorData struct definition
   b. [x] Implement parseContributorInfo function
   c. [x] Implement parseContributors array function
   d. [x] Add address validation logic
   e. [x] Implement weight-based reward calculation
   f. [x] Ensure all tests pass

## 6. [x] Update TokenManager contract (Dependent on #5)
   a. [x] Add batch minting function for multiple recipients
   b. [x] Update mintTokens to accept contributor data
   c. [x] Implement function overloads for backward compatibility
   d. [x] Add events for batch minting operations
   e. [x] Ensure access control remains intact
   f. [x] Run all TokenManager tests

## 7. [ ] Security review and optimization (Dependent on #6)
   a. [ ] Check for reentrancy vulnerabilities
   b. [ ] Validate zero address prevention
   c. [ ] Review gas optimization opportunities
   d. [ ] Consider implementing minting limits
   e. [ ] Run security analysis tools

## 8. [ ] Update documentation
   a. [ ] Document new function signatures in NatSpec comments
   b. [ ] Add JSON input examples to README.md
   c. [ ] Document gas costs for various scenarios
   d. [ ] Update deployment guide if needed
   e. [ ] Create migration guide for existing deployments

## 9. [ ] Final testing and validation (Dependent on #7)
   a. [ ] Run complete test suite
   b. [ ] Perform manual testing with sample JSONs
   c. [ ] Validate backward compatibility
   d. [ ] Check test coverage metrics
   e. [ ] Run gas profiling tests