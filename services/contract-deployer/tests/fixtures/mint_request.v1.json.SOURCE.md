Upstream source: `hokusai-data-pipeline/schema/examples/mint_request.v1.json`

This fixture is vendored into `services/contract-deployer/tests/fixtures/` so the test suite
remains self-contained in CI and in isolated worktrees.

The conformance suite compares this file byte-for-byte against the sibling
`hokusai-data-pipeline/schema/examples/mint_request.v1.json` when that checkout is present.
If the upstream example changes, update this file and the sibling copy together so the bytes,
sha256, EIP-712 digest, and submit calldata all stay pinned.

Known-answer companion: `services/contract-deployer/tests/fixtures/mint_request.v1.known_answer.json`

Regeneration protocol: see `docs/cross-repo-fixture-protocol.md` and run
`node scripts/generate-mint-request-known-answer.js` after changing the fixture.

HOK-1730: Added top-level `totalSamples` (integer >= 1) to match the pipeline fixture.
The value equals `evaluation.sample_size_candidate` when that field is a positive integer.
