Upstream source: `hokusai-data-pipeline/schema/examples/mint_request.v1.json`

This fixture is vendored into `services/contract-deployer/tests/fixtures/` so the test suite
remains self-contained in CI and in isolated worktrees.

The integration test prefers the sibling `hokusai-data-pipeline` copy when present and compares
it against this vendored copy to detect drift. If the upstream example changes, re-copy the file
from the path above so the two stay byte-identical.

HOK-1730: Added top-level `totalSamples` (integer >= 1) to match the pipeline fixture.
The value equals `evaluation.sample_size_candidate` when that field is a positive integer.

Gate 6 (HOK-2175): `attester_signatures` now contains a real EIP-712 signature from Hardhat's
test signer[2] (0x3C44...93BC) over the canonical golden fixture under the pinned conformance
domain (chainId=31337, verifyingContract=<deterministic DeltaVerifier deploy address>).
The vendored copy must be byte-identical to the pipeline's upstream copy. See
`docs/mint-request-fixture-bump-protocol.md` for the update protocol.
