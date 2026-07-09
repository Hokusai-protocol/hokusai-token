# Purchaser Whitelist Operations

AMM purchases are whitelist-gated by default. The shared whitelist address is stored in `deployments/<network>-latest.json` under `contracts.PurchaserWhitelist`.

## Sepolia commands

```bash
npm run whitelist:add:sepolia -- 0xYourWallet
npm run whitelist:remove:sepolia -- 0xYourWallet
npm run whitelist:check:sepolia -- 0xYourWallet
npm run whitelist:add:sepolia -- --batch ./wallets.json
```

Batch files must be JSON shaped like:

```json
{
  "addresses": ["0x1234...", "0xabcd..."]
}
```

## Mainnet commands

Mainnet purchaser whitelist changes should be handled as an admin operation. First verify who can mutate the deployed whitelist:

```bash
npm run whitelist:mainnet -- roles
```

If the admin Safe has `WHITELIST_ADMIN_ROLE`, generate a Safe Transaction Builder JSON for the initial wallet:

```bash
npm run whitelist:mainnet -- add 0xYourWallet --safe-tx --out deployments/mainnet-purchaser-whitelist-add-safe.json
```

Import the generated JSON into the admin Safe, review the target as `PurchaserWhitelist`, confirm chain ID `1`, simulate if available, and execute. Then verify:

```bash
npm run whitelist:mainnet -- check 0xYourWallet
```

For future batches:

```bash
npm run whitelist:mainnet -- add --batch ./wallets.json --safe-tx --out deployments/mainnet-purchaser-whitelist-add-safe.json
npm run whitelist:mainnet -- remove --batch ./wallets.json --safe-tx --out deployments/mainnet-purchaser-whitelist-remove-safe.json
```

If `roles` reports that the Safe does not have `WHITELIST_ADMIN_ROLE`, the Safe bundle will revert. Grant `WHITELIST_ADMIN_ROLE` to the Safe from the current default admin/whitelist admin first, then rerun the role check and generate the add bundle.

If the recorded deployer still has `WHITELIST_ADMIN_ROLE` and an immediate operational add is approved, sign the mutation with the KMS deployer explicitly:

```bash
npm run whitelist:mainnet -- add 0xYourWallet --use-deploy-signer
```

The default mainnet command is read-only; it will not sign unless `--use-deploy-signer` is present.

## Emergency override

If the deployment artifact is stale, set `WHITELIST_ADDRESS=0x...` before running the script. The scripts will print when the override is being used.

## Operational note

The currently deployed Sepolia HROUT pool cannot be retrofitted with a whitelist through the deployer because the factory owns the pool and does not expose a retrofit method. Immediate mitigation is to pause the affected pool or redeploy through the whitelist-enabled launch path.
