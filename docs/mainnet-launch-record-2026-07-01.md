# Hokusai Mainnet Launch Record — 2026-07-01

Live on Ethereum mainnet (chainId 1). Executed via the gated conductor `scripts/launch-mainnet.js`
from tag `mainnet-rc1` plus the launch-tooling deviations recorded in §Deviations below.

**Final gates:** `verify-governance` **55/55** · `verify-launch-posture` (post-handoff, full
ownership + roleAudit) **PASS**.

## Deployed contracts
| Contract | Address |
|---|---|
| ModelRegistry | `0x0a09B52fE6b55dE42676b3F68BED76793FB9FEe9` |
| TokenManager | `0xBD0A038C211A7694893506483EC458Bb7c8F473c` |
| TokenDeploymentFactory | `0x9C1cAeE153bd96b437CDE97B3a535893c3b4cfcf` |
| RewardVestingVault | `0x69a1A7fF6b765B27a4436EB7AC343b13abE523a5` |
| DataContributionRegistry | `0x7eeC766aF367a4F7B8C38FD2a4bAFDA81df123d3` |
| HokusaiAMMFactory | `0xC0d2958E54A8FBAf7E0ed054Ff885227804FE3B4` |
| HokusaiAMMPoolDeployer | `0x920cFfF8276a3E422690138410b60a70C8243269` |
| PurchaserWhitelist | `0x7304dC498D5d7Ef0674891D7260d00Ea3ff37569` |
| InfrastructureReserve | `0x2A15930649801398896e9b61BF36E555FA942c9D` |
| InfrastructureCostOracle | `0x75c6Ae951b734cd0abf89e5C16941F77576239DC` |
| UsageFeeRouter | `0xa0f3461d594D181E817754eE57d618A95207185F` |
| DeltaVerifier | `0xE9D40B96703391464bc6b0ea0b4F0404399AaCE7` |
| **HokusaiTimelockController (48h)** | `0xcd8076D7a15E97946fAD0baA32Bf358be3D927C8` |

## Tokens / pools
| Model | Symbol | Token | HokusaiParams |
|---|---|---|---|
| 28 | HMESS | `0x559028b237ff7d4b019d90250D70c604f4894379` | `0xDd1A79F0B587fA6d2335ce5bF84E9D2c0Dd445D3` |
| 27 | HLEAD | `0x25618B023c0e65E4daDb21ee04dc010AaE84B1F5` | `0x4Bc46f0553cB5f8bDeCb7157f5488388eD31Fd7f` |
| 30 | HROUT | `0x8866f3262621daBCC973f6D3A4953E7ad9F56D39` | `0x61E0B132b57f512Ec7384b9cBA0fA73bc940DeF0` |

Pools owned by HokusaiAMMFactory. Allocations/params per `docs/mainnet-rc1-signoff.md` §4.

## Governance / keys (final on-chain state)
- **48h timelock** `0xcd80…27C8` owns ModelRegistry, TokenManager, HokusaiAMMFactory,
  InfrastructureReserve, InfrastructureCostOracle (admin+GOV), UsageFeeRouter.
- **Admin Safe (2-of-3)** `0x158B985CC667b4E022AD05B99E89007790da66E2` holds: per-model token owner,
  HokusaiParams GOV_ROLE, DeltaVerifier + DataContributionRegistry `DEFAULT_ADMIN`, PAUSER (== emergency).
- **Relayer** `0xc18D0B6eE049B2B113eE4671cB9C8109192e29E2` holds DeltaVerifier `SUBMITTER_ROLE`.
- **Attester** `0x07bf9b22f516d2D464511219488F019c5dFF5335`, threshold 1. `legacyMintsDisabled = true`.
- **Deployer** `0x56cA22006d67e14AA1b7820cE02c6B6205Df0c9e` — revoked from every owner/admin/pauser and
  from SUBMITTER/RECORDER (see §Deviations). Retains only un-audited operational roles (VERIFIER on
  DataContributionRegistry, PAYER on InfrastructureReserve, FEE_DEPOSITOR on UsageFeeRouter) — a
  post-launch cleanup, not a blocker.

## Execution sequence (on-chain)
1. deploy-contracts, deploy-timelock (48h), create 3 tokens/pools ($10 init reserve each).
2. **Posture** (deployer-executed, `scripts/execute-posture-mainnet.js`): addAttester, threshold=1,
   3× setMintBudget(1.5M), 3× write-once setWeightGenesis, disableLegacyMints. 9 txs.
3. **Pre-handoff role fix** (`scripts/fix-deployer-roles-mainnet.js`): grant SUBMITTER→relayer,
   revoke SUBMITTER/RECORDER←deployer. 3 txs.
4. **Handoff** (`transfer-governance.js`): 41 actions → timelock/Safe, deployer revoked.
5. **Safe cleanup** (`deployments/mainnet-deployer-role-cleanup-safe.json`, 2-of-3): revoke the
   SUBMITTER/RECORDER the handoff re-granted to the deployer.
6. verify-governance 55/55 · verify-posture-post PASS.

## Deviations from `mainnet-rc1` (launch tooling only — no deployed-bytecode change)
These were required live and must be folded back into the repo + rehearsal in a follow-up PR:
1. **create-mainnet-pools.js** — used `ethers.getSigners()` instead of the KMS `getDeploySigner`.
2. **execute-posture-mainnet.js** (new) — the mainnet posture had to be executed by the DEPLOYER
   (which holds the roles pre-handoff), not the Safe bundle the conductor generated (`--execute`
   blocked on mainnet was the wrong guard for this pre-handoff phase).
3. **`governance-policy.json` root-cause bug** — DeltaVerifier `SUBMITTER_ROLE` and
   DataContributionRegistry `RECORDER_ROLE` resolve via `DEPLOYMENT_ROLE:…`, which points at the
   **deployer** (the deploy recorded it there), and neither role is in `revokedFromDeployer`. So the
   handoff **re-granted** both to the deployer after step 3 removed them, failing verify-posture-post
   and forcing the step-5 Safe cleanup. **Fix:** point SUBMITTER at `submitterRelayer`, add
   SUBMITTER/RECORDER to `revokedFromDeployer`, and have the deploy grant SUBMITTER to the relayer
   (not the deployer). The Sepolia rehearsal didn't catch this because its deploy/role mapping differed.
4. **.env.mainnet** — added the `KMS_DEPLOYER_KEY_ID` / `KMS_DEPLOYER_EXPECTED_ADDRESS` / `AWS_REGION`
   names `getDeploySigner` actually reads (local secrets file, not committed).
