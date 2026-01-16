# Tasks: API Usage Patterns Documentation

## 1. Documentation Structure Setup
- [x] a. Create `docs/integration/` directory
- [x] b. Create `docs/api-reference/` directory structure
- [x] c. Create `docs/examples/` with subdirectories (solidity, typescript, react)
- [x] d. Create placeholder files for all documentation sections

## 2. Smart Contract Integration Guide
- [x] a. Document deployment sequence (TokenManager → token → Factory → pool)
- [x] b. Document constructor parameters for each contract
- [x] c. Document role-based access control (MINTER_ROLE, FEE_DEPOSITOR_ROLE)
- [x] d. Document parameter bounds (CRR 5-50%, trade fee ≤10%, protocol fee ≤50%, IBR 1-30 days)
- [x] e. Create Solidity example: deploy new pool
- [ ] f. Create Solidity example: integrate with existing token
- [x] g. Document AMM authorization pattern
- [ ] h. Test all Solidity examples compile and work

## 3. Backend Service Integration Guide
- [x] a. Document UsageFeeRouter authentication with FEE_DEPOSITOR_ROLE
- [x] b. Document single vs batch deposit patterns
- [x] c. Document USDC approval requirements
- [x] d. Document fee deposit event monitoring
- [x] e. Document DeltaVerifier submission format and validation
- [x] f. Document evaluation data structure with examples
- [x] g. Document reward calculation formulas
- [x] h. Document event schemas with indexed parameters
- [x] i. Create TypeScript example: fee collection flow
- [ ] j. Create TypeScript example: event monitoring
- [ ] k. Create TypeScript example: ML verification submission
- [ ] l. Test all TypeScript examples execute successfully

## 4. Frontend Integration Guide (Depends on Smart Contract Integration Guide)
- [x] a. Document `getPoolState()` with return value breakdown
- [x] b. Document `getTradeInfo()` for IBR/pause status
- [x] c. Document `calculateBuyImpact()` and `calculateSellImpact()`
- [x] d. Document gas estimates for all view functions
- [x] e. Document decimal handling (USDC: 6, tokens: 18, basis points)
- [x] f. Document price impact color coding (green <1%, yellow 1-5%, red >5%)
- [x] g. Document trading button enable/disable logic based on IBR/pause
- [x] h. Document `minOut` calculation with slippage tolerance
- [x] i. Document multicall batching with ethers.js/viem
- [x] j. Document event subscription best practices
- [x] k. Create React example: TradingInterface component
- [ ] l. Create React example: PriceImpactPreview component
- [ ] m. Create React example: PoolAnalytics dashboard
- [x] n. Create TypeScript type definitions for all contract interfaces
- [ ] o. Test all React examples render and function correctly

## 5. API Reference Documentation
- [ ] a. Extract and document HokusaiAMM public functions
- [ ] b. Extract and document HokusaiAMMFactory public functions
- [ ] c. Extract and document UsageFeeRouter public functions
- [ ] d. Extract and document DeltaVerifier public functions
- [ ] e. Extract and document DataContributionRegistry public functions
- [ ] f. Document all events with parameter details and indexing
- [ ] g. Add gas cost estimates from test files to each function

## 6. Troubleshooting Guide
- [x] a. Document "Slippage exceeded" error with resolution
- [x] b. Document "Transaction expired" error with resolution
- [x] c. Document "Sells not enabled during IBR" error with resolution
- [x] d. Document "Insufficient allowance" error with resolution
- [x] e. Document "Unauthorized" error with role verification steps
- [x] f. Add gas optimization tips (batching, view functions, slippage)
- [x] g. Add debugging tools section (event logs, transaction traces)
- [ ] h. Create troubleshooting decision tree or flowchart

## 7. Code Examples Validation (Depends on Tasks 2, 3, 4)
- [ ] a. Verify all Solidity examples compile with `npx hardhat compile`
- [ ] b. Verify all TypeScript examples pass linting
- [ ] c. Test all code examples execute without errors
- [ ] d. Add success and error case examples where applicable
- [ ] e. Ensure all examples follow project coding standards

## 8. Documentation Integration
- [x] a. Update main README.md with links to new documentation
- [x] b. Create documentation index page (docs/README.md)
- [x] c. Add cross-references between related sections
- [x] d. Ensure version alignment with contract versions
- [x] e. Add table of contents to each documentation file
- [x] f. Remove any TODOs or placeholder content

## 9. Review and Polish (Depends on Tasks 2-8)
- [ ] a. Review smart contract guide for completeness
- [ ] b. Review backend guide for completeness
- [ ] c. Review frontend guide for completeness
- [ ] d. Check all links and cross-references work
- [ ] e. Verify consistent terminology across all docs
- [ ] f. Spell check and grammar check all documentation
- [ ] g. Ensure straightforward language (no marketing jargon)
- [ ] h. Get technical review from team member

## 10. Testing Documentation (Optional but Recommended)
- [ ] a. Have external developer follow smart contract guide
- [ ] b. Have external developer follow backend guide
- [ ] c. Have external developer follow frontend guide
- [ ] d. Collect feedback and iterate on unclear sections
- [ ] e. Update based on real-world integration feedback

## Notes
- All code examples must be tested and executable
- Gas estimates should come from actual test runs
- Cross-reference existing documentation (deployment guides, codebase map)
- Keep language straightforward and technical
- Priority: Smart contract guide > Backend guide > Frontend guide > Troubleshooting
