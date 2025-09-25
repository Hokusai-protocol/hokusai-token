# Migration Checklist: Replacing Token on Sepolia

## Pre-Deployment
- [ ] Note down any important data from old token (if any)
- [ ] Ensure you have enough Sepolia ETH for deployment
- [ ] Decide on initial parameter values
- [ ] Decide on governance address for params control

## Deployment Steps

### 1. Deploy New Contracts
```bash
npx hardhat run scripts/deploy-token-with-params.js --network sepolia
```

### 2. Verify Contracts on Etherscan
Use the verification commands output by the deployment script

### 3. Update Environment Variables
Update your `.env` file with new addresses:
- `MODEL_REGISTRY_ADDRESS`
- `TOKEN_MANAGER_ADDRESS`
- `DELTA_VERIFIER_ADDRESS`
- `HOKUSAI_TOKEN_ADDRESS` (new)
- `HOKUSAI_PARAMS_ADDRESS` (new)

### 4. Update Frontend/Backend Services
Replace old token address (`0xf107e000b6cf35de3a7d36667fb899cc59b6a28f`) with new one in:
- [ ] Frontend configuration
- [ ] Backend services configuration
- [ ] Any monitoring/indexing services
- [ ] Documentation

### 5. Test New Deployment
- [ ] Test token minting through TokenManager
- [ ] Test parameter reading from params module
- [ ] Test governance can update parameters
- [ ] Verify DeltaVerifier integration works

### 6. Clean Up
- [ ] Remove references to old token address
- [ ] Update any documentation
- [ ] Notify team of new addresses

## Post-Migration Verification
- [ ] Token shows up correctly on Etherscan
- [ ] Parameters can be read from params contract
- [ ] Governance role is set correctly
- [ ] TokenManager can mint tokens
- [ ] DeltaVerifier can trigger rewards

## Rollback Plan
If issues arise, the old token at `0xf107e000b6cf35de3a7d36667fb899cc59b6a28f` remains unchanged and can still be used.