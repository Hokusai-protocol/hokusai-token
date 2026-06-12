# DLQ Replay Runbook

Use `npx tsx scripts/dlq.ts` to inspect and act on `hokusai:mint_requests:dlq`.

Common commands:

- `npx tsx scripts/dlq.ts list`
- `npx tsx scripts/dlq.ts inspect #0`
- `npx tsx scripts/dlq.ts replay 0x...`
- `npx tsx scripts/dlq.ts replay #3 --execute`
- `npx tsx scripts/dlq.ts discard #3 --reason "lineage advanced" --execute`

Safety rules:

- `replay` and `discard` are dry-run by default. Add `--execute` to mutate Redis.
- Replay keeps the original message verbatim except for removing `_retryCount` before re-enqueue.
- Every replay and discard writes an audit record to `hokusai:mint_requests:dlq:audit` unless `MINT_DLQ_AUDIT_KEY` overrides it.
- `signer_not_attester` entries are security events. Do not replay them.

Operator workflow:

1. Run `list` to find the entry.
2. Run `inspect` to confirm the current on-chain state:
   - `processed=true` means the mint already landed.
   - `mintBudgetRemaining` shows current budget.
   - `modelWeightHead` must match `baseline_commitment` for replay.
3. Run `replay ... --execute` only when the key is still unprocessed and lineage matches.
4. Use `discard ... --reason "<why>" --execute` to archive entries that should never be replayed.
