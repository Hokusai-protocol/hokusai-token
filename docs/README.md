# Hokusai Token Documentation

Comprehensive developer documentation for integrating with the Hokusai Token system.

## Quick Start

Choose your integration path:

- **[Smart Contract Developer](#smart-contract-integration)** - Building on-chain protocols
- **[Backend Developer](#backend-integration)** - Server-side fee collection and ML verification
- **[Frontend Developer](#frontend-integration)** - Building trading UIs and dashboards

## Documentation Structure

### Integration Guides

#### Smart Contract Integration
**For**: Protocol developers building on Hokusai

- [Smart Contract Integration Guide](integration/smart-contracts.md)
  - Deployment sequences
  - Role-based access control
  - Parameter bounds and validation
  - Code examples in Solidity

**Key Topics**:
- Deploying tokens and AMM pools
- Granting MINTER_ROLE for automated market makers
- Parameter validation (CRR, fees, IBR duration)
- Integration patterns for external contracts

#### Backend Integration
**For**: Server-side engineers integrating ML pipelines

- [Backend Service Integration Guide](integration/backend-services.md)
  - Fee collection with UsageFeeRouter
  - ML model verification with DeltaVerifier
  - Contribution tracking
  - Event monitoring patterns

**Key Topics**:
- Authenticating with FEE_DEPOSITOR_ROLE
- Single vs batch fee deposits
- Submitting model evaluations
- Real-time event synchronization

#### Frontend Integration
**For**: Web developers building user interfaces

- [Frontend Integration Guide](integration/frontend-development.md)
  - View functions for efficient data fetching
  - Price impact calculations
  - IBR countdown and trading button states
  - Real-time event subscriptions

**Key Topics**:
- Using `getPoolState()` for single-call metrics
- Implementing price impact previews
- Decimal handling (USDC: 6, tokens: 18)
- Multicall batching for performance

### Troubleshooting

- [Troubleshooting Guide](troubleshooting.md)
  - Common errors and solutions
  - Gas optimization tips
  - Debugging tools and techniques

### API Reference

Detailed contract documentation:

- [HokusaiAMM](api-reference/contracts/HokusaiAMM.md) - AMM pool contract
- [HokusaiAMMFactory](api-reference/contracts/HokusaiAMMFactory.md) - Pool factory
- [UsageFeeRouter](api-reference/contracts/UsageFeeRouter.md) - Fee collection
- [DeltaVerifier](api-reference/contracts/DeltaVerifier.md) - ML verification
- [DataContributionRegistry](api-reference/contracts/DataContributionRegistry.md) - Contribution tracking
- [Event Schemas](api-reference/events.md) - All contract events

### Code Examples

Working examples ready to use:

**Solidity**:
- [docs/examples/solidity/deploy-pool.sol](examples/solidity/deploy-pool.sol) - Complete pool deployment
- [docs/examples/solidity/integrate-token.sol](examples/solidity/integrate-token.sol) - External contract integration

**TypeScript**:
- [docs/examples/typescript/fee-collection.ts](examples/typescript/fee-collection.ts) - Fee deposit service
- [docs/examples/typescript/event-monitoring.ts](examples/typescript/event-monitoring.ts) - Event listener
- [docs/examples/typescript/ml-verification.ts](examples/typescript/ml-verification.ts) - Evaluation submission

**React**:
- [docs/examples/react/TradingInterface.tsx](examples/react/TradingInterface.tsx) - Trading component
- [docs/examples/react/PriceImpactPreview.tsx](examples/react/PriceImpactPreview.tsx) - Price impact widget
- [docs/examples/react/PoolAnalytics.tsx](examples/react/PoolAnalytics.tsx) - Analytics dashboard

## System Overview

### Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Hokusai Token System                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐      ┌──────────────┐              │
│  │ TokenManager │◄─────┤ DeltaVerifier│              │
│  └──────┬───────┘      └──────────────┘              │
│         │                                             │
│         │ deploys                                     │
│         ▼                                             │
│  ┌──────────────┐      ┌──────────────┐              │
│  │ HokusaiToken │◄─────┤ HokusaiAMM   │              │
│  └──────────────┘      └──────┬───────┘              │
│                                │                       │
│                        created by                     │
│                                │                       │
│  ┌──────────────┐      ┌──────▼────────┐             │
│  │UsageFeeRouter├─────►│AMMFactory     │             │
│  └──────────────┘      └───────────────┘             │
│                                                         │
│  ┌──────────────┐      ┌──────────────┐              │
│  │ModelRegistry │      │Contribution  │              │
│  │              │      │Registry      │              │
│  └──────────────┘      └──────────────┘              │
└─────────────────────────────────────────────────────────┘
```

### Core Contracts

| Contract | Purpose | Documentation |
|----------|---------|---------------|
| **TokenManager** | Token deployment and minting control | [Integration Guide](integration/smart-contracts.md#deployment-sequence) |
| **HokusaiToken** | ERC20 token with controller access | [README.md](../README.md#hokusaitoken) |
| **HokusaiAMM** | Constant Reserve Ratio AMM pool | [API Reference](api-reference/contracts/HokusaiAMM.md) |
| **HokusaiAMMFactory** | Creates and tracks AMM pools | [API Reference](api-reference/contracts/HokusaiAMMFactory.md) |
| **UsageFeeRouter** | Routes API fees to pools | [Backend Guide](integration/backend-services.md#fee-collection-flow) |
| **DeltaVerifier** | Verifies ML improvements and mints rewards | [Backend Guide](integration/backend-services.md#ml-model-verification) |
| **ModelRegistry** | Maps model IDs to tokens | [README.md](../README.md#modelregistry) |
| **DataContributionRegistry** | Tracks data contributions | [Backend Guide](integration/backend-services.md#contribution-tracking) |

### Key Concepts

#### Constant Reserve Ratio (CRR)

The AMM uses a CRR bonding curve:
- **Buy Formula**: T = S × ((1 + E/R)^w - 1)
- **Sell Formula**: F = R × (1 - (1 - T/S)^(1/w))
- **Spot Price**: P = R / (w × S)

Where:
- T = tokens to mint/burn
- S = current supply
- R = reserve balance (USDC)
- E = USDC deposited
- F = USDC returned
- w = CRR (reserve ratio)

See [Smart Contract Guide](integration/smart-contracts.md#parameter-bounds) for allowed ranges.

#### Initial Bonding Round (IBR)

A configurable period (1-30 days) after pool creation where:
- ✅ Buying is allowed
- ❌ Selling is disabled

This stabilizes initial price discovery. See [Frontend Guide](integration/frontend-development.md#trading-button-state) for UI implementation.

#### Fee Distribution

API usage fees deposited via UsageFeeRouter are split:
- **Protocol Fee**: Goes to treasury (default 5%)
- **Pool Reserve**: Increases token value (remaining 95%)

See [Backend Guide](integration/backend-services.md#fee-distribution-logic) for details.

## Getting Started

### For Smart Contract Developers

1. Read the [Smart Contract Integration Guide](integration/smart-contracts.md)
2. Review [deployment examples](examples/solidity/deploy-pool.sol)
3. Check [parameter bounds](integration/smart-contracts.md#parameter-bounds)
4. Test on testnet before mainnet

### For Backend Developers

1. Read the [Backend Service Integration Guide](integration/backend-services.md)
2. Get the `FEE_DEPOSITOR_ROLE` for your service
3. Review [fee collection examples](examples/typescript/fee-collection.ts)
4. Set up [event monitoring](examples/typescript/event-monitoring.ts)

### For Frontend Developers

1. Read the [Frontend Integration Guide](integration/frontend-development.md)
2. Implement [price impact preview](integration/frontend-development.md#price-impact-preview)
3. Handle [decimal conversions](integration/frontend-development.md#decimal-handling) correctly
4. Use [multicall](integration/frontend-development.md#multicall-batching) for efficiency

## Additional Resources

### External Links

- [Hardhat Documentation](https://hardhat.org/docs) - Development framework
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/) - Security patterns
- [ethers.js Documentation](https://docs.ethers.org/) - Web3 library
- [viem Documentation](https://viem.sh/) - Alternative Web3 library

### Project Files

- [CLAUDE.md](../CLAUDE.md) - Development workflow
- [Deployment Guide](mainnet-deployment-checklist.md) - Mainnet deployment checklist
- [Test Suite](../test/) - Contract tests with examples

## Support

- **GitHub Issues**: Report bugs or request features
- **Discord**: Join the community
- **Documentation Feedback**: PRs welcome to improve these docs

## Version

This documentation is for Hokusai Token System v1.0.

Last updated: 2026-01-15
