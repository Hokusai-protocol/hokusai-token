# DataContributionRegistry Deployment Guide

This guide covers deploying the DataContributionRegistry system to Sepolia testnet.

## Overview

The DataContributionRegistry tracks data contributions to ML models and their attribution weights. It integrates with DeltaVerifier to automatically record contributions when tokens are minted.

## Prerequisites

- Funded Sepolia wallet (deployer)
- Environment variables configured in `.env`:
  ```
  DEPLOYER_PRIVATE_KEY=<your_private_key>
  SEPOLIA_RPC_URL=<your_rpc_url>
  ```

## Deployment Options

### Option 1: Fresh Deployment (Recommended)

Deploy all contracts including the registry from scratch.

```bash
npx hardhat run scripts/deploy-with-registry.js --network sepolia
```

**What this does:**
1. Deploys ModelRegistry
2. Deploys TokenManager
3. Deploys DataContributionRegistry ✨
4. Deploys HokusaiToken with HokusaiParams
5. Deploys DeltaVerifier (with registry integration)
6. Configures all access control roles
7. Registers model in ModelRegistry

**Output:** `deployment-sepolia-with-registry.json`

### Option 2: Add Registry to Existing Deployment

If you already have contracts deployed and want to add the registry:

```bash
npx hardhat run scripts/deploy-registry-only.js --network sepolia
```

**Important:** This requires redeploying DeltaVerifier because the existing one doesn't have the registry parameter in its constructor.

**What this does:**
1. Deploys DataContributionRegistry only
2. Grants RECORDER_ROLE to DeltaVerifier (if address provided)
3. Grants VERIFIER_ROLE to deployer

**Output:** `deployment-registry-only.json`

**Next Steps After Option 2:**
1. Deploy new DeltaVerifier with registry address
2. Update TokenManager to point to new DeltaVerifier
3. Update backend configuration

## Access Control Roles

### RECORDER_ROLE
- **Granted to**: DeltaVerifier contract
- **Purpose**: Record contributions when evaluations are submitted
- **Required**: Yes (automatic during evaluation)

### VERIFIER_ROLE
- **Granted to**: Backend service address (deployer by default)
- **Purpose**: Verify or reject contributions for audit/governance
- **Required**: No (verification is optional)

### DEFAULT_ADMIN_ROLE
- **Granted to**: Deployer address
- **Purpose**: Grant/revoke other roles, transfer admin
- **Required**: Yes (deployment only)

## Configuration

### Environment Variables

Add to your `.env` file:

```env
# Blockchain
DEPLOYER_PRIVATE_KEY=0x...
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com

# Contract Addresses (after deployment)
CONTRIBUTION_REGISTRY_ADDRESS=0x...
DELTA_VERIFIER_ADDRESS=0x...
TOKEN_MANAGER_ADDRESS=0x...
MODEL_REGISTRY_ADDRESS=0x...
```

### Backend Service

Update your backend service configuration:

```javascript
// services/contract-deployer/config.js
module.exports = {
  contracts: {
    contributionRegistry: process.env.CONTRIBUTION_REGISTRY_ADDRESS,
    deltaVerifier: process.env.DELTA_VERIFIER_ADDRESS,
    // ... other contracts
  }
};
```

## Verification

### Verify Contracts on Etherscan

```bash
# Verify DataContributionRegistry
npx hardhat verify --network sepolia <CONTRIBUTION_REGISTRY_ADDRESS>

# Verify DeltaVerifier (with all constructor args)
npx hardhat verify --network sepolia <DELTA_VERIFIER_ADDRESS> \
  <MODEL_REGISTRY_ADDRESS> \
  <TOKEN_MANAGER_ADDRESS> \
  <CONTRIBUTION_REGISTRY_ADDRESS> \
  1000 \
  100 \
  1000000000000000000000000
```

### Test Integration

Run a test evaluation to verify contribution recording:

```bash
# In your backend service or test script
const evaluation = {
  pipelineRunId: "test_run_001",
  baselineMetrics: { accuracy: 8500, precision: 8200, ... },
  newMetrics: { accuracy: 8800, precision: 8500, ... },
  contributor: "0x...",
  contributorWeight: 10000,
  contributedSamples: 1000,
  totalSamples: 1000
};

// Submit evaluation (this will automatically record contribution)
await deltaVerifier.submitEvaluation(modelId, evaluation);

// Query contribution
const count = await contributionRegistry.getModelContributionCount(modelId);
console.log(`Contributions recorded: ${count}`);

const contribution = await contributionRegistry.getContribution(1);
console.log(`Contributor: ${contribution.contributor}`);
console.log(`Tokens earned: ${ethers.formatEther(contribution.tokensEarned)}`);
```

## Troubleshooting

### "AccessControl: account is missing role"

**Problem**: DeltaVerifier doesn't have RECORDER_ROLE

**Solution**:
```javascript
const registry = await ethers.getContractAt('DataContributionRegistry', REGISTRY_ADDRESS);
const RECORDER_ROLE = await registry.RECORDER_ROLE();
await registry.grantRole(RECORDER_ROLE, DELTA_VERIFIER_ADDRESS);
```

### "Invalid contribution registry"

**Problem**: DeltaVerifier deployed without registry parameter

**Solution**: Redeploy DeltaVerifier with registry address in constructor (3rd parameter)

### Gas Estimation Issues

**Problem**: Transaction runs out of gas

**Solution**: The registry adds ~34k-100k gas per evaluation. Ensure your gas limits account for this:
- Single contributor: ~534k gas
- Multiple contributors (2): ~921k gas
- Batch (100 contributors): ~estimate 5-10M gas

## Security Considerations

### Role Management

1. **RECORDER_ROLE** should only be granted to DeltaVerifier
   - Never grant to EOAs or untrusted contracts
   - This role can write contribution data

2. **VERIFIER_ROLE** should be granted to trusted backend service
   - Used for governance/audit functions
   - Can mark contributions as verified/rejected

3. **DEFAULT_ADMIN_ROLE** should be transferred to governance
   - Consider using a multisig for production
   - Can grant/revoke all roles

### Access Pattern

```
                         ┌─────────────────┐
                         │   ML Pipeline   │
                         └────────┬────────┘
                                  │
                         Evaluation Data
                                  │
                                  ▼
┌──────────────┐        ┌─────────────────┐
│   Frontend   │───────▶│  DeltaVerifier  │
└──────────────┘        └────────┬────────┘
                                  │
                    ┌─────────────┴──────────────┐
                    │                             │
                    ▼                             ▼
          ┌──────────────────┐         ┌──────────────────┐
          │  TokenManager    │         │ Contribution     │
          │  (Mint Tokens)   │         │ Registry         │
          └──────────────────┘         │ (Record Data)    │
                                       └──────────────────┘
                                                │
                                                ▼
                                       ┌──────────────────┐
                                       │  Backend Service │
                                       │  (Query/Verify)  │
                                       └──────────────────┘
```

## Gas Optimization Tips

1. **Batch operations**: Use multi-contributor evaluations when possible
2. **Off-chain queries**: Use view functions for analytics (free)
3. **Event indexing**: Use subgraph or backend to index ContributionRecorded events
4. **Pagination**: Always use offset/limit parameters for large result sets

## Monitoring

### Key Metrics to Track

- Total contributions recorded
- Contributions per model
- Unique contributors
- Total tokens distributed
- Average contribution size

### Query Examples

```javascript
// Total contributions for a model
const count = await registry.getModelContributionCount(modelId);

// Contributor statistics
const [contributions, tokens, samples] =
  await registry.getContributorStatsForModel(modelId, contributorAddress);

// Global contributor stats
const [totalContributions, totalTokens, modelsCount] =
  await registry.getContributorGlobalStats(contributorAddress);

// Check if someone contributed
const hasContributed = await registry.hasContributedToModel(modelId, address);
```

## Support

For issues or questions:
- GitHub Issues: [hokusai-token/issues](https://github.com/your-org/hokusai-token/issues)
- Documentation: [CLAUDE.md](../CLAUDE.md)
- Linear: HOK-33 - Data Contribution Registry
