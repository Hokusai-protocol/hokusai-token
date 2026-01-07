# Implementation Plan: DeltaOne Simulation Tool

**Linear Ticket**: HOK-71
**Feature**: Add DeltaOne simulation + mint trigger button
**Target Users**: Non-technical team members demoing the system, developers creating tokens
**Integration**: hokus.ai model pages (e.g., `/explore-models/1/chest-x-ray-diagnostic-v2`)

---

## Overview

Build a developer-focused simulation tool that:
1. **Simulates** DeltaOne calculations (read-only, free)
2. **Executes** actual token minting on Sepolia testnet (optional, requires wallet)
3. **Outputs structured JSON** for easy React frontend integration
4. Provides clear feedback for both technical and non-technical users

The tool will be a Node.js/TypeScript utility that the React frontend can call via child process or port to browser-native code using ethers.js.

---

## Current State

### What Exists ✅
- **DeltaVerifier.sol** deployed on Sepolia: `0xbE661fA444A14D87c9e9f20BcC6eaf5fCAF525Bd`
- **TokenManager.sol** deployed on Sepolia: `0xEb81526f1D2c4226cEea08821553f6c8a9c1B431`
- Complete calculation logic in contracts:
  - `calculateDeltaOne(baselineMetrics, newMetrics)` - view function
  - `calculateRewardDynamic(modelId, deltaScore, weight, samples)` - view function
  - `submitEvaluation(modelId, evaluationData)` - state-changing function
- Comprehensive tests with example metrics in `/test` directory
- Deployed contract addresses in README

### What Doesn't Exist ❌
- No simulation tool/script
- No structured output format for frontend consumption
- No user-friendly feedback mechanism
- No integration example for React frontend

---

## Proposed Changes

### New Files to Create

```
tools/
├── deltaone-simulator/
│   ├── index.ts                 # Main entry point
│   ├── simulator.ts             # Core simulation logic
│   ├── executor.ts              # Testnet execution logic
│   ├── types.ts                 # TypeScript interfaces
│   ├── formatters.ts            # Output formatting (JSON + human-readable)
│   ├── examples/
│   │   ├── sample-metrics.json  # Example baseline/new metrics
│   │   └── sample-evaluation.json # Complete evaluation data
│   ├── abis/
│   │   ├── DeltaVerifier.json   # Contract ABI
│   │   └── TokenManager.json    # Contract ABI
│   └── README.md                # Usage documentation
├── package.json                 # Dependencies (ethers.js)
└── tsconfig.json                # TypeScript config
```

### Output Format Specification

**Simulation Output** (JSON):
```json
{
  "simulation": {
    "deltaOneScore": 387,
    "deltaOnePercentage": "3.87%",
    "rewardAmount": "3521.7",
    "rewardFormatted": "3,521.70 tokens",
    "breakdown": {
      "accuracy": { "baseline": 85.4, "new": 88.4, "improvement": 3.0 },
      "precision": { "baseline": 82.7, "new": 85.4, "improvement": 2.7 },
      "recall": { "baseline": 88.7, "new": 91.3, "improvement": 2.6 },
      "f1": { "baseline": 83.9, "new": 89.1, "improvement": 5.2 },
      "auroc": { "baseline": 90.4, "new": 93.5, "improvement": 3.1 }
    },
    "parameters": {
      "tokensPerDeltaOne": 1000,
      "contributorWeight": "91.00%",
      "contributedSamples": 5000,
      "totalSamples": 55000,
      "contributionRatio": "9.09%"
    }
  },
  "metadata": {
    "modelId": "model-123",
    "pipelineRunId": "run_abc123",
    "contributor": "0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9",
    "network": "sepolia",
    "timestamp": "2026-01-07T15:30:00Z"
  },
  "status": "simulated"
}
```

**Execution Output** (JSON):
```json
{
  "execution": {
    "txHash": "0xabc123...",
    "blockNumber": 12345678,
    "gasUsed": "245823",
    "status": "success",
    "tokensMinted": "3521.7",
    "recipient": "0x742d35Cc6631C0532925a3b844D35d2be8b6c6dD9",
    "explorerUrl": "https://sepolia.etherscan.io/tx/0xabc123..."
  },
  "simulation": { /* same as above */ },
  "metadata": { /* same as above */ },
  "status": "executed"
}
```

**Error Output** (JSON):
```json
{
  "error": {
    "code": "INSUFFICIENT_IMPROVEMENT",
    "message": "DeltaOne score (45 bps) below minimum threshold (100 bps)",
    "details": {
      "actualDelta": 45,
      "requiredDelta": 100,
      "improvement": "0.45%"
    }
  },
  "simulation": { /* partial data */ },
  "status": "error"
}
```

---

## Implementation Phases

### Phase 1: Core Simulation Logic (3-4 hours)

**Goal**: Read-only simulation that calculates DeltaOne and rewards

**Tasks**:
1. Set up TypeScript project in `/tools/deltaone-simulator`
2. Install dependencies: `ethers@6`, `dotenv`, `typescript`
3. Create type definitions for metrics, evaluation data, simulation results
4. Implement `Simulator` class:
   - Connect to Sepolia public RPC (no wallet needed)
   - Load DeltaVerifier contract ABI
   - Call `calculateDeltaOne()` with baseline/new metrics
   - Call `calculateRewardDynamic()` with model ID and calculated delta
   - Format results as structured JSON
5. Add breakdown of per-metric improvements
6. Add human-readable formatting (percentages, thousands separators)

**Acceptance Criteria**:
- ✅ Can simulate with sample metrics from tests
- ✅ Output matches expected values from unit tests
- ✅ Handles edge cases (zero improvement, invalid metrics)
- ✅ JSON output is valid and well-structured
- ✅ Gas-free (only view/pure function calls)

**Testing**:
```bash
npm run simulate -- --metrics examples/sample-metrics.json
```

---

### Phase 2: Testnet Execution Logic (2-3 hours)

**Goal**: Optional execution that actually mints tokens on Sepolia

**Tasks**:
1. Implement `Executor` class:
   - Connect to Sepolia with wallet (via private key or browser wallet)
   - Load DeltaVerifier contract with signer
   - Call `submitEvaluation()` with full evaluation data
   - Wait for transaction confirmation
   - Parse events from receipt
   - Extract minted token amount from events
2. Add transaction status tracking
3. Add Etherscan link generation
4. Merge simulation + execution outputs

**Acceptance Criteria**:
- ✅ Can execute on Sepolia with test wallet
- ✅ Tokens actually minted to contributor address
- ✅ Transaction hash returned and verified on Etherscan
- ✅ Gas estimation provided before execution
- ✅ Clear error messages for failed transactions

**Testing**:
```bash
npm run execute -- \
  --evaluation examples/sample-evaluation.json \
  --private-key $SEPOLIA_PRIVATE_KEY
```

---

### Phase 3: CLI Interface & Examples (1-2 hours)

**Goal**: User-friendly command-line interface with examples

**Tasks**:
1. Create CLI parser (using `commander` or `yargs`)
2. Add commands:
   - `simulate` - Read-only calculation
   - `execute` - Actual minting
   - `estimate-gas` - Show gas cost before execution
3. Create example files:
   - `sample-metrics.json` - Baseline/new metrics
   - `sample-evaluation.json` - Complete evaluation data
   - Multiple scenarios (high improvement, low improvement, edge cases)
4. Write comprehensive README with usage examples

**Acceptance Criteria**:
- ✅ CLI has clear help text
- ✅ Examples work out-of-the-box
- ✅ README covers all use cases
- ✅ Error messages are actionable

**Example Usage**:
```bash
# Simulate only (free)
npm run simulate -- --metrics examples/high-improvement.json

# Execute on testnet (requires wallet)
npm run execute -- \
  --evaluation examples/sample-evaluation.json \
  --private-key $SEPOLIA_PRIVATE_KEY

# Estimate gas first
npm run estimate-gas -- --evaluation examples/sample-evaluation.json
```

---

### Phase 4: Frontend Integration Guide (1 hour)

**Goal**: Documentation for React frontend integration

**Tasks**:
1. Create `FRONTEND_INTEGRATION.md` with:
   - How to port simulator to browser (ethers.js examples)
   - Sample React component code
   - API contract for input/output
   - Error handling patterns
2. Provide ethers.js code snippets that work in browser
3. Document wallet connection patterns (MetaMask, WalletConnect)
4. Add loading states and user feedback patterns

**Deliverable**: Complete integration guide that frontend team can follow

**Example React Integration**:
```tsx
import { ethers } from 'ethers';

async function simulateDeltaOne(baselineMetrics, newMetrics) {
  // Connect to Sepolia (public RPC, no wallet)
  const provider = new ethers.JsonRpcProvider(
    'https://ethereum-sepolia-rpc.publicnode.com'
  );

  const deltaVerifier = new ethers.Contract(
    DELTA_VERIFIER_ADDRESS,
    DELTA_VERIFIER_ABI,
    provider
  );

  // Read-only call (free)
  const deltaScore = await deltaVerifier.calculateDeltaOne(
    baselineMetrics,
    newMetrics
  );

  return {
    deltaOneScore: deltaScore.toNumber(),
    deltaOnePercentage: `${(deltaScore / 100).toFixed(2)}%`,
    // ... format other fields
  };
}

async function executeMinting(evaluationData) {
  // Connect user's wallet
  const provider = new ethers.BrowserProvider(window.ethereum);
  const signer = await provider.getSigner();

  const deltaVerifier = new ethers.Contract(
    DELTA_VERIFIER_ADDRESS,
    DELTA_VERIFIER_ABI,
    signer
  );

  // Submit evaluation (costs gas, mints tokens)
  const tx = await deltaVerifier.submitEvaluation(
    modelId,
    evaluationData
  );

  // Wait for confirmation
  const receipt = await tx.wait();

  return {
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    explorerUrl: `https://sepolia.etherscan.io/tx/${receipt.hash}`
  };
}
```

**Acceptance Criteria**:
- ✅ Frontend guide is clear and actionable
- ✅ Code examples work in browser
- ✅ Covers both simulation and execution
- ✅ Includes error handling

---

### Phase 5: Testing & Validation (1-2 hours)

**Goal**: Ensure tool works end-to-end and outputs are correct

**Tasks**:
1. Create automated tests:
   - Simulation with known metrics (compare to test expectations)
   - JSON schema validation
   - Error handling scenarios
2. Manual testing on Sepolia:
   - Simulate with various metrics
   - Execute actual minting
   - Verify tokens received
   - Test with invalid inputs
3. Document test results

**Test Scenarios**:
- ✅ High improvement (>5%) → Large reward
- ✅ Low improvement (<1%) → Small reward
- ✅ Below threshold → Error with clear message
- ✅ Invalid metrics → Validation error
- ✅ Network issues → Graceful degradation

**Acceptance Criteria**:
- ✅ All automated tests pass
- ✅ Manual testing confirms tokens minted
- ✅ Output format validated against schema
- ✅ Edge cases handled gracefully

---

## Success Criteria

### Automated Checks
- [ ] TypeScript compiles without errors
- [ ] All unit tests pass
- [ ] JSON output validates against schema
- [ ] Simulation results match test expectations
- [ ] CLI commands execute without errors

### Manual Verification
- [ ] Simulate with sample metrics → Correct deltaOne score
- [ ] Execute on Sepolia → Tokens minted to recipient
- [ ] Check Etherscan → Transaction confirmed
- [ ] Frontend team confirms integration guide is clear
- [ ] Non-technical user can run simulation and understand output

### Integration Readiness
- [ ] Output format documented and stable
- [ ] ABIs exported and accessible
- [ ] Examples cover common use cases
- [ ] Error messages are user-friendly
- [ ] README has clear installation/usage instructions

---

## Out of Scope

**NOT building in this phase**:
- ❌ Full React frontend application (hokus.ai integration done by frontend team)
- ❌ Backend API wrapper (tool is standalone, can be wrapped later)
- ❌ Mainnet deployment (Sepolia testnet only for now)
- ❌ Advanced wallet integrations (MetaMask support only)
- ❌ Historical data tracking (just real-time simulation/execution)
- ❌ Multi-chain support (Sepolia only)

These can be added later if needed, but are not required for the Linear ticket.

---

## Dependencies

### External
- `ethers@6` - Ethereum library
- `typescript` - Type safety
- `dotenv` - Environment variables
- `commander` or `yargs` - CLI parsing

### Internal (Already Exists)
- DeltaVerifier contract ABI (from `/artifacts`)
- TokenManager contract ABI (from `/artifacts`)
- Deployed contract addresses (from README)
- Test data (from `/test` directory)

---

## Timeline Estimate

| Phase | Effort | Priority |
|-------|--------|----------|
| 1. Core Simulation | 3-4 hours | P0 |
| 2. Execution Logic | 2-3 hours | P0 |
| 3. CLI Interface | 1-2 hours | P1 |
| 4. Frontend Guide | 1 hour | P1 |
| 5. Testing | 1-2 hours | P2 |
| **Total** | **8-12 hours** | **~1-1.5 days** |

**Recommended approach**: Build phases sequentially, testing each before moving to next.

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Sepolia RPC rate limits | Medium | Use multiple public RPCs as fallbacks |
| Contract ABI changes | Low | ABIs are stable, version-locked in repo |
| Frontend integration unclear | Medium | Work with frontend team during Phase 4 |
| Testnet gas costs | Low | Use faucet, document funding process |
| Output format changes | Medium | Version output schema, support backwards compat |

---

## Next Steps

1. **Review & Approve**: Confirm this plan meets requirements
2. **Create Feature Branch**: `git checkout -b feature/deltaone-simulation`
3. **Begin Phase 1**: Set up TypeScript project and core simulation
4. **Iterate**: Complete phases sequentially with testing

---

## Confirmed Requirements ✅

1. **Wallet Integration**: MetaMask browser extension support
2. **Network**: Sepolia testnet only
3. **Output Format**: Proposed JSON structure approved
4. **Access Control**:
   - Testnet: Anyone can execute minting (open for demos/testing)
   - Production: Simulation only (no actual minting)
5. **Deployment**: No npm package needed (internal tool only)

**Plan approved and ready for implementation.**

Use `/implement-plan` command to begin execution with validation gates.
