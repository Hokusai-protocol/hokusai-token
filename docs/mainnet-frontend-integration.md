# Mainnet Frontend & Data-Pipeline Integration

**Network:** Ethereum mainnet (chainId **1**)
**Deployed:** 2026-07-01 · **Governance handoff:** 2026-07-01T22:04Z
**Source of truth:** [`deployments/mainnet.addresses.json`](../deployments/mainnet.addresses.json) (machine-readable) / [`deployments/mainnet-latest.json`](../deployments/mainnet-latest.json) (full record)

> ⚠️ Do **not** use `FRONTEND_DEPLOYMENT_GUIDE.md` — it is Sepolia-only and pre-mainnet. This doc supersedes it for mainnet.

## Addresses the site needs

### Reserve / settlement token
| | Address | Decimals |
|---|---|---|
| USDC (reserve token) | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | **6** |

All pool reserves, prices, and quotes are denominated in USDC (6 decimals). Model tokens are **18** decimals — handle the mismatch explicitly in pricing/display.

### Core contracts
| Contract | Address |
|---|---|
| ModelRegistry | `0x0a09B52fE6b55dE42676b3F68BED76793FB9FEe9` |
| TokenManager | `0xBD0A038C211A7694893506483EC458Bb7c8F473c` |
| TokenDeploymentFactory | `0x9C1cAeE153bd96b437CDE97B3a535893c3b4cfcf` |
| RewardVestingVault | `0x69a1A7fF6b765B27a4436EB7AC343b13abE523a5` |
| DataContributionRegistry | `0x7eeC766aF367a4F7B8C38FD2a4bAFDA81df123d3` |
| DeltaVerifier | `0xE9D40B96703391464bc6b0ea0b4F0404399AaCE7` |
| HokusaiAMMFactory | `0xC0d2958E54A8FBAf7E0ed054Ff885227804FE3B4` |
| HokusaiAMMPoolDeployer | `0x920cFfF8276a3E422690138410b60a70C8243269` |
| PurchaserWhitelist | `0x7304dC498D5d7Ef0674891D7260d00Ea3ff37569` |
| InfrastructureReserve | `0x2A15930649801398896e9b61BF36E555FA942c9D` |
| InfrastructureCostOracle | `0x75c6Ae951b734cd0abf89e5C16941F77576239DC` |
| UsageFeeRouter | `0xa0f3461d594D181E817754eE57d618A95207185F` |

### Tokens & AMM pools
| Model | modelId | Token (18d) | AMM Pool | CRR | Trade fee |
|---|---|---|---|---|---|
| HMESS — Hokusai Messaging | 28 | `0x559028b237ff7d4b019d90250D70c604f4894379` | `0xC187ffc6a465247f228a63f00C2515041792A0fA` | 30% | 0.30% |
| HLEAD — Sales Lead Scoring | 27 | `0x25618B023c0e65E4daDb21ee04dc010AaE84B1F5` | `0xa6D4a50496ce6808508e6DCaB19D57845D4e30e4` | 10% | 0.30% |
| HROUT — Task Routing | 30 | `0x8866f3262621daBCC973f6D3A4953E7ad9F56D39` | `0x6C40EF10da0c0Fc87352b0026A49a6769af12816` | 20% | 0.30% |

## Data pipeline / indexer

Backfill from the deployment blocks in [`mainnet.addresses.json`](../deployments/mainnet.addresses.json) → `deploymentBlocks` (earliest: ModelRegistry at **25440259**). Pools were created ~block **25440290+** (`poolsCreatedAt` 2026-07-01T21:28Z).

Supply notes for the pipeline:
- Model tokens use a **bonding-curve AMM** — investor supply is minted on purchase, not pre-minted. `totalSupply` at launch equals only the minted supplier allocation, and grows as buyers mint against the curve. Do not treat `maxSupply` as circulating supply.
- **Supplier distribution is complete** (verified on-chain 2026-07-08): supplier recipient `0xD1Eb2fEeFDA99a0c096DD211a27406FD167D8136` holds the 10% immediate unlock; the remaining 90% is held in the RewardVestingVault. (The `modelSupplierDistributed: false` flag in `mainnet-latest.json` is a stale record artifact — it was never rewritten after the Safe executed the distribution.)

## Governance (read this before wiring any privileged call)

Ownership was handed off at launch — the deployer `0x56cA22…0c9e` is fully revoked. Any privileged/admin action now routes through governance:

- **48h Timelock** `0xcd8076D7a15E97946fAD0baA32Bf358be3D927C8` — owns structural contracts (min delay 172800s / 48h).
- **Admin Safe** `0x158B985CC667b4E022AD05B99E89007790da66E2` — token owner, params GOV_ROLE, DeltaVerifier + DataContributionRegistry admin. Also acts as emergency Safe.

Read paths (balances, quotes, registry lookups, events) need none of this. Only mint/param/role changes do — and those go through the Safe/timelock, not a backend key.

## Network config (MetaMask / provider)

```js
{
  chainId: '0x1',
  chainName: 'Ethereum Mainnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  blockExplorerUrls: ['https://etherscan.io']
}
```
