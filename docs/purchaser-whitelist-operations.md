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

## Emergency override

If the deployment artifact is stale, set `WHITELIST_ADDRESS=0x...` before running the script. The scripts will print when the override is being used.

## Operational note

The currently deployed Sepolia HROUT pool cannot be retrofitted with a whitelist through the deployer because the factory owns the pool and does not expose a retrofit method. Immediate mitigation is to pause the affected pool or redeploy through the whitelist-enabled launch path.
