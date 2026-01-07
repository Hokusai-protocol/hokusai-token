# Implementation Plan: Data Contribution Registry

**Linear Issue**: HOK-33
**Feature**: Data Contribution Registry
**Target**: Track data contributors and their weighted claims for token rewards
**Integration**: DeltaVerifier, TokenManager, ML Pipeline

---

## Overview

Build a smart contract registry that records data contributions to ML models, tracking contributor addresses, attribution weights, and contribution metadata. When models are retrained and performance improves, the registry enables proportional token reward distribution to contributors based on their calculated impact.

### Core Functionality
1. **Register contributions** with hashed identifiers, contributor addresses, and metadata
2. **Store attribution weights** calculated by off-chain ML pipeline
3. **Enable queries** for contribution history, contributor records, and model-specific contributions
4. **Integrate with DeltaVerifier** to record contributions during token minting
5. **Support batch operations** for gas efficiency with multiple contributors per evaluation

---

## Current State

### What Exists ✅

**Smart Contracts:**
- **ModelRegistry.sol**: Registry pattern with struct storage, multi-mappings, auto-incrementing IDs
- **DeltaVerifier.sol**: Already has `submitEvaluationWithMultipleContributors()` (lines 145-203)
  - Accepts arrays of contributors with weights
  - Validates weights sum to 100% (10000 basis points)
  - Calls TokenManager.batchMintTokens() for distribution
  - **BUT**: No persistence of contribution data
- **TokenManager.sol**: Batch minting infrastructure (lines 222-253)
  - Supports up to 100 recipients per transaction
  - Role-based access (MINTER_ROLE)
  - DeltaVerifier pre-authorized

**ML Pipeline Schema** (from hokusai-data-pipeline):
```json
{
  "contributor_id": "optional identifier",
  "wallet_address": "0x Ethereum address",
  "data_hash": "SHA-256 hash",
  "data_manifest": {
    "source_path": "data file path",
    "data_hash": "SHA-256 hash",
    "row_count": 5000,
    "column_count": 5,
    "columns": ["feature names"]
  },
  "contributor_weights": 0.091,
  "contributed_samples": 5000,
  "total_samples": 55000,
  "validation_status": "valid|invalid|pending|unknown"
}
```

### What Doesn't Exist ❌

- No persistent storage of contribution data
- No historical tracking of contributor participation
- No on-chain verification of contribution hashes
- No registry interface for querying contribution history
- No integration between DeltaVerifier and a contribution tracking system

---

## Proposed Changes

### New Contracts to Create

#### 1. DataContributionRegistry.sol
**Purpose**: Central registry for tracking data contributions and attribution

**Core Data Structures**:
```solidity
struct ContributionRecord {
    string modelId;                    // Model identifier (string, matches DeltaVerifier)
    address contributor;               // Ethereum address of contributor
    bytes32 contributionHash;          // SHA-256 hash of contribution data
    uint256 contributorWeightBps;      // Attribution weight in basis points (0-10000)
    uint256 contributedSamples;        // Number of data samples contributed
    uint256 totalSamples;              // Total samples in training set
    uint256 tokensEarned;              // Tokens minted for this contribution
    uint256 timestamp;                 // Block timestamp of registration
    string pipelineRunId;              // ML pipeline execution reference
    ContributionStatus status;         // pending, verified, claimed, rejected
}

enum ContributionStatus {
    Pending,
    Verified,
    Claimed,
    Rejected
}
```

**Storage Mappings**:
```solidity
// Primary storage
mapping(uint256 => ContributionRecord) public contributions;
mapping(uint256 => bool) public isContributionRegistered;
uint256 public nextContributionId = 1;

// Lookup indices
mapping(string => uint256[]) public modelContributions;      // modelId => contributionIds
mapping(address => uint256[]) public contributorRecords;     // contributor => contributionIds
mapping(bytes32 => uint256) public hashToContribution;       // hash => contributionId

// Aggregate tracking
mapping(string => mapping(address => uint256)) public contributorTotalTokens;  // modelId => contributor => total tokens
mapping(address => uint256) public contributorGlobalTokens;                    // contributor => all-time tokens
```

**Core Functions**:
```solidity
// Recording (restricted to authorized callers)
function recordContribution(
    string memory modelId,
    address contributor,
    bytes32 contributionHash,
    uint256 weightBps,
    uint256 contributedSamples,
    uint256 totalSamples,
    uint256 tokensEarned,
    string memory pipelineRunId
) external onlyRole(RECORDER_ROLE) returns (uint256 contributionId)

function recordContributionBatch(
    string memory modelId,
    address[] memory contributors,
    bytes32[] memory contributionHashes,
    uint256[] memory weightsBps,
    uint256[] memory contributedSamples,
    uint256 totalSamples,
    uint256[] memory tokensEarned,
    string memory pipelineRunId
) external onlyRole(RECORDER_ROLE) returns (uint256[] memory contributionIds)

// Status Management
function verifyContribution(uint256 contributionId) external onlyRole(VERIFIER_ROLE)
function rejectContribution(uint256 contributionId, string memory reason) external onlyRole(VERIFIER_ROLE)

// Query Functions (paginated for gas efficiency)
function getContribution(uint256 contributionId) external view returns (ContributionRecord memory)
function getContributionsByModel(string memory modelId, uint256 offset, uint256 limit) external view returns (ContributionRecord[] memory)
function getContributionsByContributor(address contributor, uint256 offset, uint256 limit) external view returns (ContributionRecord[] memory)
function getContributorStatsForModel(string memory modelId, address contributor) external view returns (uint256 totalContributions, uint256 totalTokens, uint256 totalSamples)
function getContributorGlobalStats(address contributor) external view returns (uint256 totalContributions, uint256 totalTokens, uint256 modelsContributedTo)

// Verification
function verifyContributionHash(bytes32 contributionHash) external view returns (bool exists, uint256 contributionId)
function hasContributedToModel(string memory modelId, address contributor) external view returns (bool)
```

**Events**:
```solidity
event ContributionRecorded(
    uint256 indexed contributionId,
    string indexed modelId,
    address indexed contributor,
    bytes32 contributionHash,
    uint256 weightBps,
    uint256 tokensEarned,
    string pipelineRunId
);

event ContributionVerified(uint256 indexed contributionId, address verifier);
event ContributionRejected(uint256 indexed contributionId, string reason);
event RecorderAuthorized(address indexed recorder);
event RecorderRevoked(address indexed recorder);
```

**Access Control**:
```solidity
// Using OpenZeppelin AccessControl
bytes32 public constant RECORDER_ROLE = keccak256("RECORDER_ROLE");
bytes32 public constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");

// DeltaVerifier gets RECORDER_ROLE
// Admin/backend service gets VERIFIER_ROLE
```

#### 2. IDataContributionRegistry.sol
**Purpose**: Interface for external contract integration

```solidity
interface IDataContributionRegistry {
    function recordContributionBatch(
        string memory modelId,
        address[] memory contributors,
        bytes32[] memory contributionHashes,
        uint256[] memory weightsBps,
        uint256[] memory contributedSamples,
        uint256 totalSamples,
        uint256[] memory tokensEarned,
        string memory pipelineRunId
    ) external returns (uint256[] memory contributionIds);

    function hasContributedToModel(string memory modelId, address contributor) external view returns (bool);
    function getContributorStatsForModel(string memory modelId, address contributor) external view returns (uint256, uint256, uint256);
}
```

### Contracts to Modify

#### 3. DeltaVerifier.sol
**Changes**:
1. Add immutable reference to DataContributionRegistry (line ~107)
2. Add registry recording after token minting in `submitEvaluationWithMultipleContributors()` (line ~195)
3. Update constructor to accept registry address
4. Emit additional events for contribution tracking

**Integration Point** (line 195):
```solidity
// After: tokenManager.batchMintTokens(modelId, contributorAddresses, rewardAmounts);

// Record contributions in registry
bytes32[] memory contributionHashes = new bytes32[](contributorAddresses.length);
for (uint i = 0; i < contributorAddresses.length; i++) {
    contributionHashes[i] = keccak256(abi.encodePacked(
        modelId,
        contributorAddresses[i],
        evaluationData.pipelineRunId,
        block.timestamp
    ));
}

contributionRegistry.recordContributionBatch(
    modelId,
    contributorAddresses,
    contributionHashes,
    contributorWeights,
    contributedSamples,
    totalSamples,
    rewardAmounts,
    evaluationData.pipelineRunId
);
```

---

## Implementation Phases

### Phase 1: Core Registry Contract (4-6 hours)

**Goal**: Implement DataContributionRegistry with storage and recording functions

**Tasks**:
1. Create contract file with data structures and storage mappings
2. Implement `recordContribution()` and `recordContributionBatch()` functions
3. Add access control using OpenZeppelin AccessControl
4. Implement basic view functions (getContribution, verify hash)
5. Add comprehensive events
6. Write unit tests for recording and storage

**Acceptance Criteria**:
- ✅ Can record single and batch contributions
- ✅ Proper access control (only RECORDER_ROLE can record)
- ✅ All mappings updated correctly (primary, model index, contributor index)
- ✅ Events emitted with correct data
- ✅ Gas < 150k for single record, < 100k per item for batch
- ✅ Unit tests cover all recording scenarios

**Testing**:
```javascript
describe("DataContributionRegistry - Recording", () => {
  it("should record a single contribution with correct data")
  it("should record batch contributions efficiently")
  it("should revert if non-recorder tries to record")
  it("should update all mappings correctly")
  it("should emit ContributionRecorded events")
  it("should handle duplicate hashes gracefully")
});
```

---

### Phase 2: Query & Analytics Functions (3-4 hours)

**Goal**: Implement comprehensive query functions with pagination

**Tasks**:
1. Implement `getContributionsByModel()` with pagination
2. Implement `getContributionsByContributor()` with pagination
3. Add aggregate statistics functions (contributorStatsForModel, globalStats)
4. Implement verification helpers (hasContributedToModel, verifyHash)
5. Optimize for gas efficiency (view functions)
6. Write tests for all query patterns

**Acceptance Criteria**:
- ✅ Pagination works correctly (offset/limit)
- ✅ Statistics match actual contribution data
- ✅ Gas < 5k for single lookups, efficient batch queries
- ✅ Edge cases handled (empty results, out of bounds)
- ✅ All view functions tested

**Testing**:
```javascript
describe("DataContributionRegistry - Queries", () => {
  it("should return contributions for a model with pagination")
  it("should return contributor history with pagination")
  it("should calculate correct aggregate statistics")
  it("should verify contribution hashes")
  it("should handle edge cases (empty, out of bounds)")
});
```

---

### Phase 3: Status Management & Verification (2-3 hours)

**Goal**: Add contribution verification workflow

**Tasks**:
1. Implement `verifyContribution()` and `rejectContribution()`
2. Add VERIFIER_ROLE access control
3. Add status transition logic and validation
4. Emit verification events
5. Write tests for verification workflow

**Acceptance Criteria**:
- ✅ Only VERIFIER_ROLE can verify/reject
- ✅ Status transitions validated (pending → verified/rejected)
- ✅ Cannot verify already verified/rejected contributions
- ✅ Events emitted correctly
- ✅ All status transitions tested

**Testing**:
```javascript
describe("DataContributionRegistry - Verification", () => {
  it("should verify pending contributions")
  it("should reject contributions with reason")
  it("should revert invalid status transitions")
  it("should only allow VERIFIER_ROLE")
});
```

---

### Phase 4: DeltaVerifier Integration (3-4 hours)

**Goal**: Integrate registry with existing DeltaVerifier contract

**Tasks**:
1. Create IDataContributionRegistry interface
2. Modify DeltaVerifier constructor to accept registry address
3. Add registry recording calls in `submitEvaluationWithMultipleContributors()`
4. Generate contribution hashes deterministically
5. Update deployment scripts
6. Write integration tests

**Acceptance Criteria**:
- ✅ DeltaVerifier successfully records contributions after minting
- ✅ Integration doesn't break existing functionality
- ✅ Contribution hashes generated consistently
- ✅ Gas increase is acceptable (< 200k total for batch mint + record)
- ✅ Integration tests pass

**Testing**:
```javascript
describe("DeltaVerifier - Registry Integration", () => {
  it("should record contributions when minting tokens")
  it("should handle single contributor evaluation")
  it("should handle multi-contributor evaluation")
  it("should generate consistent contribution hashes")
  it("should maintain backward compatibility")
});
```

---

### Phase 5: Deployment & Migration (2-3 hours)

**Goal**: Deploy contracts and configure access control

**Tasks**:
1. Write deployment script for DataContributionRegistry
2. Deploy to Sepolia testnet
3. Grant RECORDER_ROLE to DeltaVerifier
4. Grant VERIFIER_ROLE to backend service address
5. Update contract addresses in documentation
6. Test on Sepolia with real transactions

**Acceptance Criteria**:
- ✅ Registry deployed successfully
- ✅ Roles configured correctly
- ✅ DeltaVerifier can record contributions
- ✅ Backend service can verify contributions
- ✅ Integration works end-to-end on testnet
- ✅ Documentation updated

**Deployment Script**:
```javascript
// scripts/deploy-contribution-registry.js
const registry = await DataContributionRegistry.deploy();
await registry.grantRole(RECORDER_ROLE, deltaVerifierAddress);
await registry.grantRole(VERIFIER_ROLE, backendServiceAddress);
```

---

### Phase 6: Backend Service Integration (3-4 hours)

**Goal**: Update backend to interact with registry

**Tasks**:
1. Add registry ABI to services/contract-deployer
2. Create registry service wrapper (like ModelRegistry service)
3. Add query endpoints for contribution data
4. Implement verification workflow in backend
5. Add contribution tracking to deployment flow
6. Write service tests

**Acceptance Criteria**:
- ✅ Backend can query contribution data
- ✅ Backend can verify contributions
- ✅ API endpoints for contribution history
- ✅ Integration with existing deployment service
- ✅ Service tests pass

**New API Endpoints**:
```
GET /api/contributions/model/:modelId
GET /api/contributions/contributor/:address
GET /api/contributions/:contributionId
POST /api/contributions/:contributionId/verify
POST /api/contributions/:contributionId/reject
```

---

### Phase 7: Testing & Documentation (2-3 hours)

**Goal**: Comprehensive testing and user documentation

**Tasks**:
1. Write integration tests covering full flow
2. Test gas consumption and optimize if needed
3. Write user documentation for contribution tracking
4. Create developer guide for registry queries
5. Add contribution tracking to Hokusai token metadata docs
6. Test edge cases and failure modes

**Acceptance Criteria**:
- ✅ 100% test coverage on critical functions
- ✅ Gas benchmarks within targets
- ✅ Documentation clear and complete
- ✅ Edge cases handled gracefully
- ✅ All phases tested end-to-end

**Test Scenarios**:
- ✅ Single contributor evaluation → contribution recorded
- ✅ Multi-contributor evaluation → all contributions recorded
- ✅ High-volume contributions (100+ per model)
- ✅ Concurrent contributions from same contributor
- ✅ Query performance with large datasets
- ✅ Role-based access control enforcement

---

## Success Criteria

### Automated Checks
- [ ] All Solidity contracts compile without errors
- [ ] 100% test coverage on DataContributionRegistry
- [ ] All unit tests pass
- [ ] All integration tests pass
- [ ] Gas benchmarks within targets:
  - Single record: < 150k gas
  - Batch record: < 100k per item
  - Queries: < 5k gas
- [ ] No security vulnerabilities (Slither analysis)

### Manual Verification
- [ ] Deploy registry to Sepolia testnet
- [ ] Record test contribution via DeltaVerifier
- [ ] Query contribution data from backend
- [ ] Verify contribution via backend service
- [ ] Check contribution history for test model
- [ ] Confirm aggregate statistics are correct

### Integration Readiness
- [ ] DeltaVerifier integration complete
- [ ] Backend service can query/verify contributions
- [ ] API endpoints documented
- [ ] Frontend can display contribution history
- [ ] ML pipeline schema matches contract expectations

---

## Data Flow

### Contribution Recording Flow
```
1. ML Pipeline retrains model with data from multiple contributors
2. Pipeline calculates attribution (e.g., Contributor A: 60%, B: 40%)
3. Pipeline submits evaluation to DeltaVerifier with:
   - contributorAddresses: [0xA..., 0xB...]
   - contributorWeights: [6000, 4000] (basis points)
   - contributedSamples: [3000, 2000]
   - totalSamples: 5000
   - pipelineRunId: "run_abc123"

4. DeltaVerifier.submitEvaluationWithMultipleContributors():
   a. Validates evaluation data
   b. Calculates DeltaOne score
   c. Calculates token rewards per contributor
   d. Calls TokenManager.batchMintTokens()
   e. **NEW**: Calls ContributionRegistry.recordContributionBatch()

5. ContributionRegistry:
   a. Generates contribution hashes
   b. Stores ContributionRecord for each contributor
   c. Updates all indices (model, contributor, hash)
   d. Updates aggregate statistics
   e. Emits ContributionRecorded events

6. Backend service:
   a. Listens for ContributionRecorded events
   b. Optionally verifies contributions
   c. Updates off-chain database
   d. Displays contribution history to users
```

### Query Flow
```
1. User visits hokus.ai/models/chest-xray
2. Frontend queries: GET /api/contributions/model/chest-xray
3. Backend service calls: registry.getContributionsByModel()
4. Returns paginated list of contributions with:
   - Contributor addresses
   - Tokens earned
   - Sample counts
   - Timestamps
   - Verification status
5. Frontend displays contribution leaderboard
```

---

## Out of Scope

**NOT building in this phase:**
- ❌ Contribution claim mechanism (rewards are pushed, not pulled)
- ❌ Dispute resolution system (handled off-chain initially)
- ❌ Historical data migration (only tracks from deployment forward)
- ❌ Advanced attribution algorithms (calculated off-chain by ML pipeline)
- ❌ NFT minting for contributions (future enhancement)
- ❌ Governance over contribution verification (manual for now)
- ❌ Cross-chain contribution tracking (single chain only)
- ❌ Privacy-preserving contribution hashes (standard SHA-256 for now)

These can be added in future iterations based on user feedback and requirements.

---

## Security Considerations

### Critical Requirements
1. **Access Control**: Only authorized contracts (DeltaVerifier) can record contributions
2. **Weight Validation**: Contribution weights must sum to 100% (validated in DeltaVerifier)
3. **Hash Uniqueness**: Prevent duplicate contribution hashes
4. **Status Transitions**: Enforce valid state transitions (pending → verified/rejected)
5. **Batch Size Limits**: Follow 100-item limit to prevent gas exhaustion
6. **Pagination**: All array returns must be paginated to prevent DoS
7. **Immutable History**: Contributions cannot be deleted, only status updated

### Audit Focus Areas
- Access control on recording functions
- Storage mapping consistency
- Array length validations (batch operations)
- Event data integrity
- Gas consumption in batch operations
- Status transition logic
- Query result accuracy (pagination edge cases)

---

## Dependencies

### Existing (Already Deployed)
- ✅ ModelRegistry.sol - Pattern reference
- ✅ DeltaVerifier.sol - Integration point
- ✅ TokenManager.sol - Batch minting infrastructure
- ✅ HokusaiToken.sol - Token contract

### External (OpenZeppelin)
- @openzeppelin/contracts/access/AccessControl.sol
- @openzeppelin/contracts/security/ReentrancyGuard.sol (if needed)

### Backend Services
- Contract-deployer service (for registry queries)
- ML Pipeline (hokusai-data-pipeline) for contribution data

---

## ML Pipeline Integration

### Expected Input Format (from ML Pipeline)
Based on hokusai-data-pipeline schema:

```json
{
  "modelId": "chest-xray-v2",
  "pipelineRunId": "run_abc123",
  "totalSamples": 55000,
  "contributors": [
    {
      "wallet_address": "0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9",
      "contributor_weights": 0.091,
      "contributed_samples": 5000,
      "data_hash": "0xabc123...",
      "validation_status": "valid"
    },
    {
      "wallet_address": "0x123...",
      "contributor_weights": 0.909,
      "contributed_samples": 50000,
      "data_hash": "0xdef456...",
      "validation_status": "valid"
    }
  ],
  "baseline_metrics": {"accuracy": 0.85, "auroc": 0.90},
  "improved_metrics": {"accuracy": 0.92, "auroc": 0.95}
}
```

### Contract Data Transformation
```javascript
// In DeltaVerifier, transform ML pipeline data:
const contributorAddresses = contributors.map(c => c.wallet_address);
const contributorWeights = contributors.map(c => Math.floor(c.contributor_weights * 10000));
const contributedSamples = contributors.map(c => c.contributed_samples);
const contributionHashes = contributors.map(c => c.data_hash);
```

---

## Estimated Timeline

**Total Effort**: 19-27 hours (~2.5-3.5 days)

| Phase | Effort | Priority |
|-------|--------|----------|
| 1. Core Registry | 4-6 hours | P0 (foundation) |
| 2. Query Functions | 3-4 hours | P0 (required) |
| 3. Verification | 2-3 hours | P1 (important) |
| 4. DeltaVerifier Integration | 3-4 hours | P0 (critical) |
| 5. Deployment | 2-3 hours | P0 (required) |
| 6. Backend Integration | 3-4 hours | P1 (API) |
| 7. Testing & Docs | 2-3 hours | P1 (quality) |

**Parallel Work Opportunities**:
- Phase 2 (Queries) can be built alongside Phase 1 tests
- Phase 6 (Backend) can start during Phase 4-5
- Documentation (Phase 7) can be written incrementally

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Gas costs too high for batch recording | High | Optimize storage, use events for historical data, implement optional recording |
| ML pipeline schema changes | Medium | Version contract interface, maintain backward compatibility |
| Large array queries cause gas issues | Medium | Implement pagination, limit query sizes, use events for historical queries |
| DeltaVerifier integration breaks existing flow | High | Thorough integration tests, maintain backward compatibility, feature flag |
| Contributor address spoofing | High | Trust ML pipeline validation, verify in backend before on-chain recording |

---

## Confirmed Decisions ✅

1. **Recording Frequency**: ✅ Record ALL successful evaluations that mint tokens
   - DeltaVerifier already filters insufficient improvements
   - If tokens are minted, contribution must be recorded for transparency
   - Status field allows additional verification/auditing later

2. **Historical Data**: ✅ Start fresh from deployment
   - No backfill of previous contributions
   - Registry tracks from deployment forward only

3. **Backend Service Address**: ✅ Use DEPLOYER_PRIVATE_KEY address for VERIFIER_ROLE
   - **Testnet (Sepolia)**: Use same address as deployer for simplicity
   - **Production**: Consider separate VERIFIER_PRIVATE_KEY for security
   - Role can be transferred later via `grantRole()` / `revokeRole()`

4. **Contribution Hash Format**: Store both ML pipeline hash and on-chain generated hash
   - ML pipeline provides `data_hash` in contribution data
   - Contract generates deterministic hash for on-chain verification

5. **Verification Workflow**: ✅ After token minting (optional audit step)
   - Tokens minted first (push model, automatic)
   - Contributions recorded with `status: Pending`
   - Backend service can verify later if needed

6. **Privacy**: ✅ Fully public on-chain
   - Contribution hashes publicly visible
   - Privacy preserved by storing hashes, not raw data

---

## Next Steps

1. ✅ **Review & Approve**: Plan confirmed and approved
2. **Create Feature Branch**: `git checkout -b feature/data-contribution-registry`
3. **Begin Phase 1**: Implement core DataContributionRegistry contract
4. **Iterate**: Complete phases sequentially with testing after each
5. **Deploy to Sepolia**: Test integration with deployed contracts
6. **Update Documentation**: Add registry to codebase-map.md

---

## Related Documentation

- **ML Pipeline Schema**: [hokusai-data-pipeline README](https://github.com/Hokusai-protocol/hokusai-data-pipeline)
- **DeltaVerifier Integration**: [contracts/DeltaVerifier.sol:145-203](../../contracts/DeltaVerifier.sol)
- **Registry Pattern**: [contracts/ModelRegistry.sol](../../contracts/ModelRegistry.sol)
- **Batch Minting**: [contracts/TokenManager.sol:222-253](../../contracts/TokenManager.sol)
- **Linear Issue**: HOK-33 - Data Contribution Registry

---

## Implementation Approved ✅

All decisions confirmed:
- ✅ ML pipeline output format matches expectations
- ✅ Backend service address for VERIFIER_ROLE (use DEPLOYER_PRIVATE_KEY)
- ✅ Recording happens for all successful evaluations
- ✅ Privacy requirements confirmed (fully public hashes)
- ✅ Timeline and phasing approach approved

**Ready to begin implementation.**

Use `/implement-plan` command to execute this plan with validation gates.
