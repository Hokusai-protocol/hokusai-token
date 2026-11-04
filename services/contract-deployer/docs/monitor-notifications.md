# Monitor notification policy

Testnet emits metrics and logs but sends no direct application emails at any priority. Its independent infrastructure evaluator sends a noncritical notice after 24 continuous hours without coverage, including a stopped task. Mainnet coverage outages notify after five minutes. Healthy backup operation is silent; mainnet primary-only degradation warns once after 30 minutes. Two minutes of verified recovery resolves only previously emailed incidents.

Set `MONITORING_OUTAGE_NOTIFICATION_OWNER=external` when the independent evaluator takes ownership of mainnet outage notifications. During shadow rollout leave mainnet ownership at `application`. Security and financial mainnet alerts retain their existing SES path. Set `NETWORK=mainnet`, `HOKUSAI_ENVIRONMENT=production` on mainnet and `NETWORK=sepolia`, `HOKUSAI_ENVIRONMENT=development` on testnet so scoped metrics match the evaluator targets. Do not mute legacy alarm actions until scoped coverage is verified.

Coverage includes every discovered pool's fresh state reads and confirmed log reconciliation. Quiet pools remain healthy. Reconciliation uses persistent Redis checkpoints, a 12-block overlap, bounded 500-block requests and at most 2,000 blocks per pool per heartbeat; recovery waits for complete catch-up. A new enrollment begins 12 blocks before the confirmed head. Seed the scoped `event-checkpoint:<pool>` through IncidentStore when older history is required. Failed contract reads, replay or initialization must not declare coverage recovered. ECS monitor readiness follows the active provider; separate signer/deployment readiness still checks its own RPC.

The full [infrastructure runbook](https://github.com/Hokusai-protocol/hokusai-infrastructure/blob/main/docs/monitor-notifications.md) covers imports, shadow/live ownership, target configuration, delivery limits and rollback. Existing process changes are not a deployment: build and validate an immutable image, then cut over testnet before mainnet.


HTTP backup traffic is serialized with at least 400 ms between requests, with bounded retry for
Infura JSON-RPC rate-limit responses. The provider detects its fixed chain once and retains the
chain-ID check at promotion. On the paced backup, confirmed log reconciliation replaces duplicate
per-event subscriptions; replayed trades/fees explicitly refresh pool state. Factory inventory and
five-minute fallback state reads remain enabled. WebSocket primary behavior is unchanged.
