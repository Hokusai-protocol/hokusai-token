# Gate 9 — Operational drills runbook (HOK-2178)

Each drill below is **executed + timed on Sepolia**, and the results table filled in, before mainnet.
The contract-level mechanism behind drills 1 and 3 is proven deterministically on every CI run by
`test/drills/gate9-ops-drills.test.js` (pause halts/restores minting + exactly-once replay; attester
rotation new-key-mints / removed-key-reverts / backup-signs), so the live drill measures wall-clock
and operational fit, not contract behavior.

## Drill 1 — pause kill-switch latency
- **Mechanism (CI):** pause() halts minting without burning idempotency; unpause() restores; replay settles once.
- **Live:** `set -a; . ./.env.sepolia; set +a; node scripts/drills/pause-drill.js` — times submit→`paused()==true` and unpause→resumed using the PAUSER key. Record the detection→decide legs (operator/automation) separately.
- **Budget to set:** detection→paused wall-clock target (e.g. < 15 min). Verify queued-during-pause messages settle exactly once on resume (the consumer replays; idempotency guarantees once).
- **Decision this forces:** the designated pause path — hot PAUSER key vs Safe. (PAUSER must act faster than the budget drain rate.)

## Drill 2 — DeltaOneAccepted anomaly → alert (and, if enabled, auto-pause)
- Trigger each: (a) unusually large reward, (b) unknown-recipient pattern, (c) burst rate > N mints/hr, (d) any legacy-entrypoint call or `AttesterAdded`/`ThresholdChanged`/param-change event. Each must page within its SLA.
- **GAP:** the monitoring service (`services/contract-deployer/src/monitoring/`) is email-only (SES) and **read-only — no auto-pause wiring**. This drill needs (i) the anomaly alerts built/tuned (HOK-1698) and (ii) a decision on AUTO_PAUSE (alert-only → automated pause). Alerts that don't exist get built, not waived.

## Drill 3 — attester rotation under threshold (+ lost-device)
- **Mechanism (CI):** add-new → remove-old keeps threshold met; new key mints, removed key reverts `SignerNotAttester`; a pre-registered backup signs with zero downtime.
- **Live (Sepolia):** rotate via the Gate-8 tooling — edit `scripts/configs/sepolia-launch-posture.json` `expectedAttesters`/`attesterThreshold`, then `npm run init:launch-posture:sepolia` (plan) and `... -- --execute` (apply), `npm run verify:launch-posture:sepolia` to confirm. Then submit one mint signed by the new key (succeeds) and one by the removed key (reverts).
- **Lost-device answer:** with a backup attester pre-registered (threshold 1), restore time is **zero** — the backup signs immediately. Decide whether to pre-register a backup (see HOK-1694 attester-redundancy decision).

## Drill 4 — DLQ replay
- Use the HOK-2173 tooling (`services/contract-deployer/scripts/dlq.ts`, built): `list → inspect <key> → replay <key> --execute` against a real Sepolia DLQ entry (the Gate-7 budget-exhaustion entry if <12h old, else synthesize one). Confirm exactly one settlement.
- Replay re-validates against live state (idempotency unburned, budget available, lineage current) and **refuses** `signer_not_attester` entries. Triage one forged-message DLQ entry as a security event — documented decision path, **not** replayed.

## Drill 5 — key-compromise tabletop (paper)
- (a) Submitter key stolen → revoke/grant `SUBMITTER_ROLE`; bounded exposure (attacker needs validly-signed unsubmitted requests). (b) Attester key stolen → pause, `removeAttester`, assess exposure window vs per-model budget cap. Output: decision tree with named owners in this runbook.

## Results (fill on execution)

| Drill | Date | Operator(s) | Measured | Budget/SLA | Deviations / fixes filed |
|---|---|---|---|---|---|
| 1 pause latency | | | pause __s / unpause __s; detection→paused __ | < 15 min | |
| 2 anomaly alerts | | | a/b/c/d page latency | per-alert SLA | (alerts to build: HOK-1698) |
| 3 attester rotation | | | rotate __; new-key mint ✓ / old-key revert ✓; backup restore __ | zero-downtime | |
| 4 DLQ replay | | | list/inspect/replay → 1 settlement | | forged-entry triaged, not replayed |
| 5 key-compromise | | | tabletop walked | | decision tree + owners recorded |

## Cross-issue dependencies
- **HOK-1698** — deploy monitoring + build/tune the Drill-2 anomaly alerts; decide alert channels (today: email/SES only).
- **HOK-1694** — attester-redundancy decision (backup attester?) feeds Drill 3's lost-device answer; pause-path (hot key vs Safe) feeds Drill 1.
- **AUTO_PAUSE** — not yet wired; Drill 2's automated-pause leg depends on the rollout decision (recommend phased: alert-only → auto).
