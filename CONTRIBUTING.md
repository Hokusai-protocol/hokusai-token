# Contributing

## Mint-request fixture changes

If you change the MintRequest schema, EIP-712 types, or the wire format between the pipeline and token repos, you must follow the **fixture bump protocol** to keep both repos' conformance tests aligned.

See [`docs/mint-request-fixture-bump-protocol.md`](docs/mint-request-fixture-bump-protocol.md) for the full protocol, file list, and reviewer checklist.

Quick summary:

1. Update `shared/mint-request-eip712.js` (single source of truth for EIP-712 types).
2. Update both golden fixtures and the vendored pipeline copy.
3. Run `npm run conformance:regen` to regenerate the known-answer file.
4. Run conformance tests: `npx hardhat test test/conformance/golden-fixture.test.js`.
5. Open paired PRs in both repos within the same 24-hour window.
