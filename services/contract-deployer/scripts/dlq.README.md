# MintRequest DLQ Replay CLI

Use `npm run dlq -- <command>` from `services/contract-deployer`.

## Configuration

Required for `inspect` and `replay`:

- `REDIS_URL` defaults to `redis://localhost:6379`
- `RPC_URL` defaults to `http://localhost:8545`
- `DELTA_VERIFIER_ADDRESS`
- `MODEL_REGISTRY_ADDRESS`

Queue overrides:

- `MINT_REQUEST_QUEUE` or `INBOUND_QUEUE`, default `hokusai:mint_requests`
- `MINT_REQUEST_DLQ` or `DLQ_QUEUE`, default `hokusai:mint_requests:dlq`
- `DLQ_ARCHIVE_QUEUE`, default `<dlq>:archive`

## Workflow

1. `npm run dlq -- list`
2. `npm run dlq -- inspect <id>`
3. If the decision is `ALLOWED`, run `npm run dlq -- replay <id>` to dry-run.
4. Run `npm run dlq -- replay <id> --execute` only after confirming the dry-run output.
5. Use `npm run dlq -- discard <id> --reason=<text> --execute` for entries that should not be replayed.

All mutating commands are dry-run by default. The CLI only acts with `--execute`.

## Failure Classes

- `budget_exhausted`: replayable after a Safe `topUpMintBudget` is confirmed. Inspect first; replay refuses if the idempotency key is already processed, the model lineage head moved, or budget is still zero.
- `unknown_outcome`: inspect shows whether the transaction actually landed. If `processed=true`, discard with a reason such as `already-minted`; replay is refused.
- `forgery_suspect`, schema failures, and signature-invalid messages: do not replay. Discard only after routing the entry through security triage.
- `model_inactive` and other permanent failures: do not replay without admin investigation.

## Payload Integrity

Replay preserves every signed MintRequest field verbatim. The only removed field is `_retryCount`, which is consumer scratch state and is not part of the EIP-712 payload.

## Audit Trail

`discard --execute` archives the exact raw DLQ entry to `hokusai:mint_requests:dlq:archive` before removing it from the DLQ. There is no silent delete path.
