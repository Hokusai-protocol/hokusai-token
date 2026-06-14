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

### Pauser custody decision (HOK-2178, 2026-06-14)

The drill forces the "who holds the kill switch" decision:

- **Sepolia (this drill):** `PAUSER_ROLE` and `DEFAULT_ADMIN_ROLE` are held by the
  hot KMS deployer key `0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da`. The pause is
  executed via that key (and/or the automated pause Lambda, which now uses the
  same identity once `AUTO_PAUSE_ENABLED` is turned on). This matches the current
  live role assignment; Safe handoff is intentionally out of scope for Sepolia.
- **Mainnet (recorded target):** `PAUSER_ROLE` must be held by the operational
  Safe; the pause is executed as a Safe transaction. The hot-key path is testnet
  only. Latency budget to record at mainnet rehearsal: detection → `paused()`
  confirmed within the budget (target ≤ 15 min) measured against the per-model
  budget drain rate.

### Dry-run result

- Status: **deferred** to the live mint-drill session. The mechanical
  `pause()`/`unpause()` path is exercisable today via the hot KMS key, but the
  full drill needs a *known-good* attested `submitMintRequest` to show it reverts
  while paused and succeeds after unpause — and the registered attester
  (`0x07bf…`) is a hardware-wallet key, so a valid signature requires the Ledger
  operator. Batched with the other live mint drills.
- Evidence to record: `pause()` tx hash, reverted mint attempt tx hash or trace
  reference, `unpause()` tx hash, resumed mint tx hash, and detection→paused
  wall-clock.

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

### Execution record (HOK-2178, 2026-06-14)

**Partially executed. Monitoring infrastructure exercised and a real outage found + fixed; the on-chain over-budget retry step is deferred with the other live mint drills (needs the hardware-wallet attester signature).**

Setting up this drill surfaced that the DeltaOne anomaly detector
(`hokusai-deltaone-anomaly-detector-development`, an EventBridge-scheduled Lambda
that polls `DeltaVerifier` logs every minute) was **failing on 100% of
invocations** — anomaly detection was effectively offline, silently.

- **Symptom:** every invocation raised `RuntimeError` wrapping RPC `-32602
  "invalid address: empty hex string"` in `_collect_events → _logs_for_range →
  _rpc_call`. 180 invocations/hour, 180 errors/hour. No alarm covered this.
- **Root cause 1 (empty address):** the Lambda sourced `DELTA_VERIFIER_ADDRESS`
  from a Terraform variable that defaults to `""` and was never assigned, so it
  called `eth_getLogs` with an empty `address`. Reproduced exactly against live
  Sepolia RPC.
- **Root cause 2 (stale canonical pointer):** the SSM parameter
  `/hokusai/development/contracts/delta_verifier_address` pointed at a
  pre-hardening `DeltaVerifier` (`0x7990…`, last set 2026-05-23) that is missing
  every hardening function (confirmed on-chain: `attesterThreshold`,
  `isAttester`, `mintBudgetRemaining` all revert). The live hardened contract is
  `0x867E61c9D4ccF1419180B3257314fa8CEb2D27a6`. The token-repo deploy never
  synced this SSM value, and the ECS relayer reads the same parameter.
- **Fix:** both the detector and pause Lambdas now resolve the address from the
  canonical SSM parameter at runtime (override-able) and validate it before any
  RPC call; added `Errors`-saturation and `Invocations`-liveness CloudWatch
  alarms so total detector failure can no longer be silent (`hokusai-infrastructure`
  PR #65). The token-repo deploy script now writes contract addresses to SSM on
  every Sepolia/mainnet deploy so this drift cannot recur.
- **Verification:** corrected SSM → `0x867E…` (v4), `terraform apply` on
  development, then invoked the detector — now returns
  `{"status":"ok","eventsProcessed":0,"classifications":[]}` (HTTP 200).

**Second-order finding — detector misclassification (also fixed).** Once the
detector could reach the contract, replaying the real Gate 7 `DeltaOneAccepted`
event (block 11058422, true `baselineScoreBps=4200`, `candidateScoreBps=4300`)
showed it would have false-positived on every legitimate mint:

- `DELTAONE_ACCEPTED_TOPIC0` was unset → every log from the verifier (not just
  `DeltaOneAccepted`) was parsed as an event. Default now set to the event's
  keccak topic so logs are filtered (6 logs → 1 real event).
- Score decoding read data words `[0]/[1]` (attestationHash/datasetHash) as the
  scores instead of `[4]/[5]`, producing enormous bogus jumps → false
  `implausible_jump`. Fixed; the real event now decodes 4200/4300 (jump 100 <
  ceiling 5000 → no alert).
- The hardcoded `RewardCalculated` topic did not match the deployed signature, so
  the payout recipient never resolved → false `unexpected_recipient`. Corrected;
  the recipient now resolves.

After the fixes, the real legitimate mint classifies clean once its recipient is
allowlisted. **Operator action required (config, not code):** populate
`deltaone_recipient_allowlist` with the legitimate contributor wallets before
enabling `AUTO_PAUSE_ENABLED` — it is fail-closed (empty list flags every
recipient), so an empty allowlist would alert/pause on legitimate mints.

Deferred (with the live mint drills): trigger an over-budget `submitMintRequest`,
confirm `MintBudgetExceeded` with idempotency key intact, observe the alert, then
top up and confirm the identical attested request succeeds and pays in full.

### Dry-run result

- Status: detector infrastructure fixed and verified; on-chain over-budget/alert
  step pending the live mint drill.
- Evidence recorded: SSM parameter version 4; detector invoke response above;
  CloudWatch alarms `hokusai-deltaone-detector-errors-development` and
  `hokusai-deltaone-detector-not-invoking-development`.

## Runbook 5: Sepolia launch-posture rehearsal (HOK-2176)

### Rehearsal posture

- Attester address: `0x07bf9b22f516d2D464511219488F019c5dFF5335` (hardware wallet, separated custody — matches the live registry and `scripts/configs/sepolia-launch-posture.json`). *Corrected 2026-06-14 (HOK-2178): earlier drafts listed `0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da` as the attester, but that is the KMS deployer key holding `DEFAULT_ADMIN_ROLE`, not the attester. The two must remain distinct.*
- Admin/deployer address: `0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da` (`KMS_DEPLOYER_KEY_ID=alias/hokusai/development/ethereum/sepolia/deployer`) — holds `DEFAULT_ADMIN_ROLE`/`PAUSER_ROLE` on Sepolia.
- Submitter address: `0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c` (`KMS_BACKEND_KEY_ID=alias/hokusai/development/ethereum/sepolia/submitter`)
- DeltaVerifier (current live): `0x867E61c9D4ccF1419180B3257314fa8CEb2D27a6`
- Model scope: Model `30` only
- Mint budget: `1500000000000000000000000` (1.5M tokens, 18 decimals) provisioned; `1250000000000000000000000` remaining as of 2026-06-14 after the Gate 7 part-1 mint consumed one 250k DeltaOne.
- Weight commitment version: `sha256-merkle-v1`
- Weight genesis: `0x2d1813cb95d8ed3c6423e230860521b10d37e3c47b9cab577cb1fc29250fa323`

The rehearsal genesis is reproducible from [test/fixtures/sepolia-rehearsal-model-30.json](../test/fixtures/sepolia-rehearsal-model-30.json) with `node scripts/compute-weight-genesis.js --fixture test/fixtures/sepolia-rehearsal-model-30.json`.

### Execution record

Verified live against DeltaVerifier `0x867E61c9D4ccF1419180B3257314fa8CEb2D27a6`;
snapshot `deployments/launch-posture-sepolia-latest.json` (2026-06-13T23:15) =
`overall: pass`. Re-confirmed on-chain 2026-06-14 (HOK-2178).

- `disableLegacyMints()`: ✅ executed — `legacyMintsDisabled() == true`
- `addAttester(0x07bf9b22f516d2D464511219488F019c5dFF5335)`: ✅ executed — `isAttester == true`, `attesterCount == 1` (NB: the attester is the `0x07bf…` hardware wallet, not the deployer key)
- `setAttesterThreshold(1)`: ✅ executed — `attesterThreshold == 1`
- `setMintBudget(30, 1500000000000000000000000)`: ✅ executed — `mintBudgetRemaining(30) == 1250000000000000000000000` after one Gate 7 mint
- `setWeightGenesis(30, 0x2d1813cb95d8ed3c6423e230860521b10d37e3c47b9cab577cb1fc29250fa323)`: ✅ executed
- `setBaseRewardRate(1000)`: ✅ matches live state
- `setMinImprovementBps(100)`: ✅ matches live state
- `setMaxReward(2500000000000000000000000)`: ✅ matches live state
- Verify snapshot: `deployments/launch-posture-sepolia-latest.json` (pass)
- Canary run URL: see Gate 7 execution record below

### Notes

- `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE`, and `SUBMITTER_ROLE` handoff to the Safe remains out of scope for HOK-2176 and is intentionally not enforced by the Sepolia launch-posture config.
- The weekly Sepolia canary now requires separate KMS attester and submitter credentials and fails closed if those identities collapse to the same address or if the attester configuration drifts.
- **Off-chain address drift (fixed 2026-06-14, HOK-2178):** the canonical SSM pointer `/hokusai/development/contracts/delta_verifier_address` was stale (`0x7990…`, a pre-hardening DeltaVerifier) because redeploys did not sync it. Corrected to `0x867E…` (v4) and the deploy script now writes contract addresses to SSM on every Sepolia/mainnet deploy. The DeltaOne anomaly detector and pause Lambdas now read this parameter at runtime. See Runbook 4 execution record.

## Gate 7 — Adversarial Dress Rehearsal: Execution Record (HOK-2177)

Executed 2026-06-14 against the deadline-aware Sepolia deployment. This is the HOK-2119
proof-of-fix: the hand-forged MintRequest that minted 1,000,000 tokens on 2026-06-08
(tx `0x2937083221e4c6e00ba71462996456e78d9b338b57591661ef37f267d55806de`) is re-run and
must now be rejected.

**Live stack:** DeltaVerifier `0x867E61c9D4ccF1419180B3257314fa8CEb2D27a6`,
ModelRegistry `0x62f61e2505B96662cEF2168635244AFEE3C0F12E`, HROUT token (model 30)
`0x36D3503C11ebb3c30adA3fa13fb60795062f667B`. Attester `0x07bf9b22f516d2D464511219488F019c5dFF5335`
(hardware wallet, separated custody), threshold 1. Submitter: KMS backend
`0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c`. Harnesses: `scripts/gate7-adversarial-sepolia.js`,
`scripts/gate7-part1-sepolia.js`.

### Part 1 — real signed mint (separated custody) — PASS

- Operator signed the canonical Model-30 MintRequest digest
  `0x383d7cbf7ed4647c6f033200695ddae527c9aa0b30b3c0a798ed010b9f95e30e` on the `0x07bf`
  hardware wallet; signature recovered to the registered attester (verified pre-submit).
- Mint tx `0x6d266ad2fb33771c0bb000ff63e4f8c8c3221f78fb96c17f71df5a64d1ef40c8`
  (block 11058422, status 1): `DeltaOneAccepted` + `ModelLineageAdvanced` emitted.
- Lineage head advanced genesis `0x2d18…fa323` → candidate `0xd3c0c7c3…155cfea`.
- Reward 250,000 tokens drawn from budget (1,500,000 → 1,250,000): 50,000 (20%) to the
  contributor, 200,000 (80%) to infrastructure accrual per HROUT `infrastructureAccrualBps=8000`.

### Part 2 — adversarial battery — ALL REJECTED

Every variant submitted via the legitimate SUBMITTER and reverted on-chain:

| Attack | On-chain result |
|---|---|
| Forged MintRequest, no attester signature | `InsufficientAttesterSignatures` |
| Forged, malformed signature | reverts at ECDSA decode |
| **June-8 re-run: fake attestation/dataset hashes + attacker-chosen recipient, signed by a non-attester key** | **`SignerNotAttester`** |
| Valid-shape request past its deadline | `SignatureExpired` (HOK-2170) |
| Legacy `submitEvaluation` entrypoint | `LegacyMintEntrypointDisabled` |
| Replay of the Part-1 signed message | reverted (idempotency key burned) |
| Tamper-after-sign (mutate recipient, keep signature) | `SignerNotAttester` (digest binding) |

**Outcome:** the exact forgery that succeeded on 2026-06-08 now reverts `SignerNotAttester`.
HOK-2119 is fixed and verified on a live network. Exact revert reasons for the RPC cases are
corroborated by the merged Hardhat suites (`DeltaVerifier.attesterSignature` / `.deadline` /
`.disableLegacy` / `.lineage` / `.mintBudget`).

## Runbook 6: Key-Compromise Tabletop (HOK-2178)

Paper exercise, completed 2026-06-14. Two scenarios, each with a bounded exposure
assessment and a decision tree. Named owners are placeholders to be assigned at
on-call setup; the *roles* are fixed.

### Scenario A — Submitter (relayer) key stolen

The submitter holds `SUBMITTER_ROLE` (Sepolia: KMS `0xbe2640bB…acf0c`). It can
only *relay* requests; it cannot mint without a valid attester signature.

- **Exposure (bounded):** an attacker with the submitter key can submit any
  MintRequest, but each still requires a current attester signature over the
  exact digest. The realistic damage is limited to **replaying validly-signed,
  not-yet-submitted requests** the attacker has captured, and to griefing
  (spamming reverts, burning gas). It cannot forge new rewards or redirect
  recipients — the digest binds `contributors`, and a mutated recipient reverts
  `SignerNotAttester`. Idempotency keys prevent double-spend of an already-settled
  request.
- **Decision tree:**
  1. Detect (anomalous submitter activity, gas drain, unexpected reverts) →
     page on-call (owner: _Relayer on-call_).
  2. Revoke: `revokeRole(SUBMITTER_ROLE, compromisedSubmitter)` from the admin
     authority (owner: _Admin Safe signer_). No pause required — minting integrity
     does not depend on the submitter.
  3. Grant `SUBMITTER_ROLE` to a freshly provisioned submitter identity; update
     the relayer/SSM `submitter` config.
  4. Rotate the compromised KMS key; quarantine any captured-but-unsubmitted
     signed requests (they remain replayable until their `deadline`, ≤ 5 days per
     HOK-2170, or until superseded by lineage/idempotency).
  5. Post-incident: confirm no unexpected `DeltaOneAccepted` events occurred while
     the key was exposed (detector + lineage log).

### Scenario B — Attester key stolen

The attester (Sepolia: `0x07bf…` hardware wallet, threshold 1) is the mint
authority. A stolen attester key is the high-severity case: with the submitter it
can mint arbitrary rewards up to the per-model budget.

- **Exposure (bounded by budget caps):** maximum loss before response is the
  remaining per-model mint budget (`mintBudgetRemaining`, e.g. model 30 = 1.25M)
  plus `maxReward` per tx — *not* unlimited. Lineage head enforcement means each
  forged mint must chain from the current head, so a burst is serialized and
  visible as `ModelLineageAdvanced` events.
- **Decision tree:**
  1. Detect (anomalous `DeltaOneAccepted`: unexpected recipient/amount/rate) →
     the detector pages (and, with `AUTO_PAUSE_ENABLED`, trips the pause Lambda).
     Owner: _Security on-call_.
  2. **Pause first** (`pause()` via `PAUSER_ROLE`) — this is the containment
     action; it stops all minting immediately regardless of attester state.
  3. `removeAttester(compromised)` from the admin authority. With threshold 1,
     add the replacement attester *before* removing the old one to keep the
     threshold satisfiable (`AttesterThresholdWouldBeUnmet` guards this).
  4. Drain residual budget exposure: optionally `setMintBudget(modelId, 0)` for
     affected models until rotation completes.
  5. Unpause only after the new attester is verified (a mint signed by the new
     key succeeds; one signed by the removed key reverts `SignerNotAttester`).
  6. **Lost-device variant (no compromise, just unavailable):** restore signing
     capability from the backup key path. Time-to-restore target to be measured
     in the live rotation drill; until restored, minting is paused (fail-closed)
     rather than run with a single point of failure.

### Cross-cutting

- Detection for both scenarios now has live alarm coverage: anomaly classifiers
  (`UnexpectedRecipient`, `ImplausibleJump`, `VelocityExceeded`) plus
  detector-health alarms (Runbook 4 fix).
- Mainnet must hold `DEFAULT_ADMIN_ROLE`/`PAUSER_ROLE` on the Safe so no single
  hot key can both mint-authorize and pause.

## Deferred live mint drills (next session — needs Ledger operator)

The following require a *valid attester signature*, which on Sepolia means the
`0x07bf…` hardware wallet. They are batched for a session with the Ledger
operator using `scripts/gate7-signing-helper.js` to render and sign each digest:

- **Pause drill (Runbook 3):** known-good attested mint reverts while paused,
  succeeds after unpause; record detection→paused latency.
- **Monitoring over-budget (Runbook 4):** over-budget `submitMintRequest` →
  `MintBudgetExceeded` (idempotency intact) → top-up → identical request settles.
- **Attester rotation (HOK-2126 sequence):** add new attester → mint signed by
  new key succeeds, mint signed by removed key reverts; measure lost-device
  restore time.
- **DLQ settlement (Runbook / HOK-2173):** end-to-end replay of a legit DLQ entry
  through to one on-chain settlement (the `list → inspect → replay` mechanics and
  forged-entry triage are exercised separately without a live mint).
