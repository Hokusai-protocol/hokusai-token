# Mainnet Release Candidate — `mainnet-rc1` Sign-off

**Candidate commit:** `3ccf27067aad32a9af8ce1e18e489f2d3dd13464` (`main`, as prepared)
**Prepared:** 2026-07-01
**Owner:** @timogilvie
**Tag to apply on sign-off:** `mainnet-rc1`

> Tag `mainnet-rc1` on the `main` commit that **includes this sign-off doc** (one commit past
> the candidate above). Record that exact SHA in §8 before running the freeze gates on it.

> **Post-freeze rule.** Any code change after this tag (even one line) voids the freeze and
> requires a new: compile + full test + Slither + Echidna (`echidna:all`) + Sepolia delta, and a
> new tag. No "trivial" carve-outs.

---

## 1. Scope of this release

Pre-mainnet security remediation from the 2026-06-29 review, plus the gated launch tooling,
**validated end-to-end by a full Sepolia launch rehearsal (2026-06-30, all gates green)**. No
confirmed Critical/High *code* defect remains; both AMM "Criticals" were numerically defused.

Reference docs: `docs/mainnet-security-review-findings.md`, `docs/sepolia-rehearsal-2026-06-30.md`,
`docs/mainnet-launch-token-parameter-lock.md`.

## 2. Freeze gates

| Gate | Status | Notes |
|------|--------|-------|
| `npx hardhat compile` | ✅ | clean |
| `npx hardhat test` | ✅ | full suite green on `main` |
| `npm run slither` | ✅ | gate green vs refreshed baseline |
| `npm run echidna:all` (17 harnesses, 50k) | ✅ | passed locally 2026-07-01 — all 17 harnesses green, 0 falsified (incl. the 5 H-6: vesting/escrow/funding/router/timelock). Note: benign "unconfigured RPC (…0001EmptyBase)" log line in the DeltaVerifier harnesses; properties still 10/10. **Re-run on the frozen commit if it differs from this run.** |
| 5M `fuzz-long` (workflow_dispatch) | ☐ **dispatch on frozen commit** | record per-harness result |
| Sepolia delta from frozen commit | ✅ | `verify:launch-posture:sepolia` PASS 2026-07-01 (posture matches expected config). A full `launch:rehearse:sepolia` also passed 55/55 on the candidate code. |
| Numerical AMM round-trip conservation | ✅ | 0.0000% extraction, CRR 5/10/20/50% incl. ln-scaling region |

## 3. Security findings status

| Sev | Status |
|-----|--------|
| Critical (code) | 0 confirmed (AMM C-1/C-2 defused) |
| High H-1…H-6 | ✅ all mitigated (H-5 FundingVault off initial path; cancelGraduation ships as hardening) |
| Launch gates G-1/G-2 | ✅ process validated on Sepolia; **run on mainnet at launch** (handoff verify + `disableLegacyMints`) |
| Medium | M-3 → HOK-2409 (risk-accepted, below); others tracked / config-enforced |

## 4. Frozen launch parameters

**Governance / keys**
| Role | Address |
|---|---|
| Admin Safe (== Emergency Safe, 2-of-3) | `0x158B985CC667b4E022AD05B99E89007790da66E2` |
| Timelock | deployed at launch; 48h delay (`mainnetMinDelay` 172800), proposer/executor/canceller = admin Safe |
| Deployer (KMS) | `0x56cA22006d67e14AA1b7820cE02c6B6205Df0c9e` (revoked everywhere post-handoff) |
| SUBMITTER relayer (KMS backend) | `0xc18D0B6eE049B2B113eE4671cB9C8109192e29E2` |
| Attester | `0x07bf9b22f516d2D464511219488F019c5dFF5335` (threshold 1) |
| Supplier recipient (all models) | `0xD1Eb2fEeFDA99a0c096DD211a27406FD167D8136` |

**Per-model (allocations approved 2026-06-30; drift-guard enforced)**
| Model | Symbol | Supplier | Investor | Init reserve | Weight-genesis root |
|---|---|---:|---:|---:|---|
| 28 | HMESS | 2,500,000 | 10,000,000 | $10 | `0xebdae89e…0476c4` |
| 27 | HLEAD | 1,250,000 | 10,000,000 | $10 | `0xc4e28d42…381883` |
| 30 | HROUT | 2,500,000 | 10,000,000 | $10 | `0xce7fc97f…06554c` |

Common: `tokensPerDeltaOne` 250,000 · `infrastructureAccrualBps` 8000 · per-model mint budget
1,500,000 · `maxReward` 2,500,000 · vesting 10% immediate / 365d linear / no cliff · flat curve
$0.01 to $25,000 threshold. Initial reserves are intentionally thin ($10/pool, all flat-phase);
real opening liquidity funded post-launch. Weight-genesis roots are `sha256-merkle-v1`
(provenance in `scripts/configs/mainnet-weight-genesis-sources.json`), write-once on-chain, and
match the off-chain DeltaOne lineage.

## 5. Governance & custody model

- **48h timelock owns the structural contracts:** ModelRegistry, TokenManager, HokusaiAMMFactory,
  InfrastructureReserve, UsageFeeRouter, InfrastructureCostOracle.
- **Admin Safe keeps control/economic powers** (fast, not 48h-delayed): per-model token owner
  (`setController`), HokusaiParams `GOV_ROLE` (economic params — structurally permanent at the
  Safe), DeltaVerifier + DataContributionRegistry admin (mint-config), reward cap.
- Deployer EOA revoked on every contract; the handoff moves only deployer-owned contracts and
  is verified by `verify-governance` + post-handoff `verify-launch-posture`.

## 6. Risk-accepted / deferred (not blockers)

- **HOK-2409** — reward cap (`100 × tokensPerDeltaOne`) stays under the admin Safe; decouple +
  timelock deferred. Risk-accepted for launch (cap is a 2-of-3 multisig, not an EOA).
- **FundingVault** off the initial mainnet path (not deployed); M-10 fix (Option A) deferred with it.
- **M-4/M-5** contribution-weight double-count / batch sum — tracked follow-ups.

## 7. Launch execution (post-freeze)

Deployer funded with **~4 ETH + ~$30 USDC**. Run the gated conductor:
`npm run launch:mainnet` → deploy → 48h timelock → 3 tokens/pools → **generates the Safe posture
bundle, STOPS** (submit via admin Safe: `disableLegacyMints` + attesters + budget + write-once
weight-genesis) → resume `--from verify-posture-pre` → `HANDOFF` → transfer-governance →
`verify-governance` + `verify-posture-post`. Archive verifier outputs as launch artifacts.

## 8. Freeze declaration

I confirm the freeze gates (§2) pass on `3ccf270`, the launch parameters (§4) are correct and
intentional, and the risk-accepted items (§6) are acknowledged.

**Approver:** ______________________  **Date:** ____________  **Tag applied:** `mainnet-rc1` ☐
