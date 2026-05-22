# Canonical Model Registration

## Decision

`uint256 modelId` is the canonical on-chain model identity.

- `ModelRegistry.registerModel(uint256, address, string)` is the authoritative write path.
- `ModelRegistry.registerStringModel(string, address, string)` is retained for ABI compatibility, but it now accepts only decimal strings and writes the same canonical numeric slot.
- `DeltaVerifier`, `TokenManager` launch flows, and AMM setup now converge on the same registry state.

## Why

Previously, Sepolia launches could succeed through the string registry path while `DeltaVerifier.submitMintRequest` still failed because it validated the numeric registry path. That produced launched, tradable tokens which could not process MintRequests.

## Runtime invariants

For a launched model `id`:

- `isRegistered(id)` must be `true`
- `isStringRegistered(String(id))` must be `true`
- `getTokenAddress(id)` must equal `getStringToken(String(id))`
- `DeltaVerifier` rejects drift between the canonical registry token and `TokenManager.getTokenAddress(String(id))`

## Launch implications

Launch scripts now register models canonically before pool creation:

1. Deploy token through `TokenManager`
2. Register via `ModelRegistry.registerModel(uint256, token, metric)`
3. Verify numeric and string-compatible reads
4. Create the AMM pool

This prevents creating a token + pool without satisfying DeltaVerifier registration requirements.

## Canonical pool registration

AMM pool registration is now canonical at the contract layer:

- `HokusaiAMMFactory.createPoolWithParams(...)` writes the deployed pool into `ModelRegistry.modelPools`
- stack deployment authorizes `HokusaiAMMFactory` as a `ModelRegistry` pool registrar
- pool creation is atomic: if registry registration fails, the entire pool creation reverts

Launch scripts may still perform an idempotent verification/fallback check, but they are no longer the source of truth for `ModelRegistry.getPool(modelId)`.

## Sepolia backfill

This remains a one-time remediation for the May 20, 2026 Sepolia deployment before canonical pool registration was enforced during pool creation.

Use the idempotent script in this order:

1. `node scripts/backfill-canonical-registration.js --dry-run --network sepolia`
2. Verify the planned writes for models `27`, `28`, and `30`
3. `node scripts/backfill-canonical-registration.js --network sepolia`
4. `SEPOLIA_E2E_READONLY=1 npm run e2e:sepolia:tokens`
5. `npm run e2e:sepolia:mintrequest`

The script aborts if the string registry and `TokenManager` disagree about the token address for a model.

## Existing Sepolia models

- `27`: already numerically registered during earlier Sepolia recovery work
- `28`: requires canonical backfill if numeric registration is missing
- `30`: requires canonical backfill if numeric registration is missing

## Model 30 symbol note

Model `30` is the launch slot referenced in issue HOK-1776 and should use symbol `HROUT` going forward. Current Sepolia observations indicate the deployed token at that slot reports symbol `HTASK`; treat that token as a superseded rehearsal artifact and replace it before final rehearsal signoff.

## Mainnet implications

No protocol ABI migration is required. Future launches use the canonical numeric registration path directly. Any already-written numeric registrations are additive and safe to keep.
