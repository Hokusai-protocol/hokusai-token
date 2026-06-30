# Sepolia Launch Rehearsal — 2026-06-30 (PASSED)

End-to-end dress rehearsal of the mainnet launch sequence on Sepolia, driven by the gated launch
conductor. **Every gate passed.** This is the pre-freeze validation that the full
deploy → configure → handoff → verify flow works as a single process.

| | |
|---|---|
| **Date** | 2026-06-30 |
| **Network** | Sepolia (chainId `11155111`) |
| **Code** | branch `fix/hok-2171-launch-conductor-network-aware` @ `f521c63` (→ PR #207) |
| **Command** | `node scripts/launch-mainnet.js --network sepolia` (full, from `deploy-contracts`) |
| **Deployer (KMS)** | `0xAfA95114441e1E13f67E2E6De5Cd6cF03D57B4Da` |
| **Result** | ✅ Conductor complete through final gate |

> Note: Sepolia timelock `minDelay` = 300s (rehearsal value); mainnet is 48h. Token/contract
> ownership and roles, the handoff logic, and all gates are identical to mainnet — only the delay
> constant and the network-specific deploy/pool scripts differ.

## Deployed addresses (rehearsal)

**Core**
| Contract | Address |
|---|---|
| ModelRegistry | `0x98A27e4592D32FE367327d684C98bc8159C75b0A` |
| TokenManager (DeployableTokenManager) | `0xa679bC5292351316865d407edD8dcd57c5a04481` |
| TokenDeploymentFactory | `0x97E137EA0c7272959EAEdF0788231Aa126F748D1` |
| HokusaiAMMFactory | `0x8d706A532456aF48F8351b9Ad05f1C229BA2Ab37` |
| HokusaiAMMPoolDeployer | `0xAf60e0b17a6c3934683F632afE93fa07efF38657` |
| PurchaserWhitelist | `0x717dc407DE4fA1D6a149427DEf968EE7FB98D43e` |
| RewardVestingVault | `0x9727B1C62c0612f43E63B217AdF188671dE26978` |
| DataContributionRegistry | `0x5436Cbc59DAD6C41eDED41e65222E2d0bf4827cf` |
| InfrastructureReserve | `0x94aaC27e8D53F4b9e62187d2671467d14E936643` |
| InfrastructureCostOracle | `0x3ba4a419c5aE58CC431CdF8EFD2eb87064B74Ee8` |
| UsageFeeRouter | `0x7697C3F811140cE5e32d20f35e764DAee3Ae1eaa` |
| DeltaVerifier | `0xA1bfEA670652a0706A98CF4FCBD7787Ee041ca01` |
| MockUSDC (reserve token) | `0xc95B6a6dfC8DDA7074845b74667457d2eD1F8d20` |

**Governance**
| Role | Address |
|---|---|
| Timelock (HokusaiTimelockController) | `0x7c5938F4f34EaB427fD8bbD5AfFc78A0E5743eFe` |
| Admin Safe (== Emergency Safe) | `0x158B985CC667b4E022AD05B99E89007790da66E2` |

**Tokens & pools** (governor = admin Safe)
| Model | Symbol | Token | AMM Pool |
|---|---|---|---|
| 28 | HMESS | `0x9Ba98E65DAbd148ac7e6AdfACD20Da34730e0706` | `0x200a0c5c55695CbD3e2E3767D1E6782E1261307e` |
| 27 | HLEAD | `0xA1E204F67867B0f53C9973A47A8a9280A78dcd13` | `0x772EBFb17d20E5E9e7E8eAbA251f7B26f92F5A25` |
| 30 | HROUT | `0xe17772f575fd5A45Add1BaAaFcF11628614F15F3` | `0x32dA02fCA33Cb19f0C1a0cc2dfD862243E89f56D` |

## Gate results

| Phase | Result |
|---|---|
| `deploy-contracts` (deploy-sepolia.js) | ✅ full stack deployed |
| `deploy-timelock` | ✅ `0x7c5938…3eFe` |
| `create-pools` (create-sepolia-test-tokens.js) | ✅ 3 tokens + 3 pools, governor = admin Safe |
| `posture-execute` (`init-launch-posture --execute`) | ✅ attesters + threshold + per-model budget + weight-genesis + `disableLegacyMints` |
| `verify-posture-pre` (`--skip-ownership`) | ✅ **PASS** — mint posture only (pre-handoff) |
| `confirm-handoff` | ✅ operator typed `HANDOFF` |
| `handoff-dry-run` | ✅ 41 actions previewed |
| `handoff` (transfer-governance) | ✅ all transfers/grants/renounces sent; tokens `already-set` (owned by Safe); params `skipped-not-admin` |
| `verify-governance` | ✅ **PASS: 55/55** |
| `verify-posture-post` | ✅ **PASS** — full mint-posture + ownership audit |

### Mint-posture transactions (Sepolia)
- `addAttester` — `0xb9f96f11685b0cb77776bb6679da8fe0a93c93c0614859146e109ce50907b2f0`
- `setAttesterThreshold(1)` — `0x6b7944fcc4b7c4f8e81cf42ea963a1434ded9c9b36271cc202737440404bfaf2`
- `setMintBudget(30, 1.5M)` — `0xe070409d2803304c313a199fd72a216b79dd42733553f488384a968f45df0bca`
- `setWeightGenesis(30, …)` — `0x1ca92a2af7a6a75dfabb4dbbde0188a69e607f23bf0f5f746ede11afc9449b77`
- `disableLegacyMints()` — `0xa28f2dab5a52753e18aa6cbdf34f3a68763d7298cb6a245c7fc3681d0b581cb8`

## What this validated

- **End-to-end launch sequence** as one gated process (conductor), including the Safe-mediated
  vs deployer-key boundary.
- **Governance handoff (G-1):** every deployer-owned contract → timelock; deployer revoked
  everywhere; DeltaVerifier + DataContributionRegistry admin remain the admin Safe (per policy);
  `verify-governance` 55/55.
- **Mint posture (G-2):** `disableLegacyMints` + attester registry + per-model budget +
  weight-genesis applied and verified.
- **Token/params custody decision (2026-06-30):** per-model token ownership and params `GOV_ROLE`
  stay with the admin Safe by design; the handoff correctly leaves them in place (skip guards) and
  the verify gates confirm it.
- **H-2 mitigation is live:** re-pointing existing models was blocked, forcing a clean fresh
  deploy — exactly the intended behavior.

## Mainnet deltas (not exercised on Sepolia, by design)
- Timelock `minDelay` 300s → **48h** on mainnet.
- Mint posture is applied via a **Safe Transaction Builder bundle** on mainnet
  (`init-launch-posture --safe-txs`), not `--execute` (which is rejected on mainnet).
- Real USDC reserve token instead of MockUSDC; production initial reserves; production attester /
  relayer / license values.

## Related
- Conductor + handoff fixes: PR #207 (follow-up to #206).
- Security review: `docs/mainnet-security-review-findings.md`.
- Open follow-up: HOK-2409 (decouple + timelock the reward cap).
