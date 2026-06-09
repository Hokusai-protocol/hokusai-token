# Mint Authority Hardening — Design & Options

**Status:** Direction set; design in progress · **Tracking:** HOK-2119 · **Date:** 2026-06-09

**Purpose:** lay out the options (with pros/cons) for closing the mint-authority gap before mainnet, and record the direction we've chosen. This is a decision doc, not an implementation spec.

**Read first / do not duplicate:**
- [`docs/deltaverifier-trust-model.md`](deltaverifier-trust-model.md) — the V1 "trusted submitter" model as shipped. This doc assumes it.
- [`docs/mainnet-custody-runbook.md`](mainnet-custody-runbook.md) — `SUBMITTER_ROLE` / `DEFAULT_ADMIN_ROLE` custody, Safe handoff, rotation.

## Decisions to date (direction set 2026-06-09)

These are settled and frame the rest of the doc; the options below are retained to record *why* and to scope the open design work.

1. **We will separate the attester key from the submitter key, in different custody.** This is the assumption that makes on-chain verification worth anything (see §4 Axis A — co-located keys would make it security theater).
2. **We will add some form of on-chain signature verification (Axis A1).** `DeltaVerifier` will verify that a mint is authorized by a registered **attester**, not merely relayed by a `SUBMITTER`. A2 (consumer-side check) is at most a bridge, not the destination.
3. **The attester's custody will mature over time, and we should design for that from day one:** start with a **human-in-the-loop signer** (strongest separation, lowest infra), then move to an **HSM / automated attester** (and optionally multisig/threshold) as mint volume grows. The contract verifies a registered attester address, so this evolution is a custody/rotation change, **not** a contract change (see §4 Axis A — "Attester custody maturation").

Still open (see §7): the EIP-712 message scope, single-vs-set attester registry, whether the automated attester independently re-validates, per-epoch rate limits, and migration/cutover.

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

**Chosen direction: A1 (on-chain signature), with a separate attester key whose custody matures human-in-the-loop → HSM.** A2 is at most a bridge. Rationale below.

#### Why a signature helps — and the load-bearing caveat

A signature scheme only buys real security to the extent the **attester key escapes the submitter key's threat surface**. If both keys live in the same custody/host, "compromise one ≈ compromise both" and on-chain verification is just complexity. We have decided to keep them in **different custody** (see Decisions), which is what makes this worthwhile. The benefit is best understood by adversary tier:

| Tier | Adversary | What signing buys |
|---|---|---|
| 1 | Can reach Redis, **holds no key** (the attack demonstrated 2026-06-08) | **Defeated by any signature** (A1 *or* A2) — a forged queue message lacks a valid attester signature. Holds **even if both keys are co-located**, because the Redis-injecting attacker has neither key. This is the exploitable-today vector. |
| 2 | Compromises the **consumer / submitter host** | A1 defeats it **iff the attester key is elsewhere** (our decision). A2 never helps here — a compromised consumer bypasses its own check. |
| 3 | Compromises the **attester-key holder** | Signatures don't help (they hold the signing key). Mitigated only by HSM / multisig / human-in-loop / caps + monitoring. This is the residual tier the custody-maturation path attacks. |

So: signing kills tier 1 unconditionally; **separating the attester key** is what extends that to tier 2; and **the attester's custody quality** is what shrinks tier 3.

**A1. On-chain signature verification (attester key). — CHOSEN**
A dedicated **attester** signs the canonical mint payload; `DeltaVerifier.submitMintRequest` takes a signature and verifies `recover(EIP-712 digest, sig) == registeredAttester` (an on-chain address/allowlist, rotatable by the admin Safe) before minting. The signature binds chainId + verifying contract + modelId + anchors + scores/costs + contributors + idempotency key, so nothing can be tampered between attester and contract.
- **Pros:** Closes tiers 1–2 and shrinks tier 3. Decouples "who pays gas / submits" (`SUBMITTER`, intrinsically hot) from "who authorizes the mint" (attester, which need not be hot). Enforced at the asset layer, auditable on-chain (every mint is provably authorized by the registered attester — meaningful to token holders independent of the compromise math). **Linchpin:** once in, the consumer + Redis become untrusted transport, shrinking the isolation work to "protect the attester," and custody can evolve (human → HSM → multisig) **without a contract change** — just rotate the registered attester.
- **Cons:** `DeltaVerifier` change + re-audit (Echidna/Slither/external). New attester registry + rotation. Must get the EIP-712 message right (bind all economic content + replay). Cross-repo lockstep (attester signs, contract verifies) + a migration/cutover plan.

**A2. Consumer-side signature verification (off-chain only). — BRIDGE ONLY**
Attester signs; the consumer verifies before calling `submitMintRequest`. Contract unchanged.
- **Pros:** No contract change / no re-audit; fastest. Closes tier 1 today (forged queue messages dropped before the chain).
- **Cons:** Does **not** close tier 2 — the consumer still holds `SUBMITTER` and is the enforcement point; a compromised consumer bypasses the check and mints. No on-chain auditability or custody option-value. Use only as an interim step *if* the audit timeline blocks A1; the same attester signature should be designed so it later verifies on-chain unchanged.

**A3. Trust-minimized / verifiable computation.** Contract verifies a proof the attestation corresponds to the committed eval (Merkle/ZK).
- **Pros:** Removes the trusted attester entirely. **Cons:** Not feasible for an ML eval pipeline in any near-term scope. **Out of scope** — long-term only.

#### Attester custody maturation (design for this from day one)

The contract verifies a **registered attester address**; it does not care how the signature is produced. That lets custody mature without redeploys:

- **Stage 1 — human-in-the-loop attester (start here).** A human (or small group), out-of-band from the hot submitter/relayer, reviews each accepted DeltaOne and signs the authorization from a hardware wallet / Safe. The signed payload is attached to the `MintRequest`; the submitter only relays + pays gas.
  - *Pros:* Strongest separation immediately and the best tier-3 posture — a fully-compromised pipeline **and** consumer still cannot mint without a human signature. Minimal infra (no automated signer to build/secure). Fits low early-mainnet mint frequency.
  - *Cons:* Latency + a throughput ceiling (a human signs each batch); the signer is an availability dependency; **rubber-stamp risk** — the human must be given a verifiable, human-readable summary of what they're signing, or the gate is illusory.
- **Stage 2 — HSM / automated attester (move here as volume grows; optionally m-of-n).** Replace the human with an automated signing service whose key is in an HSM/KMS, in an isolated zone with no public ingress, that **independently re-validates** the attestation before signing.
  - *Pros:* Scales; key non-extractable; central rate-limit/log/revoke.
  - *Cons:* If it auto-signs whatever the pipeline produces *without independent checks*, it's just a second confused deputy with a different key — security then rests on its isolation + independent validation, not the signature. Securing that service's host + logic becomes the new tier-3 surface.

**Key design implication:** the human stage gives the strongest guarantee at the cost of throughput; the HSM stage trades some of that guarantee for scale, and its security hinges on the automated attester *genuinely re-deriving/validating* the attestation rather than blindly signing. Plan the Stage-2 attester's independent-validation story now, even if Stage 1 ships first.

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
| A1 on-chain sig | T2,T3,T4 (and bounds T5 to attester) | High | Yes (contract) | **CHOSEN** — root fix; linchpin |
| A2 consumer sig | T2,T3 | Med | No | Bridge only (if A1 audit timeline blocks); not the destination |
| B1 split services | T3 (contains) | High | No | Architectural; best with A1 |
| B2 KMS/HSM | key theft (partial T3/T4) | Med | No | Protects material, not use |
| B3 Redis lockdown | T2 (open-Redis) | Low | No | Table stakes |
| C caps/limits/mon | bounds all | Low–Med | Maybe (if on-chain rate limit) | Defense in depth |

---

## 6. Recommended sequencing

Target end state **A1 + separate attester custody + B1 + B3 + C**, with the attester maturing human-in-the-loop → HSM. Sequenced by risk-reduction-per-effort:

- **Phase 0 — immediate, no contract change (days):** B3 (Redis auth/TLS/network/ACL) + B2 (move `SUBMITTER` key to KMS/remote signer) + C (conservative `maxReward`/caps on mainnet, `DeltaOneAccepted` monitoring + a tested pause runbook). Confirm the custody-runbook end state (admin = Safe, submitter ≠ deployer). Collapses the trivial paths (T2 open-Redis) and bounds blast radius before anything else ships.
- **Phase 1 — A1 with a Stage-1 (human-in-the-loop) attester:** add EIP-712 signature verification to `DeltaVerifier` against a rotatable registered attester; stand up the **separate attester key** in human/hardware-wallet custody, out-of-band from the submitter; update the producer to attach the signature and the consumer to forward it; re-audit. **Once this lands, the consumer and Redis stop being mint authority** (they can't produce a valid signature) — closing the demonstrated tier-1/2 vectors at the asset layer. Throughput is gated by human signing, which is acceptable at early-mainnet volume.
- **Phase 2 — isolation + automated attester (Stage 2):** B1 split public ingestion from the now-small attester/signer component; move the attester key to HSM/KMS with an automated signer that **independently re-validates** the attestation (not a second confused deputy), in an isolated zone. Because the contract verifies a registered address, this is a custody rotation, **not** a contract change. With A1 done, the scope is "protect one signer," not "lock down the whole pipeline."

**Why this order:** signing kills the exploitable-today tier-1 vector immediately; the separate attester key extends that to consumer compromise (tier 2); the human-in-the-loop start gives the strongest tier-3 posture from day one at the cost of throughput; HSM/automation later trades some of that for scale, gated on building the attester's independent-validation story. If the Phase-1 contract audit timeline slips, **A2 (consumer-side verification of the same attester signature) is a legitimate bridge** for tier 1 — but it does not cover consumer compromise and is not the destination.

---

## 7. Open questions / decisions needed

*Settled (see Decisions):* separate attester key in different custody; on-chain signature (A1) is the destination; custody matures human-in-the-loop → HSM. Remaining:

1. **EIP-712 binding scope:** sign the full economic payload (modelId, all anchors, scores/costs, contributors, idempotency key) — recommended — vs. just `attestation_hash`. Signing only the hash re-introduces tampering risk on the other fields. Also bind chainId + verifying contract to prevent cross-deployment replay.
2. **Attester registry shape:** single rotatable address vs. an allowlist/set (zero-downtime rotation: add-new-then-remove-old) vs. threshold m-of-n. Recommend at least an allowlist so Stage-1→Stage-2 cutover needs no outage; threshold is a later option.
3. **Stage-1 human signing UX (avoid rubber-stamping):** what verifiable, human-readable summary does the signer see, and how is it bound to the exact bytes signed? Without this the human gate is illusory.
4. **Stage-2 independent validation:** what does the automated attester re-derive/verify (HEM digest? recompute `attestation_hash` from artifacts?) before signing, so it isn't a second confused deputy? This is the crux of the Stage-2 security story.
5. **Per-epoch / per-model rate limit on the V2 path:** on-chain (stronger, audited) or consumer-side (faster)? What limits don't break legitimate throughput? (Defense-in-depth for the residual tier-3.)
6. **Migration / cutover:** A1 is a lockstep cross-repo change. Plan to avoid a mint outage — e.g. a contract flag that makes the signature optional during a dual-accept window, then enforced; or deploy-verify-flip. Define rollback.

## 8. Non-goals (this round)

- On-chain verification of benchmark methodology / dataset bodies / scorer code (A3) — long-term only.
- Changes to reward economics beyond cap tuning.
- Governance/admin (`DEFAULT_ADMIN_ROLE`) custody — covered by the custody runbook (T6).

## 9. Cross-links

- [`docs/deltaverifier-trust-model.md`](deltaverifier-trust-model.md) — V1 trust model (assumed).
- [`docs/mainnet-custody-runbook.md`](mainnet-custody-runbook.md) — role custody / rotation.
- Linear: **HOK-2119** (security tracking) under epic **HOK-2053**.
