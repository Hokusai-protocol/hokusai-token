# Sepolia Contract Deployment Test Plan

## Current Status

### Service Health ✅
- Contract listener service deployed at https://contracts.hokus.ai
- Health endpoint responding: `/health` (200 OK)
- Ready endpoint responding: `/health/ready` (200 OK)
- Service running on ECS with 1 instance active

### Infrastructure ✅
- Redis connected to AWS ElastiCache
- RPC endpoint configured for Sepolia testnet (Alchemy)
- Service configured with proper environment variables

### Dummy Values Requiring Update 🔄
1. **MODEL_REGISTRY_ADDRESS**: Currently `0x0000000000000000000000000000000000000000`
2. **TOKEN_MANAGER_ADDRESS**: Currently `0x0000000000000000000000000000000000000000`
3. **DEPLOYER_PRIVATE_KEY**: Currently a test key (needs funded wallet)

## Test Plan

### Phase 1: Pre-Deployment Testing (Current State)
✅ **Completed Tests:**
- Service health checks
- Redis connectivity verification
- RPC endpoint connectivity

**Remaining Tests:**
1. Test message queue processing (with mock messages)
2. Verify error handling for invalid contract addresses
3. Test webhook functionality with dummy endpoints

### Phase 2: Wallet Setup
1. **Create/Fund Deployer Wallet**
   - Generate new private key or use existing test wallet
   - Fund with Sepolia ETH (minimum 0.5 ETH recommended)
   - Update SSM parameter: `/hokusai/development/contracts/deployer_key`

2. **Verify Wallet Balance**
   - Check Sepolia ETH balance
   - Ensure sufficient funds for deployment + operations

### Phase 3: Contract Deployment to Sepolia
1. **Deploy Core Contracts**
   - Deploy ModelRegistry contract
   - Deploy HokusaiToken contract
   - Deploy TokenManager contract
   - Deploy BurnAuction contract

2. **Update SSM Parameters**
   ```bash
   aws ssm put-parameter --name "/hokusai/development/contracts/model_registry_address" \
     --value "<DEPLOYED_ADDRESS>" --overwrite
   
   aws ssm put-parameter --name "/hokusai/development/contracts/token_manager_address" \
     --value "<DEPLOYED_ADDRESS>" --overwrite
   ```

3. **Restart ECS Service**
   ```bash
   aws ecs update-service --cluster hokusai-development \
     --service hokusai-contracts-development --force-new-deployment
   ```

### Phase 4: Integration Testing
1. **Queue Message Processing**
   - Send model_ready message to Redis queue
   - Verify token deployment
   - Check token_deployed message in outbound queue

2. **Contract Interaction Tests**
   - Verify ModelRegistry functions
   - Test token minting/burning through TokenManager
   - Validate access controls

3. **API Integration**
   - Test webhook notifications
   - Verify event logging
   - Check health endpoints report contract connectivity

### Phase 5: Load Testing
1. **Queue Processing Performance**
   - Send batch of 10 model_ready messages
   - Measure processing time
   - Verify all tokens deployed correctly

2. **Error Recovery**
   - Test with insufficient gas
   - Test with invalid model data
   - Verify dead letter queue functionality

## Test Script Requirements

### Environment Variables
```bash
# Sepolia Configuration
export NETWORK="sepolia"
export RPC_URL="https://eth-sepolia.g.alchemy.com/v2/p4ekL3z6khieGFgCH3m-n..."
export DEPLOYER_PRIVATE_KEY="<FUNDED_WALLET_KEY>"
export CHAIN_ID="11155111"

# Contract Addresses (after deployment)
export MODEL_REGISTRY_ADDRESS="<DEPLOYED>"
export TOKEN_MANAGER_ADDRESS="<DEPLOYED>"
export HOKUSAI_TOKEN_ADDRESS="<DEPLOYED>"
export BURN_AUCTION_ADDRESS="<DEPLOYED>"
```

### Test Data
```json
{
  "model_ready_message": {
    "modelId": "test-model-001",
    "name": "Test Model Alpha",
    "symbol": "TMA",
    "initialSupply": "1000000000000000000000",
    "metadata": {
      "description": "Test model for Sepolia deployment",
      "accuracy": 0.95,
      "version": "1.0.0"
    }
  }
}
```

## Success Criteria
- [ ] All contracts deployed to Sepolia
- [ ] Service processes queue messages successfully
- [ ] Tokens created for test models
- [ ] Health checks report healthy with contract connectivity
- [ ] No errors in CloudWatch logs
- [ ] Webhook notifications received
- [ ] Dead letter queue remains empty for valid messages

## Monitoring & Validation
1. **CloudWatch Logs**: Monitor `/ecs/hokusai-contracts-task`
2. **Sepolia Explorer**: Verify contract deployments and transactions
3. **Redis Monitoring**: Check queue depths and processing rates
4. **ECS Metrics**: Monitor CPU/Memory usage during load tests

## Rollback Plan
1. Keep dummy addresses in SSM parameters
2. Redeploy previous ECS task definition
3. Clear Redis queues if needed
4. Document any issues for resolution