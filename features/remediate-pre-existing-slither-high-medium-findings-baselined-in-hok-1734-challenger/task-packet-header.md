# Remediate pre-existing Slither High/Medium findings baselined in HOK-1734 - Quick Reference

**Issue ID**: HOK-1823

## Objective

Remediate the 12 pre-existing High/Medium severity Slither findings (`arbitrary-send-eth` ×3, `reentrancy-eth` ×4, `unchecked-transfer` ×1, `divide-before-multiply` ×1, `incorrect-equality` ×3) that were baselined in `slither-baseline.json` during HOK-1734. Each finding must be either fixed in the contract source or formally confirmed as a false positive with documented justification, after which its baseline entry is removed so the CI gate enforces it going forward.

## Key Files

- `slither-baseline.json` — baseline entries to remove/update once findings are resolved
- `contracts/HokusaiAMM.sol` — ETH-handling AMM (likely source of `arbitrary-send-eth` / `reentrancy-eth`)
- `contracts/TokenManager.sol` / `contracts/DeployableTokenManager.sol` — token distribution logic (`incorrect-equality`, `divide-before-multiply`)
- `scripts/slither-gate.js` — CI gate that consumes the baseline
- `docs/slither-static-analysis.md` — baseline workflow runbook to keep in sync

## Critical Constraints

1. Every baseline removal must be backed by either a verifiable contract fix OR a written false-positive justification in the entry's `justification`/`followUp` fields — never silently delete an entry.
2. All existing Hardhat tests (especially `test/Phase-Security-ReentrancyAttacks.test.js` and the full `test/Phase-Security-*` suite) must pass after changes; contract behavior changes must not break AMM pricing or token-distribution invariants.
3. Follow checks-effects-interactions and use OpenZeppelin `ReentrancyGuard` / `SafeERC20` already available in `node_modules`; do not introduce new external dependencies.

## Success Criteria (High-Level)

- [ ] All 12 findings individually triaged as "fixed" or "false positive" with documented rationale
- [ ] Genuine vulnerabilities fixed via contract changes (reentrancy guards, pull-payment, return-value checks, reordered arithmetic, range-based comparisons)
- [ ] Corresponding entries removed from `slither-baseline.json`; remaining entries (if any false positives stay) have updated `followUp` referencing HOK-1823
- [ ] `npm run slither:report` shows no un-baselined High/Medium findings; `node scripts/slither-gate.js` passes
- [ ] `npx hardhat compile` and `npm test` pass; PR created and linked to HOK-1823

## Detailed Sections

Full details available on-demand in task-packet-details.md:

- [Section 1: Complete Objective & Scope](#1-objective)
- [Section 2: Technical Context](#2-technical-context)
- [Section 3: Implementation Approach](#3-implementation-approach)
- [Section 4: Success Criteria](#4-success-criteria)
- [Section 5: Implementation Constraints](#5-implementation-constraints)
- [Section 6: Validation Steps](#6-validation-steps)
- [Section 8: Definition of Done](#8-definition-of-done)
- [Section 9: Rollback Plan](#9-rollback-plan)
- [Section 10: Release Readiness](#10-release-readiness)
- [Section 11: Proposed Labels](#11-proposed-labels)

**Implementation Note**: Start with this overview. Read detailed sections on-demand as you implement.