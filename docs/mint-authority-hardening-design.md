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
3. **The attester's custody will mature over time, and we should design for that from day one:** start with a **human-in-the-loop signer** (strongest separation, lowest infra), then move to an **HSM / automated attester** (and optionally multisig/threshold) as mint volume grows. The contract verifies a registered attester, so this evolution is a custody/rotation change, **not** a contract change (see §4 Axis A — "Attester custody maturation").
4. **The signature binds the full economic payload** (EIP-712 over modelId + all anchors + scores/costs + contributors + idempotency key, domain-separated by chainId + verifying contract). Signing only `attestation_hash` would leave the other fields tamperable. **The human-in-the-loop UX summarizes exactly this payload**, and that summary must be bound to the bytes actually signed (the summary *is* a rendering of the signed struct — see §7 Q2).
5. **Launch with the smallest *audited* signer model (single registered attester), but shape storage/events so threshold `m`-of-`n` can be added later without a rewrite.** *(Revised per review — full on-chain threshold is **not** cheap: signature ordering, duplicate-signer rejection, gas bounds, EIP-1271/Safe compatibility, threshold-update safety, and audit surface.)* If we do ship threshold at launch, we must first define the invariants (cap `n`, require sorted unique signers, rotation/emergency-removal rules) and audit them. The set/threshold *foundation* (registry storage + events) is what's cheap to lay now; the verification logic is not.
6. **No *permanent* artificial caps on legitimate rewards — but a *launch-phase* deterministic cap is required.** *(Revised per review.)* Our intent stands: if results genuinely move a model by *X* DeltaOnes we don't want to throttle distribution long-term, and the human attester is the judgment-based fraud check. But a human + monitoring is a *probabilistic* control, not a *deterministic damage bound* — and with `tokensPerDeltaOne = 500,000` and mints repeatable under fresh idempotency keys, an unbounded path is a large blast radius. So at launch we add a deterministic loss bound: a **per-model on-chain mint budget** (`mintBudgetRemaining[modelId]`, decremented per mint, **topped up by the admin Safe — separate from the attester**), plus a **generously-set** per-mint `maxReward` (sized to the largest *plausible legitimate single* jump, so it never clips a real breakthrough — only the impossible). The budget is a **loss ceiling, not a fraction of the model's lifetime reward** (worked example in §9.3: HROUT's lifetime max is ~14.5M tokens; the standing budget should be far smaller — e.g. 1–2M — and refilled as genuine improvement is earned, since Safe top-ups are easy). Legitimate fast-improvers are paid in full per mint (human-approved, within `maxReward`); only a temporarily-drained budget *defers* them until the next top-up — **not a forfeiture**. **Budget-exceeded reverts (does not truncate)** — the full attested amount is paid after a Safe top-up, never haircut (§9.3). **LOCKED for HROUT:** `tokensPerDeltaOne = 250,000`, `maxReward = 2.5M`, starting budget `1.5M`.
7. **We will add a model/weights *content* commitment to the v1 signed payload + `DeltaOneAccepted` now** (a `bytes32`, signed and emitted, of the candidate model artifact — and likely the baseline). This is a deliberate scope addition to the A1 contract change because it is the one foundation that is *expensive to retrofit*: A1 is already a contract change + re-audit, so bundling it in is nearly free now, whereas adding it later means a second signed-payload + contract change + re-audit + cross-repo migration. It is the durable hook that lets a future verifier (committee / TEE / ZK) confirm an eval ran against *specific* weights **without the weights being public**. Note the pipeline today commits only to the model *identity* (`model_hash = hash(model_id)`) and `dataset_hash`, and references the model via a private `source_mlflow_run_id` — **not** the weights content; this decision upgrades that identity/reference into a content commitment (see §4 Axis A "Long-term", §7 Q1).

8. **We will record a verifiable model-weight lineage chain** — commit to **both** `baseline` and `candidate` weight commitments per mint; the contract stores the canonical head per model, requires `payload.baselineCommitment == head[modelId]`, then advances the head. Makes the mint history a hash-linked chain anyone can rebuild from genesis to head; a forged mint can't invent a baseline (it must parent off the on-chain head). Resolves candidate-vs-baseline (= **both, linked**). See §4 Axis A — "Model-weight lineage chain". **Caveat (per review): the marginal *contract-change* cost is low, but the *system prerequisites are not* — and a wrong/ambiguous commitment can brick a model's mint path forever (`baseline == head` would never again match). Do not ship lineage unless (a) genesis is set at model registration, (b) the deterministic weights serialization is nailed down, and (c) a correction/admin-reset policy exists. These are launch prerequisites, not implementation details (§7 Q1).**

   > **Implemented (HOK-2133).** `MintRequestPayload` + the EIP-712 typehash now carry `baselineCommitment`/`candidateCommitment`; `DeltaVerifier.modelWeightHead[modelId]` enforces `baselineCommitment == head` and advances to `candidateCommitment` **only on paying mints** (the canonical chain never regresses), emitting `ModelLineageAdvanced(modelId, parent, child)`. Prerequisites: (a) **genesis lives in `ModelRegistry.weightGenesis` via `setWeightGenesis`, authorized by the registration authority** — chosen over a separate DeltaVerifier admin-seed so genesis tracks registration permissions and inherits any future permissionless registration (no extra chokepoint); fail-closed (`LineageNotSeeded`) until set, so a first mint can't define history. (b) deterministic weights serialization = HOK-2129. (c) correction = `resetModelHead` (DEFAULT_ADMIN_ROLE; future: per-model owner). Re-base is surfaced by the `LineageParentMismatch` revert (no idempotency-key burn), so a producer that loses a concurrent race re-bases on the new head and re-evals.

9. **Attester authorization must gate *every* minting path — or the legacy paths must be disabled.** *(Added per review — critical.)* `DeltaVerifier` today has four `SUBMITTER_ROLE`-gated mint entrypoints: `submitEvaluation` (L172), `submitEvaluationWithContributorInfo` (L184), `submitEvaluationWithMultipleContributors` (L213), and `submitMintRequest` (L287). Adding A1 to `submitMintRequest` alone leaves **three live bypass routes**: a compromised submitter just calls a legacy path. **Decided (2026-06-09): the legacy mint entrypoints will be disabled on mainnet** (e.g. revert / removed / permanently guarded), leaving `submitMintRequest` (with attester verification) as the only mint path. **This is a launch blocker.**

Still open (see §7): exact EIP-712 field list; commitment form per link (content hash vs. Merkle root) + reproducible weights serialization; genesis seeding + concurrency/re-base; attester-set/threshold mechanics; the human-signing UX; the long-term decentralized-attestation + **privacy** design (foundations now, full solution later); and migration/cutover.

### Launch blockers & stop conditions (must clear before mainnet minting is enabled)

Minting **must not be enabled on mainnet** while Redis or the consumer can produce an asset-layer mint without an independent authorization check. Concretely:

- [ ] **Every** mint entrypoint enforces attester authorization, or legacy paths are disabled (Decision 9).
- [ ] A1 attester verification deployed + covered by **Echidna/Slither + internal review** (external audit WAIVED for launch — recorded risk acceptance 2026-06-22, see `mint-authority-launch-gate.md` "Audit decision"); the attester key is in *separate* custody from the submitter (Decisions 1–2).
- [ ] Admin (`DEFAULT_ADMIN_ROLE`) and the attester registry are Safe/timelock-controlled — A1 is only meaningful if an attacker can't swap in their own attester (§3 T6).
- [ ] Launch-phase cumulative mint cap configured + a `maxReward` per-mint backstop; conservative vs. the `tokensPerDeltaOne = 500,000` economics (Decision 6).
- [ ] Monitoring on `DeltaOneAccepted` with defined thresholds **and** a pause authority that can act faster than the mint drain rate; pause drill rehearsed (§7 Q5). Note: `pause()` is `PAUSER_ROLE`, `unpause()` is `DEFAULT_ADMIN_ROLE`.
- [ ] If lineage ships: genesis-at-registration, deterministic weights serialization, and a correction/reset policy all nailed down (Decision 8).
- [ ] Redis auth/TLS/network lockdown + KMS custody (B2/B3) — necessary but **not sufficient**; they do not substitute for A1.
- [ ] **Data hygiene:** the 2026-06-08 Sepolia forged mint (`0x2937…`) and any rehearsal metrics/settlement records/dashboards that include it are marked polluted / excluded from launch evidence.

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
| T5 | Dishonest/compromised `SUBMITTER` holder | Mint fabricated results within caps **— incl. via legacy `submitEvaluation*` paths** | ❌ No (accepted V1 risk; see Decision 9) |
| T6 | Compromise of `DEFAULT_ADMIN` (Safe) | Grant role / unpause / emergency params / **swap the registered attester** | Custody-owned, **but A1 depends on it** — A1 is only meaningful if admin + the attester registry are Safe/timelock-controlled (an attacker who can re-register an attester defeats A1). Not fully out of scope. |
| T7 | Attester **rubber-stamp / signing-UI compromise** | Human signs a forged payload because the rendering it saw was wrong/manipulated | ❌ No — human-in-the-loop only helps if the signer sees an *independently trustworthy* rendering of the exact typed data being signed (§7 Q2) |

The goal of this work is to push T2–T5/T7 from ❌ toward ✅, bound the damage when they aren't fully closed, and keep T6 in custody scope while noting A1's dependency on it.

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

#### Long-term: decentralized attestation vs. payload privacy (lay foundations now, solve later)

The end-state we're aiming toward is a **decentralized set of attesters that each independently verify the accuracy of the mint payload and reach consensus (m-of-n) before a mint is authorized** — turning "trust one attester" into "trust that a quorum of independent verifiers agree." This is strictly stronger than any single-signer scheme and is the natural extension of the Stage-2 "independent validation" question (§7 Q3–Q4).

**The core tension:** independent verification of accuracy normally requires the verifier to *see* the model weights and the eval set — but **those must remain private** (they are the protected IP). Naively, "each attester re-runs the eval" leaks exactly what we need to keep secret. So decentralization and privacy pull in opposite directions, and the design has to reconcile them. The plausible approaches (to explore, **not** decide now), from cheapest/weakest to strongest:

- **Commitment + private artifact sharing under NDA.** The producer publishes a public *commitment* (hashes already in the payload: `attestation_hash`, `dataset_hash`, `benchmark_spec_id`, + a possible **model/weights commitment**); a small set of attesters receive the private artifacts under legal agreement, verify they match the commitment, re-run the eval privately, and sign. *Privacy by contract/law, not cryptography — the committee still sees the IP.*
- **Trusted execution environments (TEEs / enclaves).** Attesters verify weights + eval *inside* an enclave that attests the result without exposing the artifacts in the clear. *Privacy preserved under a hardware-trust assumption.*
- **Zero-knowledge proof of evaluation.** A proof that "eval *E* over committed model *M* and dataset *D* yields score *S*" without revealing *M*/*D*. *The trust-minimized ideal, but likely infeasible for real ML eval in the near term.*

**Foundations to lay now so this isn't a costly rewrite later:**

1. **Verify m-of-n over an attester set in the contract from day one** (run 1-of-1 at launch). Going from one trusted signer to a quorum then becomes governance config, not a contract change/re-audit. *(Decision 5.)*
2. **Commit to the eval artifacts in the signed + emitted payload — including a model/weights *content* commitment, which we are adding in v1 *(Decision 7)*.** The signature and `DeltaOneAccepted` already bind `dataset_hash` and `benchmark_spec_id`; the gap is a commitment to the model **weights content** (today the pipeline only hashes the model *id* and references weights via a private MLflow run, which a verifier cannot check). Adding a `bytes32` candidate-model commitment (and likely a baseline one) lets a future verifier confirm *private* artifacts against the *public* commitment. Cheap now (a `bytes32` or two); expensive to retrofit. Align with the existing `zk_output_formatter` scaffolding in the pipeline.
3. **Keep the attester role cleanly separable from any party that must see private artifacts** so a future TEE/ZK or NDA-committee verifier can slot in behind the same on-chain interface.

Net: we don't solve decentralized private verification now, but the contract's signature/registry shape and the payload's commitments should be chosen so that moving there later is additive, not a re-architecture.

#### Model-weight lineage chain (verifiable model evolution) — *Decision 8*

Building on Decision 7, we don't just commit to *a* model version per mint — we **link successive versions into a per-model hash-linked chain**, so the mint history becomes a ledger anyone can follow/rebuild from the root (initial model deploy) to today's head.

- **Each accepted mint commits to `baselineCommitment` and `candidateCommitment`** — both signed in the EIP-712 payload, both emitted in `DeltaOneAccepted`.
- **The contract stores the canonical head per model** — `mapping(uint256 modelId ⇒ bytes32 head)` — and on each mint enforces `baselineCommitment == head[modelId]`, then sets `head[modelId] = candidateCommitment`. This is the **parent-hash check of a blockchain**: a mint must build on the current canonical weights and atomically advances them.
- **Genesis** is seeded at model registration (or the first mint) to the initial/root deploy commitment, giving the chain a well-defined root.
- **History is reconstructable from events** (each `DeltaOneAccepted` carries parent → child); only the head is stored on-chain — exactly like rebuilding a chain from its blocks.

Why do it now (it's part of the same A1 contract change):
- **Security:** a forged mint can no longer invent an arbitrary baseline — it must parent off the on-chain head, which is immutable and attested. With the attester signature (authorized) + idempotency key (non-replayable) + parent check (correctly-parented), the lineage is canonical, ordered, and tamper-evident.
- **Verifiability:** given the private artifacts, a verifier (committee / TEE / ZK) can replay the entire evolution — root → v1 → v2 → … → head — and check each transition produced its claimed DeltaOne, because both endpoints of every step are committed on-chain.
- **Auditability:** the model's full provenance (which contributors moved it, and by how much at each step) becomes a public, immutable ledger keyed off the weight chain.

Implications / sub-questions:
- **Linearity:** the chain is strictly linear per model — only one candidate can advance the head. Concurrent evals sharing a baseline race; the loser's `baselineCommitment` no longer matches the head and must **re-base** on the new head and re-eval. Desirable as canonical history, but an operational constraint to design for. It also tightens the existing "canonical score advances only after publish" invariant — the score head and the weight head must advance together atomically.
- **Each link can itself be a Merkle root** over weight shards (Decision-7 sub-question); that composes — the chain is simply over those roots.
- **Pin in the spec:** genesis seeding mechanism (ModelRegistry-at-registration vs. first-mint special case), the reproducible/deterministic weights serialization the commitment is taken over (pipeline dependency), and how re-base is surfaced to the producer/attester.

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
| A1 on-chain sig | T2,T3,T4 (bounds T5) — **only if all mint paths require it (Decision 9) and the attester key is truly separated** | High | Yes (contract) | **CHOSEN** — root fix; linchpin |
| A2 consumer sig | T2,T3 | Med | No | Bridge only (if A1 audit timeline blocks); not the destination |
| B1 split services | T3 (contains) | High | No | Architectural; best with A1 |
| B2 KMS/HSM | key theft (partial T3/T4) | Med | No | Protects material, not use. **Post-A1 the priority is the *attester* key, not the submitter** (which becomes a mere relayer) |
| B3 Redis lockdown | T2 (open-Redis) | Low | No | Table stakes — **not** a mint-authority fix on its own |
| C caps/limits/mon | bounds all | Low–Med | Maybe (if on-chain rate limit) | Defense in depth |

---

## 6. Recommended sequencing

Target end state **A1 + separate attester custody + B1 + B3 + C**, with the attester maturing human-in-the-loop → HSM. Sequenced by risk-reduction-per-effort:

- **Phase 0 — immediate, no contract change (days):** B3 (Redis auth/TLS/network/ACL) + B2 (move `SUBMITTER` key to KMS/remote signer) + C (conservative launch cap + `maxReward` on mainnet, `DeltaOneAccepted` monitoring + a tested pause runbook). Confirm the custody-runbook end state (admin = Safe, submitter ≠ deployer). Collapses the trivial paths (T2 open-Redis) and bounds blast radius. **Not sufficient for a public mainnet launch with minting enabled** — it still leaves the approved submitter (and thus a pipeline/consumer compromise) as mint authority. Minting stays disabled on mainnet until Phase 1.
- **Phase 1 — A1 with a Stage-1 (human-in-the-loop) attester (the launch gate):** add EIP-712 signature verification to `DeltaVerifier` against a registered attester; **apply it to (or disable) every mint entrypoint, not just `submitMintRequest`** (Decision 9); decide **EOA `ecrecover` vs. EIP-1271** based on the chosen attester wallet type; stand up the **separate attester key** in human/hardware-wallet custody, out-of-band from the submitter; enforce signatures from the first mainnet mint (**no "signature optional" dual-accept window** — that is an intentional bypass during the most sensitive period); re-audit. Plus rehearsals: attester custody, **signature-rendering** (what the human sees == the bytes signed), pause drill, monitoring drill. **Once this lands, the consumer and Redis stop being mint authority.** Throughput is gated by human signing, acceptable at early-mainnet volume.
- **Phase 2 — isolation + automated attester (Stage 2):** B1 split public ingestion from the now-small attester/signer component; move the attester key to HSM/KMS with an automated signer that **independently re-validates** the attestation (not a second confused deputy), in an isolated zone. Because the contract verifies a registered address, this is a custody rotation, **not** a contract change. With A1 done, the scope is "protect one signer," not "lock down the whole pipeline."

**Why this order:** signing kills the exploitable-today tier-1 vector immediately; the separate attester key extends that to consumer compromise (tier 2); the human-in-the-loop start gives the strongest tier-3 posture from day one at the cost of throughput; HSM/automation later trades some of that for scale, gated on building the attester's independent-validation story. If the Phase-1 contract audit timeline slips, **A2 (consumer-side verification of the same attester signature) is a legitimate bridge** for tier 1 — but it does not cover consumer compromise and is not the destination.

---

## 7. Open questions / decisions needed

*Settled (see Decisions 1–7):* separate attester key in different custody; on-chain signature (A1) is the destination; custody matures human-in-the-loop → HSM; sign the full economic payload; verify m-of-n over an attester set (1-of-1 at launch); no artificial rate caps (human + monitoring + `maxReward` backstop instead); add a model/weights content commitment in v1. Remaining design work:

1. **Exact EIP-712 field list + the lineage-chain mechanics.** Confirm the struct fields (modelId, anchors, scores/costs, contributors, idempotency key, **`baselineCommitment` + `candidateCommitment`**; domain = chainId + verifying contract). Per Decision 8 the chain is decided (commit to both, store the head per model, enforce `baseline == head`, advance head). Remaining: (a) commitment form per link — single content hash vs. **Merkle root** over weight shards (the latter is friendlier to partial/streaming and ZK verification later; composes with the chain); (b) hash function/format (match the existing `0x`+64-hex sha256 anchor convention); (c) **reproducible, deterministic weights serialization** the commitment is taken over (pipeline dependency to confirm); (d) **genesis** — *decided: seed `head[modelId]` at ModelRegistry registration* (a first-mint special case would let the first accepted mint define history, weakening the whole lineage story); (e) **concurrency/re-base** — a real product constraint, not a detail: with slow human signing, two valid evals can race and one becomes invalid; we need a head-lock/queue rule **before** human signing goes live; (f) **correction policy** — if an accepted commitment is later found wrong, can the head be admin-reset / the model deactivated-and-replaced, or is the chain immutable? Must be decided before launch (brick risk). The contract treats each commitment as opaque `bytes32`. **This whole item is a launch blocker if lineage ships.**
2. **Attester registry + governance + signature type.** (a) **Governance mechanics:** who can add/remove attesters and change `m` (Safe-owned), whether changes are **timelocked**, and an **emergency-removal** path if the sole/launch attester is compromised or unavailable (don't strand minting). (b) **Signature type:** *decided — launch attester is a hardware-wallet EOA, so the contract uses `ecrecover` at launch*; still design the registry/verification so an **EIP-1271** (Safe/contract) attester can be added later (multi-human or threshold) without a rewrite. (c) **Domain/app separation:** include `schema/version` (and the EIP-712 domain) so a future schema change can't produce an ambiguous/repurposable signature. (d) **Human signing UX:** an independently trustworthy rendering of the exact typed data the signer approves (resolves T7 rubber-stamp). (e) Zero-downtime rotation (add-then-remove).
3. **[Big, long-term] Decentralized attestation under privacy.** How independent attesters verify accuracy *without* seeing private weights/eval set — NDA committee vs. TEE/enclave vs. ZK (see §4 "Long-term"). **Not for now**, but the §4 foundations (m-of-n contract, artifact commitments, separable attester role) must be in the first version so this stays additive. Needs its own design spike.
4. **Stage-2 automated-attester validation.** When we move off the human, what does the automated attester independently re-derive/verify (HEM digest? recompute `attestation_hash` from artifacts?) before signing, so it isn't a second confused deputy? This is a sub-problem of Q3 and the crux of Stage-2 security.
5. **Global mint budget + generous maxReward + fraud watch.** *(Decision 6.)* Implement an on-chain **`mintBudgetRemaining[modelId]`** counter (decrement per mint, **Safe** top-up, kept small — sized to tolerable forgery loss, *not* the model's lifetime reward; see §9.3) as the deterministic loss bound — per-model to align with the lineage head and the user's per-model framing (a global ceiling can sit on top if desired). Set per-mint `maxReward` **generously** (largest plausible legitimate single jump) so it never clips a real mint. Remaining to define: the **budget size** (= your max tolerable forgery loss before pause — §9.3 input), the **governance top-up cadence/authority**, concrete **monitoring thresholds** on `DeltaOneAccepted` (unexpected recipients, implausible DeltaOne jumps, velocity), and a **pause authority that can act faster than the drain rate** (the budget exists precisely because human response may lag the drain). Reconcile `tokensPerDeltaOne` (parameter-lock says 500,000; router cited at 250k).
6. **Migration / cutover.** A1 is a lockstep cross-repo change. Plan to avoid a mint outage — e.g. a contract flag that makes the signature optional during a dual-accept window, then enforced; or deploy-verify-flip. Define rollback.

## 8. Non-goals (this round)

- On-chain verification of benchmark methodology / dataset bodies / scorer code (A3) — long-term only.
- Changes to reward economics beyond cap tuning.
- Governance/admin (`DEFAULT_ADMIN_ROLE`) custody — covered by the custody runbook (T6).

## 9. Clarifying questions — answered 2026-06-09

1. **Legacy mint entrypoints on mainnet → DISABLE.** They will be disabled on mainnet (not left callable, not just attester-gated). *(Decision 9 firmed.)*
2. **Launch attester → hardware-wallet EOA.** The contract verifies with `ecrecover` at launch; the registry is still designed so an EIP-1271 (Safe/contract) attester can be added later without a rewrite. *(§7 Q2.)*
3. **Reward bound → layered control (see Decision 6 / §7 Q5).** A single hard `maxReward` would risk clipping a legitimate breakthrough (esp. the **router**, where current results are weak so a large early jump is both likely and desirable). Recommended layering instead:
   - **Human attester** approves each mint — the per-mint fraud check; won't sign an implausible jump.
   - **Per-mint `maxReward`: set generously** — to the reward for the largest *plausible legitimate* single improvement (≈ full headroom from the current baseline toward the metric ceiling × `tokensPerDeltaOne`). This never clips a real mint; it only blocks the physically-impossible (more improvement than exists) as a forgery/bug backstop. For the router this is intentionally a large number.
   - **Global on-chain mint budget (the deterministic loss bound):** the contract mints at most `mintBudgetRemaining`, decremented per mint, **topped up by governance**. Total exposure to a forgery is bounded regardless of per-model dynamics, with minimal contract surface (one counter). A legitimate fast-improver is paid **in full** per mint and is only *deferred* if the global budget is temporarily exhausted — governance tops it up readily for legitimate activity. **A deferral, not a forfeiture.**
   - **Monitoring** (velocity, implausible delta, unexpected recipient) → trip pause.
   - **Budget ≠ lifetime reward (worked example, HROUT).** Baseline accuracy `0.42` → ceiling `1.00` = **58 points** of headroom × `250,000` = **14.5M tokens** of *lifetime* legitimate reward, earned incrementally. The budget is a **loss ceiling**, not a fraction of that lifetime total: sizing it at 25–50% of 14.5M (3.6M–7.25M) would let a forgery drain that much before the cap bites. Instead the standing budget should bound *forgery loss before detect-and-pause*, which is far smaller — the 14.5M is what governance authorizes *over time as real improvement lands*, not upfront.
   - **LOCKED (2026-06-09):** HROUT `tokensPerDeltaOne = 250,000` (mainnet); `maxReward = 2.5M` (≈ 10-point largest single-eval jump × 250k); starting per-model budget `mintBudgetRemaining[HROUT] = 1.5M` (max tolerable forgery loss). Per-model budget, **Safe top-up, separate from the attester**.
   - **Budget semantics — REVERT, not truncate (answers "what if a legit mint deserves 2M vs a 1.5M budget?").** A mint that would exceed the remaining budget **reverts atomically**: nothing mints, the idempotency key is **not** consumed, the lineage head does **not** advance. The full 2M is neither lost nor truncated — the **identical attested mint is re-submitted verbatim after the Safe tops the budget up to ≥ 2M, and pays the full 2M**. In practice the attester reads `mintBudgetRemaining` on-chain *before* signing a large mint and requests the top-up first, so the big mint simply waits for a deliberate governance action, then pays in full. (Truncate-and-owe would underpay or need a claim ledger; revert is simpler and fully correct.) Note `maxReward (2.5M) > standing budget (1.5M)` by design: any single mint above 1.5M requires a deliberate Safe top-up — that's the intended safety, not a bug.
   - *(Optional v2 ergonomics: an auto-replenishing "drip" — budget accrues X/epoch up to a cap — removes routine manual top-ups and bounds drain rate automatically; not launch surface.)*
4. **Deterministic weight commitments → feasible; DECIDED: include lineage.** Investigation of `hokusai-data-pipeline`: models are materialized as **MLflow artifacts** (`trainer.log_model_to_mlflow(...)`, `mlflow.pyfunc.load_model(model_uri)`, CLI `--model-path ./checkpoints/final`), i.e. there *is* a stored weight artifact to hash — not just remote endpoints. The two existing `model_hash` paths are explicit **proxies** (`zk_output_formatter._compute_model_hash`: *"use model_id and metrics as proxy for model content"*; `attestation.py`: `hash(model_id)`), so a true weights-content commitment is **net-new but moderate**: a utility that reads the stored artifact's weight files and produces a deterministic hash (canonical file ordering → per-file sha256 → Merkle root), wired into the baseline + candidate commitments. **Effort: small-to-medium, not a multi-week lift.** The one care item is *determinism*: hash the immutable stored weight tensors (e.g. `*.safetensors`/`*.bin`), **excluding** MLflow's timestamped wrapper metadata, and never re-serialize. Given it's not a ton of work and is expensive to retrofit, **include it now** (matches your inclination). Defer only if the determinism utility proves unexpectedly hard for a specific model type (the router uses a custom serializer — confirm it round-trips byte-stable).

## 10. Required follow-up doc updates (from review)

- [`deltaverifier-trust-model.md`](deltaverifier-trust-model.md): reviewer summary still describes the old trusted-submitter model — update once A1 is chosen. *(Pause-role wording corrected 2026-06-09.)*
- [`mainnet-custody-runbook.md`](mainnet-custody-runbook.md): add rows for attester-set custody, threshold changes, signer rotation, emergency removal, and human-signing rehearsal.
- [`mainnet-launch-token-parameter-lock.md`](mainnet-launch-token-parameter-lock.md): **HROUT mainnet `tokensPerDeltaOne` is 250,000 (owner-confirmed 2026-06-09) — the doc records 500,000; update/clarify the mainnet value.** Also add the planned per-mint `maxReward` (2.5M for HROUT) and starting per-model budget (1.5M for HROUT).

## 11. Cross-links

- [`docs/deltaverifier-trust-model.md`](deltaverifier-trust-model.md) — V1 trust model (assumed).
- [`docs/mainnet-custody-runbook.md`](mainnet-custody-runbook.md) — role custody / rotation.
- Linear: **HOK-2119** (security tracking) under epic **HOK-2053**.
