# DeltaVerifier v1 Trust Model

Purpose: document what DeltaVerifier v1 does and does not verify for launch reviewers, operators, and backend relayer owners before production use.

Audience: security reviewers, launch reviewers, multisig owners, relayer operators, and benchmark pipeline maintainers.

This is a protocol trust-model note, not a deployment-instance runbook. Model-specific parameter values, production addresses, and signer identities belong in deployment artifacts and custody runbooks, not here. See `contracts/DeltaVerifier.sol`, `contracts/HokusaiParams.sol`, and `deployments/TESTNET-CHECKLIST.md` for the implementation and rehearsal sources cited below.

## Purpose and audience

DeltaVerifier v1 is intentionally not a fully trustless benchmark-verification system. The contract trusts an approved submitter to relay honest benchmark results, then applies a narrow set of on-chain checks before minting through `TokenManager` and recording provenance in `DataContributionRegistry` (`contracts/DeltaVerifier.sol:168-205`, `contracts/DeltaVerifier.sol:207-359`).

This document exists so reviewers can answer four questions precisely:

- Who is allowed to submit evaluations, and how is that role granted or rotated?
- Which anti-gaming controls are enforced on-chain, and which are only off-chain or procedural?
- What does `attestation_hash` commit to, and what does it not prove?
- What residual trust assumptions still exist after all current checks pass?

Version scope:

- This note describes the current repository state on the `task/document-v1-deltaone-trusted-submitter-and-anti-gaming-model` branch.
- Where legacy v1 and protocol-aware v2 paths differ, both are called out explicitly so launch reviewers do not overgeneralize one path's guarantees onto the other.

## System overview

```text
benchmark pipeline / relayer
  validates MintRequest shape, contributor weights, score ranges,
  optional benchmark anchors, and off-chain attestation material
            |
            v
DeltaVerifier
  checks SUBMITTER_ROLE, model active state, pause state,
  replay key, budget cap, reward bounds, and contributor array rules
            |
            v
TokenManager
  mints reward tokens to contributors
            |
            v
RewardVestingVault
  applies token-level vesting rules when the launched token is configured
  for vesting via HokusaiParams / token params
```

The relevant v1/v2 entrypoints are:

- Legacy single-contributor paths: `submitEvaluation` and `submitEvaluationWithContributorInfo` (`contracts/DeltaVerifier.sol:168-205`).
- Legacy multi-contributor v1 path: `submitEvaluationWithMultipleContributors` (`contracts/DeltaVerifier.sol:207-275`).
- Protocol-aware v2 path with benchmark anchors: `submitMintRequest` (`contracts/DeltaVerifier.sol:277-359`).

The reward path after a valid submission is contract-only and deterministic:

- DeltaVerifier computes reward size from score delta, contributor weight, `minImprovementBps`, `maxReward`, and token params (`contracts/DeltaVerifier.sol:457-489`).
- DeltaVerifier calls `TokenManager.mintReward` or `TokenManager.batchMintReward` (`contracts/DeltaVerifier.sol:255-269`, `contracts/DeltaVerifier.sol:401-415`).
- Each launched token reads reward parameters from its params contract, including `tokensPerDeltaOne` and vesting configuration (`contracts/DeltaVerifier.sol:463-489`, `contracts/HokusaiParams.sol:223-238`).

## SUBMITTER_ROLE governance

`SUBMITTER_ROLE` is the only role that can call DeltaVerifier submission entrypoints. It is defined as `keccak256("SUBMITTER_ROLE")` in `contracts/DeltaVerifier.sol:15`, and all four submission functions are gated by `onlyRole(SUBMITTER_ROLE)` (`contracts/DeltaVerifier.sol:171`, `contracts/DeltaVerifier.sol:182`, `contracts/DeltaVerifier.sol:211`, `contracts/DeltaVerifier.sol:284`).

The role admin is `DEFAULT_ADMIN_ROLE` because DeltaVerifier inherits OpenZeppelin `AccessControl` and does not override the admin relationship. In practice that means the holder of `DEFAULT_ADMIN_ROLE` can use `grantRole(SUBMITTER_ROLE, account)` and `revokeRole(SUBMITTER_ROLE, account)` on DeltaVerifier. The constructor grants both `DEFAULT_ADMIN_ROLE` and `SUBMITTER_ROLE` to the deployer EOA at deployment time (`contracts/DeltaVerifier.sol:143-166`).

Operationally, the long-lived admin is expected to be a Safe or other multisig before any routine key rotation:

- The Sepolia checklist requires treasury/admin Safe rehearsal and deployer role revocation before sign-off (`deployments/TESTNET-CHECKLIST.md:66-76`, `deployments/TESTNET-CHECKLIST.md:100-107`).
- The custody runbook says the deployer must not remain the long-lived holder of admin rights after handoff, and explicitly calls for the Safe to receive `DEFAULT_ADMIN_ROLE` on DeltaVerifier before deployer revocation (`docs/mainnet-custody-runbook.md:24-37`, `docs/mainnet-custody-runbook.md:120-146`).
- The same runbook states the desired end state for DeltaVerifier is treasury/admin Safe as `DEFAULT_ADMIN_ROLE` and the approved backend submitter as `SUBMITTER_ROLE` (`docs/mainnet-custody-runbook.md:72-73`).

### Grant flow

The expected grant flow for a new environment is:

1. Deploy DeltaVerifier. The deployer EOA receives `DEFAULT_ADMIN_ROLE` and `SUBMITTER_ROLE` automatically (`contracts/DeltaVerifier.sol:164-165`).
2. Grant `DEFAULT_ADMIN_ROLE` to the Safe or approved multisig before revoking the deployer (`docs/mainnet-custody-runbook.md:124-134`).
3. Grant `SUBMITTER_ROLE` to the backend relayer or verifier wallet with `DeltaVerifier.grantRole(SUBMITTER_ROLE, <BACKEND>)` (`docs/mainnet-custody-runbook.md:72-73`, `docs/mainnet-custody-runbook.md:159-160`).
4. Verify the backend can submit a rehearsal transaction.
5. Revoke `SUBMITTER_ROLE` from the deployer once the backend submitter is active (`deployments/TESTNET-CHECKLIST.md:71-75`, `docs/mainnet-custody-runbook.md:148-170`).

### Rotation flow

The safe rotation procedure is:

1. Confirm the current admin is the Safe or another controlled multisig, not the hot submitter key (`docs/mainnet-custody-runbook.md:24-37`, `docs/mainnet-custody-runbook.md:120-146`).
2. Grant `SUBMITTER_ROLE` to the replacement backend wallet with `grantRole`.
3. Smoke-test a real or dry-run submission from the new wallet.
4. Revoke `SUBMITTER_ROLE` from the old wallet with `revokeRole`.
5. Record transaction hashes in the custody runbook / Sepolia rehearsal notes (`deployments/TESTNET-CHECKLIST.md:75`, `docs/mainnet-custody-runbook.md:21`, `docs/mainnet-custody-runbook.md:79-80`).

The contract does not implement staged rotation, timelocks, multi-submit quorum, or per-submitter rate limits. Rotation safety depends on custody discipline around `DEFAULT_ADMIN_ROLE`, not on extra contract logic.

## On-chain guarantees

The following checks are enforced by the deployed contracts, not merely by operator policy:

- Caller authorization: every submission path requires `SUBMITTER_ROLE` (`contracts/DeltaVerifier.sol:171`, `contracts/DeltaVerifier.sol:182`, `contracts/DeltaVerifier.sol:211`, `contracts/DeltaVerifier.sol:284`).
- Emergency stop: every submission path is blocked while DeltaVerifier is paused, and only `DEFAULT_ADMIN_ROLE` can pause or unpause (`contracts/DeltaVerifier.sol:171`, `contracts/DeltaVerifier.sol:182`, `contracts/DeltaVerifier.sol:211`, `contracts/DeltaVerifier.sol:284`, `contracts/DeltaVerifier.sol:603-608`).
- Model existence and active state: all paths require `modelRegistry.isRegistered(modelId)` and `modelRegistry.isModelActive(modelId)` (`contracts/DeltaVerifier.sol:173-175`, `contracts/DeltaVerifier.sol:184-185`, `contracts/DeltaVerifier.sol:213-214`, `contracts/DeltaVerifier.sol:285-286`).
- v2 replay protection: `submitMintRequest` rejects empty idempotency keys, rejects any already-processed key, and marks the key as consumed before the budget check (`contracts/DeltaVerifier.sol:287-297`).
- Budget cap enforcement: both v1 multi-contributor and v2 paths emit `BudgetConstraintViolated` and return `0` instead of minting when `actualCostUsd > maxCostUsd`; a `0` in either field disables the comparison (`contracts/DeltaVerifier.sol:218-225`, `contracts/DeltaVerifier.sol:298-305`, `contracts/DeltaVerifier.sol:544-558`).
- Legacy single-contributor rate limit: `_processEvaluation` enforces a one-hour per-contributor cooldown on the two legacy single-contributor entrypoints only (`contracts/DeltaVerifier.sol:94-95`, `contracts/DeltaVerifier.sol:361-383`).
- Contributor-array validation on multi-contributor paths: contributor arrays must be non-empty, have at most 100 entries, contain no zero address, contain no duplicate address, and sum to exactly `10000` basis points (`contracts/DeltaVerifier.sol:561-583`).
- Score-floor and reward-cap enforcement: rewards below `minImprovementBps` mint nothing, and rewards above `maxReward` are capped (`contracts/DeltaVerifier.sol:474-485`).
- Token existence on the reward path: `calculateRewardDynamic` reverts if the token for the model does not exist in TokenManager (`contracts/DeltaVerifier.sol:463-466`).
- Contribution recording is contract-mediated: when rewards are non-zero, DeltaVerifier writes through the contribution registry after minting via `_recordContributions` or `_recordSingleContribution` (`contracts/DeltaVerifier.sol:261-269`, `contracts/DeltaVerifier.sol:405-414`).
- v2 anchor persistence is passthrough-only: `submitMintRequest` emits `DeltaOneAccepted` with the supplied benchmark and attestation anchors but does not verify those anchors against an on-chain registry or recomputed digest (`contracts/DeltaVerifier.sol:129-141`, `contracts/DeltaVerifier.sol:343-355`).

### Parameter governance relevant to gaming resistance

Reward economics are partly governance-controlled rather than hardcoded:

- `tokensPerDeltaOne` is settable by `GOV_ROLE` through `setTokensPerDeltaOne`, with bounds enforced by `_validateTokensPerDeltaOne` (`contracts/HokusaiParams.sol:230-238`, `contracts/HokusaiParams.sol:376-381`).
- The same parameter can be overridden immediately only by `DEFAULT_ADMIN_ROLE` through `emergencySetParam` (`contracts/HokusaiParams.sol:535-554`).
- Normal parameter updates can be queued and applied only after the current price epoch ends, which is the contract-level mitigation against mid-epoch reward-parameter gaming (`contracts/HokusaiParams.sol:441-495`).

## Off-chain guarantees

The relayer and benchmark pipeline provide several guarantees that DeltaVerifier v1 does not prove itself:

- MintRequest envelope validation: the contract-deployer schema requires `message_type`, `schema_version`, `message_id`, `timestamp`, `model_id`, `model_id_uint`, `eval_id`, `attestation_hash`, `idempotency_key`, `evaluation`, and `contributors`, with optional `benchmark_spec_id` and `dataset_hash` (`services/contract-deployer/src/schemas/mint-request-schema.ts:28-43`, `services/contract-deployer/src/schemas/mint-request-schema.ts:109-137`).
- Score-range validation for the relayer path: the schema enforces integer `[0, 10000]` bounds for `baseline_score_bps` and `new_score_bps`, which is important because the legacy v1 multi-contributor entrypoint does not run `_validateMetrics` (`services/contract-deployer/src/schemas/mint-request-schema.ts:79-107`, `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md:85-86`, `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md:126-130`).
- Contributor weight validation beyond the Solidity minimums: the schema requires each contributor weight to be an integer between `1` and `10000`, and the total to equal `10000` (`services/contract-deployer/src/schemas/mint-request-schema.ts:62-65`, `services/contract-deployer/src/schemas/mint-request-schema.ts:124-135`).
- `attestation_hash` and `idempotency_key` format validation: both must match canonical `0x`-prefixed 32-byte lowercase hex in the current schema (`services/contract-deployer/src/schemas/mint-request-schema.ts:3`, `services/contract-deployer/src/schemas/mint-request-schema.ts:119-122`).
- Total-sample derivation: the relayer derives `totalSamples` from candidate or baseline sample size and rejects messages that do not provide a positive integer sample count (`services/contract-deployer/src/schemas/mint-request-schema.ts:67-77`, `services/contract-deployer/src/schemas/mint-request-schema.ts:95-107`, `services/contract-deployer/src/services/mint-request-processor.ts:58-64`).
- Benchmark-anchor preparation: the relayer computes `benchmarkSpecHash` as `keccak256(benchmark_spec_id)` when present, or a deterministic fallback `keccak256(abi.encode(model_id_uint, metric_name))` when absent; `dataset_hash` is forwarded when present, else zero (`services/contract-deployer/src/services/mint-request-processor.ts:48-57`, `services/contract-deployer/src/services/mint-request-processor.ts:73-80`).
- Settlement logging: after submission, the relayer writes a settlement envelope carrying `idempotency_key`, `attestation_hash`, model IDs, tx hash, block number, status, reward amount, and gas used (`services/contract-deployer/src/schemas/mint-request-schema.ts:45-60`, `services/contract-deployer/src/services/mint-request-processor.ts:22-45`).

These checks matter because DeltaVerifier v1 is narrow by design. The on-chain contract does not inspect benchmark methodology, dataset lineage, confidence intervals, statistical significance, evaluator identity, or raw benchmark artifacts.

## Anti-gaming controls

The table below separates what is cryptographically or contractually enforced from what is only enforced by relayer policy or process.

| Threat | Layer | Mechanism | Source |
| --- | --- | --- | --- |
| Replay / duplicate minting on the v2 MintRequest path | On-chain | `processedIdempotencyKeys` rejects a second use of the same idempotency key and consumes the key before budget evaluation, so even budget-blocked or zero-delta requests cannot be retried with the same key. | `contracts/DeltaVerifier.sol:96`, `contracts/DeltaVerifier.sol:287-297`, `contracts/DeltaVerifier.sol:298-305` |
| Replay / duplicate processing before gas spend | Off-chain | The relayer schema requires a canonical `idempotency_key`, and the MintRequest design expects a relayer-side processed-set / fast rejection layer in front of the transaction sender. | `services/contract-deployer/src/schemas/mint-request-schema.ts:119-122`, `features/support-custom-benchmarks-via-smart-contract/task-packet.md:50-53` |
| Fake evaluation submitted by an unapproved wallet | On-chain | Only `SUBMITTER_ROLE` can call submission functions; the contract can also be paused by `DEFAULT_ADMIN_ROLE` if the submitter is suspected to be compromised. | `contracts/DeltaVerifier.sol:15`, `contracts/DeltaVerifier.sol:171`, `contracts/DeltaVerifier.sol:182`, `contracts/DeltaVerifier.sol:211`, `contracts/DeltaVerifier.sol:284`, `contracts/DeltaVerifier.sol:603-608` |
| Fake evaluation submitted by an approved but dishonest wallet | Social / off-chain | The contract does not recompute benchmark outputs or verify attestation provenance. Reviewers are trusting backend key custody, benchmark pipeline correctness, and operator monitoring. | `contracts/DeltaVerifier.sol:343-355`, `services/contract-deployer/src/services/mint-request-processor.ts:66-81`, `features/document-v1-deltaone-trusted-submitter-and-anti-gaming-model/task-packet.md:112-116` |
| Contributor-weighting abuse | On-chain | Multi-contributor paths reject empty arrays, more than 100 contributors, zero addresses, duplicate addresses, and any total weight other than `10000` bps. | `contracts/DeltaVerifier.sol:561-583` |
| Contributor-weighting abuse through zero-value or malformed client input | Off-chain | The relayer schema additionally rejects non-integer or zero `weight_bps` values before submission. | `services/contract-deployer/src/schemas/mint-request-schema.ts:62-65`, `services/contract-deployer/src/schemas/mint-request-schema.ts:124-135` |
| Benchmark gaming through mid-epoch reward-parameter changes | On-chain governance | `queueParamUpdate` delays parameter changes until the current epoch ends, so operators cannot change `tokensPerDeltaOne` mid-epoch through the normal governance path. | `contracts/HokusaiParams.sol:441-495` |
| Benchmark gaming through arbitrary benchmark normalization or off-chain scorer changes | Off-chain / social | Non-proportion metrics must be normalized to `[0, 10000]` before submission, and the contract does not validate benchmark methodology, scorer code, or dataset choice. | `contracts/DeltaVerifier.sol:277-279`, `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md:24-26`, `features/support-custom-benchmarks-via-smart-contract/task-packet.md:67-70` |
| Cost-cap evasion | On-chain | DeltaVerifier compares actual cost to max cost and refuses to mint when actual exceeds max; a blocked submission emits `BudgetConstraintViolated` and returns `0`. | `contracts/DeltaVerifier.sol:218-225`, `contracts/DeltaVerifier.sol:298-305`, `contracts/DeltaVerifier.sol:553-558` |
| Cost-cap evasion through dishonest cost reporting | Off-chain / social | The contract only compares the two submitted numbers; it does not verify invoices, token spend, or third-party billing data. | `contracts/DeltaVerifier.sol:298-305`, `services/contract-deployer/src/services/mint-request-processor.ts:66-81` |

## `attestation_hash` scope

### What happens in v1

On the legacy v1 multi-contributor path, `attestation_hash` is not submitted on-chain at all. The standard mapping document is explicit that `submitEvaluationWithMultipleContributors` has no `bytes32 attestationHash` field and keeps `attestation_hash` off-chain only (`features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md:84`, `features/define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md:111-120`).

That means a v1 chain observer can see:

- model ID
- pipeline run ID
- scores
- contributor addresses and weights
- budget fields

But cannot see any attestation digest unless an off-chain system stores and exposes it separately.

### What happens in v2

On the protocol-aware v2 path, the relayer forwards `message.attestation_hash` into `payload.anchors.attestationHash`, and DeltaVerifier emits it in `DeltaOneAccepted` without recomputing or validating the digest (`services/contract-deployer/src/services/mint-request-processor.ts:73-80`, `contracts/DeltaVerifier.sol:67-84`, `contracts/DeltaVerifier.sol:343-355`).

The contract therefore treats `attestation_hash` as a caller-supplied anchor, not as a proof. Passing a well-formed `bytes32` only proves that the submitter chose to associate that digest with the submission.

### What it commits to

Within this repo, the only implemented guarantee is shape and transport:

- The contract-deployer schema requires `attestation_hash` to be a canonical `0x`-prefixed 32-byte hex string (`services/contract-deployer/src/schemas/mint-request-schema.ts:3`, `services/contract-deployer/src/schemas/mint-request-schema.ts:119`).
- The relayer passes that value through unchanged into Solidity calldata (`services/contract-deployer/src/services/mint-request-processor.ts:73-80`).
- DeltaVerifier stores no separate copy and only re-emits the supplied value in `DeltaOneAccepted` (`contracts/DeltaVerifier.sol:343-355`).

For semantic meaning, the only in-repo specification is the adjacent benchmark feature packet, which defines:

- `attestation_hash` as `sha256` of the HEM attestation payload.
- `idempotency_key` as `sha256(model_id_uint:eval_id:attestation_hash)`.

Those intended semantics are documented in `features/support-custom-benchmarks-via-smart-contract/task-packet.md:29-39` and `features/support-custom-benchmarks-via-smart-contract/plan.md:12-19`.

The important limitation is that this repo does not contain code that recomputes the HEM payload digest or enumerates the HEM payload fields. Reviewers should therefore read "commits to the HEM payload" narrowly:

- Exact preimage schema: external to this repo.
- Hashing algorithm: specified as `sha256` in the benchmark feature packet, not enforced by DeltaVerifier.
- Preimage computation location: off-chain in the benchmark pipeline / producer, before the contract-deployer receives the MintRequest (`features/support-custom-benchmarks-via-smart-contract/task-packet.md:17-23`, `services/contract-deployer/src/services/mint-request-processor.ts:18-22`).
- On-chain behavior: passthrough only.

### What remains off-chain

The following artifacts remain off-chain or only partially anchored:

- The raw HEM attestation payload behind `attestation_hash`.
- Benchmark methodology, scorer configuration, and normalization logic for non-proportion metrics.
- Dataset contents; only `dataset_hash` may be forwarded, and even then the contract does not verify it against storage or a registry (`services/contract-deployer/src/services/mint-request-processor.ts:73-80`).
- Statistical metadata such as confidence intervals, p-values, effect size, and reasons. The relayer logs some of this for observability but does not send it on-chain or persist it in the settlement envelope (`services/contract-deployer/src/services/mint-request-processor.ts:36-43`, `services/contract-deployer/src/services/mint-request-processor.ts:91-130`).
- The settlement envelope itself except for what can be reconstructed from chain events and transaction metadata (`services/contract-deployer/src/schemas/mint-request-schema.ts:45-60`).

### What it does not prove

`attestation_hash` does not prove any of the following on-chain:

- That the benchmark was executed correctly.
- That the reported scores came from the attested benchmark artifacts.
- That the dataset hash matches a specific dataset body.
- That the benchmark configuration was approved governance policy.
- That the relayer used the correct scoring or normalization code.

In short: `attestation_hash` is a dispute-reconstruction anchor, not a verification primitive.

## Residual trust assumptions

Even if every current control passes, launch reviewers are still trusting several humans and services:

- The holder of `SUBMITTER_ROLE` is trusted not to submit fabricated results. A compromised submitter can mint rewards for any active model so long as the transaction also satisfies the contract's cost-cap, reward-cap, and shape checks (`contracts/DeltaVerifier.sol:284-359`).
- The holder of `DEFAULT_ADMIN_ROLE` is trusted to grant and revoke submitter access correctly and to pause the contract during an incident (`contracts/DeltaVerifier.sol:164`, `contracts/DeltaVerifier.sol:603-608`).
- The benchmark pipeline is trusted to compute scores honestly, normalize non-proportion metrics correctly, and derive `attestation_hash` from the intended payload (`features/support-custom-benchmarks-via-smart-contract/task-packet.md:17-23`, `features/support-custom-benchmarks-via-smart-contract/task-packet.md:67-70`).
- The relayer is trusted to preserve `attestation_hash`, `dataset_hash`, and benchmark-anchor values correctly when translating the MintRequest into Solidity calldata (`services/contract-deployer/src/services/mint-request-processor.ts:48-81`).
- Cost numbers are trusted operator inputs. The chain enforces `actual <= max` when both are non-zero, but does not independently verify real-world spend (`contracts/DeltaVerifier.sol:298-305`, `contracts/DeltaVerifier.sol:553-558`).
- Parameter governance is trusted not to use `GOV_ROLE` or `DEFAULT_ADMIN_ROLE` opportunistically. Epoch locking mitigates normal mid-epoch changes, but the admin emergency path can still override parameters immediately (`contracts/HokusaiParams.sol:441-495`, `contracts/HokusaiParams.sol:535-554`).

## Future work / out of scope for v1

The current implementation deliberately stops short of several stronger security properties:

- No on-chain verification that `attestation_hash` matches supplied scores or contributor data.
- No on-chain registry proving that `dataset_hash` corresponds to a specific dataset object.
- No threshold-signature or multi-party attestation requirement for benchmark acceptance.
- No timelock or quorum around `SUBMITTER_ROLE` rotation.
- No contract-level replay protection on the legacy v1 path based on `attestation_hash`.
- No cryptographic linkage from `DeltaOneAccepted` to raw benchmark artifacts beyond caller-supplied hashes.

These omissions are acceptable only if operators and reviewers understand that v1 is an access-controlled mint pipeline, not a self-verifying benchmark protocol.

## Cross-links

- Sepolia rehearsal checklist: [deployments/TESTNET-CHECKLIST.md](../../deployments/TESTNET-CHECKLIST.md)
- Mainnet custody and role runbook: [docs/mainnet-custody-runbook.md](../../docs/mainnet-custody-runbook.md)
- MintRequest relayer mapping: [relayer-schema-mapping.md](../define-mintrequest-to-deltaverifier-relayer-schema-mapping/relayer-schema-mapping.md)
- Parent launch issue follow-up: after merge, post the final document link to Linear issue `HOK-1269` so launch reviewers can find the trust model from the launch tracker.

## Reviewer summary

For launch review, the shortest accurate summary is:

- Only `SUBMITTER_ROLE` can submit.
- `DEFAULT_ADMIN_ROLE` controls who gets `SUBMITTER_ROLE`.
- The chain enforces model-active checks, pause state, idempotency on the v2 path, contributor-array rules, reward bounds, and cost caps.
- The chain does not verify benchmark correctness or attestation provenance.
- `attestation_hash` is meaningful only if the off-chain benchmark pipeline, relayer, and audit trail are trustworthy.
