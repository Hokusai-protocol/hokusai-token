# Mint Authority Launch Gate

**Tracking:** HOK-2137  
**Security program:** HOK-2119  
**Current repo commit:** `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`

## Re-audit Package

### Scope statement

This launch gate covers the canonical `DeltaVerifier.submitMintRequest` path after the mint-authority hardening series:

- legacy mint-entrypoint disable switch
- attester registry governance
- EIP-712 attester signature verification
- per-model mint budgets
- model-weight lineage head enforcement
- relayer-side mint-request schema and calldata mapping

No new production mint logic is introduced in HOK-2137 itself. This task adds fuzz/static-analysis coverage, cross-repo fixture conformance checks, and the operational runbooks required before minting is enabled for mainnet use.

### In-scope contracts and commit hashes

The current launch-gate package is built from repo commit `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`:

- `contracts/DeltaVerifier.sol` at `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`
- `contracts/ModelRegistry.sol` at `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`
- `contracts/TokenManager.sol` at `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`
- `contracts/DataContributionRegistry.sol` at `cd2cbc972fad08dd3cb22ee5681dde9ba3bb2b27`

### Diff from prior audit scope

The launch-gate delta from the earlier pre-hardening DeltaVerifier audit is the union of these merged changes:

- `c403eb4` — HOK-2125: one-way disable switch for legacy DeltaVerifier mint entrypoints.
- `b80b1b7` — HOK-2126: attester registry governance and threshold storage/events.
- `3f14b59` — HOK-2131: per-model mint budgets with revert-not-truncate retry semantics.
- `6e17cbd` — HOK-2132: EIP-712 attester signature verification on `submitMintRequest`.
- `864306c` — HOK-2133: model-weight lineage chain (`baselineCommitment`/`candidateCommitment`, per-model head, genesis/root flow).

### Auditor checklist

- Confirm the EIP-712 digest computed by `hashMintRequest()` matches off-chain signing code and the relayer mapping.
- Confirm all positive-reward mint paths are budget-gated, attester-gated, and lineage-gated.
- Confirm failure modes do not burn the idempotency key for budget or lineage-parent mismatches.
- Confirm only paying mints advance `modelWeightHead`.
- Confirm attester rotation, threshold configuration, and legacy-disable behavior are fail-closed.
- Confirm cross-repo fixture parity between contract tests and `services/contract-deployer`.

### Open issues

- Slither re-triage on this branch produced no new gating findings for `DeltaVerifier.sol` or `ModelRegistry.sol`.
- Existing accepted-baseline entries still cover the current static-analysis output; no new HOK issue was opened from this coding phase.

## Runbook 1: Attester Custody

### Preconditions

- Admin Safe holds `DEFAULT_ADMIN_ROLE`.
- The designated attester hardware wallet or HSM exists in separate custody from the relayer submitter.
- Mainnet/testnet `DeltaVerifier` address and chain ID are recorded.

### Steps

1. Generate the attester key inside the hardware wallet or HSM boundary; do not export raw private key material.
2. Record the attester address in the custody inventory with operator, device, and recovery metadata.
3. From the admin Safe, call `addAttester(attester)` and then `setAttesterThreshold(1)` on the target `DeltaVerifier`.
4. Verify `isAttester(attester) == true`, `attesterCount >= 1`, and `attesterThreshold == 1`.
5. Produce a benign `hashMintRequest()` digest on testnet and confirm the attester can sign it.
6. Archive the signature artifact, signer address, and the rendered typed-data summary used during approval.
7. For rotation, add the replacement attester first, validate signatures from the replacement, then remove the old attester.

### Expected observations

- The attester address is visible on-chain in registry state and events.
- A signature from the registered attester authorizes a mint; an old or unregistered attester does not.
- Rotation is zero-downtime because the new attester is added before the old one is removed.

### Rollback

- If the new attester fails verification, keep the prior attester registered and leave the threshold unchanged.
- If the wrong address was registered, remove it from the Safe and re-run the verification step before any minting.

### Dry-run result

- Status: pending manual execution before launch.
- Evidence to record: attester address, registration tx hash, validation tx hash or signed digest reference, rotation rehearsal tx hashes if performed.

## Runbook 2: Signature Rendering

### Preconditions

- The attester has a trusted renderer for the exact EIP-712 payload.
- The relayer-generated payload includes:
  `modelId`, `pipelineRunId`, `baselineScoreBps`, `candidateScoreBps`, `maxCostUsdMicro`, `actualCostUsdMicro`, `totalSamples`, `benchmarkSpecHash`, `datasetHash`, `attestationHash`, `idempotencyKey`, `metricName`, `metricFamily`, `baselineCommitment`, `candidateCommitment`, `contributors`.

### Steps

1. Generate the canonical digest with `DeltaVerifier.hashMintRequest(modelId, payload, contributors)`.
2. Render the typed-data summary to the attester, including model ID, score delta, cost fields, total samples, commitments, idempotency key, and contributor payouts.
3. Have the attester verify the rendered summary against the expected evaluation packet out-of-band.
4. Sign only after the rendered summary and the digest source match.
5. Recover the signer off-chain from the produced signature and confirm it equals the registered attester address.
6. Submit the mint through the relayer or direct contract call and confirm the contract accepts the signature.

### Expected observations

- Off-chain digest equals `hashMintRequest()`.
- The recovered signer matches the attester registry entry.
- Any single-field mutation after signing causes `SignerNotAttester` and the mint is rejected.

### Rollback

- If the rendered summary is incomplete or differs from the digest source, discard the signature and regenerate the payload.
- If signer recovery fails, treat the signature as invalid and do not enqueue or relay the mint.

### Dry-run result

- Status: pending manual execution before launch.
- Evidence to record: digest, signer address, rendered summary screenshot or signed review artifact, and the acceptance tx hash from the testnet rehearsal.

## Runbook 3: Pause Drill

### Preconditions

- `PAUSER_ROLE` and `DEFAULT_ADMIN_ROLE` are held by the intended operational Safe(s).
- A known-good testnet mint payload and attester signature are available.

### Steps

1. On testnet, call `pause()` from the `PAUSER_ROLE` holder.
2. Attempt `submitMintRequest()` using the known-good payload and signature.
3. Verify the mint reverts while paused.
4. Call `unpause()` from the admin authority.
5. Re-submit the same mint request or a fresh equivalent payload.
6. Confirm minting resumes successfully and events are emitted normally.

### Expected observations

- The paused submission reverts with `Pausable: paused`.
- The unpaused submission succeeds without any contract reconfiguration.
- Monitoring emits both the pause/unpause operational events and the resumed mint acceptance.

### Rollback

- If `pause()` was triggered on the wrong deployment, immediately unpause from the admin Safe and confirm state recovery.
- If resumed minting fails for a reason unrelated to pause state, halt further mint attempts and escalate as an incident.

### Dry-run result

- Status: pending manual execution before launch.
- Evidence to record: `pause()` tx hash, reverted mint attempt tx hash or trace reference, `unpause()` tx hash, resumed mint tx hash.

## Runbook 4: Monitoring Drill

### Preconditions

- The testnet monitoring stack (`hokusai-monitor-testnet`) is active and alert routes are configured.
- A model with a deliberately low remaining mint budget is available on testnet.

### Steps

1. Set or top up a test model budget to a small known value.
2. Submit a valid mint request whose reward exceeds the remaining budget.
3. Confirm the contract reverts with `MintBudgetExceeded` and the idempotency key is not burned.
4. Verify the relayer/monitoring pipeline classifies the result as retryable budget exhaustion rather than success.
5. Observe alert delivery in the testnet monitoring destination.
6. Top up the mint budget and re-submit the identical request to confirm successful retry behavior.

### Expected observations

- The over-budget request does not mint and does not advance lineage.
- Alerting fires for the budget-exceeded condition.
- After top-up, the exact same attested request succeeds and pays in full.

### Rollback

- If alerting does not fire, keep minting disabled for that environment until the pipeline is corrected and the drill is re-run.
- If the retry path burns idempotency or haircuts the reward, treat it as a launch blocker.

### Dry-run result

- Status: pending manual execution before launch.
- Evidence to record: over-budget revert tx hash, alert timestamp or incident ID, top-up tx hash, successful retry tx hash.

## Runbook 5: Sepolia launch-posture rehearsal (HOK-2176)

### Rehearsal posture

- Attester address: `0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da` (`KMS_DEPLOYER_KEY_ID=alias/hokusai/development/ethereum/sepolia/deployer`)
- Submitter address: `0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c` (`KMS_BACKEND_KEY_ID=alias/hokusai/development/ethereum/sepolia/submitter`)
- Model scope: Model `30` only
- Mint budget: `1500000000000000000000000` (1.5M tokens, 18 decimals)
- Weight commitment version: `sha256-merkle-v1`
- Weight genesis: `0x2d1813cb95d8ed3c6423e230860521b10d37e3c47b9cab577cb1fc29250fa323`

The rehearsal genesis is reproducible from [test/fixtures/sepolia-rehearsal-model-30.json](/Users/timothyogilvie/Dropbox/Hokusai/worktrees/sepolia-launch-posture-configuration-attesters-threshold-budgets-weight-genesis-disablelegacymints/test/fixtures/sepolia-rehearsal-model-30.json:1) with `node scripts/compute-weight-genesis.js --fixture test/fixtures/sepolia-rehearsal-model-30.json`.

### Execution record

- `disableLegacyMints()`: pending live execution
- `addAttester(0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da)`: pending live execution
- `setAttesterThreshold(1)`: pending live execution
- `setMintBudget(30, 1500000000000000000000000)`: pending live execution
- `setWeightGenesis(30, 0x2d1813cb95d8ed3c6423e230860521b10d37e3c47b9cab577cb1fc29250fa323)`: pending live execution
- `setBaseRewardRate(1000)`: pending drift check on live state
- `setMinImprovementBps(100)`: pending drift check on live state
- `setMaxReward(2500000000000000000000000)`: pending drift check on live state
- Verify snapshot: `deployments/launch-posture-sepolia-latest.json`
- Canary run URL: pending live execution

### Notes

- `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE`, and `SUBMITTER_ROLE` handoff to the Safe remains out of scope for HOK-2176 and is intentionally not enforced by the Sepolia launch-posture config.
- The weekly Sepolia canary now requires separate KMS attester and submitter credentials and fails closed if those identities collapse to the same address or if the attester configuration drifts.
