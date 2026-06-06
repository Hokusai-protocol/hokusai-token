# Field Naming Review

## Scope and method

Repo-wide review used:

```sh
rg -n "maxSupply|Max Supply|maxSupplyWei" \
  contracts docs deployments scripts services/contract-deployer \
  Hokusai_Token_Metadata.md AMM_SYSTEM_REQUIREMENTS.md
```

Goal: identify in-repo user-facing or operator-facing uses of `maxSupply` that may need clearer naming such as `launchAllocationCap`, `investorAllocation`, or `totalSupply`.

## Findings

- `contracts/HokusaiToken.sol` and `contracts/interfaces/IManagedHokusaiToken.sol`
  - `maxSupply` is part of the deployed contract ABI.
  - Recommendation: do not rename on-chain storage or getter in this task because that would be ABI-breaking. Use display-layer aliases such as `launchAllocationCap` where clearer operator or user messaging is needed.

- `scripts/create-mainnet-pools.js:256`
  - Operator console output currently prints `Max Supply:`.
  - Recommendation: relabel this operator-facing output to `Launch Allocation Cap:` in a separate non-ABI cleanup task.

- `scripts/lib/launch-tokens.js:240`
  - Internal variable `maxSupplyWei` stores supplier allocation + investor allocation in wei.
  - Recommendation: safe to keep as an internal implementation detail for now. A rename to `launchAllocationCapWei` would be cosmetic only.

- `services/contract-deployer/src/monitoring/`
  - Review found `totalSupply` and `tokenSupply` usage, but no misleading user-facing `maxSupply` label.
  - Recommendation: no rename needed in the backend monitoring service.

## Out of scope

- The website/frontend is not in this repository.
- Recommendation for that codebase: prefer `launchAllocationCap` for supplier + investor allocation, `investorAllocation` for AMM sale headroom, and `totalSupply` when showing the full ERC20 supply including reward-bucket minting.

## Notes

- `AMM_SYSTEM_REQUIREMENTS.md` was reviewed and already describes AMM pricing in terms of redeemable circulating supply rather than `maxSupply`, so no wording change was needed there.
