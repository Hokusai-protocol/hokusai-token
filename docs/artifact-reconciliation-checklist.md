# Deployment Artifact Reconciliation Checklist (HOK-1700)

Compare on-chain / artifact values against the approved config **after every phase** of a
launch. Approved values come from the single source of truth
[`scripts/configs/locked-economics.json`](../scripts/configs/locked-economics.json) (HOK-2199/HOK-2207),
the per-network launch-tokens config, and the launch-posture config. The guard test
`test/scripts/launchEconomicsConsistency.test.js` enforces that those config files agree;
this checklist confirms the **deployed chain state** agrees with them.

How to pull observed values: the full-stack deploy writes `deployments/<network>-latest.json`
(contracts, `config.deltaVerifierParams`, `tokens[]`, `pools[]`, `roles`, gas, git SHA,
compiler settings); the posture gate writes `deployments/launch-posture-<network>-latest.json`
(on-chain reads vs expected). `npm run verify:launch-posture:<network>` must print
`PASS`, and `npm run verify:contracts:<network>` must verify all contracts on Etherscan.

Amounts below are whole tokens unless noted; on-chain storage is ×1e18 (or ×1e6 for USDC).

---

## Worked example — Sepolia rehearsal 2026-06-26

- Artifact: `deployments/sepolia-latest.json` — chainId `11155111`, git `76a31c9`, scriptSha `c2718ac…`
- Compiler: solidity 0.8.20, optimizer runs 200, viaIR true (`hardhat.config.js`)
- Posture gate: **PASS** · Etherscan: **13/13 verified**

### Phase 1 — Infrastructure deploy

| Item | Approved (source) | Observed (artifact / chain) | ✓ |
|---|---|---|---|
| Core contracts deployed | 13 contracts | 13 addresses in `contracts` | ✓ |
| `baseRewardRate` | 1000 | 1000 | ✓ |
| `minImprovementBps` | 100 | 100 | ✓ |
| `maxReward` (constructor) | 2.5M (`locked.maxReward`) | artifact records **1M**; **on-chain 2.5M after posture** — see note | ⚠︎ |
| Roles wired | per `deploy-stack` | `roles{}` populated for all 8 contracts | ✓ |

> **maxReward note:** before this PR the deploy constructor shipped 1M and the posture
> step's `setMaxReward` corrected it to the locked 2.5M (the artifact still records the 1M
> constructor input). After wiring `deploy-sepolia.js`/`deploy-mainnet.js` to
> `locked-economics.json`, the constructor ships 2.5M directly and future artifacts will
> record 2.5M (posture `setMaxReward` becomes a no-op). Final verified on-chain value: **2.5M**.

### Phase 2 — Tokens & pools (per model: 28 HMESS, 27 HLEAD, 30 HROUT)

| Item | Approved (source) | Observed (`tokens[]` / `pools[]`) | ✓ |
|---|---|---|---|
| `tokensPerDeltaOne` | 250k (`locked`) | 250k (never 500k) | ✓ |
| Supplier allocation | 1,000,000 | 1,000,000 | ✓ |
| Investor allocation | 10,000,000 | 10,000,000 | ✓ |
| Max supply | 11,000,000 | 11,000,000 | ✓ |
| Vesting | 10% immediate / 1yr (31,536,000s) / no cliff | `immediateUnlockBps 1000, vestingDurationSeconds 31536000, cliffSeconds 0` | ✓ |
| Supplier split | 100k immediate / 900k vested | 100,000 / 900,000 | ✓ |
| Pool CRR | 20% (200000) | 200000 | ✓ |
| Pool trade fee | 0.3% (30) | 30 | ✓ |
| IBR duration | 7d (604800) | 604800 | ✓ |
| Flat-curve threshold | $25,000 (25000e6) | 25000.0 (`parseUnits(.,6)` → 25000000000) | ✓ |
| Flat-curve price | $0.01 (10000) | 0.01 (`parseUnits(.,6)` → 10000) | ✓ |
| Initial reserve | $100 (100e6) | 100000000 | ✓ |

> **Pool unit note:** `pools[]` stores `flatCurveThreshold`/`flatCurvePrice` as
> `formatUnits(v,6)` strings ("25000.0"/"0.01"); the on-chain constructor ints are
> `parseUnits(v,6)`. Etherscan verification reconstructs them this way.

### Phase 3 — Launch posture (`init-launch-posture` → `verify-launch-posture`)

| Item | Approved (`*-launch-posture.json`) | Observed (on-chain) | ✓ |
|---|---|---|---|
| `maxReward` | 2.5M | 2.5M | ✓ |
| Attester threshold | 1 | 1 | ✓ |
| Expected attester(s) | `0x07bf…5335` | present | ✓ |
| Mint budget (model 30) | 1,500,000 | 1,500,000 | ✓ |
| Weight genesis (model 30) | `0x2d1813cb…fa323` | seeded | ✓ |
| Legacy mints disabled | true | true | ✓ |
| Paused | false | false | ✓ |
| Posture gate | — | `PASS: launch posture matches expected config` | ✓ |

### Phase 4 — Etherscan verification (`verify:contracts:<network>`)

| Item | Expected | Observed | ✓ |
|---|---|---|---|
| Infra contracts (8) | verified | verified | ✓ |
| Tokens (3) | verified | verified | ✓ |
| Pools (3) | verified | verified | ✓ |
| **Total** | 13/13 | **13/13** | ✓ |

---

## Reusable per-launch procedure

1. **After infra deploy:** confirm `config.deltaVerifierParams` and contract count vs Phase 1 table; record git SHA + compiler settings from the artifact.
2. **After tokens/pools:** confirm `tokens[]` allocations + vesting and `pools[]` params vs Phase 2 table (remember the `parseUnits(.,6)` unit reconstruction).
3. **After posture init:** run `verify:launch-posture:<network>` and require `PASS`; spot-check the Phase 3 table against the posture report.
4. **After verification:** run `verify:contracts:<network>` and require all contracts green.
5. **On mainnet:** posture is applied via Safe (`--safe-txs`), not `--execute`; reconcile after the Safe batch executes. `maxReward` should already be 2.5M from the constructor.
