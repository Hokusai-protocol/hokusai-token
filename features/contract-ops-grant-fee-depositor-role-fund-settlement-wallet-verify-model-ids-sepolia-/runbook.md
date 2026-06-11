# HOK-2141 — Sepolia Fee Depositor Ops Runbook

Tracks the on-chain steps to grant `FEE_DEPOSITOR_ROLE`, fund the settlement wallet, and smoke-test a fee deposit on Sepolia.

## Settlement Wallet

| Field | Value |
|---|---|
| Address | **PENDING — obtain from auth-service KMS public key (HOK-2140)** |
| Derivation | `python -c 'from src.services.settlement.kms_signer import derive_address_from_public_key; ...'` in auth-service repo |
| KMS Key ID alias | Stored in auth-service repo only; not held here |

> **Note (Sepolia only):** The smoke test requires `SETTLEMENT_WALLET_PRIVATE_KEY` in `.env.sepolia` (gitignored). On mainnet the auth-service KMS signer (`scripts/settlement_deposit_fees.py`) performs the deposit — no raw key is ever used.

## Grant

| Field | Value |
|---|---|
| Granting key | Sepolia deployer EOA `0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B` |
| UsageFeeRouter | `0xCDa3604f9D7F89e47eE1ebc1d27A13fa7551C04d` |
| Grant tx hash | **PENDING** |
| Block | **PENDING** |
| RoleGranted event | `(FEE_DEPOSITOR_ROLE, <wallet>, 0x3018Cf…d5B)` |

> **Mainnet custody note:** On mainnet, this grant MUST be a Safe-proposed `grantRole` call per `docs/mainnet-custody-runbook.md` §"Role Grant/Revoke Matrix" / `UsageFeeRouter` row. The Sepolia rehearsal uses the deployer key by deliberate exception.

## Funding

| Field | Value |
|---|---|
| ETH sent | 0.05 SepoliaETH (default) |
| USDC minted | 100 USDC = `100_000_000` base units |
| ETH tx hash | **PENDING** |
| USDC mint tx hash | **PENDING** |
| Post-fund ETH balance | **PENDING** |
| Post-fund USDC balance | **PENDING** |

## Model-ID Mapping

Router string IDs are sourced from `deployments/sepolia-latest.json:tokens[].modelId`. Byte-for-byte equality with auth-service `model_id` (no padding, no `model_` prefix, no `0x`, no whitespace):

| Router `modelId` string | Token symbol | Auth-service `model_id` column | Match confirmed? |
|---|---|---|---|
| `"27"` | HLEAD (Hokusai Sales Lead Scoring) | `"27"` | pending upstream query — `SELECT DISTINCT model_id FROM balance_transactions WHERE model_id IN ('27','28','30')` |
| `"28"` | HMESS (Hokusai Messaging) | `"28"` | pending upstream query |
| `"30"` | HROUT (Hokusai Task Routing) | `"30"` | pending upstream query |

> Mark each row confirmed once `SELECT DISTINCT model_id FROM balance_transactions` and `SELECT model_id FROM model_pricing` return results from the auth-service DB. Per plan §4.4: if DB access is unavailable at commit time, rows are marked "pending upstream confirmation (HOK-2138)".

## Oracle Decision

**Decision: accept bps fallback (80/20) for MVP.**

Rationale:
- `InfrastructureCostOracle.getEstimatedCost("30") == 0` — no per-model cost has ever been set.
- Model-30 params (`0xA9B4a260f06e674c7a24AECaE0D195E01cc8D422`) were deployed with `infrastructureAccrualBps = 8000`.
- Expected fallback split: `infraShare = amount * 8000 / 10000`, `ammShare = amount - infraShare` (80/20).
- Using `setEstimatedCost` would commit to a cost number with no empirical basis and create epoch-update churn (`InfrastructureCostOracle` enforces epoch boundaries).
- The fallback is observable via `costBasis == PERCENTAGE_FALLBACK (1)` in `FeeSplitCalculated` events; monitoring can flag any silent path change (HOK-2144).
- Switch to `setEstimatedCost` once cost telemetry exists (post-MVP).

## Smoke Test

Invocation: `SETTLEMENT_WALLET_PRIVATE_KEY=0x… SETTLEMENT_WALLET_ADDRESS=0x… npx hardhat run scripts/smoke-deposit-fee-sepolia.js --network sepolia`

| Field | Value |
|---|---|
| Deposit tx hash | **PENDING** |
| Model ID | `"30"` |
| Amount | `1000000` (1 USDC) |
| Call count | `1` |
| Expected infra delta | `800000` (80%) |
| Expected AMM delta | `200000` (20%) |
| Cost basis | `1` (PERCENTAGE_FALLBACK) |
| `accrued("30")` before | **PENDING** |
| `accrued("30")` after | **PENDING** |
| AMM `reserveBalance` before | **PENDING** |
| AMM `reserveBalance` after | **PENDING** |
| Etherscan link | **PENDING** |

## Deployment Artifact Update

After a successful grant, `scripts/grant-fee-depositor-sepolia.js` automatically writes `deployments/sepolia-latest.json` with:
- `backendService` set to the settlement wallet address
- Settlement wallet appended to `roles.UsageFeeRouter.FEE_DEPOSITOR_ROLE`
- `roles.UsageFeeRouter.feeDepositorGrantTx` map recording `{ "<wallet>": "<txHash>" }`

Run `node -e "JSON.parse(require('fs').readFileSync('deployments/sepolia-latest.json','utf8')); console.log('valid')"` after the grant to validate JSON.

## Completion Checklist

- [ ] Settlement wallet address obtained from auth-service KMS key
- [ ] `SETTLEMENT_WALLET_ADDRESS` and (for smoke only) `SETTLEMENT_WALLET_PRIVATE_KEY` set in `.env.sepolia`
- [ ] `fund-settlement-wallet-sepolia.js` run successfully; tx hashes recorded above
- [ ] `grant-fee-depositor-sepolia.js` run successfully; tx hash and updated `sepolia-latest.json` committed
- [ ] `smoke-deposit-fee-sepolia.js` run successfully; tx hash and split figures recorded above
- [ ] Model-ID mapping confirmed against auth-service DB
- [ ] Tx hashes linked on HOK-2141
