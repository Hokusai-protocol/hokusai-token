# RPC failback canary

Use this runbook after the Infura quota has reset. Do not deploy the failback image while the
configured backup is known to reject requests.

## Preconditions

- Confirm both Alchemy and Infura return the expected chain ID and a current block.
- Confirm Infura no longer returns `-32005` / `Too Many Requests`.
- Keep Alchemy configured as `RPC_URL` / `MAINNET_RPC_URL` and Infura as `BACKUP_RPC_URL`.
- Build and push an immutable image; do not update the mutable `latest` tag.

## Testnet canary

1. Register a new testnet task revision using the immutable image digest.
2. Retain `/health/monitor-ready` as the ECS health check.
3. Keep the deployment circuit breaker enabled with rollback.
4. Wait for the rollout to reach `COMPLETED` and for the task to become ECS `HEALTHY`.
5. Confirm startup selects the Alchemy WebSocket provider and does not log a backup rebind.
6. Confirm `Heartbeat`, `IngestionHealthy`, and `RedisReady` are `1`.
7. Confirm `UsingBackupProvider` is `0` on every heartbeat.
8. Confirm bootstrap discovery emits no `New pool created` alert.

A forced provider transition should only be run through a reversible fault proxy or equivalent
canary-only mechanism. Do not edit a shared SSM parameter to force a running production task onto a
different provider. The expected transition is:

1. Alchemy failure produces an ingestion error and a rebind to Infura.
2. `UsingBackupProvider` changes to `1`.
3. Alchemy probes succeed on the correct chain and are no more than three blocks behind.
4. After at least five minutes and three consecutive successful probes, all listeners rebind to a
   fresh Alchemy WebSocket provider.
5. `UsingBackupProvider` returns to `0` and `rpc_primary_recovered` is emitted.

## Alarm and mainnet promotion

- Create a CloudWatch alarm on `UsingBackupProvider` with the matching `Environment` dimension.
- Alarm when the maximum value is greater than `0` for five consecutive one-minute periods.
- Treat missing data as `notBreaching`; monitor liveness and dependency alarms already cover
  missing metrics.
- Promote the exact testnet image digest to mainnet with circuit-breaker rollback.
- Verify the same provider, readiness, metric, and bootstrap-alert checks before closing the rollout.
