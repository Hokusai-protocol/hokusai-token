# Align Backend, Frontend, and Contract-Deployer Service with Current ABIs - Quick Reference

**Issue ID**: HOK-1697

## Objective

Update all off-chain consumers (contract-deployer service, backend usage-fee depositor path, and frontend wallet flows) so their bundled ABIs, contract addresses, function signatures, and event names match the current smart-contract stack — specifically `deployTokenWithAllocations`, the params tuple that now carries oracle price and vesting config, the current `UsageFeeRouter` API, and current event names. This unblocks the parent mainnet-deployment effort (HOK-658) by guaranteeing off-chain systems can safely read from and write to the deployed contracts.

## Key Files

- `services/contract-deployer/contracts/DeltaVerifier.json` — service-bundled ABI (and sibling ABI JSONs in this dir)
- `services/contract-deployer/src/config/env.validation.ts` — Sepolia address/env validation
- `services/contract-deployer/src/blockchain/delta-verifier-client.ts` — on-chain client wiring
- `tools/deltaone-simulator/abis/*.json` — reference ABIs (`DeltaVerifier.json`, `TokenManager.json`) regenerated from current contracts
- `docs/integration/smart-contracts.md` — integration contract surface documentation consumed by frontend/backend

## Critical Constraints

1. **Protocol vs instance separation** — contracts stay model-agnostic; model-specific values belong only in config/env, never hard-coded into ABIs or clients (see `[[feedback_protocol_vs_instance]]`).
2. **No secrets in the repo or docs** — document required SSM/secret keys by name only; never commit private keys, RPC URLs with embedded keys, or actual secret values.
3. **ABIs must be regenerated from compiled artifacts**, not hand-edited — run `npx hardhat compile` and copy from `artifacts/` so signatures, tuples, and event names match the source contracts exactly.

## Success Criteria (High-Level)

- [ ] All bundled ABIs expose `deployTokenWithAllocations`, the current params tuple (incl. oracle price + vesting config), current `UsageFeeRouter` API, and current event names.
- [ ] Contract-deployer service env points to current Sepolia addresses and its integration suite passes.
- [ ] Frontend wallet flows handle approvals, buys, sells, IBR disabled-sell, slippage/deadline errors, and network mismatch with explicit messages.
- [ ] API usage-fee depositor path is tested against Sepolia contracts.
- [ ] Production env var + SSM/secret updates documented without exposing secrets.
- [ ] Tests and lint pass; PR created and linked to HOK-1697.

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 7: UI-Specific Validation](#7-ui-specific-validation-conditional) *(Conditional - UI issues only)*
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.