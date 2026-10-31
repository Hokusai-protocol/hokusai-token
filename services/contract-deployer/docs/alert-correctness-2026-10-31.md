# Mainnet alert correctness release — 2026-10-31

The release replaces the July deployment artifacts with the October deployment,
normalizes ethers v6 event payloads and pricing phases, and persists monitoring
incidents in Redis. Existing uncommitted RPC failback and monitoring changes are
preserved.

## Behavior

- Contract events wait for two confirmations by default, check receipt and block
  hashes, and use mined block timestamps and transaction/log identity. Removed
  or orphaned logs do not produce notifications. The October `PoolCreated` and
  `ParametersUpdated` signatures are supported alongside legacy signatures.
- Unexpected pauses remain critical. Unpause and state-condition recovery are
  informational. Critical notifications bypass volume limits; replayed chain
  events are deduplicated for seven days using transaction hash and log index.
- Pool incident state is checkpointed in Redis under a chain- and factory-scoped
  prefix. A task restart preserves pause first-observed time and active incident
  timestamps. Ongoing conditions can remind at most once every six hours. Closed
  incidents produce recovery notifications. Delivery failures release the
  notification claim and are retried on a later state sample. Email delivery and
  Redis commits are not a transaction; a crash between them can still replay an
  email. This is deliberately preferable to claiming exactly-once delivery.
- State reads use a single confirmed block. ERC20 total supply remains available
  for reporting, while the curve check uses `getReserves()` redeemable supply,
  live CRR, graduation supply, and anchor basis supply. For the anchored curve,
  the expected ratio is 1 below the effective anchor, and
  `w + (1-w)*(S/Sg)^(-1/w)` above it. Supplier unlocks rescale the anchor as in
  the deployed implementation. The check allows price quantization. It does not
  label every price inconsistency as unauthorized minting.
- Reserve-drop detection applies in bootstrap too. Absolute reserve minimums
  remain disabled for newly seeded pools.
- Email subjects/bodies include network, chain, and factory. CloudWatch emits
  both the existing Environment-only series (for existing alarms) and a series
  with Environment, ChainId, and Deployment dimensions.
- Mainnet requires Redis at startup, validates all configured monitoring and
  reconciliation addresses against `deployments/mainnet-monitoring.json`, and
  requires every expected proxy pool to be discovered and initialized. New pools
  from the same factory remain discoverable. Update the manifest with every
  redeploy; do not bypass the gate to accept unexplained drift.

## Optional planned maintenance

`MONITORING_MAINTENANCE_JSON` defaults to `[]`. To classify a planned pause as
informational, provide entries shaped as:

```json
[{"pool":"0x…","actors":["0x…"],"expiresAt":"2026-11-01T00:00:00Z"}]
```

Addresses must be valid, actors nonempty, and the expiry no more than 24 hours
in the future. Suppression applies only after a confirmed pause from an expected
actor on that exact pool. An unexpected actor remains critical and clears the
maintenance marker. Once the marker expires, persistent paused-state monitoring
escalates normally. No maintenance entries were enabled for this release.

`MONITORING_CONFIRMATIONS` defaults to 2, with a permitted range of 1–64. The
two-confirmation policy reduces reorg noise; it does not assert chain finality.

## Validation

TypeScript compilation and all 63 tests in the monitoring unit suite passed.
New regressions cover phase conversion, decimal cancellation, graduation and
anchored buys/sells, supplier unlocks, actual v6 payloads, reorg rejection,
persistent incidents and notifications, delivery failure retry, maintenance
scope, unpause severity, and bootstrap reserve drops. Production verification
must confirm a healthy ECS task, three expected proxies, new contract addresses,
numeric phase 0 for the flat pools, and no startup alert storm.
