Upstream source: `hokusai-data-pipeline/schema/examples/mint_request.v1.json`

This fixture is vendored into `services/contract-deployer/tests/fixtures/` so the test suite
remains self-contained in CI and in isolated worktrees.

The integration test prefers the sibling `hokusai-data-pipeline` copy when present and compares
it against this vendored copy to detect drift. If the upstream example changes, re-copy the file
from the path above so the two stay byte-identical.
