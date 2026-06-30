# Mainnet Launch Token Parameter Lock

This document locks the economic and identity parameters to verify before the final Sepolia rehearsal and before translating the launch plan to mainnet. It is connected to the mainnet launch checklist and should be reviewed with [Mainnet Deployment Checklist](mainnet-deployment-checklist.md), [Mainnet Custody And Role Rehearsal Runbook](mainnet-custody-runbook.md), and [Mainnet Launch Day Rollback Runbook](mainnet-launch-rollback-runbook.md).

## Source Of Truth

Approved rehearsal config:

- `scripts/configs/sepolia-launch-tokens.json`
- `deployments/sepolia-latest.json`

Live Sepolia verification:

- Read on 2026-05-22 against chain ID `11155111`.
- Registry: `0x2670c95507DEe0E2143DD43759874169F06F9F33`
- TokenManager: `0x4674800e5C923E4D37b1b170055aDaa6aBD7DCD9`
- AMM factory: `0x0DA818890e6366EFE17a329c2fD43d885C38cF34`
- Reserve token: `0x42bEAcA3808cf40d091E97f0b654A8B9aD177582`

## Model 30 Identity Decision

Model `30` should use symbol `HROUT` going forward.

The current Sepolia token for model `30` still reports symbol `HTASK`. Treat that token and pool as a superseded rehearsal artifact. Token symbols are constructor-set ERC20 identity fields, so moving from `HTASK` to `HROUT` requires deploying a replacement model `30` token and pool before the final rehearsal.

## Approved Token Identity And Rewards

| Model ID | Token name | Approved symbol | Current Sepolia symbol | Token address | Supplier recipient | Supplier allocation | Investor allocation | tokensPerDeltaOne | infrastructureAccrualBps | Oracle cost per 1000 calls | License hash | License URI | Vesting policy |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- |
| `27` | Hokusai Sales Lead Scoring | `HLEAD` | `HLEAD` | `0x9755034ed1F375A23B7f3cc5E5084e43f4C722f7` | `0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B` | 1,000,000 | 10,000,000 | 250,000 | 8000 | 0.00 USD | `0x2727272727272727272727272727272727272727272727272727272727272727` | `https://hokus.ai/licenses/sepolia-test` | Enabled; 10% immediate, 1 year (365d) vesting, no cliff |
| `28` | Hokusai Messaging | `HMESS` | `HMESS` | `0x200468201d9b7A5F84CaE3026737D03F3C87c3CA` | `0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B` | 1,000,000 | 10,000,000 | 250,000 | 8000 | 0.00 USD | `0x2828282828282828282828282828282828282828282828282828282828282828` | `https://hokus.ai/licenses/sepolia-test` | Enabled; 10% immediate, 1 year (365d) vesting, no cliff |
| `30` | Hokusai Task Routing | `HROUT` | `HTASK` superseded | `0x527ec54236188F4ad9eaffA608e459981520DEA9` | `0x3018Cf81729c932Bc3E733A264e5F4a0A08deD5B` | 1,000,000 | 10,000,000 | 250,000 | 8000 | 0.00 USD | `0x3030303030303030303030303030303030303030303030303030303030303030` | `https://hokus.ai/licenses/sepolia-test` | Enabled; 10% immediate, 1 year (365d) vesting, no cliff |

> The table above is the **Sepolia rehearsal** record (preserved for traceability). The **mainnet** allocations and supplier recipient differ — see the mainnet block below.

### Mainnet Launch Allocations (M-6 — APPROVED 2026-06-30)

These are the canonical mainnet values, enforced by `scripts/configs/locked-economics.json` →
`mainnetAllocations` and the `test/scripts/launchEconomicsConsistency.test.js` drift guard
(blocking CI). `supplierAllocation` = model-supplier tokens; `investorAllocation` = tokens
available for investor purchase via the AMM; on-chain `maxSupply` (launch cap) = supplier +
investor (reward minting can add supply beyond it later, bounded by the reward cap).

| Model ID | Symbol | Supplier recipient | Supplier allocation | Investor allocation | Derived maxSupply (launch cap) |
| --- | --- | --- | ---: | ---: | ---: |
| `28` | `HMESS` | `0xD1Eb2fEeFDA99a0c096DD211a27406FD167D8136` | 2,500,000 | 10,000,000 | 12,500,000 |
| `27` | `HLEAD` | `0xD1Eb2fEeFDA99a0c096DD211a27406FD167D8136` | 1,250,000 | 10,000,000 | 11,250,000 |
| `30` | `HROUT` | `0xD1Eb2fEeFDA99a0c096DD211a27406FD167D8136` | 2,500,000 | 10,000,000 | 12,500,000 |

`tokensPerDeltaOne` (250,000), `infrastructureAccrualBps` (8000), and the vesting policy
(10% immediate / 365d linear / no cliff) are unchanged from the lock above.

**Approved:** these mainnet allocations supersede the rehearsal allocations (was uniform
1,000,000 / 10,000,000) and are the canonical values, enforced by the
`launchEconomicsConsistency` drift guard. Approved by **@timogilvie, 2026-06-30**.

Notes:

- `infrastructureAccrualBps = 8000` means 80% infrastructure accrual and 20% AMM/profit share under the current parameter interpretation.
- `tokensPerDeltaOne` is a whole-token display value; on-chain it is stored with 18 decimals.
- `oracle cost per 1000 calls` is stored with the platform's 6-decimal USD convention.
- Supplier allocation now follows the same `HokusaiParams.vestingConfig()` as DeltaOne contributor rewards. Immediate unlock bps, duration, and cliff must match the token params for both flows.
- Current Sepolia supplier allocations were distributed before this vesting change and should be treated as superseded rehearsal state.

## Approved AMM Parameters

| Model ID | Symbol | Pool address | Initial USDC reserve | CRR | Trade fee | IBR duration | Flat curve threshold | Flat curve price | Max trade bps |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `27` | `HLEAD` | `0xb1A88bF680D0c81d9ae826834E571Fe735f7dd4C` | 100 USDC | 200000 | 30 bps | 604800 seconds | 25,000 USDC | 0.01 USDC | 2000 |
| `28` | `HMESS` | `0xb8Aa731A44c0F2fC9B04fEEE491cad2E44F992f2` | 100 USDC | 200000 | 30 bps | 604800 seconds | 25,000 USDC | 0.01 USDC | 2000 |
| `30` | `HROUT` target; current Sepolia pool is `HTASK` | `0x8223eFdaf130414Ba27EDa3a8BB870B08573e030` | 100 USDC | 200000 | 30 bps | 604800 seconds | 25,000 USDC | 0.01 USDC | 2000 |

Display interpretation:

- `CRR = 200000` means 20%.
- `tradeFee = 30` means 0.30%.
- `maxTradeBps = 2000` means 20% of reserve once the pool is in bonding-curve phase.
- `IBR duration = 604800` means 7 days.
- `flatCurveThreshold = 25,000 USDC` is the graduation threshold.
- `flatCurvePrice = 0.01 USDC` is the pre-graduation fixed price per token.

## Live Sepolia Verification Snapshot

The current Sepolia state has already been exercised by test buys. Do not treat live reserve balances as the intended initial reserve. Model `30` is shown here as `HTASK` because that is the symbol on the currently deployed, superseded Sepolia token.

| Model ID | Symbol | Registry active | Registry token matches | Registry pool matches | Params address | Supplier distributed | Live total supply | Live reserve balance | Graduated |
| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |
| `27` | `HLEAD` | Yes | Yes | Yes | `0x4234fb38cB6262e6736F40e2ee6E74F8ACa43f5B` | Yes | 5,485,146.089914781205014471 | 25,011.994001 USDC | Yes |
| `28` | `HMESS` | Yes | Yes | Yes | `0x78Cc472C523f23099767a6451E20F2fb8Aa52a1b` | Yes | 5,485,146.089914781205014471 | 25,011.996001 USDC | Yes |
| `30` | `HTASK` | Yes | Yes | Yes | `0x437271c4F84a38309CD3D2242286946358dFFc8b` | Yes | 5,485,146.089914781205014471 | 25,011.994001 USDC | Yes |

## Final Rehearsal Gates

- [ ] Redeploy or replace model `30` as `HROUT`; do not use the current `HTASK` token for final rehearsal signoff.
- [ ] Update `deployments/sepolia-latest.json` after the `HROUT` replacement deployment.
- [ ] Confirm supplier recipient for mainnet. The Sepolia recipient is the deployer address and should not be assumed correct for mainnet.
- [ ] Confirm mainnet Admin Safe or timelock will hold governance/admin authority before public launch.
- [ ] Confirm production license hashes and URIs. Sepolia uses test license placeholders.
- [ ] Confirm production oracle cost per 1000 calls. Sepolia uses `0`.
- [ ] Confirm production initial USDC reserves. Sepolia uses `100` USDC per pool for rehearsal.
- [ ] Re-run live parameter verification after the `HROUT` redeploy.
- [ ] Re-run the direct Sepolia rehearsal after this change and verify each supplier allocation split between the supplier wallet and `RewardVestingVault` using the configured immediate unlock, cliff, and duration.
- [ ] Do not begin final rehearsal until this document and `scripts/configs/sepolia-launch-tokens.json` agree.
