# Cross-Repo MintRequest Fixture Protocol

This protocol keeps the MintRequest seam between `hokusai-token` and `hokusai-data-pipeline` fail-closed.

## Rule

A MintRequest schema, wire-format, or EIP-712 signing change requires paired PRs in both repos. The fixture and known-answer files must stay byte-identical across repos.

## Token repo flow

1. Update `services/contract-deployer/tests/fixtures/mint_request.v1.json`.
2. Run `node scripts/generate-mint-request-known-answer.js`.
3. Commit both:
   - `services/contract-deployer/tests/fixtures/mint_request.v1.json`
   - `services/contract-deployer/tests/fixtures/mint_request.v1.known_answer.json`
4. Confirm `npx hardhat test test/conformance/*.js` and `cd services/contract-deployer && npm test -- --ci tests/unit/blockchain/golden-fixture-parity.test.ts tests/integration/mint-request-flow.test.ts` are green.

## Pipeline repo flow

1. Copy the exact fixture bytes into `schema/examples/mint_request.v1.json`.
2. Copy the exact known-answer bytes into `schema/examples/mint_request.v1.known_answer.json`.
3. Run the pipeline-side conformance tests that assert schema validity, byte parity, and EIP-712 digest parity.

## Merge protocol

1. Open paired PRs in `hokusai-token` and `hokusai-data-pipeline`.
2. Merge both PRs on the same business day.
3. If one PR lands first, the scheduled cross-repo workflow is expected to fail until the other repo catches up.

## Hard requirements

- Do not hand-edit `mint_request.v1.known_answer.json`.
- If the EIP-712 domain, primary type, field set, field order, or field types change, regenerate the known-answer file in the same PR.
- If the Solidity typehash changes, the fixture bump and known-answer regeneration must happen in the same paired PR set.

## Paired-PR contract for `hokusai-data-pipeline`

The paired pipeline PR must add or update:

- `schema/examples/mint_request.v1.json`
- `schema/examples/mint_request.v1.known_answer.json`
- the Python digest-parity implementation and tests
- the blocking pipeline conformance workflow
