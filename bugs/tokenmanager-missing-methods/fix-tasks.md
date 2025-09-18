# TokenManager Bug Fix Tasks

## Overview
Fix the TokenManager contract to match the frontend's expected interface and redeploy to Sepolia testnet.

## Fix Implementation Tasks

### 1. Update TokenManager Contract Interface
- [ ] Modify `deployToken` function signature to match frontend expectations
  - [ ] Change modelId parameter from `uint256` to `string`
  - [ ] Add `totalSupply` parameter
  - [ ] Reorder parameters: modelId, name, symbol, totalSupply
- [ ] Update `modelTokens` mapping to use string keys
- [ ] Update all related functions to handle string modelId
- [ ] Update events to use string modelId

### 2. Write Comprehensive Tests
- [ ] Create test file `test/tokenmanager-fix.test.js`
- [ ] Test `deployToken` with string modelId
- [ ] Test `deployToken` with totalSupply parameter
- [ ] Test `modelTokens` lookup with string modelId
- [ ] Test `deploymentFee` view function
- [ ] Test duplicate token deployment prevention
- [ ] Test event emission with correct parameters
- [ ] Add integration test simulating frontend calls

### 3. Update Related Contracts
- [ ] Update HokusaiToken to accept totalSupply in constructor
- [ ] Update ModelRegistry if needed for string modelId support
- [ ] Ensure backward compatibility where possible

### 4. Update Deployment Scripts
- [ ] Update `scripts/deploy-sepolia.ts` with new contract
- [ ] Add verification step to deployment script
- [ ] Create migration script for existing data if needed

### 5. Documentation Updates
- [ ] Update FRONTEND_DEPLOYMENT_GUIDE.md with correct ABI
- [ ] Document the interface change in README
- [ ] Add integration testing guide
- [ ] Create deployment checklist

### 6. Monitoring & Alerting Improvements
- [ ] Add deployment verification step
- [ ] Create contract interface validation script
- [ ] Add monitoring for failed transactions
- [ ] Set up alerts for contract function failures

## Implementation Order

### Phase 1: Contract Updates (Priority: HIGH)
1. Update TokenManager.sol with new interface
2. Update HokusaiToken.sol for totalSupply
3. Write unit tests for new functionality
4. Run full test suite

### Phase 2: Testing (Priority: HIGH)
1. Write integration tests
2. Test on local Hardhat network
3. Test gas consumption
4. Validate against frontend expectations

### Phase 3: Deployment (Priority: HIGH)
1. Deploy to Sepolia testnet
2. Verify contract on Etherscan
3. Update frontend configuration
4. Test end-to-end on testnet

### Phase 4: Validation (Priority: MEDIUM)
1. Manual testing of token deployment
2. Check event logs
3. Verify all functions work
4. Document deployment details

### Phase 5: Preventive Measures (Priority: LOW)
1. Add CI/CD checks for interface compatibility
2. Create automated deployment validation
3. Set up monitoring dashboards

## Success Criteria
- [ ] All tests pass
- [ ] Contract deployed and verified on Sepolia
- [ ] Frontend can successfully deploy tokens
- [ ] `deploymentFee()` returns correct value
- [ ] `modelTokens()` returns correct addresses
- [ ] Events are properly emitted
- [ ] No gas estimation errors

## Rollback Plan
If issues arise after deployment:
1. Frontend can be updated to point to previous contract
2. Deploy hotfix if minor issues
3. Full redeployment if major issues
4. Maintain old contract address for reference

## Notes
- Ensure totalSupply is properly validated (> 0)
- Consider adding max supply limits
- String modelId should be validated (non-empty)
- Gas optimization should be considered
- Consider upgrade path for future changes