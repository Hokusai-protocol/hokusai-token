# Test Fixtures

## mint_request.v1.json

This file is a **vendored copy** of the canonical data pipeline v1 MintRequest example. It must remain structurally identical to the upstream source to enable drift detection.

**Upstream source**: `hokusai-data-pipeline/schema/examples/mint_request.v1.json`

**Sync requirement**: When the upstream fixture changes, update this vendored copy to match. The contract-deployer integration test (`tests/integration/mint-request-flow.test.ts`) validates structural equality (via JSON deep comparison) and emits a clear re-sync message on mismatch.
