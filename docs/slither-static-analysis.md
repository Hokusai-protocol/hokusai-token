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

## Baselined High / Medium Findings

The following pre-existing High and Medium findings were discovered during the initial rollout (HOK-1734) and accepted into `slither-baseline.json` with `followUp: HOK-1823`. They are tracked for remediation in that issue and must **not** be used as precedent to baseline new findings of the same type.

| Detector | Severity | Count | Tracked in |
| --- | --- | --- | --- |
| `arbitrary-send-eth` | High | 3 | HOK-1823 |
| `reentrancy-eth` | High | 4 | HOK-1823 |
| `unchecked-transfer` | High | 1 | HOK-1823 |
| `divide-before-multiply` | Medium | 1 | HOK-1823 |
| `incorrect-equality` | Medium | 3 | HOK-1823 |
| `unused-return` | Medium | 12 | HOK-1823 |
| `reentrancy-no-eth` | Medium | 5 | HOK-1823 |

Any new finding matching these detectors on new or modified code is **not** suppressed by the existing baseline entries (baseline entries are keyed by finding hash, not by detector name) and will fail the gate.
