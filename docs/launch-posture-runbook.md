# Launch Posture Runbook

`init-launch-posture.js` applies the DeltaVerifier launch configuration drift that is still manual in the deployment checklist: legacy mint disablement, attester registry, reward parameters, per-model mint budgets, and model lineage genesis roots.

Use `verify-launch-posture.js` as the final gate. It reads the on-chain deployment and the expected network JSON, emits a saved report under `deployments/launch-posture-<network>-*.json`, and exits non-zero with a human-readable diff on any mismatch.

> ## Invocation gotcha: `--execute` / `--safe-txs` flags (read first)
>
> `npm run init:launch-posture:<network>` runs a **dry run only** — the npm script
> cannot forward extra flags. Passing them through `hardhat run` (e.g.
> `npx hardhat run scripts/init-launch-posture.js --network sepolia -- --execute`)
> fails with **`HH305: Unrecognized param --`** on the current Hardhat version.
>
> To actually apply changes, run the script directly with `node` and select the
> network via `HARDHAT_NETWORK` so `process.argv` reaches the script:
>
> ```bash
> HARDHAT_NETWORK=sepolia node scripts/init-launch-posture.js --execute
> HARDHAT_NETWORK=mainnet node scripts/init-launch-posture.js --safe-txs <path>   # --execute is rejected on mainnet
> ```
>
> The init script is **idempotent**: it computes the plan from current on-chain
> state, so re-running after a partial/failed apply only does the remaining actions.

## Full clean-deploy rehearsal sequence (Sepolia)

This is the ordering proven by the HOK-1695 rehearsal. The critical point: on a
**fresh** deployment the `ModelRegistry` is empty, so `init-launch-posture` reverts
with **`Model not registered`** on `setWeightGenesis` unless the launch tokens are
created first. Token/model registration must run **between** the infra deploy and
posture init.

```bash
# 0. Prereq: .env.sepolia must NOT contain a stub DEPLOYER_PRIVATE_KEY (e.g. `0x...`).
#    Signing is via KMS (KMS_DEPLOYER_KEY_ID); a too-short stub crashes Hardhat config
#    loading with "private key too short". Leave it unset/commented.

# 1. Deploy the full infra stack -> deployments/sepolia-latest.json
npm run deploy:sepolia

# 2. Create the three launch tokens + pools and REGISTER the models.
#    Reads scripts/configs/sepolia-launch-tokens.json; merges into sepolia-latest.json.
npm run launch:sepolia:test-tokens

# 3. Apply launch posture (attesters, threshold, per-model budget, weight genesis,
#    setMaxReward -> 2.5M, disableLegacyMints). Dry run first, then execute.
npm run init:launch-posture:sepolia                                    # dry run / plan
HARDHAT_NETWORK=sepolia node scripts/init-launch-posture.js --execute  # apply

# 4. Final gate — must print "PASS: launch posture matches expected config".
npm run verify:launch-posture:sepolia

# 5. Etherscan verification (HOK-1700) — requires ETHERSCAN_API_KEY in .env.sepolia.
npx hardhat run scripts/verify-all-contracts.js --network sepolia
```

## Mainnet flow

1. Update `scripts/configs/mainnet-launch-posture.json` with the real relayer, attester, and model `expectedWeightGenesis` values.
2. Deploy infra (`npm run deploy:mainnet`) and create the launch tokens/pools so the models are registered **before** posture init (same ordering as Sepolia step 2).
3. Run `npm run init:launch-posture:mainnet` for a dry run.
4. Emit Safe Transaction Builder JSON with `HARDHAT_NETWORK=mainnet node scripts/init-launch-posture.js --safe-txs <path>` and submit via the admin Safe. (`--execute` is intentionally rejected on mainnet.)
5. Run the governance handoff flow.
6. Run `npm run verify:launch-posture:mainnet` and require a passing report before launch.

## Sepolia flow

`npm run verify:launch-posture:sepolia` is expected to fail until Sepolia is configured to the intended launch posture. Treat the failing diff as the work order.

### How the rehearsal was wired

1. Compute the rehearsal Model 30 genesis from [test/fixtures/sepolia-rehearsal-model-30.json](../test/fixtures/sepolia-rehearsal-model-30.json) with `node scripts/compute-weight-genesis.js --fixture test/fixtures/sepolia-rehearsal-model-30.json`.
2. Apply Sepolia posture changes with the `node ... --execute` invocation above (see the gotcha note); execute only through the Gate 8 init script.
3. Verify the resulting state with `npm run verify:launch-posture:sepolia`; the committed [launch-posture-sepolia-latest.json](../deployments/launch-posture-sepolia-latest.json) snapshot is the expected post-init report.
4. Run the weekly canary through [.github/workflows/sepolia-canary.yml](../.github/workflows/sepolia-canary.yml), which now signs the attestation with the KMS deployer key and submits the transaction with the KMS backend key.

See [mint-authority-launch-gate.md](mint-authority-launch-gate.md) for the rehearsal record and operator notes.
