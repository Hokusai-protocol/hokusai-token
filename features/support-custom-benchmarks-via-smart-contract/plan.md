# Implementation Plan: HOK-1653 Support custom benchmarks via smart contract

## Goal
Add protocol-level support for tokens whose reward baseline comes from a user-defined `BenchmarkSpec`. End-to-end: pipeline publishes a `MintRequest` → contract-deployer consumes it, dedupes, and submits to `DeltaVerifier` → `DeltaVerifier` enforces on-chain idempotency, anchors benchmark identifiers in an event, and mints rewards via `TokenManager`. The contract surface stays model-agnostic; sales outreach is the first concrete deployment, not a special case.

## Architectural Decisions

### D1. New DeltaVerifier entry point `submitMintRequest` (don't overload existing functions)
Add a new external function on `DeltaVerifier`:

```solidity
struct BenchmarkAnchors {
    bytes32 benchmarkSpecHash;   // keccak256(benchmark_spec_id) — model-agnostic
    bytes32 datasetHash;          // sha256 of dataset payload (passed as bytes32)
    bytes32 attestationHash;      // sha256 of HEM attestation
    bytes32 idempotencyKey;       // sha256(model_id_uint:eval_id:attestation_hash)
    string metricName;            // e.g. "sales:revenue_per_1000_messages"
    string metricFamily;          // e.g. "zero_inflated_continuous", "proportion"
}

struct MintRequestPayload {
    string pipelineRunId;         // eval_id
    uint256 baselineScoreBps;     // in [0, 10000]
    uint256 candidateScoreBps;    // in [0, 10000]
    uint256 maxCostUsdMicro;      // USDC 6-decimal
    uint256 actualCostUsdMicro;   // USDC 6-decimal
    BenchmarkAnchors anchors;
}

function submitMintRequest(
    uint256 modelId,
    MintRequestPayload calldata payload,
    Contributor[] calldata contributors
) external nonReentrant whenNotPaused onlyRole(SUBMITTER_ROLE) returns (uint256);
```

**Why a new function (not modify existing)**:
- Preserves backward compatibility with existing `submitEvaluation`, `submitEvaluationWithContributorInfo`, `submitEvaluationWithMultipleContributors` (other consumers + tests).
- The relayer schema doc (`HOK-1683`) standardises on `submitEvaluationWithMultipleContributors` for v1 — `submitMintRequest` is the v2 protocol-aware path the doc anticipates by noting attestation_hash had no v1 on-chain destination.
- Avoids overloading `accuracy` slots and removes the off-chain "attestation_hash retained off-chain" caveat from v1.

**Why a struct param**: avoids stack-too-deep and groups anchor fields cleanly.

**Why bps for scores (not normalized floats)**: matches existing `_calculateSingleMetricDelta` semantics and the pipeline's existing `MintRequestEvaluation.baseline_score_bps`/`new_score_bps` shape. Non-proportion metrics (e.g. revenue-per-1k-messages) are normalized to bps by the pipeline before publishing.

**Why micro-USDC for cost (not whole USD)**: matches `MintRequestEvaluation.max_cost_usd_micro`/`actual_cost_usd_micro`. The existing `_isBudgetConstraintViolated` only cares whether `actual > max` and treats `0` as sentinel — unit changes don't affect the comparison so we can safely store micro-units. (Update `EvaluationDataBase` to keep its field name semantics but the contract doesn't care about the unit downstream — we just compare.)

### D2. On-chain idempotency authoritative; Redis used for fast pre-flight
- `DeltaVerifier` adds `mapping(bytes32 => bool) public processedIdempotencyKeys`. First call records; second call **reverts** with `"Idempotency key already processed"`.
- The contract-deployer keeps a Redis set `hokusai:mint_requests:processed` to skip already-handled keys without paying gas. This is best-effort; the chain is the source of truth.
- Why both: on-chain prevents double-mint across multiple relayer instances or restarts; Redis short-circuits the common case before any RPC roundtrip.
- Tradeoff considered: an on-chain-only model adds gas to every submission for the SSTORE. We pay this cost; the alternative (signed claim ticket pattern) is heavier and unnecessary at our throughput.

### D3. New event `DeltaOneAccepted` (anchors-rich), kept in addition to existing events
```solidity
event DeltaOneAccepted(
    uint256 indexed modelId,
    bytes32 indexed idempotencyKey,
    bytes32 indexed benchmarkSpecHash,
    bytes32 attestationHash,
    bytes32 datasetHash,
    string metricName,
    string metricFamily,
    uint256 baselineScoreBps,
    uint256 candidateScoreBps,
    uint256 rewardAmount,
    string pipelineRunId
);
```
- Three indexed topics give indexers fast lookup paths: by model, by idempotency key, by benchmark spec.
- Contributors+amounts are still emitted via the existing `BatchRewardsDistributed` event (no duplication).

### D4. MintRequest schema extension policy (cross-repo)
The pipeline's current `MintRequest` schema **does not** include `benchmark_spec_id` or `dataset_hash`. Two options:
- **Option A** (chosen): Have the contract-deployer derive `benchmarkSpecHash = keccak256(model_id || metric_name)` and accept `datasetHash = 0x00...` when not present in the MintRequest. This unblocks HOK-1653 without a cross-repo change but provides weaker anchoring.
- **Option B**: Require pipeline schema additive update (HOK-1653-followup) to include `benchmark_spec_id: string` and `dataset_hash: 0x...`. The contract-deployer reads them straight from the MintRequest.

**Decision**: Implement Option B but make both fields **optional** on the consumer side (Joi schema accepts undefined). When missing, fall back to a deterministic derivation (`keccak256(model_id_uint, metric_name)` for benchmarkSpecHash, `bytes32(0)` for datasetHash). This way:
- No cross-repo blocker for v1
- Pipeline can land a follow-up that adds the fields, and the contract-deployer picks them up with no additional change
- Audit-grade anchoring is achievable when the pipeline emits the richer schema

We will surface this as a clear note in the PR description and in the contract-deployer README.

### D5. Token launch flow stays generic
A new generic helper script `scripts/deploy-token-with-benchmark.js` reads a small JSON config:
```json
{
  "modelId": "sales-outreach-v1",
  "metricName": "sales:revenue_per_1000_messages",
  "tokenName": "...",
  "tokenSymbol": "...",
  "initialSupply": "...",
  "tokensPerDeltaOne": "...",
  "infrastructureAccrualBps": 8000,
  "vestingConfig": { ... }
}
```
The script wires up:
1. `TokenManager.deployTokenWithParams(...)` (existing path) using `MetricType.SingleMetric`.
2. `ModelRegistry.registerModel(...)` with the BenchmarkSpec primary metric name.
3. Grants `SUBMITTER_ROLE` on `DeltaVerifier` to the contract-deployer signer.
4. Grants `MINTER_ROLE` on `TokenManager` to `DeltaVerifier` (if not already), sets `setDeltaVerifier`.
5. Grants `RECORDER_ROLE` on `DataContributionRegistry` to `DeltaVerifier` (if not already).

Existing `scripts/deploy-sepolia-sales-lead-scoring.js` and `scripts/deploy-testnet-full-v2.js` continue to work. The new script is a thin layer that reuses what they already do — no removal.

---

## Implementation Phases

### Phase 1: Smart contract — `submitMintRequest` + idempotency + event
**Files**:
- `contracts/DeltaVerifier.sol` (main change)
- `contracts/interfaces/IDeltaVerifier.sol` (if exists; otherwise no interface file change needed)

**Substeps**:
1. Add `BenchmarkAnchors` and `MintRequestPayload` structs alongside existing `EvaluationDataBase`.
2. Add storage: `mapping(bytes32 => bool) public processedIdempotencyKeys;`.
3. Add event `DeltaOneAccepted` (see D3 signature).
4. Add `error IdempotencyKeyAlreadyProcessed(bytes32 key)` and `error EmptyIdempotencyKey()` (use require strings if codebase prefers — check existing pattern: existing contracts use `require("...")` strings, so we use those for consistency).
5. Implement `submitMintRequest(uint256 modelId, MintRequestPayload calldata payload, Contributor[] calldata contributors)`:
   - Validate model registered + active (mirrors `submitEvaluationWithMultipleContributors`).
   - Validate `payload.anchors.idempotencyKey != bytes32(0)`.
   - Check `!processedIdempotencyKeys[payload.anchors.idempotencyKey]`, revert if already set.
   - Mark `processedIdempotencyKeys[payload.anchors.idempotencyKey] = true` **before** external calls (CEI pattern; already protected by `nonReentrant` but belt + suspenders).
   - Validate contributors array (non-empty, max 100, no duplicates, weights sum to 10000) — reuse same loop pattern as `submitEvaluationWithMultipleContributors`.
   - Validate baseline_bps ≤ 10000 and candidate_bps ≤ 10000.
   - Validate `payload.pipelineRunId` non-empty (DataContributionRegistry requires it on reward path).
   - Validate `metricName` non-empty (anchoring requires it).
   - Budget check: `_isBudgetConstraintViolated(payload.maxCostUsdMicro, payload.actualCostUsdMicro)`. If violated, emit `BudgetConstraintViolated` + return 0 (same shape as existing function — but we still consume the idempotency key so a budget-blocked submission cannot be re-tried with reduced cost to mint).
   - Compute `deltaInBps = _calculateSingleMetricDelta(payload.baselineScoreBps, payload.candidateScoreBps)`.
   - If `deltaInBps == 0`, emit `DeltaOneAccepted(..., rewardAmount: 0)` + `EvaluationSubmitted` and return 0.
   - Otherwise compute `totalReward = calculateRewardDynamic(modelIdStr, deltaInBps, 10000, 0)`.
   - Distribute proportionally to contributors (reuse existing rounding-dust-to-first-contributor pattern), call `tokenManager.batchMintReward(...)`, emit `RewardCalculated` per contributor + `BatchRewardsDistributed` + new `DeltaOneAccepted` event.
   - Record contributions in `DataContributionRegistry` using existing `_recordContributions` helper.
6. **Do not modify** `submitEvaluation*` existing functions. Backward compatibility preserved.

**Test plan (Hardhat, `test/DeltaVerifier.mintRequest.test.js`)**:
- Happy path single contributor (weight=10000): mints exact reward, emits `DeltaOneAccepted` with all anchor fields, sets `processedIdempotencyKeys`.
- Happy path multi-contributor (e.g. 60/30/10 split): correct per-contributor amounts, dust assigned to first contributor.
- Replay (same idempotencyKey): second call reverts.
- Zero idempotency key: reverts.
- Inactive model: reverts `"Model is deactivated"`.
- Unregistered model: reverts `"Model not registered"`.
- Budget violation (`actual > max`, both non-zero, micro-units): emits `BudgetConstraintViolated`, returns 0, **but still consumes** the idempotency key (replay still reverts).
- `candidate ≤ baseline`: emits `DeltaOneAccepted` with reward=0, no minting, still consumes idempotency.
- Empty `pipelineRunId`: reverts before any state mutation.
- Empty `metricName`: reverts.
- Weights don't sum to 10000: reverts `"Weights must sum to 100%"`.
- Caller lacks `SUBMITTER_ROLE`: reverts with AccessControl error.
- Contract paused: reverts.
- "Sales zero_inflated_continuous" simulation: pass `metricFamily="zero_inflated_continuous"`, `metricName="sales:revenue_per_1000_messages"`, baseline=5000, candidate=7500, verify event payload + reward computed using SingleMetric semantics. Verifies the contract is metric-family-agnostic.

### Phase 2: Solidity test infrastructure
**Files**:
- `test/DeltaVerifier.mintRequest.test.js` (new)
- `test/helpers/mintRequest.js` (new helper for building canonical payloads)

**Substeps**:
1. Helper `buildMintRequestPayload({ baselineBps, candidateBps, idempotencyKey, ... })` returns a struct ready for `submitMintRequest`.
2. Use existing `deployTestToken` and patterns from `test/deltaVerifier.multiContributor.test.js`.
3. No mocking of DataContributionRegistry — use the real one (matches existing tests).

### Phase 3: Contract-deployer — MintRequest schema validation
**Files**:
- `services/contract-deployer/src/schemas/mint-request-schema.ts` (new)
- `services/contract-deployer/tests/unit/schemas/mint-request-schema.test.ts` (new)

**Substeps**:
1. Create TypeScript interface + Joi schema mirroring `MintRequest` pydantic from `hokusai-data-pipeline/src/events/schemas.py:243`:
   - `message_type: "mint_request"`, `schema_version: "1.0"`
   - `message_id`, `timestamp`
   - `model_id`, `model_id_uint` (decimal string), `eval_id`
   - `attestation_hash`, `idempotency_key` (0x-prefixed sha256)
   - `evaluation`: `{ metric_name, metric_family, baseline_score_bps, new_score_bps, max_cost_usd_micro, actual_cost_usd_micro, ... }`
   - `contributors`: `[{ wallet_address, weight_bps }]` — sum must be 10000
   - **Optional additive fields** (per D4): `benchmark_spec_id?: string`, `dataset_hash?: string` (0x-prefixed sha256)
2. Validation rules:
   - `weight_bps` sum == 10000
   - `contributors.length` in `[1, 100]`
   - `baseline_score_bps`, `new_score_bps` in `[0, 10000]`
   - `attestation_hash`, `idempotency_key` match `/^0x[0-9a-f]{64}$/`
   - `model_id_uint` parses as positive integer
3. Unit tests cover happy/edge cases.

### Phase 4: Contract-deployer — MintRequest consumer
**Files**:
- `services/contract-deployer/src/queue/mint-request-consumer.ts` (new)
- `services/contract-deployer/src/services/mint-request-processor.ts` (new)
- `services/contract-deployer/src/blockchain/delta-verifier-client.ts` (new)
- `services/contract-deployer/src/mint-request-listener.ts` (new — analogous to `contract-deploy-listener.ts`)
- `services/contract-deployer/src/index.ts` (update — start both listeners)
- `services/contract-deployer/contracts/DeltaVerifier.json` (new — ABI export from `npx hardhat compile`)

**Substeps**:
1. **Redis consumer** (`mint-request-consumer.ts`):
   - Pattern after `redis-consumer.ts`: BRPOPLPUSH from `hokusai:mint_requests` to `hokusai:mint_requests:processing`.
   - Validate via the schema in Phase 3.
   - **Redis idempotency check** (fast-path): `SISMEMBER hokusai:mint_requests:processed <idempotency_key>` → if 1, log + ACK + skip (mark already-done).
   - Call processor.
   - On success, `SADD hokusai:mint_requests:processed <idempotency_key>` + LREM from processing queue.
   - On failure, retry up to N times then DLQ (`hokusai:mint_requests:dlq`).
   - **On-chain idempotency** is the ground truth: if the chain reverts with `"Idempotency key already processed"`, treat as success (already minted by a prior attempt) and add to the Redis processed set so we never re-attempt.

2. **DeltaVerifier client** (`delta-verifier-client.ts`):
   - Loads the new ABI subset (`submitMintRequest`, `processedIdempotencyKeys`, `EvaluationSubmitted`, `DeltaOneAccepted`, `BudgetConstraintViolated`).
   - Method `submitMintRequest(modelIdUint, payload, contributors)` → returns tx hash, block number, event payload.
   - Pre-flight: `processedIdempotencyKeys(key)` view call to avoid unnecessary tx.
   - Preflight `modelRegistry.isRegistered` + `isModelActive` (per HOK-1683 doc); on failure, route to DLQ with a clear classification.
   - Gas estimation + max-gas cap (mirror existing `contract-deployer.ts` pattern).
   - Retries on transient RPC errors (mirror existing pattern).

3. **Processor** (`mint-request-processor.ts`):
   - Map MintRequest → `BenchmarkAnchors` + `MintRequestPayload`:
     - `idempotencyKey` ← `0x...` from MintRequest
     - `attestationHash` ← `0x...` from MintRequest
     - `benchmarkSpecHash` ← `keccak256(benchmark_spec_id)` if present, else `keccak256(abi.encode(model_id_uint, metric_name))` (deterministic fallback per D4)
     - `datasetHash` ← `0x...` if present, else `bytes32(0)`
     - `metricName` ← `evaluation.metric_name`
     - `metricFamily` ← `evaluation.metric_family`
     - `baselineScoreBps`, `candidateScoreBps` ← from `evaluation`
     - `maxCostUsdMicro`, `actualCostUsdMicro` ← from `evaluation`
     - `pipelineRunId` ← `eval_id`
   - Map contributors directly (`wallet_address`, `weight_bps` → `weight`).
   - Invoke `DeltaVerifierClient.submitMintRequest(...)`.
   - On `BudgetConstraintViolated` event: classify as "budget_blocked" and emit settlement record.
   - On `DeltaOneAccepted` with reward=0: classify as "no_delta".
   - On `DeltaOneAccepted` with reward>0: classify as "minted".

4. **Settlement publication** (`mint-request-listener.ts` or `event-publisher.ts` extension):
   - Publish `MintRequestSettled` event to `hokusai:mint_request_settlements` queue with:
     - `idempotency_key`, `attestation_hash`, `model_id`, `tx_hash`, `block_number`, `status` (minted | budget_blocked | no_delta | replay | error), `reward_amount`, `gas_used`.
   - Mirrors the existing token-deployed publisher contract.

5. **Wire-up** (`index.ts`):
   - Conditionally start a `MintRequestListener` alongside `ContractDeployListener` when `DELTA_VERIFIER_ADDRESS` env var is set and a `SUBMITTER_ROLE` private key is available (could share `DEPLOYER_PRIVATE_KEY`).
   - New env vars:
     - `DELTA_VERIFIER_ADDRESS` (required to enable mint consumer)
     - `MINT_REQUEST_QUEUE` (default `hokusai:mint_requests`)
     - `MINT_REQUEST_PROCESSING_QUEUE` (default `hokusai:mint_requests:processing`)
     - `MINT_REQUEST_DLQ` (default `hokusai:mint_requests:dlq`)
     - `MINT_REQUEST_PROCESSED_SET` (default `hokusai:mint_requests:processed`)
     - `MINT_REQUEST_SETTLEMENT_QUEUE` (default `hokusai:mint_request_settlements`)
     - `MINT_REQUEST_MAX_RETRIES` (default `3`)

### Phase 5: Contract-deployer tests
**Files**:
- `services/contract-deployer/tests/unit/queue/mint-request-consumer.test.ts`
- `services/contract-deployer/tests/unit/services/mint-request-processor.test.ts`
- `services/contract-deployer/tests/unit/blockchain/delta-verifier-client.test.ts`
- `services/contract-deployer/tests/integration/mint-request-flow.test.ts`

**Test scenarios**:
- Schema validation: happy/edge MintRequest payloads.
- Consumer happy path: message picked up, validated, processed, ACKed, processed-set updated.
- Consumer replay (Redis set hit): skip processing entirely.
- Consumer replay (chain says already processed): mark as Redis-processed without re-submitting.
- Consumer retry-then-DLQ on transient errors.
- Processor field mapping: with `benchmark_spec_id` present, with it absent (fallback), with `dataset_hash` absent.
- DLQ classification: unregistered model, deactivated model, schema errors.
- Settlement publication for each terminal status.

### Phase 6: Deployment helper
**Files**:
- `scripts/deploy-token-with-benchmark.js` (new, generic)
- `scripts/configs/sales-outreach-v1.json` (new, instance config)

**Substeps**:
1. Build the script as a thin wrapper over existing `TokenManager.deployTokenWithParams` + `ModelRegistry.registerModel` + role grants (`SUBMITTER_ROLE` on DeltaVerifier, `MINTER_ROLE` on TokenManager, `RECORDER_ROLE` on DataContributionRegistry).
2. Script reads config from JSON path passed via CLI arg (`--config`).
3. Sales outreach config: `metricName: "sales:revenue_per_1000_messages"`, `tokensPerDeltaOne: 1000` (calibrated for bps), default vesting.
4. Output: a `deployments/<network>-<modelId>.json` artifact with all addresses + roles for reproducibility.
5. **Do not** delete or move existing scripts like `deploy-sepolia-sales-lead-scoring.js`. New script lives alongside.

### Phase 7: Documentation
**Files**:
- `services/contract-deployer/README.md` (update — new env vars + queue name)
- Update `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md` with a "v2" section pointing to `submitMintRequest` and the new anchor fields (without removing v1 mapping — it remains valid for callers that only use v1).
- Add a short note in `project-knowledge/codebase-map.md` about the MintRequest flow.
- Add an inline comment in `DeltaVerifier.sol` `submitMintRequest` explaining the bps normalization expectation (anchors what callers must do off-chain).

---

## Release Readiness

- `database_change_risk`: **none** — no SQL/Alembic in this repo.
- `env_changes`: `DELTA_VERIFIER_ADDRESS`, `MINT_REQUEST_QUEUE`, `MINT_REQUEST_PROCESSING_QUEUE`, `MINT_REQUEST_DLQ`, `MINT_REQUEST_PROCESSED_SET`, `MINT_REQUEST_SETTLEMENT_QUEUE`, `MINT_REQUEST_MAX_RETRIES`. All optional; defaults match queue names already used by the pipeline (`hokusai:mint_requests`).
- `config_changes`: `services/contract-deployer/src/config/env.validation.ts` (add the new vars as optional), `services/contract-deployer/.env.example` (if present; add the same).
- `manual_steps`:
  - On Sepolia/mainnet, after deploying the updated `DeltaVerifier`, the contract-deployer service must be granted `SUBMITTER_ROLE`.
  - The new `DELTA_VERIFIER_ADDRESS` env var must be set in ECS (or local `.env`) to enable the mint consumer.
  - For the sales outreach token launch: run `scripts/deploy-token-with-benchmark.js --config scripts/configs/sales-outreach-v1.json --network sepolia` and update the `sepolia-latest.json` deployment artifact.
  - **Pipeline-side follow-up** (out of scope for this PR but tracked): add optional `benchmark_spec_id` and `dataset_hash` fields to `MintRequest` schema in `hokusai-data-pipeline` so the contract can record full provenance instead of falling back to derived hashes.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| Cross-repo MintRequest schema drift | Make new fields optional in the consumer (D4); document in PR. |
| Double-mint if `processedIdempotencyKeys` not checked before external mint call | We check + set the flag **before** the `tokenManager.batchMintReward` call; `nonReentrant` guards against reentrancy mid-mint. |
| Existing `submitEvaluation*` consumers break | New function only — no modifications to existing entry points. Existing tests must still pass. |
| Storage layout change of `DeltaVerifier` breaks upgradeable proxy | `DeltaVerifier` is **not** behind a proxy (constructor-only roles, no `__init` pattern). Storage append is safe. Confirm by reviewing imports — already verified no `@openzeppelin/contracts-upgradeable`. |
| Gas cost of SSTORE on every submission | Acceptable at our throughput (sub-hourly cadence). ~20k gas extra per first-time mint; ~5k per replay-attempt. |
| `metricFamily` string emitted in event bloats indexer payload | Acceptable — emitted as non-indexed string. If this becomes a problem, follow-up can switch to a `bytes32` enum encoding. |
| Sales `zero_inflated_continuous` normalization wrong off-chain | Out of scope here — the contract treats the bps as opaque. Pipeline-side calibration is the only correct location; we document it in the PR + a code comment. |
| `ModelRegistry.registerModel` requires non-empty performance metric — but takes uint256 modelId only, while `MintRequest.model_id_uint` may not match an existing uint256-keyed registration | Verify the deployment path uses `registerModel(uint256, address, string)` with the same model id used by the pipeline. The launch helper script (Phase 6) reads the model id from config and registers it explicitly. |

---

## Test Matrix Summary

**Hardhat (Solidity)** — `test/DeltaVerifier.mintRequest.test.js`:
- [ ] happy path single contributor
- [ ] happy path multi-contributor with rounding dust
- [ ] replay reverts
- [ ] zero idempotency key reverts
- [ ] inactive model reverts
- [ ] unregistered model reverts
- [ ] budget violation: emits + returns 0 + still consumes idempotency
- [ ] candidate ≤ baseline: reward=0, emits DeltaOneAccepted, still consumes idempotency
- [ ] empty pipelineRunId reverts
- [ ] empty metricName reverts
- [ ] weights sum != 10000 reverts
- [ ] non-SUBMITTER_ROLE caller reverts
- [ ] contract paused reverts
- [ ] zero_inflated_continuous metric family records correctly in event
- [ ] anchor fields propagate exactly to event topics/data
- [ ] does not regress existing `submitEvaluation*` paths (existing tests still pass)

**Jest (TypeScript)** — `services/contract-deployer/tests/`:
- [ ] schema validation: pass/fail cases mirroring pipeline pydantic
- [ ] consumer: happy path, replay skip, retry/DLQ
- [ ] processor: field mapping with/without optional anchor fields
- [ ] DeltaVerifierClient: preflight checks, on-chain idempotency rejection handling
- [ ] settlement publisher emits correct status

**Integration**:
- [ ] In-process integration test that spins up a Hardhat node, deploys the full stack, publishes a sample MintRequest to Redis, asserts on-chain state + settlement event. (Builds on `services/contract-deployer/tests/integration/contract-deploy-flow.test.ts` pattern.)

---

## Out of Scope (for HOK-1653)
- Modifying the pipeline's `MintRequest` pydantic schema. (Optional follow-up to add `benchmark_spec_id`/`dataset_hash` for full provenance.)
- Updating hokusai-site to surface BenchmarkSpec metadata in the explore page. (Site-side concern.)
- Mainnet deployment of the new DeltaVerifier. (Operational rollout, separate work order.)
- Migrating existing pipeline callers from `submitEvaluation*` to `submitMintRequest`. (Pipeline already targets a not-yet-implemented relayer endpoint; this PR delivers that endpoint.)
- Multi-metric reward computation (`MetricType.MultiMetric`). Removed in PR #82 and intentionally not reintroduced.

---

## File-Level Checklist (for coding phase)
- [ ] `contracts/DeltaVerifier.sol` — add structs, storage, event, `submitMintRequest`
- [ ] `test/DeltaVerifier.mintRequest.test.js` — new test file (matrix above)
- [ ] `test/helpers/mintRequest.js` — helper builder
- [ ] `services/contract-deployer/src/schemas/mint-request-schema.ts` — new Joi schema
- [ ] `services/contract-deployer/src/queue/mint-request-consumer.ts` — new consumer
- [ ] `services/contract-deployer/src/services/mint-request-processor.ts` — new processor
- [ ] `services/contract-deployer/src/blockchain/delta-verifier-client.ts` — new contract client
- [ ] `services/contract-deployer/src/mint-request-listener.ts` — orchestrator (consumer + processor + publisher)
- [ ] `services/contract-deployer/src/index.ts` — wire up second listener
- [ ] `services/contract-deployer/src/config/env.validation.ts` — add optional env vars
- [ ] `services/contract-deployer/contracts/DeltaVerifier.json` — copy generated ABI
- [ ] `services/contract-deployer/tests/unit/...` — schema, consumer, processor, client unit tests
- [ ] `services/contract-deployer/tests/integration/mint-request-flow.test.ts` — e2e integration
- [ ] `scripts/deploy-token-with-benchmark.js` — generic launch helper
- [ ] `scripts/configs/sales-outreach-v1.json` — sales instance config
- [ ] `services/contract-deployer/README.md` — env vars + new queue documentation
- [ ] `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md` — v2 section (additive)
