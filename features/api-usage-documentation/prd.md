# PRD: API Usage Patterns Documentation

## Objective

Create comprehensive developer documentation for the Hokusai Token system covering three distinct audiences: smart contract integrators, backend service developers, and frontend developers. The documentation will enable each audience to efficiently integrate with the protocol by providing clear patterns, code examples, and troubleshooting guidance.

## Background

The Hokusai Token system has grown to include AMM functionality, fee collection, ML verification, and analytics capabilities. While the README.md provides basic API documentation, developers need audience-specific guides that address their integration patterns, common pitfalls, and performance considerations. The recent Phase 7 analytics implementation added view functions specifically designed for frontend efficiency, warranting dedicated documentation.

## Success Criteria

1. Smart contract integrators can deploy new pools and integrate with existing tokens following clear deployment sequences
2. Backend developers can implement fee collection and ML validation flows with proper authentication
3. Frontend developers can build UIs using view functions with correct decimal handling and event filtering
4. All three audiences have working code examples in their preferred language (Solidity/TypeScript/JavaScript)
5. Common errors are documented with user-friendly explanations and resolutions
6. Gas cost estimates are provided for all operations to help users understand transaction fees

## Target Audiences

### 1. Smart Contract Integrators
**Persona**: Protocol developers building on top of Hokusai
**Needs**:
- Deployment sequences with constructor parameters
- Role-based access control patterns
- Parameter bounds and validation rules
- Integration with existing contracts

### 2. Backend Service Developers
**Persona**: Server-side engineers integrating ML pipelines and fee collection
**Needs**:
- Fee collection authentication and batching patterns
- ML model verification workflows
- Event monitoring and synchronization
- Error handling and retry logic

### 3. Frontend Developers
**Persona**: Web developers building trading UIs and dashboards
**Needs**:
- View function usage with gas-efficient multicall patterns
- Decimal conversion (6 for USDC, 18 for tokens)
- Real-time price impact calculations
- Event listening and UI state updates

## Documentation Structure

### Part 1: Smart Contract Integration Guide
**Location**: `docs/integration/smart-contracts.md`

**Sections**:
1. Deployment Sequence
   - TokenManager → deploy token → Factory → create pool flow
   - Constructor parameters for each contract
   - Required role grants (MINTER_ROLE, FEE_DEPOSITOR_ROLE)

2. Parameter Bounds
   - CRR: 5-50%
   - Trade fee: ≤10%
   - Protocol fee: ≤50%
   - IBR duration: 1-30 days

3. AMM Authorization Pattern
   - Authorize AMM to mint/burn tokens
   - Register pool in factory
   - Initial liquidity provision

4. Code Examples
   - Solidity examples for deploying new pools
   - Integrating with existing HokusaiToken instances
   - Access control configuration

### Part 2: Backend Service Integration Guide
**Location**: `docs/integration/backend-services.md`

**Sections**:
1. Fee Collection Flow
   - Authenticating with FEE_DEPOSITOR_ROLE
   - Single deposit vs batch deposit patterns
   - USDC approval requirements
   - Monitoring deposit events for accounting

2. ML Model Verification
   - DeltaVerifier submission format
   - Evaluation data structure and validation
   - Reward calculation formulas
   - Rate limiting considerations

3. Event Monitoring
   - Event schemas with indexed parameters
   - Efficient filtering strategies
   - Backend synchronization patterns
   - Handling reorgs and confirmations

4. Code Examples
   - TypeScript examples for fee deposits
   - Event listener implementations
   - Batch processing patterns

### Part 3: Frontend Integration Guide
**Location**: `docs/integration/frontend-development.md`

**Sections**:
1. View Functions Reference
   - `getPoolState()` - Single-call pool metrics
   - `getTradeInfo()` - IBR status and pause state
   - `calculateBuyImpact()` / `calculateSellImpact()` - Price impact preview
   - Gas estimates for each function

2. Decimal Handling
   - USDC: 6 decimals
   - Tokens: 18 decimals
   - Price impact: basis points (100 = 1%)
   - Conversion utilities and examples

3. Real-time UI Patterns
   - Price impact preview as users type
   - Color coding (green <1%, yellow 1-5%, red >5%)
   - Enable/disable trading based on IBR and pause state
   - Calculating `minOut` with slippage tolerance

4. Performance Optimization
   - Multicall batching with ethers.js/viem
   - Event subscription best practices
   - Caching strategies for static data

5. Code Examples
   - React/Next.js component examples
   - TypeScript type definitions
   - Error handling patterns

### Part 4: Troubleshooting Guide
**Location**: `docs/troubleshooting.md`

**Sections**:
1. Common Errors
   - "Slippage exceeded" - Explanation and resolution
   - "Transaction expired" - Timestamp validation
   - "Sells not enabled during IBR" - IBR period explanation
   - "Insufficient allowance" - USDC approval pattern
   - "Unauthorized" - Role verification steps

2. Gas Optimization Tips
   - Batch operations when possible
   - Use view functions before transactions
   - Optimal slippage settings

3. Debugging Tools
   - Event log analysis
   - Transaction trace interpretation
   - Contract state inspection

## Technical Implementation

### File Organization
```
docs/
├── integration/
│   ├── smart-contracts.md
│   ├── backend-services.md
│   └── frontend-development.md
├── troubleshooting.md
├── api-reference/
│   ├── contracts/
│   │   ├── HokusaiAMM.md
│   │   ├── HokusaiAMMFactory.md
│   │   ├── UsageFeeRouter.md
│   │   ├── DeltaVerifier.md
│   │   └── DataContributionRegistry.md
│   └── events.md
└── examples/
    ├── solidity/
    │   ├── deploy-pool.sol
    │   └── integrate-token.sol
    ├── typescript/
    │   ├── fee-collection.ts
    │   ├── event-monitoring.ts
    │   └── ml-verification.ts
    └── react/
        ├── TradingInterface.tsx
        ├── PriceImpactPreview.tsx
        └── PoolAnalytics.tsx
```

### Content Sources
- Contract interfaces from investigation (Tier 1 files)
- Deployment scripts for sequence documentation
- Test files for gas estimates and examples
- Phase 7 analytics implementation for view functions
- Security audit for parameter bounds and validation rules

### Documentation Standards
- Code examples must be tested and executable
- Include both success and error cases
- Provide gas estimates from actual test runs
- Cross-reference related sections
- Keep language straightforward, no marketing jargon
- Version documentation with contract versions

## Out of Scope

- Mainnet deployment guide (already exists in `docs/mainnet-deployment-checklist.md`)
- Internal architecture documentation (already in codebase-map.md)
- Contract development/testing guides (already in CLAUDE.md)
- Governance and multisig setup (covered in separate Linear tasks)
- Protocol economics and tokenomics (product documentation, not developer docs)

## Dependencies

- Access to all Tier 1 contract files for API extraction
- Test files for gas cost data and working examples
- Phase 7 analytics implementation for view function documentation
- Deployment scripts for sequence documentation

## Success Metrics

- All code examples pass linting and compilation
- At least one complete integration example per audience
- All events documented with indexed parameter details
- Gas estimates provided for all state-changing operations
- Zero TODOs or placeholder content in final documentation

## Timeline Estimate

- Smart Contract Integration Guide: 6-8 hours
- Backend Service Integration Guide: 6-8 hours
- Frontend Integration Guide: 8-10 hours
- Troubleshooting Guide: 3-4 hours
- Code Examples and Testing: 8-10 hours
- Review and Polish: 2-3 hours

Total: 33-43 hours of focused work
