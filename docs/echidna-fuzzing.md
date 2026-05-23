# Echidna Fuzzing

Hokusai's fuzzing suite uses the pinned Docker image `ghcr.io/crytic/echidna/echidna:v2.2.4` against Solidity `0.8.20`. On Apple Silicon, run the container with `--platform linux/amd64` because this tag does not publish a native `arm64` image.

## Local Usage

Run a single harness:

```sh
npm run echidna:sanity
npm run echidna:token
npm run echidna:manager
npm run echidna:amm
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
