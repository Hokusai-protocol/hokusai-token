# HOK-2248 — Live contributor-reward drill (canary model 930, Sepolia)

The repeatable CI proof lives in `test/e2e/contributor-reward-e2e.test.js` (both cases on a local
chain). This runbook is the **live Sepolia** counterpart: it drives the same two cases against the
deployed canary model **930** (never Model 30), using the existing reconcile-drill harness plus the
escrow-release helper. Signing is on the **0x07bf Ledger** attester; submitting/releasing use the
**backend KMS key** (`0xbe26…`, holds `RELEASER_ROLE`).

## 0. Readiness (read-only)

```bash
node scripts/canary-reward-drill-readiness.js
```

Confirms canary 930 token/genesis/budget, the Ledger attester + threshold, the vesting vault wiring,
and the escrow deployment + backend `RELEASER_ROLE`. As of last run: **ALL READY** —

| item | value |
|------|-------|
| canary token (930) | `0x1075620e50f9f52044a0a23f0578dCBCE010771b` |
| DeltaVerifier | `0x867E61c9D4ccF1419180B3257314fa8CEb2D27a6` |
| RewardVestingVault | `0xFE5407b6E313Fba105F48454fAB88611Ae42B87c` |
| PendingClaimsEscrow | `0x46779C8eA22A9554cD53346bE382558F0d7EdEC0` |
| attester (Ledger) | `0x07bf9b22f516d2D464511219488F019c5dFF5335` |
| releaser (backend KMS) | `0xbe2640bB22ae79f0d611aC727036fEBcFB7acf0c` |

Load env once per shell: `set -a; . ./.env.sepolia; set +a; export HARDHAT_NETWORK=sepolia`.

## Case (a) — registered-wallet contributor

The mint pays a wallet directly (10% liquid now + 90% into a vesting schedule if canary vesting is on).

```bash
# build (default recipient is the controlled wallet 0xAfA9; override with DRILL_RECIPIENT=0x<wallet>)
node scripts/deltaone-reconcile-drill.js build
# -> prints the EIP-712 digest + saves deployments/gate7-part1-pending.json

npm run gate7:sign                     # sign the digest on the 0x07bf Ledger; copy the 0x signature

node scripts/deltaone-reconcile-drill.js submit 0x<sig>   # KMS backend submits; asserts DeltaOneAccepted + head advance
```

**Verify:** recipient wallet `balanceOf` increased; if vesting is enabled,
`RewardVestingVault.getSchedulesByBeneficiary(wallet)` returns a new schedule (90% leg); lineage head
advanced to the new candidate; the detector run reconciles clean against the payout intent.
**Optional:** later, the wallet calls `RewardVestingVault.claim(scheduleId)` to pull matured vesting.

## Case (b) — no-wallet contributor → escrow → release

The mint pays the **escrow** (the route the orchestrator uses for accounts without a verified wallet);
the tranche is preserved, then released to a wallet once one is verified.

```bash
# build with the escrow as the recipient
DRILL_RECIPIENT=0x46779C8eA22A9554cD53346bE382558F0d7EdEC0 node scripts/deltaone-reconcile-drill.js build

npm run gate7:sign                     # sign on the Ledger; copy the 0x signature

node scripts/deltaone-reconcile-drill.js submit 0x<sig>   # mints into the escrow
```

**Verify after submit:** `PendingClaimsEscrow.tokenBalance(canaryToken)` increased by the liquid
tranche; `RewardVestingVault.getSchedulesByBeneficiary(escrow)` has a schedule (90% leg, beneficiary =
escrow).

**Release** (stand-in for auth's auto-release-on-verification, since the drill has no auth account):

```bash
RELEASE_TO=0x<verified-wallet> node scripts/canary-escrow-release.js
# releases the escrow's full canary-token balance to the wallet; asserts the wallet balance delta.
```

**Negative control:** a release from any key without `RELEASER_ROLE` reverts (the backend key is the
only grantee). The contract-level guard is covered by `test/PendingClaimsEscrow.test.js` and the E2E
test; on-chain you can confirm by attempting `release` from a non-releaser key and observing the revert.

## Notes / prerequisites

- **Detector reconcile (case b):** the escrow address must be registered in `deltaone_system_sinks` so
  the anomaly detector treats the escrow mint as a system sink (not an unauthorized payout). See the
  note recorded by `scripts/grant-releaser-role.js`.
- **Vesting split:** whether case (a)/(b) shows a 10/90 split depends on the canary token's vesting
  config. The split logic itself is proven deterministically in the E2E test; the live drill proves the
  real chain accepts the attested mint and routes funds to the wallet/escrow.
- **Production trigger:** in production the case-(b) release fires automatically when a wallet is
  verified (auth-service `WalletVerificationService`); `canary-escrow-release.js` is only the manual
  operational equivalent for the drill.
- **Env for submit/release:** `RPC_URL`, `KMS_BACKEND_KEY_ID`, `KMS_BACKEND_EXPECTED_ADDRESS`,
  `AWS_REGION`, AWS creds (`kms:Sign` on the backend key; `dynamodb:PutItem` on the payout-intent table
  for the reconcile leg).
