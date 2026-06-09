# Mint Authority Hardening — Implementation Plan (issue breakdown)

**Tracking:** HOK-2119 · **Design:** [`mint-authority-hardening-design.md`](mint-authority-hardening-design.md) · **Date:** 2026-06-09

Ordered, dependency-annotated work breakdown across three Linear projects: **Hokusai smart contracts (SC)**, **Hokusai data pipeline (DP)**, **Hokusai infrastructure (INFRA)**. Each item lists scope, tests, and dependencies. Locked params: HROUT `tokensPerDeltaOne = 250,000`, `maxReward = 2.5M`, starting budget `1.5M`; budget is **revert-not-truncate**.

## Layer 0 — no dependencies (start in parallel; Phase 0 bounds blast radius)

1. **[SC] Disable legacy DeltaVerifier mint entrypoints on mainnet** *(P1, launch blocker)* — make `submitEvaluation` / `submitEvaluationWithContributorInfo` / `submitEvaluationWithMultipleContributors` revert/removed; `submitMintRequest` is the only mint path. Tests: legacy paths revert; submitMintRequest unaffected; Echidna/Slither green. Deps: none.
2. **[SC] Attester registry governance + admin Safe finalization** *(P2)* — Safe-owned attester add/remove + threshold; timelock; emergency removal; deployer revoked; storage/events shaped for set+threshold (run 1-of-1). Tests: only Safe mutates; rotation/emergency rehearsal. Deps: none.
3. **[INFRA] Redis hardening** *(P1)* — auth token + TLS (`rediss://`), private subnet/no public ingress, least-privilege ACLs (publisher LPUSH-only, consumer read/ack). Tests: unauth/external refused; ACL scoping. Deps: none.
4. **[INFRA] Move SUBMITTER key to KMS/remote signer** *(P2)* — no raw key on host; rotation runbook. Tests: submit via KMS, no key on disk. Deps: none.
5. **[DP] Deterministic model-weight content commitment utility (+ router serializer spike)** *(P1)* — hash the stored MLflow weight artifact (canonical file ordering → per-file sha256 → Merkle root), baseline + candidate; replace proxy `model_hash`. Tests: same model→same hash across reloads; different→different; router round-trips byte-stable; MLflow metadata excluded. Deps: none. **Gating spike for lineage.**
6. **[INFRA] Monitoring + fast automated pause for `DeltaOneAccepted` anomalies** *(P2)* — alerting on unexpected recipients / implausible DeltaOne jumps / velocity; a pause path (PAUSER_ROLE) that can act faster than the drain rate; drill. Tests: synthetic anomaly fires alert + pause. Deps: none (uses existing events; enrich after Layer 2).

## Layer 1 — depends on Layer 0

7. **[SC] Per-model mint budget + Safe top-up + revert-not-truncate** *(P1)* ← (1). `mintBudgetRemaining[modelId]`, decremented per mint; **revert** (no key burn, no head advance) when exceeded so the exact mint retries verbatim after top-up; Safe-only top-up (separate from attester); `maxReward` interplay. Tests: decrement; revert-when-exceeded + retry-after-topup pays full; Safe-only top-up; budget=0 blocks; events. Deps: (1).
8. **[SC] EIP-712 attester signature verification on `submitMintRequest`** *(P1, linchpin)* ← (2). `ecrecover == registeredAttester`; full economic payload incl. `schema/version`, domain = chainId + verifying contract; EIP-1271-ready storage; **no signature-optional window** (enforce from first mainnet mint). Tests: valid sig mints; missing/invalid/tampered reverts; rotation; cross-deployment replay blocked. Deps: (2).

## Layer 2

9. **[SC] Model-weight lineage chain** *(P1)* ← (8),(5). `baselineCommitment`/`candidateCommitment` in payload+event; per-model `head`; require `baseline == head`; advance head; **genesis at ModelRegistry registration**; correction/admin-reset policy (brick-prevention); concurrency/re-base rule. Tests: chain advance; parent-mismatch revert; genesis; re-base; admin reset; brick-prevention. Deps: (8) payload struct, (5) commitment format, ModelRegistry genesis hook.

## Layer 3

10. **[DP] MintRequest schema: add baseline/candidate commitments + attester signature fields** *(P1)* ← (5),(8),(9). Pydantic + golden fixture + **byte-identical cross-repo fixture** with the token side; preserve contributor provenance (incl. `contributorId`). Tests: schema validation; cross-repo conformance both CIs. Deps: (5),(8),(9).

## Layer 4

11. **[DP] Attester signing flow + wire commitments into MintRequest production** *(P1)* ← (10),(8),(9),(5). Build the EIP-712 payload; sign out-of-band with the **hardware-wallet attester**; render the exact typed data for the human (T7 — verifiable rendering); populate `baseline = current on-chain head`, `candidate`, commitments, signature. Tests: signed payload verifies against the contract digest; rendering == signed bytes; baseline matches head (integration). Deps: (10),(8),(9),(5).
12. **[SC] Consumer (contract-deployer) integration** *(P1)* ← (7),(8),(9),(10). Forward signature + commitments to `submitMintRequest`; handle budget-exceeded **revert** (DLQ/retry-after-topup, no phantom success); stop using legacy paths. Tests: maps new fields to calldata; budget-revert retryable; settlement correctness. Deps: (7),(8),(9),(10).

## Layer 5

13. **[SC] Re-audit + Echidna/Slither coverage + cross-repo conformance** *(P1, launch gate)* ← (7),(8),(9),(12). Fuzz/static coverage for budget + signature + lineage; external re-audit; update the golden-fixture conformance for the new payload; rehearsals (attester custody, signature rendering, pause drill, monitoring drill). Deps: (7),(8),(9),(12).

## Parallelism summary
- Start immediately, in parallel: (1),(2),(3),(4),(5),(6).
- Pipeline weights-hash (5) and infra (3,4,6) run alongside the contract work and gate (9)/(10).
- Critical path to launch: (1)→(8)→(9)→(10)→(11)/(12)→(13), with (5) feeding (9)/(10)/(11).
