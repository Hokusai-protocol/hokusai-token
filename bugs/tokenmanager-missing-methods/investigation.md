# TokenManager Bug Investigation Plan

## Bug Summary
The TokenManager smart contract deployed at `0xB4A25a1a72BDd1e0F5f3288a96a6325CD9219196` on Sepolia testnet is non-functional. All method calls to the contract revert, preventing token deployment functionality from working.

## Impact Analysis
- **Severity**: Critical - Core functionality completely broken
- **User Impact**: Cannot deploy tokens for registered models
- **Business Impact**: Blocks entire token creation workflow
- **Scope**: Affects all users attempting to deploy tokens on Sepolia

## Affected Components/Services

### Smart Contracts
- **TokenManager** (0xB4A25a1a72BDd1e0F5f3288a96a6325CD9219196) - Deployed contract
- **ModelRegistry** - Dependent contract for model-token mapping
- **HokusaiToken** - Token implementation contract

### Frontend Components
- `/packages/web/src/lib/contracts/TokenManager.ts` - Frontend integration
- Token deployment UI components
- Gas estimation logic

### Deployment Infrastructure
- `/scripts/deploy-sepolia.ts` - Main deployment script
- `/scripts/update-token-manager-sepolia.ts` - TokenManager update script
- Contract verification process

## Reproduction Steps
1. Connect to Sepolia network
2. Call `deploymentFee()` on contract 0xB4A25a1a72BDd1e0F5f3288a96a6325CD9219196
   - Result: "execution reverted"
3. Call `modelTokens("21")` on same contract
   - Result: "execution reverted"
4. Attempt to call `deployToken("21", "Test", "TST", 1000000)` with fee
   - Result: Gas estimation fails with "execution reverted"

## Initial Observations

### From Code Analysis
1. **Function Signature Mismatch**:
   - Frontend expects: `deployToken(string modelId, string name, string symbol, uint256 totalSupply)`
   - Current code has: `deployToken(string name, string symbol, uint256 modelId)`

2. **Data Type Conflict**:
   - Frontend uses `string` for modelId
   - Contract uses `uint256` for modelId

3. **Missing Parameter**:
   - Frontend expects `totalSupply` parameter
   - Current contract doesn't accept totalSupply

4. **Deployment Issues**:
   - Contract at deployed address is unverified
   - No successful transactions since deployment
   - Appears to be wrong contract or wrong version

### From Testing
- Test file exists but doesn't cover the `deployToken` function
- No integration tests with frontend expectations
- Missing tests for the expected interface

## Investigation Areas

### 1. Contract Code Analysis
- [x] Review current TokenManager.sol implementation
- [x] Check for version control history
- [x] Analyze expected vs actual ABI
- [ ] Verify contract bytecode at deployed address

### 2. Deployment Process
- [x] Review deployment scripts
- [ ] Check deployment transaction history
- [ ] Verify deployment parameters
- [ ] Confirm contract verification status

### 3. Frontend Integration
- [x] Analyze frontend ABI expectations
- [x] Review TokenManager.ts integration code
- [ ] Check for any frontend workarounds or patches

### 4. Testing Coverage
- [x] Review existing test coverage
- [ ] Identify missing test scenarios
- [ ] Plan comprehensive test suite

## Next Steps
1. Generate hypotheses about root cause
2. Test each hypothesis systematically
3. Document confirmed root cause
4. Create fix implementation plan
5. Write tests first, then implement fix
6. Validate against original bug report