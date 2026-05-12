# HOK-1653: Support custom benchmarks via smart contract

## Title
Support user-defined BenchmarkSpec baselines and DeltaOne mint events for sales outreach token launches (generalized).

## Description

We need smart contract support for launching tokens whose reward baseline comes from a user-defined benchmark. The first instance is the sales messaging outreach benchmark, but the contract must remain protocol-level (model-agnostic). Instance-specific choices (e.g. metric name `sales:revenue_per_1000_messages`) belong in the deployment config / pipeline, not in the contracts.

### Current contract behavior
- `DeltaVerifier` accepts baseline/new scores via `EvaluationData.Metrics`, but the single-metric path treats `baselineMetrics.accuracy` and `newMetrics.accuracy` as generic score slots (`contracts/DeltaVerifier.sol:27,213,285,430`).
- `HokusaiParams.metricType` supports SingleMetric only and defaults to it (`contracts/HokusaiParams.sol:107`).
- Rewards use `tokensPerDeltaOne` from the token's params contract (`contracts/DeltaVerifier.sol:378`).
- There is **no** on-chain anchoring of an evaluation to a BenchmarkSpec, eval_spec, dataset hash/version, measurement policy, or scorer refs.
- `services/contract-deployer` does **not** currently process `hokusai:mint_requests` into `DeltaVerifier.submitEvaluation*` calls.

### Off-chain context (already in place)
- `hokusai-site` can create custom benchmark/eval specs during model creation and persist `benchmark_spec_id`.
- The sales outreach template uses `sales:revenue_per_1000_messages`, `zero_inflated_continuous`, `measurement_policy.mint_eligible: true`.
- `hokusai-data-pipeline` stores `BenchmarkSpec.baseline_value`/`eval_spec`, requires canonical `sha256:<hex>` dataset versions for remote datasets, and emits `MintRequest` messages to Redis queue `hokusai:mint_requests` with `model_id_uint`, baseline/new bps, cost USDC micro, contributors, attestation hash, idempotency key, metric_name, metric_family.
- `MintRequest` schema lives at `hokusai-data-pipeline/src/events/schemas.py:244` and `MintRequestPublisher` at `hokusai-data-pipeline/src/events/publishers/mint_request_publisher.py`.
- HOK-1683 (commit `888c74c`) defined the v1 relayer schema mapping doc that the contract-deployer should follow when translating `MintRequest` → `DeltaVerifier.submitEvaluationWithMultipleContributors`. See `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md`.

## Scope
Implement protocol-level support for **any** user-defined benchmark, not a sales-only special case. The contract surface must remain model-agnostic.

## Requirements

### R1. Define on-chain/contract-deployer representation for benchmark-backed evaluations
The relayer + contract path must carry/anchor:
- `benchmark_spec_id` (bytes32 hash of the canonical id)
- `dataset_hash` (sha256 of dataset, as bytes32) — distinct from `dataset_version`, which is a human-readable string
- `attestation_hash` (sha256 of HEM payload, bytes32)
- `idempotency_key` (sha256 of `model_id_uint:eval_id:attestation_hash`, bytes32)
- `metric_name` (string)
- `metric_family` (string — e.g. `proportion`, `zero_inflated_continuous`)
- `baseline_score_bps` and `candidate_score_bps`
- `max_cost_usd_micro` and `actual_cost_usd_micro` (USDC micro-units)
- contributor weights (existing `Contributor[]`)

### R2. MintRequest consumer in services/contract-deployer
- Consume `hokusai:mint_requests` (LPUSH from pipeline; RPOP / BRPOPLPUSH from consumer)
- Validate `MintRequest` schema (mirrors pipeline pydantic)
- Replay/idempotency check (Redis durable storage)
- Map scores into the new DeltaVerifier struct
- Call multi-contributor entrypoint (single contributors submit with weight=10000 per HOK-1683 mapping)
- Retry + DLQ failures
- Publish/record settlement result

### R3. Idempotency / replay protection
- Prevent the same `idempotency_key` (and same `attestation_hash`) from minting twice
- Replay protection lives in **both** places: on-chain `mapping(bytes32 => bool) processedIdempotencyKeys` in DeltaVerifier (authoritative), and Redis processed-set in contract-deployer (fast rejection without paying gas)

### R4. Anchor accepted DeltaOne events
Emit a new event `DeltaOneAccepted` carrying:
- `modelId` (uint256)
- `benchmarkSpecHash` (bytes32)
- `datasetHash` (bytes32)
- `attestationHash` (bytes32)
- `idempotencyKey` (bytes32)
- `metricName` (string)
- `metricFamily` (string)
- `baselineScoreBps` (uint256)
- `candidateScoreBps` (uint256)
- contributors and reward amount (already covered by `BatchRewardsDistributed`)

### R5. Confirm single-metric scoring semantics
- Single-metric path uses `newScore - baselineScore` in bps via `_calculateSingleMetricDelta` (`contracts/DeltaVerifier.sol:390`).
- Pipeline `DeltaOneAcceptanceEvent.delta_bps` must align with this (`new_score_bps - baseline_score_bps` in `[0, 10000]`).
- Document in code/PR description: non-proportion metrics (e.g. `sales:revenue_per_1000_messages`, family `zero_inflated_continuous`) must be normalized to 0–10000 bps **before** the pipeline publishes the MintRequest. Normalization is an off-chain pipeline concern.

### R6. Update deployment/token launch flow
- When launching a token from a custom BenchmarkSpec:
  - Register the model in `ModelRegistry` with the BenchmarkSpec primary metric name (string) — not always `accuracy`.
  - Ensure `HokusaiParams.metricType == SingleMetric` (default after HOK-1651 / `Remove MultiMetric` revert).
  - Calibrate `tokensPerDeltaOne` against the normalized bps convention (caller decides per token).
  - Grant `SUBMITTER_ROLE` on `DeltaVerifier` to the contract-deployer signer.
  - Grant `MINTER_ROLE` on `TokenManager` to `DeltaVerifier` and ensure `TokenManager.setDeltaVerifier` is set.
- Provide a generic `scripts/deploy-token-with-benchmark.js` that takes BenchmarkSpec metadata as args (model_id, metric_name, token_symbol, baseline_bps, etc.) — model-agnostic. Sales outreach is one configuration.

## Acceptance Criteria
1. A token can be launched using a user-defined BenchmarkSpec baseline from hokusai-site.
2. A sales outreach accepted eval from hokusai-data-pipeline produces a MintRequest.
3. Contract-deployer consumes the MintRequest and submits a DeltaVerifier transaction.
4. The verifier mints rewards to weighted contributors **exactly once** per idempotency key (replay-attempted submissions revert).
5. The emitted on-chain event can be traced back to the BenchmarkSpec, dataset hash/version, and attestation hash.
6. Tests cover: single contributor, multi contributor, replay/idempotency, budget violation, inactive model, sales `zero_inflated_continuous` normalized-score handling, attestation-hash mismatch, weights-must-sum-to-100% edge case.

## Reviewed Context
- Token PR #75: single-metric DeltaVerifier support
- Pipeline PR #165: sales custom outcome eval contract
- Pipeline PR #172: remote S3 sales custom evals and canonical dataset hashes
- Site PR #303: create-model Step 2 custom metrics and benchmark flow
- Existing HLEAD Sepolia deployment config in `scripts/deploy-testnet-full-v2.js:9`
- HOK-1683 (`888c74c`) relayer schema mapping (`features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md`)
- HOK-1651 (`c11ec75`) configurable vesting
- HOK-1276 MintRequest schema/publisher in pipeline
