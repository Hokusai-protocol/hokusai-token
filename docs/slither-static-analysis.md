# Slither Static Analysis

Slither is integrated as a static analysis gate for the `hokusai-token` smart contracts. It complements (but does not replace) the Hardhat security test suite in `test/Phase-Security-*.test.js`, which covers runtime properties like reentrancy resistance, flash-loan attacks, and price manipulation.

## Gating Threshold

CI fails on **medium or higher** severity findings (`--fail-medium`). Low and informational findings are still reported for visibility but do not block merges.

The medium threshold is required because `tx-origin` (a key detector) is classified as Medium severity by Slither. A high-only gate would miss it.

### Gated Detector Categories

| Category | Detectors | Severity |
|---|---|---|
| Reentrancy | `reentrancy-eth`, `reentrancy-no-eth` | High, Medium |
| Unsafe delegatecall | `controlled-delegatecall`, `delegatecall-loop` | High |
| Uninitialized storage | `uninitialized-state`, `uninitialized-storage`, `uninitialized-local` | High, Medium |
| `tx.origin` misuse | `tx-origin` | Medium |
| Shadowing | `shadowing-state`, `shadowing-abstract` | High, Medium |
| Upgradeability | `unprotected-upgrade` | High |
| Access control | `suicidal`, `arbitrary-send-eth` | High |

Additional detectors like `unchecked-transfer`, `incorrect-equality`, `divide-before-multiply`, and `unused-return` also gate at medium+ severity.

Low-severity detectors (`shadowing-local`, `shadowing-builtin`, `reentrancy-benign`, `reentrancy-events`, `calls-loop`, `missing-zero-check`, `timestamp`) appear in reports but do not block.

### Upgradeability Note

`slither-check-upgradeability` is not applicable — there are no upgradeable proxy contracts in `contracts/`. If a proxy pattern is introduced, this tool should be added.

## Local Setup

### Prerequisites

Install Slither (one-time):

```bash
pip install slither-analyzer==0.11.5
```

Ensure contracts compile:

```bash
npx hardhat compile
```

### Running Locally

Human-readable output (all findings):

```bash
npm run slither
```

CI-equivalent check (exits non-zero on medium+ findings, generates SARIF):

```bash
npm run slither:ci
```

## Triage Process

Existing findings that have been reviewed are stored in `slither.db.json`. Slither automatically skips findings whose ID matches an entry in this file.

### Reviewing a New Finding

When Slither reports a new medium+ finding:

1. Determine if the finding is a true positive requiring a code change, or an acceptable pattern.
2. If it needs a code fix, fix it. If it requires design changes beyond the current scope, file a follow-up Linear issue.
3. If the finding is acceptable (e.g., intentional pattern, false positive), add it to the baseline:

```bash
slither . --triage-mode
```

This interactive command lets you select findings to suppress. Accepted findings are appended to `slither.db.json`.

4. Add a justification entry to the table below for every baselined finding.

### Refreshing the Baseline

Triage DB entries are keyed by a finding hash. If contract code changes shift the hash of a previously-baselined finding, it will reappear as "new" in CI. To refresh:

1. Run `slither . --triage-mode` locally.
2. Review the re-surfaced finding and accept it again.
3. Commit the updated `slither.db.json`.

### Current Baseline Justifications

| Detector | Contract | Justification |
|---|---|---|
| `arbitrary-send-eth` | TokenManager, DeployableTokenManager | Fee collection sends ETH to `feeRecipient` set by owner via `setFeeRecipient()`. Access-controlled; not user-controlled destination. |
| `reentrancy-eth` | TokenManager, DeployableTokenManager | Deployment functions write `modelTokens` after fee collection external call. The `onlyOwner` modifier restricts callers; `modelId` uniqueness check prevents duplicate entries. Acceptable risk — follow-up issue recommended if CEI refactor is pursued. |
| `unchecked-transfer` | HokusaiAMM | `sell()` uses `transferFrom` on the Hokusai token whose `transfer`/`transferFrom` always returns true (OZ ERC20). False positive for this token; would be caught by `SafeERC20` if token changes. |
| `divide-before-multiply` | BondingCurveMath | Precision-aware logarithm implementation. The division-then-multiplication sequence is intentional for fixed-point arithmetic with `PRECISION` scaling. |
| `incorrect-equality` | DataContributionRegistry, FundingVault | Enum status checks (`== ContributionStatus.Verified`) and dust-zero checks (`dust == 0`) are intentional exact comparisons, not balance comparisons susceptible to manipulation. |
| `reentrancy-no-eth` | UsageFeeRouter, InfrastructureReserve, FundingVault, HokusaiAMM | State writes after ERC20 `transferFrom`/`transfer` calls. These use trusted reserve tokens set by owner. Functions are access-controlled or use `nonReentrant`. Acceptable risk for the current trust model. |
| `unused-return` | DeltaVerifier, TokenManager, DeployableTokenManager, HokusaiAMM, FundingVault, UsageFeeRouter | Return values from internal helper calls (`FeeLib.applyFee`, `vestingVault.createSchedule`, `contributionRegistry.recordContributionBatch`, `pool.buy`, ERC20 `approve`) are unused where the caller does not need the returned value or reverts on failure. |

## CI Workflow

The GitHub Actions workflow (`.github/workflows/slither.yml`) runs on every pull request targeting `main` and on pushes to `main`.

### Making It a Required Check

After merging, a repository admin must add the `Slither / slither` check to the `main` branch protection rules in GitHub Settings > Branches > Branch protection rules to make it a required, merge-blocking check.
