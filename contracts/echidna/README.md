## Echidna Harness Conventions

- Harnesses are additive and must not require production contract changes.
- Constructors should deploy their own isolated dependency graph.
- Public mutators should bound fuzzed inputs and tolerate expected reverts.
- Property functions use the `echidna_` prefix and return `bool`.
- Helper caller contracts are preferred for negative authorization checks because they preserve the helper as `msg.sender` at the target contract.
- Harnesses should keep their own accounting when the invariant depends on successful calls rather than raw attempted inputs.
- Long-running campaigns should reuse the shared `echidna.config.yaml` baseline unless the campaign explicitly needs a temporary override.
