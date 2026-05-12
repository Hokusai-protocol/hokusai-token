# MintRequest to DeltaVerifier Relayer Schema Mapping

Purpose: define the implementation-level contract the relayer should use to translate pipeline `MintRequest` messages into `DeltaVerifier.submitEvaluationWithMultipleContributors` calldata.

Audience: relayer and pipeline implementers.

Verified against commit `c11ec75dda62d18a1f893ad6f32124154b7ae13c`.

## Standard v2 transaction path

The protocol-aware path is now `DeltaVerifier.submitMintRequest(uint256 modelId, MintRequestPayload payload, Contributor[] contributors)` in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L217).

What v2 adds on-chain:

- `attestation_hash` via `payload.anchors.attestationHash`
- `idempotency_key` via `payload.anchors.idempotencyKey`
- `benchmark_spec_id` anchoring as `keccak256(benchmark_spec_id)` or a deterministic fallback hash when the field is absent
- `dataset_hash` when present, else `bytes32(0)`
- `metric_name` and `metric_family`
- an indexed `DeltaOneAccepted` event for audit and settlement indexing

Notes:

- The contract remains single-metric. Callers must normalize non-proportion metrics to integer bps in `[0, 10000]` before submission.
- v2 consumes the idempotency key even for budget-blocked or zero-delta submissions, so replay attempts revert on-chain.
- v1 remains valid for legacy callers, but new benchmark-backed relayers should target v2.

## Standard v1 transaction path

The standard v1 path is `DeltaVerifier.submitEvaluationWithMultipleContributors(uint256 modelId, EvaluationDataBase data, Contributor[] contributors)` in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L172).

Why this is the standard path:

- It is the only path that directly accepts a multi-contributor attribution set.
- It also covers the single-contributor case by submitting one contributor with `weight = 10000`.
- It keeps the relayer on one encoding path instead of branching between `submitEvaluation` and `submitEvaluationWithContributorInfo`.
- It matches the pipeline’s basis-point weighting model directly.

The other public entrypoints are non-v1:

- `submitEvaluation` in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L133) expects single-contributor sample metadata and goes through `_processEvaluation`, including the one-hour per-contributor rate limit in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L268).
- `submitEvaluationWithContributorInfo` in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L144) is still a single-contributor wrapper and also goes through `_processEvaluation`.

## MintRequest reference schema

This is the pipeline-side reference shape the relayer should accept:

```json
{
  "model_id_uint": 42,
  "eval_id": "string",
  "attestation_hash": "0x<64 hex chars>",
  "baseline_score_bps": 8125,
  "new_score_bps": 8450,
  "cost": {
    "max_cost_usd": 250,
    "actual_cost_usd": 180
  },
  "contributors": [
    {
      "wallet_address": "0x...",
      "weight_bps": 5000
    }
  ]
}
```

Units and conventions:

- `*_bps` values are integer basis points in `[0, 10000]`.
- `model_id_uint` is a raw unsigned integer model identifier.
- `eval_id` is the on-chain `pipelineRunId` string, not a `bytes32`.
- `attestation_hash` is a `bytes32`-shaped hex string off-chain, even though v1 does not submit it on-chain.
- `cost.max_cost_usd` and `cost.actual_cost_usd` are whole-dollar integer USD values.
- `contributors[*].weight_bps` must sum to exactly `10000`.

## Field mapping

| MintRequest field | Type (pipeline) | DeltaVerifier destination | Type (Solidity) | Transformation | Validation rules | On revert / outcome |
| --- | --- | --- | --- | --- | --- | --- |
| `model_id_uint` | integer | `modelId` function arg in `submitEvaluationWithMultipleContributors` | `uint256` | Direct integer conversion | Must be an integer `>= 0`; relayer should preflight `modelRegistry.isRegistered(modelId)` and `modelRegistry.isModelActive(modelId)` before submit. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L178), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L179) | Reverts `"Model not registered"` or `"Model is deactivated"` |
| `eval_id` | string | `data.pipelineRunId` | `string` | Pass through unchanged | Treat as required and non-empty. DeltaVerifier emits it in `EvaluationSubmitted` and `BudgetConstraintViolated`, and `DataContributionRegistry.recordContributionBatch` requires non-empty `pipelineRunId`. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L58), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L255), [contracts/DataContributionRegistry.sol](../../contracts/DataContributionRegistry.sol#L218) | If reward distribution is reached and the string is empty, contribution recording reverts with `"Pipeline run ID cannot be empty"` |
| `attestation_hash` | `0x`-prefixed 32-byte hex string | No v1 on-chain destination | n/a | Keep off-chain only in v1. Optional non-normative fallback: concatenate into `eval_id` if a deployment requires it, but that is not the standard mapping. | Must match `^0x[0-9a-fA-F]{64}$` off-chain so downstream systems can treat it as canonical `bytes32`. No contract line consumes it directly. | No DeltaVerifier revert because it is not submitted on-chain in v1 |
| `baseline_score_bps` | integer bps | `data.baselineMetrics.accuracy` | `uint256` | Direct integer conversion | Must be an integer in `[0, 10000]`. The multi-contributor path does not invoke `_validateMetrics`, so the relayer must enforce the cap client-side. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L213), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L418) | Without relayer validation this path can submit out-of-range values; v1 contract does not reject them |
| `new_score_bps` | integer bps | `data.newMetrics.accuracy` | `uint256` | Direct integer conversion | Must be an integer in `[0, 10000]`. Same relayer-side cap as baseline score. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L213), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L423) | If `new_score_bps <= baseline_score_bps`, `_calculateSingleMetricDelta` returns `0` and the call succeeds with zero reward. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L390) |
| `cost.max_cost_usd` | integer USD | `data.maxCostUsd` | `uint256` | Direct integer conversion | Must be an integer `>= 0`. `0` is a sentinel that disables budget enforcement. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L62), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L452) | If both cost fields are non-zero and `actualCostUsd > maxCostUsd`, the call succeeds, emits `BudgetConstraintViolated`, and returns `0`. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L202) |
| `cost.actual_cost_usd` | integer USD | `data.actualCostUsd` | `uint256` | Direct integer conversion | Must be an integer `>= 0`. `0` disables budget enforcement together with `maxCostUsd`. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L63), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L453) | Same `BudgetConstraintViolated` success-without-mint semantics as above |
| `contributors[*].wallet_address` | address string | `contributors[*].walletAddress` | `address` | Canonicalize to EIP-55 before encoding | Must be a valid address, non-zero, unique within the array. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L189), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L193) | Reverts `ZeroAddress("wallet address")` or `"Duplicate contributor address"` |
| `contributors[*].weight_bps` | integer bps | `contributors[*].weight` | `uint256` | Direct integer conversion | Each weight should be an integer in `[1, 10000]`; the contract only enforces array total `== 10000`, so the relayer should reject zeros and oversize values. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L197), [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L200) | Reverts `"Weights must sum to 100%"` if the array sum is not exactly `10000` |

### Metrics fields not named by MintRequest

`EvaluationDataBase` still requires full `Metrics` structs. For v1, map only the MintRequest scores to `accuracy` and set `precision`, `recall`, `f1`, and `auroc` to `0`. This is safe because the reward path uses `accuracy` only in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L213) and [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L285).

## On-chain vs off-chain split

Submitted on-chain:

- `model_id_uint`
- `eval_id`
- `baseline_score_bps`
- `new_score_bps`
- `cost.max_cost_usd`
- `cost.actual_cost_usd`
- `contributors[*].wallet_address`
- `contributors[*].weight_bps`

Retained off-chain in v1:

- `attestation_hash`

Rationale:

- `submitEvaluationWithMultipleContributors` has no `bytes32 attestationHash` field.
- No event, reward path, or contribution registry write consumes `attestation_hash`.
- Embedding it into `pipelineRunId` would overload a human-readable tracking field and create indexer ambiguity. Keep it off-chain unless a specific integration explicitly opts into that non-standard fallback.

## Validation rules

### Basis-point values

- `baseline_score_bps` and `new_score_bps` must be integers in `[0, 10000]`.
- Each contributor `weight_bps` should be an integer in `[1, 10000]`.
- The contract validates the `Metrics` cap only on the single-contributor `_processEvaluation` path through `_validateMetrics` in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L418).
- The multi-contributor v1 path does not invoke `_validateMetrics`, so the relayer must enforce the cap before broadcast.

### Contributor weights

- `contributors.length` must be in `[1, 100]`. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L180).
- The sum of `weight_bps` must equal exactly `10000`. Source: [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L200).
- A single-contributor submission with `weight_bps = 10000` is valid and should still use the multi-contributor path.
- To avoid rounding dust in the client, compute the last contributor weight as `10000 - sum(previousWeights)`.

### Addresses

- Normalize contributor addresses to EIP-55 checksum form before encoding.
- Reject the zero address.
- Reject duplicates after lowercase normalization.
- The contract does not care about checksum casing, but off-chain normalization makes duplicate detection deterministic.

### `attestation_hash`

- Treat this as a required off-chain `bytes32` value represented as `0x` plus 64 hex chars.
- Reject empty strings, short hashes, long hashes, and non-hex characters.
- Do not hash the value again before storage or transport.
- Do not call `ethers.id(eval_id)` or any other digest function in place of this field.

### `eval_id` / `pipelineRunId`

- Treat `eval_id` as required and non-empty.
- A raw UUID, benchmark run name, or hex-looking string is acceptable because the contract type is `string`.
- Do not coerce `eval_id` into `bytes32`.
- An empty `pipelineRunId` can still emit `EvaluationSubmitted` if reward is zero, but will revert during contribution recording when reward distribution occurs. The relayer should reject empties up front rather than depend on runtime reward shape.

### Cost fields

- `cost.max_cost_usd` and `cost.actual_cost_usd` should be whole-dollar integers `>= 0`.
- `0` on either field disables the budget-constraint check in `_isBudgetConstraintViolated` at [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L452).
- If both are non-zero and `actual_cost_usd > max_cost_usd`, the transaction returns success with no mint rather than reverting.

## Pre-submission checklist

- Validate `model_id_uint` is an integer and query `modelRegistry.isRegistered(modelId)`.
- Query `modelRegistry.isModelActive(modelId)`.
- Query `tokenManager.getTokenAddress(modelId.toString())` and reject `address(0)` to avoid the `"Token not found for model"` revert in [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L364).
- Confirm the relayer wallet has `SUBMITTER_ROLE`.
- Confirm the contract is not paused.
- Require `eval_id` to be a non-empty string.
- Require `attestation_hash` to be a canonical `bytes32` hex string, even though it remains off-chain.
- Require `baseline_score_bps` and `new_score_bps` to be integers in `[0, 10000]`.
- Require `contributors.length` to be between `1` and `100`.
- Require every contributor address to be valid, non-zero, and unique.
- Require every contributor weight to be an integer in `[1, 10000]`.
- Require the contributor weight sum to equal exactly `10000`.
- Treat `new_score_bps <= baseline_score_bps` as a valid no-reward submission, not a malformed request.
- Treat `actual_cost_usd > max_cost_usd` with both values non-zero as a valid no-mint submission, not a revert condition.

## Post-submission semantics

Expected events on a successful rewarding submission:

- `EvaluationSubmitted` from [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L77)
- `RewardCalculated` from [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L82)
- `BatchRewardsDistributed` from [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L94)

Expected event on a budget-blocked submission:

- `BudgetConstraintViolated` from [contracts/DeltaVerifier.sol](../../contracts/DeltaVerifier.sol#L101)

Interpretation rules:

- `actual_cost_usd > max_cost_usd` does not revert. The function emits `BudgetConstraintViolated` and returns `0`.
- `new_score_bps <= baseline_score_bps` returns `0` reward without reverting. In that case `EvaluationSubmitted` still emits, but no minting or contribution recording happens.
- Distinguish budget-skipped mints from ordinary zero-reward submissions by parsing emitted events, not just the return value.

## Sample encoding path

The reproducible sample lives in:

- Fixture: [wavemill-sample.json](./fixtures/wavemill-sample.json)
- Script: [generate-sample-calldata.ts](./scripts/generate-sample-calldata.ts)
- Output doc: [sample-calldata.md](./sample-calldata.md)

Run:

```bash
npx tsx features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/scripts/generate-sample-calldata.ts
```

## Verification footer

Verified against commit `c11ec75dda62d18a1f893ad6f32124154b7ae13c`.
