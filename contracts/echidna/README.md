## Echidna Harness Conventions

- Harnesses are additive and must not require production contract changes.
- Constructors should deploy their own isolated dependency graph.
- Public mutators should bound fuzzed inputs and tolerate expected reverts.
- Property functions use the `echidna_` prefix and return `bool`.
- Helper caller contracts are preferred for negative authorization checks because they preserve the helper as `msg.sender` at the target contract.
- Harnesses should keep their own accounting when the invariant depends on successful calls rather than raw attempted inputs.
- Long-running campaigns should reuse the shared `echidna.config.yaml` baseline unless the campaign explicitly needs a temporary override.

## Harness Map

- `EchidnaAMMEconomic`: bounded AMM economic-attack coverage.
- `EchidnaDeltaVerifier`: attester-signature, per-model budget, and lineage-head invariants for `submitMintRequest`.
- Properties:
- `echidna_no_profitable_roundtrip`: immediate attacker buy/sell round trips do not end with net USDC profit beyond documented rounding tolerance.
- `echidna_price_monotonic_on_buy`: successful buys do not reduce the reported spot price.
- `echidna_sell_reduces_reserve`: successful sells do not increase tracked reserve.
- `echidna_sell_does_not_improve_exit_quote`: successful sells do not improve the executable quote for selling the same amount again.
- `echidna_no_profitable_repeated_cycle`: repeated bounded buy/sell cycles do not accumulate attacker profit.
- `echidna_sandwich_preserves_position_and_supply`: a bounded attacker/victim sandwich sequence does not leave attacker token dust or unexpected total supply drift.
- `echidna_reserve_not_exceeds_usdc_balance`: tracked reserve never exceeds the AMM's actual USDC balance.
- `echidna_minted_never_exceeds_budget`: tracked successful DeltaVerifier reward mints never exceed each model's seeded budget.
- `echidna_no_mint_without_valid_signature`: random or malformed attester signatures never authorize a positive-reward mint.
- `echidna_lineage_monotonic`: successful paying mints only advance the canonical lineage head, and stale parents never succeed.
