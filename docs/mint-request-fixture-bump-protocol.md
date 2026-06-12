# MintRequest Fixture Bump Protocol

When the MintRequest schema changes (new signed field, field rename, type change, or EIP-712 struct reordering), both the `hokusai-token` and `hokusai-data-pipeline` repos must update their fixtures, known-answers, and conformance tests in lockstep.

## SECURITY

The committed signatures, private keys, and known-answer digests in this repo's test fixtures are **test-only artifacts** derived from Hardhat's canonical mnemonic (`test test test test test test test test test test test junk`). They have zero value on any network. They exist so anyone can regenerate the conformance artifacts deterministically.

## When to bump

A bump is required when any of the following change:

- A field is added, removed, or renamed in the EIP-712 `MintRequest`, `MintRequestPayload`, `BenchmarkAnchors`, or `Contributor` structs.
- A field's Solidity type changes (e.g., `uint256` → `int256`).
- The EIP-712 domain name or version string changes.
- The pipeline's JSON wire format changes (new field, field rename, value encoding).
- The consumer's `buildPayload` or `buildContributors` mapping logic changes.

## Step-by-step protocol

### 1. Pipeline repo (hokusai-data-pipeline)

1. Update `schema/examples/mint_request.v1.json` with the new field/format.
2. Regenerate the pipeline's known-answer (if the pipeline has one).
3. Open a PR with the updated fixture and known-answer.

### 2. Token repo (hokusai-token)

1. Update the EIP-712 types in `shared/mint-request-eip712.js` (single source of truth).
2. If the Solidity struct changed, update `contracts/DeltaVerifier.sol` typehashes.
3. Update `test/fixtures/deltaverifier-mint-request.golden.json` (camelCase contract-side fixture).
4. Copy the updated pipeline fixture to `services/contract-deployer/tests/fixtures/mint_request.v1.json` (must be byte-identical to the pipeline copy).
5. Regenerate the known-answer:
   ```bash
   npm run conformance:regen
   ```
6. Run conformance tests:
   ```bash
   npx hardhat test test/conformance/golden-fixture.test.js
   npm test --prefix services/contract-deployer -- --testPathPattern='golden-fixture-parity'
   ```
7. Open a PR with all updated files.

### 3. Landing window

Both PRs must land within the same 24-hour window. If only one side lands:

- The **scheduled cross-repo workflow** (`conformance-cross-repo.yml`, runs daily at 06:00 UTC) will detect the drift.
- On failure, it automatically files a GitHub issue with labels `p0,seam-drift`.
- The on-call team should resolve the drift by landing the partner PR.

## Files that change in each repo

### Token repo

| File | Change |
|------|--------|
| `shared/mint-request-eip712.js` | EIP-712 types (add/remove/rename fields) |
| `shared/mint-request-eip712.ts` | TS mirror (keep in sync with JS) |
| `test/fixtures/deltaverifier-mint-request.golden.json` | camelCase contract-side fixture |
| `test/fixtures/deltaverifier-mint-request.known-answer.json` | Regenerated via `npm run conformance:regen` |
| `services/contract-deployer/tests/fixtures/mint_request.v1.json` | Byte-identical copy of pipeline fixture |
| `services/contract-deployer/src/schemas/mint-request-schema.ts` | Joi schema (if wire format changes) |
| `services/contract-deployer/src/services/mint-request-processor.ts` | `buildPayload`/`buildContributors` mapping |
| `contracts/DeltaVerifier.sol` | Typehash constants + struct definitions |

### Pipeline repo

| File | Change |
|------|--------|
| `schema/examples/mint_request.v1.json` | Canonical pipeline fixture |
| `schema/mint_request.v1.schema.json` | JSON Schema (if applicable) |
| Pipeline known-answer file | Regenerated via pipeline's regen command |

## Reviewer checklist

- [ ] Typehashes in `DeltaVerifier.sol` match the updated `shared/mint-request-eip712.js`
- [ ] `npm run conformance:check` passes (known-answer matches regen)
- [ ] Vendored fixture is byte-identical to the pipeline copy
- [ ] Known-answer `structHash` and `typedDataDigest` are both regenerated
- [ ] Committed signatures verify against the known-answer digest
- [ ] Mutation matrix covers the new field (auto if field is in EIP-712 types)
- [ ] Consumer `buildPayload` maps the new field correctly
- [ ] Joi schema validates the new field

## CI jobs that enforce this protocol

| Job | Repo | Trigger | What it checks |
|-----|------|---------|---------------|
| `conformance` | token | Every PR + push to main | Known-answer freshness, Hardhat A+C, consumer A+B |
| `conformance-cross-repo` | token | Daily cron + manual dispatch | Full matrix including byte parity against pipeline |
| Pipeline CI | pipeline | Every PR + push to main | Pipeline digest against committed known-answer |
