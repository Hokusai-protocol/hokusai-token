# Slither Static Analysis

This repository uses [Slither](https://github.com/crytic/slither) as a CI-gating static-analysis baseline for smart contract changes.

## What This Covers

The gate explicitly evaluates these issue categories:

| Category | Slither detectors |
| --- | --- |
| Reentrancy risks | `reentrancy-balance`, `reentrancy-eth`, `reentrancy-no-eth`, `reentrancy-benign`, `reentrancy-events`, `reentrancy-unlimited-gas` |
| Unsafe delegatecalls | `controlled-delegatecall`, `delegatecall-loop` |
| Uninitialized storage | `uninitialized-state`, `uninitialized-storage`, `uninitialized-local` |
| `tx.origin` misuse | `tx-origin` |
| Shadowing issues | `shadowing-state`, `shadowing-abstract`, `shadowing-local`, `shadowing-builtin` |
| Upgradeability hazards | `unprotected-upgrade`, `function-init-state` |
| Access control problems | `suicidal`, `arbitrary-send-eth`, `arbitrary-send-erc20`, `arbitrary-send-erc20-permit`, `incorrect-modifier` |

`slither-check-upgradeability` is not part of the gate because the repository does not currently contain proxy or upgradeable contract patterns. If upgradeable contracts are introduced later, add that check as a separate workflow step.

## Local Usage

Install the pinned analyzer version:

```bash
pip install slither-analyzer==0.11.5
```

Run the CI-equivalent gate:

```bash
npm run slither
```

Run a reporting-only pass that never fails the process:

```bash
npm run slither:report
```

The gate uses [slither.config.json](../slither.config.json) to exclude `node_modules` and `contracts/mocks` from analysis so third-party code and test harnesses do not block CI.

## Gate Policy

A finding fails the gate when both of these are true:

1. The finding is not already accepted in [slither-baseline.json](../slither-baseline.json).
2. The finding is either:
   - High or Medium impact in Slither, or
   - in one of the seven target categories listed above, regardless of impact.

Informational and Low findings outside those categories are reported as warnings but do not fail the build.

## Baseline Workflow

Use the baseline only for accepted or triaged findings that are intentionally left in place.

1. Run `npm run slither:report`.
2. Copy the exact finding `id` from the report output.
3. Add an entry to `slither-baseline.json` with:
   - `id`
   - `check`
   - `justification`
   - `reviewedBy`
   - `followUp`
4. Re-run `npm run slither` and confirm only that accepted finding is suppressed.

Do not use the baseline to hide newly introduced vulnerabilities without a documented justification and follow-up issue.

## Current Notes

- HOK-1734 adds tooling only. It does not change contract logic or existing behavioral tests.
- Existing runtime security coverage remains in `test/Phase-Security-*.test.js`; Slither is the complementary static-analysis layer.
- After merge, add the `Slither` GitHub Actions check to `main` branch protection so it becomes a required status check.

## Baselined Findings

The following findings remain in `slither-baseline.json` as confirmed false positives.
They were reviewed and documented during HOK-1823.

| Detector | Severity | Count | Status | Notes |
| --- | --- | --- | --- | --- |
| `incorrect-equality` | Medium | 3 | False positive | Confirmed: comparisons are on access-controlled accounting variables, not manipulable balances. See `slither-baseline.json` for per-entry justification. |
| `reentrancy-no-eth` | Medium | 2 | False positive | Introduced by `nonReentrant` suppressing `reentrancy-benign`; Slither reclassifies as `reentrancy-no-eth`. All re-entry paths are guarded by `nonReentrant`. See baseline for details. |
| `unused-return` | Medium | 12 | False positive | Return values are intentionally ignored where the called function is trusted in-house or the return value is redundant. See baseline for per-entry justification. |

The following findings were **fixed** in HOK-1823 and their baseline entries removed:

| Detector | Severity | Count | Resolution |
| --- | --- | --- | --- |
| `arbitrary-send-eth` | High | 3 | Converted to pull-payment (`withdrawDeploymentFees`) + `nonReentrant` |
| `reentrancy-eth` | High | 4 | CEI ordering + `nonReentrant` on all ETH-moving entry points |
| `unchecked-transfer` | High | 1 | `transferFrom` return value wrapped in `require(...)` in `HokusaiAMM.sell()` |
| `divide-before-multiply` | Medium | 1 | Arithmetic reordered to multiply-before-divide in `BondingCurveMath` |

Any new finding matching these detector classes on new or modified code is **not** suppressed by remaining baseline entries (entries are keyed by finding hash, not detector name) and will fail the gate.
