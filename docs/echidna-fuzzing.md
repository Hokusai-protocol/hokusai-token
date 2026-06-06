# Echidna Fuzzing

Hokusai's fuzzing suite uses the pinned Docker image `ghcr.io/crytic/echidna/echidna:v2.2.4` against Solidity `0.8.20`. On Apple Silicon, run the container with `--platform linux/amd64` because this tag does not publish a native `arm64` image.

## Local Usage

Run a single harness:

```sh
npm run echidna:sanity
npm run echidna:token
npm run echidna:manager
npm run echidna:amm
npm run echidna:phase
npm run echidna:amm-econ
npm run echidna:reserve
```

Run the full short suite:

```sh
npm run echidna:all
```

The baseline config lives in `echidna.config.yaml` and is tuned for CI short runs:

- `seqLen: 100`
- `testLimit: 50000`
- `workers: 1`

The npm scripts invoke `echidna .` from the repo root so `crytic-compile` can use the Hardhat project layout directly. This avoids relying on the container's standalone `solc` toolchain bootstrap.

## Harness Map

- `EchidnaSanity`: compiler/runtime sanity checks and basic Echidna health.
- `EchidnaHokusaiToken`: token-level authorization and accounting invariants.
- `EchidnaTokenManager`: mint/burn/deploy lifecycle and role boundaries.
- `EchidnaAMMReserve`: reserve delta, quote consistency, fee accounting, pause gating, and owner parameter fuzzing.
- `EchidnaAMMPhase`: IBR sell gating, sell-enable monotonicity, and graduation one-way behavior under mixed actions.
- `EchidnaAMMEconomic`: economic/price behavior and broader AMM stress paths.
- `EchidnaInfrastructureReserve`: infrastructure reserve-specific invariants.

## Assumptions And Bounds

- `MAX_USDC_INPUT` bounds in AMM harnesses are precision guards to keep fuzzing productive; they are not invariants.
- `EchidnaAMMPhase` depends on Echidna's automatic `block.timestamp` advancement to cross the IBR window.
- Owner-only mutators are intentionally exercised in harnesses because the harness deployer is AMM owner; production access remains `onlyOwner`.

### Economic-attack assumptions

`EchidnaAMMEconomic` uses explicit harness bounds so the fuzz campaign spends time on plausible attack paths instead of pathological dust or unlimited-liquidity scenarios.

| Constant | Value | Rationale |
|---|---:|---|
| `MAX_TRADE` | `2_500_000e6` | Caps attacker and victim trade sizing to a large but bounded USDC range. |
| `MIN_LIQUIDITY` | `1_000e6` | Skips cycle and sandwich probes that are too small to add signal beyond dust behavior. |
| `MAX_CYCLES` | `5` | Bounds repeated-cycle accumulation so Echidna can explore the sequence deeply without exploding runtime. |
| `ROUND_TOLERANCE_USDC` | `100` | Allows only 0.0001 USDC of cumulative rounding dust per check, well below fee losses. |
| `VICTIM_INITIAL_USDC` | `10_000_000e6` | Pre-funds the helper victim so sandwich legs are approval-ready and liquidity-independent. |

- The harness leaves `purchaserWhitelist = address(0)`, so both the attacker harness and the victim helper can buy without whitelist gating.
- The AMM is deployed with `_ibrDuration = 0`, so sells are enabled immediately here; IBR timing behavior is covered separately by `EchidnaAMMPhase`.
- The harness intentionally crosses the flat-price threshold quickly because `_bound()` always returns at least `1` and successful buys steadily advance reserve toward the `25,000e6` flat threshold.
- Buy-side price movement is checked directly after successful buys.
- Sell-side impact is represented by a stronger executable-quote invariant: after a successful sell, the AMM must not offer a better `getSellQuote()` for selling that same token amount again from the new state.
- The harness does not assert absolute sandwich profitability because a victim buy can legitimately move price in the attacker's favor in any path-dependent AMM; instead it asserts that attacker exit and total supply reconcile exactly after the attacker round-trips around the victim trade.
- Dust sells that would return zero reserve are expected to revert or behave as no-op accounting paths; the harness treats those as skipped paths rather than profitable counterexamples.
- Sandwich legs that hit the AMM's `maxTradeBps` cap revert and are swallowed by the harness, which documents that boundary instead of flagging it as attacker profit.
- The repeated-cycle property allows cumulative attacker delta up to `ROUND_TOLERANCE_USDC * MAX_CYCLES` to cover bounded rounding dust without masking fee-sized profits.

## CI Behavior

- `fuzz-short` runs on push and pull requests against `main`.
- `fuzz-long` runs only on the weekly schedule or manual dispatch.
- Long runs raise `testLimit` to `5000000` and upload the resulting `echidna-corpus` artifacts even on failure.

## Failure Triage

1. Read the failing property name and counterexample sequence from the Echidna output.
2. Re-run the specific harness locally with the same image tag.
3. Preserve the failing corpus directory if the issue needs debugging over multiple sessions.
4. Confirm whether the failure is a harness bug, an assumption gap, or a production contract defect before widening the invariant.

## Extending The Suite

- Add new harnesses under `contracts/echidna/`.
- Keep harness constructors self-contained.
- Prefer helper caller contracts for negative authorization properties.
- Keep production contract behavior unchanged unless fuzzing reveals a separate defect that must be fixed independently.

## Manual Long Campaign

Create a temporary high-limit config and run a single harness:

```sh
cp echidna.config.yaml /tmp/echidna.long.yaml
perl -0pi -e 's/testLimit: 50000/testLimit: 5000000/' /tmp/echidna.long.yaml
docker run --rm --platform linux/amd64 -v "$PWD:/code" -w /code ghcr.io/crytic/echidna/echidna:v2.2.4 \
  echidna . --contract EchidnaAMMEconomic --config /tmp/echidna.long.yaml
```
