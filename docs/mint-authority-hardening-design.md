# Mint Authority Hardening — Design & Options

**Status:** Draft for decision · **Tracking:** HOK-2119 · **Date:** 2026-06-09

**Purpose:** lay out the options (with pros/cons) for closing the mint-authority gap before mainnet, so we can decide the right sequence of steps. This is a decision doc, not an implementation spec.

**Read first / do not duplicate:**
- [`docs/deltaverifier-trust-model.md`](deltaverifier-trust-model.md) — the V1 "trusted submitter" model as shipped. This doc assumes it.
- [`docs/mainnet-custody-runbook.md`](mainnet-custody-runbook.md) — `SUBMITTER_ROLE` / `DEFAULT_ADMIN_ROLE` custody, Safe handoff, rotation.

---

## 1. Why this is on the table now

The V1 trust model already documents — and consciously accepts for V1 — that the chain "does not verify benchmark correctness or attestation provenance," and lists as **future work**: "no threshold-signature or multi-party attestation requirement" and "no on-chain verification that `attestation_hash` matches supplied scores." A compromised `SUBMITTER_ROLE` holder "can mint rewards for any active model" within the caps.

Two things move this from *accepted V1 residual risk* to a *mainnet go/no-go decision*:

1. **The architecture co-locates mint authority with a public attack surface.** `hokusai-data-pipeline` is publicly exposed (it accepts user data submissions) **and** is the producer that LPUSHes `MintRequest`s onto the Redis queue that the privileged consumer drains. The consumer holds (or will hold, per the custody runbook) `SUBMITTER_ROLE`. So a write to the Redis queue is *de facto* a mint instruction.
2. **It's demonstrated, not theoretical.** On 2026-06-08, during cross-repo E2E validation, a **hand-forged** `MintRequest` (arbitrary fake `attestation_hash`/`dataset_hash`, chosen recipient — not produced by the real pipeline) was LPUSHed to the queue and minted on Sepolia: tx `0x2937083221e4c6e0…`, block 11017156, `status: minted`, 1,000,000 tokens. The only thing that had blocked an earlier attempt was an unrelated schema typo — **no security control**.

---

## 2. Where authority actually lives today

```
  PUBLIC                          PRIVATE-ish                         ON-CHAIN
  ┌──────────────────┐   LPUSH    ┌────────────────────┐   tx        ┌──────────────┐
  │ data-pipeline    │ ─────────► │ contract-deployer  │ ──────────► │ DeltaVerifier│
  │ (accepts user    │  Redis     │ consumer (relayer) │  SUBMITTER  │ submitMint() │
  │  submissions)    │  queue     │ holds the key      │  ROLE       │              │
  └──────────────────┘            └────────────────────┘             └──────────────┘
        ▲ public ingress                ▲ confused deputy:                ▲ verifies WHO
        │ = de facto mint trigger       │ submits anything that          │ (role) + economics,
        │ via the queue                 │ passes its Joi schema          │ NOT authenticity
```

- **The contract** verifies *who* submits (`onlyRole(SUBMITTER_ROLE)`), model active/registered, replay (idempotency key uniqueness), contributor-array rules, cost caps, and `reward ≤ maxReward`. It does **not** verify that the mint reflects real off-chain work — `attestation_hash`/`dataset_hash`/`benchmarkSpecHash` are passthrough anchors (re-emitted in `DeltaOneAccepted`, never checked). The idempotency key is treated as an **opaque** unique value; the contract does not enforce its derivation formula.
- **The consumer** holds the only thing the contract trusts (the `SUBMITTER` key) and is a **confused deputy**: it signs+submits any queue message that passes `mint-request-schema.ts`.
- **The Redis queue** is therefore the real trust boundary, and it is reachable from the publicly-exposed pipeline (and anything else with network + credentials to Redis).

**Blast radius if abused:** per-mint bounded by on-chain `maxReward` and the model's `tokensPerDeltaOne`; throttled only by epoch-locked param governance and the `mint_paused` kill-switch. There is **no per-model/per-epoch mint-count rate limit** on the V2 path (only the legacy single-contributor path has a cooldown). So a successful forgery can be repeated with fresh idempotency keys up to the per-mint cap, rapidly.

---

## 3. Threat model

**Assets:** the ability to mint reward tokens (real economic value on mainnet); the `SUBMITTER` key; the attester trust anchor (proposed); contributor payout integrity.

**Adversaries / paths we must consider:**
| # | Adversary | Path | Currently stopped? |
|---|---|---|---|
| T1 | External, no access | Call `submitMintRequest` directly | ✅ Yes — `onlyRole(SUBMITTER_ROLE)` |
| T2 | External, can reach Redis | LPUSH a forged `MintRequest` | ❌ No — consumer submits it (demonstrated) |
| T3 | Compromise of the **public pipeline** host | Publish forged mints via its Redis creds | ❌ No |
| T4 | Compromise of the **consumer** host | Use the `SUBMITTER` key directly | ❌ No (key is right there) |
| T5 | Dishonest/compromised `SUBMITTER` holder | Mint fabricated results within caps | ❌ No (accepted V1 risk) |
| T6 | Compromise of `DEFAULT_ADMIN` (Safe) | Grant role / unpause / emergency params | Out of scope here — governance/custody |

The goal of this work is to push T2–T5 from ❌ toward ✅, and to bound the damage when they aren't fully closed.

---

## 4. Design axes

The problem decomposes into **three independent axes** that compose. Pick one option from each (or sequence them).

### Axis A — Authenticity: prove a mint is genuinely attested

**A1. On-chain signature verification (attester key).**
The pipeline (or a dedicated attester) signs the canonical mint payload with an **attester key**; `DeltaVerifier.submitMintRequest` takes a signature and verifies `recover(EIP-712 digest, sig) == trustedAttester` (an on-chain address, rotatable by governance) before minting. The signature binds chainId + verifying contract + modelId + anchors + scores/costs + contributors + idempotency key.
- **Pros:** Strongest. Closes T2, T3, **and T4** — even with the `SUBMITTER` key *and* Redis fully compromised, an attacker can't mint without the attester key. Decouples "who pays gas / submits" (`SUBMITTER`) from "who authorizes the mint" (attester). Enforced at the asset layer (the only place that ultimately matters), auditable on-chain. **This is the linchpin: once it's in, the consumer + Redis become untrusted transport, which makes the isolation problem far smaller.**
- **Cons:** Contract change to `DeltaVerifier` + re-audit (Echidna/Slither/external). New trusted-attester registry + rotation logic. Must get the EIP-712 message design right (bind all economic content + replay). Cross-repo lockstep change (pipeline signs, contract verifies). The attester key becomes the crown jewel — but it is small, offline-able, HSM-friendly.

**A2. Consumer-side signature verification (off-chain only).**
Pipeline signs; the consumer verifies before calling `submitMintRequest`. Contract unchanged.
- **Pros:** No contract change / no re-audit; fastest to ship. Closes T2 and T3 (forged queue messages without a valid signature are dropped before the chain).
- **Cons:** Does **not** close T4 — the consumer still holds `SUBMITTER` and is the enforcement point; a compromised consumer bypasses the check and mints. Defense-in-depth, not a root fix. Risk of divergence between the consumer's notion of "valid" and the contract's (which still trusts the role).

**A3. Trust-minimized / verifiable computation.**
Make the contract verify a proof that the attestation corresponds to the committed eval (Merkle/ZK).
- **Pros:** Removes the trusted attester entirely.
- **Cons:** Not feasible for an ML eval pipeline in any near-term scope. **Out of scope** — record as long-term direction only.

### Axis B — Custody & isolation: where the trust anchor runs, and lock the channel

**B1. Split public ingestion from the mint-publisher (privilege separation).**
The public service that accepts user submissions runs with **no** mint key and **no** Redis publish rights. A separate, non-public component (the attester / mint-publisher), triggered via a validated one-way boundary, holds the key/signer and publishes.
- **Pros:** Removes mint authority from the public attack surface — closes/contains T3. Least privilege. Pairs naturally with A1 (only the small attester needs isolating, not the whole pipeline).
- **Cons:** Pipeline architecture refactor; defines a new internal trust boundary + handoff that *itself* must be authenticated (else the problem just moves). Operational cost (another service/zone).

**B2. Managed signer (KMS/HSM / remote signer) for the key.**
The `SUBMITTER` (and/or attester) key never lives on a host — it's in AWS KMS / HSM / remote signer; the publish path is least-privileged.
- **Pros:** Protects key *material* even under host compromise; enables rate-limit/detect/revoke at the signer. Less refactor than B1. Strong when combined with A1 (attester signs via KMS in an isolated zone).
- **Cons:** Protects key theft, not key *use* — a compromised host can still request signatures (mint) while it has access. Necessary but not sufficient alone.

**B3. Redis hardening (table stakes, regardless of A/B choice).**
`REDIS_AUTH_TOKEN` + TLS (`rediss://`, already supported by the publisher), private subnet / no public exposure, least-privilege ACLs (publisher: `LPUSH` to one key only; consumer: read/ack only).
- **Pros:** Removes the trivial "anyone on the network LPUSHes" path (T2 via open Redis). Cheap, immediate.
- **Cons:** Does nothing for host compromise (T3/T4) or authenticity (T5). Necessary, not sufficient.

### Axis C — Blast-radius limitation (defense in depth, independent)

- **Conservative economic caps:** tight `maxReward` (on-chain) + Gate-5 `tokensPerDeltaOne` / per-eval caps + epoch-locked governance.
- **Rate limiting:** add a per-model / per-epoch mint-count (or cumulative-amount) limit on the V2 path (contract or consumer). Today only the legacy path has a cooldown.
- **Monitoring + automated response:** alert on `DeltaOneAccepted` anomalies (unexpected recipients/amounts/rate) and wire a fast `mint_paused` / `PAUSER_ROLE` trip.
- **Pros:** Bounds damage even when prevention fails; cheap; complementary to everything above.
- **Cons:** Mitigation not prevention; caps too tight break legitimate mints. Note idempotency stops only *replay of the same key*, not a novel forgery.

---

## 5. Decision matrix

| Option | Closes | Effort | Re-audit? | Notes |
|---|---|---|---|---|
| A1 on-chain sig | T2,T3,T4 (and bounds T5 to attester) | High | Yes (contract) | Root fix; linchpin |
| A2 consumer sig | T2,T3 | Med | No | Stopgap; doesn't cover consumer compromise |
| B1 split services | T3 (contains) | High | No | Architectural; best with A1 |
| B2 KMS/HSM | key theft (partial T3/T4) | Med | No | Protects material, not use |
| B3 Redis lockdown | T2 (open-Redis) | Low | No | Table stakes |
| C caps/limits/mon | bounds all | Low–Med | Maybe (if on-chain rate limit) | Defense in depth |

---

## 6. Recommended sequencing (for discussion)

The strongest end state is **A1 + B1 + B3 + C**. Sequenced by risk-reduction-per-effort:

- **Phase 0 — immediate, no contract change (days):** B3 (Redis auth/TLS/network/ACL) + B2 (move `SUBMITTER` key to KMS/remote signer) + C (set conservative `maxReward`/caps on mainnet, stand up `DeltaOneAccepted` monitoring + a tested pause runbook). Confirm the custody-runbook end state (admin = Safe, submitter ≠ deployer). This collapses the trivial paths (T2 open-Redis) and limits blast radius before anything else ships.
- **Phase 1 — the root fix (the linchpin):** A1 on-chain signed attestation. Design the EIP-712 message (bind chainId, contract, modelId, all anchors, scores/costs, contributors, idempotency key); add a rotatable trusted-attester registry to `DeltaVerifier`; update pipeline to sign and consumer to forward the signature; re-audit. **Once this lands, the consumer and Redis are no longer mint authority** — they can't produce a valid signature — which de-risks T2/T3/T4 at the asset layer and shrinks Phase 2.
- **Phase 2 — isolation:** B1 split the public ingestion from the now-small attester/signer component (which holds the only thing that matters post-A1), in its own zone / HSM. With A1 done, this is "protect one signer," not "lock down the whole pipeline."

**Why A1 before heavy B1:** isolation without authenticity still leaves a confused deputy (whoever can reach the isolated publisher can still mint); authenticity without isolation already removes mint power from Redis/consumer. A1 gives the most security per unit of effort and makes the isolation scope tractable. If A1's contract change/re-audit timeline is the blocker, **A2 is a legitimate bridge** (closes the demonstrated T2/T3 today) — but it must be explicitly understood as a stopgap that does not cover consumer compromise.

---

## 7. Open questions / decisions needed

1. **Who is the attester?** The pipeline itself, or a separate attestation service that *independently* re-derives the attestation from HEM/eval artifacts before signing? The latter is stronger (it isn't a confused deputy) but heavier. Decision affects A1 + B1 scope.
2. **On-chain (A1) vs. consumer-only (A2)** for v1-mainnet — root fix now, or stopgap + fast-follow? Drives the audit timeline.
3. **EIP-712 binding scope:** sign the full economic payload (recommended) vs. just `attestation_hash`. Signing only the hash re-introduces tampering risk on the other fields.
4. **Attester rotation / multi-attester:** single rotatable address, or a set / threshold (m-of-n) for higher assurance? Threshold adds resilience but more contract surface.
5. **Per-epoch / per-model rate limit on the V2 path:** on-chain (stronger, audited) or consumer-side (faster)? What limits don't break legitimate throughput?
6. **Key custody for the attester:** KMS vs. HSM vs. multisig signer — and where it runs relative to the public boundary.
7. **Migration:** A1 is a lockstep cross-repo change. Cutover plan (dual-accept window? feature flag on the contract?) to avoid a mint outage.

## 8. Non-goals (this round)

- On-chain verification of benchmark methodology / dataset bodies / scorer code (A3) — long-term only.
- Changes to reward economics beyond cap tuning.
- Governance/admin (`DEFAULT_ADMIN_ROLE`) custody — covered by the custody runbook (T6).

## 9. Cross-links

- [`docs/deltaverifier-trust-model.md`](deltaverifier-trust-model.md) — V1 trust model (assumed).
- [`docs/mainnet-custody-runbook.md`](mainnet-custody-runbook.md) — role custody / rotation.
- Linear: **HOK-2119** (security tracking) under epic **HOK-2053**.
