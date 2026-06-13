# Launch Posture Runbook

`init-launch-posture.js` applies the DeltaVerifier launch configuration drift that is still manual in the deployment checklist: legacy mint disablement, attester registry, reward parameters, per-model mint budgets, and model lineage genesis roots.

Use `verify-launch-posture.js` as the final gate. It reads the on-chain deployment and the expected network JSON, emits a saved report under `deployments/launch-posture-<network>-*.json`, and exits non-zero with a human-readable diff on any mismatch.

## Mainnet flow

1. Update `scripts/configs/mainnet-launch-posture.json` with the real relayer, attester, and model `expectedWeightGenesis` values.
2. Run `npm run init:launch-posture:mainnet` for a dry run.
3. Run `npx hardhat run scripts/init-launch-posture.js --network mainnet -- --execute` to apply the changes, or `--safe-txs <path>` to emit Safe Transaction Builder JSON.
4. Run the governance handoff flow.
5. Run `npm run verify:launch-posture:mainnet` and require a passing report before launch.

## Sepolia flow

`npm run verify:launch-posture:sepolia` is expected to fail until Sepolia is configured to the intended launch posture. Treat the failing diff as the work order.

### How the rehearsal was wired

1. Compute the rehearsal Model 30 genesis from [test/fixtures/sepolia-rehearsal-model-30.json](../test/fixtures/sepolia-rehearsal-model-30.json) with `node scripts/compute-weight-genesis.js --fixture test/fixtures/sepolia-rehearsal-model-30.json`.
2. Apply Sepolia posture changes with `npm run init:launch-posture:sepolia` and execute only through the Gate 8 init script.
3. Verify the resulting state with `npm run verify:launch-posture:sepolia`; the committed [launch-posture-sepolia-latest.json](../deployments/launch-posture-sepolia-latest.json) snapshot is the expected post-init report.
4. Run the weekly canary through [.github/workflows/sepolia-canary.yml](../.github/workflows/sepolia-canary.yml), which now signs the attestation with the KMS deployer key and submits the transaction with the KMS backend key.

See [mint-authority-launch-gate.md](mint-authority-launch-gate.md) for the rehearsal record and operator notes.
