# Mainnet Custody And Role Rehearsal Runbook

This runbook must be completed before any Hokusai mainnet deployment. It defines production custody, role ownership, signer separation, Sepolia rehearsal steps, and the emergency pause procedure for the live-deployable stack.

The current deployment guide records `DeployableTokenManager` under `contracts.TokenManager` in deployment artifacts. In this document, `TokenManager` means the deployed address recorded as `contracts.TokenManager`, regardless of whether the implementation is `TokenManager` or `DeployableTokenManager`.

## Deployment Gate

Do not deploy to mainnet until every item in this section is checked.

- [ ] Treasury/admin Safe exists on Ethereum mainnet.
- [ ] Treasury/admin Safe signer set and threshold are approved in writing.
- [ ] Sepolia rehearsal Safe exists with the same signer threshold, or an explicitly approved lower threshold for rehearsal only.
- [ ] Backend fee depositor address is documented.
- [ ] Deployer Ledger address is documented.
- [ ] Emergency operator and backup operator addresses are documented.
- [ ] Role grant/revoke matrix below is completed with concrete addresses.
- [ ] Ownership transfer process is rehearsed on Sepolia.
- [ ] Temporary deployer role revocation process is rehearsed on Sepolia.
- [ ] Emergency pause/unpause process is rehearsed on Sepolia.
- [ ] Rehearsal transaction hashes are recorded.
- [ ] Any Sepolia rehearsal blocker is fixed in code, scripts, or governance process before mainnet.

## Production Custody

Use a Safe as the long-lived admin and treasury address. The initial single-user Ledger deployer can perform deployment transactions, but it must not remain the long-lived holder of admin ownership or `DEFAULT_ADMIN_ROLE` after the post-deployment custody transfer.

Recommended initial custody:

| Purpose | Address | Required control | Notes |
| --- | --- | --- | --- |
| Treasury/admin Safe | `0x____________________________` | `__-of-__` Safe | Owns long-lived admin rights and receives treasury payments. |
| Deployer Ledger | `0x____________________________` | Single Ledger | Used only for deployment and temporary wiring. Revoke admin roles after rehearsal/mainnet handoff. |
| Backend fee depositor | `0x____________________________` | Backend hot/warm wallet | Receives only `FEE_DEPOSITOR_ROLE`. Must not hold admin roles. |
| Verifier/backend operator | `0x____________________________` | Backend hot/warm wallet | Receives `VERIFIER_ROLE` if automated contribution verification is used. |
| Emergency operator | `0x____________________________` | Ledger or Safe module | First operator for incident response. Must be able to coordinate Safe transactions. |
| Backup operator | `0x____________________________` | Ledger or Safe module | Backup for emergency operator absence. |

Approved Safe configuration:

- Mainnet Safe address: `0x____________________________`
- Sepolia rehearsal Safe address: `0x____________________________`
- Threshold: `__` of `__`
- Signers:
  - `0x____________________________`
  - `0x____________________________`
  - `0x____________________________`
  - `0x____________________________`
  - `0x____________________________`
- Signer approval record: `____________________________`
- Date approved: `YYYY-MM-DD`

## Role Grant/Revoke Matrix

Complete this matrix before Sepolia rehearsal. The desired end state should leave the deployer Ledger with no long-lived admin role unless there is a written exception.

| Contract | Admin mechanism | Temporary deployer access | Mainnet desired grant | Mainnet desired revoke | Notes |
| --- | --- | --- | --- | --- | --- |
| `TokenManager` | `Ownable.owner()` and `DEFAULT_ADMIN_ROLE` through `AccessControlBase` | `owner`, `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, `DEPLOYER_ROLE` at deploy | Treasury/admin Safe as `owner` and `DEFAULT_ADMIN_ROLE`; only approved minters as `MINTER_ROLE`; deployer role only if launches require it | Revoke deployer `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, and `DEPLOYER_ROLE` after wiring unless explicitly retained | `setDeltaVerifier`, `setVestingVault`, deployment fee settings, and role administration are sensitive. |
| `ModelRegistry` | `Ownable.owner()` | Deployer owner at deploy | Treasury/admin Safe as owner | Transfer ownership away from deployer | Owner can register/update/deactivate models and manage pool registrars. |
| `DataContributionRegistry` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE`, `RECORDER_ROLE`, `VERIFIER_ROLE` at deploy | Treasury/admin Safe as `DEFAULT_ADMIN_ROLE`; `DeltaVerifier` as `RECORDER_ROLE`; approved verifier/backend as `VERIFIER_ROLE` | Revoke deployer `DEFAULT_ADMIN_ROLE`, `RECORDER_ROLE`, and `VERIFIER_ROLE` after verification | `RECORDER_ROLE` should normally be contract-only (`DeltaVerifier`). |
| `InfrastructureReserve` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE` at deploy | Treasury/admin Safe as `DEFAULT_ADMIN_ROLE`; `UsageFeeRouter` as `DEPOSITOR_ROLE`; treasury/admin Safe as `PAYER_ROLE` | Revoke deployer `DEFAULT_ADMIN_ROLE`; do not grant backend payer rights | Admin can pause/unpause and emergency withdraw to treasury. |
| `UsageFeeRouter` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE` and `FEE_DEPOSITOR_ROLE` at deploy | Treasury/admin Safe as `DEFAULT_ADMIN_ROLE`; backend fee depositor as `FEE_DEPOSITOR_ROLE`; optional deployer depositor only during rehearsal | Revoke deployer `DEFAULT_ADMIN_ROLE`; revoke deployer `FEE_DEPOSITOR_ROLE` after backend smoke test | Backend depositor must be isolated from admin custody. |
| `HokusaiAMMFactory` | `Ownable.owner()` | Deployer owner at deploy | Treasury/admin Safe as owner, or an approved operational controller if pool creation is delegated | Transfer ownership away from deployer after all immediate launch pools are created or after Safe-run pool creation is rehearsed | Factory owner creates pools and changes defaults/treasury. |
| AMM pools | `Ownable.owner()` on each pool | Factory-created pools are expected to be owned by the factory unless ownership is transferred in the deployment flow | Treasury/admin Safe or emergency-capable controller as owner for each pool | No deployer ownership should remain | Hard gate: confirm `pool.owner()` is callable by the emergency process. If owner is the factory and the factory has no pause wrapper, direct pool pause/unpause is not externally executable. |
| `HokusaiParams` per token | `DEFAULT_ADMIN_ROLE` and `GOV_ROLE` | Constructor grants `DEFAULT_ADMIN_ROLE` to the contract that creates params and `GOV_ROLE` to the configured governor | Treasury/admin Safe or governance timelock as `GOV_ROLE`; params admin path must be explicitly verified for the deployed implementation | Revoke any deployer/governor EOA `GOV_ROLE` after Safe/governance is granted | In the live `DeployableTokenManager` path, params are created by `TokenDeploymentFactory`, so `DEFAULT_ADMIN_ROLE` is expected to be held by that factory contract and may not be externally usable. `emergencySetParam` is admin-only; regular parameter setters require `GOV_ROLE`. |

Optional but related contracts:

| Contract | Desired custody |
| --- | --- |
| `DeltaVerifier` | Treasury/admin Safe as `DEFAULT_ADMIN_ROLE`; approved backend submitter as `SUBMITTER_ROLE`; revoke deployer submitter after backend rehearsal unless intentionally retained. |
| `InfrastructureCostOracle` | Treasury/admin Safe as `DEFAULT_ADMIN_ROLE`; governance/Safe as `GOV_ROLE`; revoke deployer admin/governance roles after rehearsal. |
| `RewardVestingVault` | Confirm `tokenManager()` is the deployed TokenManager; document any owner/admin surface if added later. |
| `TokenDeploymentFactory` | Confirm whether it has ownership or role state in the deployed implementation; document before mainnet. |

## Sepolia Rehearsal

Run this rehearsal on a fresh Sepolia deployment or on an explicitly approved rehearsal deployment. Record every transaction hash in the rehearsal log below.

### 1. Deploy With Production-Like Addresses

Use Ledger-backed deployer access where possible.

```bash
DEPLOYER_PRIVATE_KEY=0x...
TREASURY_ADDRESS=<SEPOLIA_SAFE>
BACKEND_SERVICE_ADDRESS=<SEPOLIA_BACKEND_FEE_DEPOSITOR>
VERIFIER_ADDRESS=<SEPOLIA_VERIFIER>
INFRASTRUCTURE_GROSS_MARGIN_BPS=1500
npm run deploy:sepolia
```

Record:

- Deployment artifact: `deployments/sepolia-________________.json`
- Deployer Ledger: `0x____________________________`
- Sepolia Safe: `0x____________________________`
- Backend fee depositor: `0x____________________________`
- Verifier address: `0x____________________________`

### 2. Verify Initial Custody State

For each contract, read current owner/role state and compare it to the artifact `roles` block.

Required checks:

- [ ] `ModelRegistry.owner()`
- [ ] `TokenManager.owner()`
- [ ] `TokenManager.hasRole(DEFAULT_ADMIN_ROLE, deployer)`
- [ ] `TokenManager.hasRole(MINTER_ROLE, deployer)`
- [ ] `TokenManager.hasRole(DEPLOYER_ROLE, deployer)`
- [ ] `DataContributionRegistry` role holders
- [ ] `InfrastructureReserve` role holders
- [ ] `UsageFeeRouter` role holders
- [ ] `HokusaiAMMFactory.owner()`
- [ ] `DeltaVerifier` role holders, if deployed
- [ ] `InfrastructureCostOracle` role holders, if deployed

### 3. Grant Safe Admin Before Revoking Deployer

Submit these transactions from the current admin/owner. If the current admin is the deployer Ledger, execute them from the deployer during rehearsal. On mainnet, prefer batching through the Safe once the Safe has admin power.

Required grant/transfer sequence:

- [ ] `ModelRegistry.transferOwnership(<SAFE>)`
- [ ] `TokenManager.transferOwnership(<SAFE>)`
- [ ] `TokenManager.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`
- [ ] `DataContributionRegistry.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`
- [ ] `InfrastructureReserve.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`
- [ ] `UsageFeeRouter.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`
- [ ] `HokusaiAMMFactory.transferOwnership(<SAFE>)`
- [ ] `DeltaVerifier.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`, if deployed
- [ ] `InfrastructureCostOracle.grantRole(DEFAULT_ADMIN_ROLE, <SAFE>)`, if deployed

Parameter contracts are deployed per token. For each launch token:

- [ ] Confirm configured governor has `GOV_ROLE`.
- [ ] If governor is still an EOA, grant `GOV_ROLE` to the Safe or timelock.
- [ ] Confirm which address has `DEFAULT_ADMIN_ROLE`.
- [ ] If the live `DeployableTokenManager` path is used, expect `DEFAULT_ADMIN_ROLE` to be held by `TokenDeploymentFactory`; document that admin-only `emergencySetParam` is not operator-callable unless the contract flow changes.
- [ ] Revoke any EOA `GOV_ROLE` once Safe/governance control is verified.

### 4. Revoke Temporary Deployer Roles

Only revoke after Safe admin/ownership has been verified. Use the Safe to submit the revoke transactions during rehearsal.

Required revocations unless there is a written exception:

- [ ] `TokenManager.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`
- [ ] `TokenManager.revokeRole(MINTER_ROLE, <DEPLOYER>)`
- [ ] `TokenManager.revokeRole(DEPLOYER_ROLE, <DEPLOYER>)`
- [ ] `DataContributionRegistry.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`
- [ ] `DataContributionRegistry.revokeRole(RECORDER_ROLE, <DEPLOYER>)`
- [ ] `DataContributionRegistry.revokeRole(VERIFIER_ROLE, <DEPLOYER>)`
- [ ] `InfrastructureReserve.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`
- [ ] `UsageFeeRouter.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`
- [ ] `UsageFeeRouter.revokeRole(FEE_DEPOSITOR_ROLE, <DEPLOYER>)` after backend fee-deposit smoke test
- [ ] `DeltaVerifier.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`, if deployed
- [ ] `DeltaVerifier.revokeRole(SUBMITTER_ROLE, <DEPLOYER>)`, if backend submitter is active
- [ ] `InfrastructureCostOracle.revokeRole(DEFAULT_ADMIN_ROLE, <DEPLOYER>)`, if deployed
- [ ] `InfrastructureCostOracle.revokeRole(GOV_ROLE, <DEPLOYER>)`, if deployed

Post-revocation checks:

- [ ] Deployer cannot grant/revoke roles on AccessControl contracts.
- [ ] Deployer cannot transfer ownership on Ownable contracts.
- [ ] Safe can still grant/revoke an operational role in a controlled test.
- [ ] Backend fee depositor can still call `UsageFeeRouter.depositFee`.
- [ ] Unauthorized address cannot call `UsageFeeRouter.depositFee`.

## Emergency Pause/Unpause Rehearsal

Emergency controls cover at least:

- `InfrastructureReserve.pause()` and `InfrastructureReserve.unpause()` by `DEFAULT_ADMIN_ROLE`.
- `DeltaVerifier.pause()` and `DeltaVerifier.unpause()` by `DEFAULT_ADMIN_ROLE`, if deployed and active.
- Each `HokusaiAMM.pause()` and `HokusaiAMM.unpause()` by `owner()`.

Hard gate for pools: after creating Sepolia rehearsal pools, check `pool.owner()` for every pool. If `pool.owner()` is the factory contract and the factory has no callable pause/unpause wrapper, then the pool pause process is not operational. Fix this before mainnet by changing the deployment/ownership flow or adding an approved factory-level pause path, then repeat rehearsal.

### Pause Drill

Trigger:

- Unexpected reserve movement
- Incorrect fee routing
- Model exploit report
- Price manipulation or trade-size anomaly
- Backend compromise involving fee depositor or verifier roles

Operator steps:

1. Identify affected contract(s), model IDs, pools, and latest suspicious transaction hashes.
2. Emergency operator drafts Safe transaction(s):
   - `pool.pause()` for affected pools.
   - `DeltaVerifier.pause()` if submissions must stop.
   - `InfrastructureReserve.pause()` if infrastructure payments/deposits must stop.
3. Backup operator validates calldata, target addresses, and chain ID.
4. Safe signers execute once threshold is met.
5. Confirm on-chain:
   - `paused() == true`
   - `Paused(address)` event emitted
   - buys/sells or gated operations revert as expected
6. Notify backend/frontend operators to disable affected user flows.
7. Record incident timeline and transaction hashes.

Rehearsal checks:

- [ ] Unauthorized EOA cannot pause.
- [ ] Safe can pause each affected contract.
- [ ] Trading is blocked while a pool is paused.
- [ ] Fee deposits/payments are blocked while `InfrastructureReserve` is paused.
- [ ] Delta submissions are blocked while `DeltaVerifier` is paused.
- [ ] Monitoring alerts fire for `Paused(address)`.

### Unpause Drill

Unpause only after the incident owner confirms root cause, affected state, and remediation.

Operator steps:

1. Confirm the reason for pause is resolved.
2. Confirm no compensating role or parameter action remains pending.
3. Emergency operator drafts Safe transaction(s):
   - `pool.unpause()` for affected pools.
   - `DeltaVerifier.unpause()` if submissions can resume.
   - `InfrastructureReserve.unpause()` if deposits/payments can resume.
4. Backup operator validates calldata, target addresses, and chain ID.
5. Safe signers execute once threshold is met.
6. Confirm on-chain:
   - `paused() == false`
   - `Unpaused(address)` event emitted
   - one small smoke transaction succeeds, where economically safe
7. Record transaction hashes and post-incident approval.

Rehearsal checks:

- [ ] Unauthorized EOA cannot unpause.
- [ ] Safe can unpause each affected contract.
- [ ] Trading resumes after pool unpause.
- [ ] Monitoring alerts fire for `Unpaused(address)`.
- [ ] Frontend/backend state refreshes correctly.

## Mainnet Execution Order

1. Create and approve the mainnet Safe.
2. Fund the deployer Ledger with ETH only for deployment gas.
3. Fund the treasury/admin Safe with any treasury-owned USDC.
4. Configure `.env` with:
   - `TREASURY_ADDRESS=<MAINNET_SAFE>`
   - `BACKEND_SERVICE_ADDRESS=<BACKEND_FEE_DEPOSITOR>`
   - `VERIFIER_ADDRESS=<VERIFIER_OR_BACKEND_OPERATOR>`
5. Run compile/tests and mainnet dry-runs from `scripts/README-MAINNET-DEPLOYMENT.md`.
6. Deploy mainnet contracts.
7. Verify contracts on Etherscan.
8. Perform ownership/admin grants to the Safe.
9. Create launch tokens/pools either from the Safe-controlled owner or from a temporary deployer flow that has been rehearsed.
10. Verify each pool owner and pause path.
11. Revoke temporary deployer roles.
12. Run backend fee-deposit smoke test with the backend fee depositor.
13. Run read-only role audit and archive the output.
14. Approve launch only after custody, monitoring, and pause checks are green.

## Rehearsal Log

| Step | Sepolia tx hash | Result | Operator initials | Date |
| --- | --- | --- | --- | --- |
| Deploy rehearsal stack | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Transfer `ModelRegistry` owner | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Transfer `TokenManager` owner | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Grant Safe admin roles | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Create rehearsal pool | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Confirm pool owner/pause path | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause pool | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause pool | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause `InfrastructureReserve` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause `InfrastructureReserve` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause `DeltaVerifier` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause `DeltaVerifier` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Backend fee-deposit smoke test | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Revoke deployer roles | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Final role audit | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |

## Mainnet Custody Sign-Off

- Custody owner: `____________________________`
- Technical reviewer: `____________________________`
- Emergency operator: `____________________________`
- Backup operator: `____________________________`
- Sepolia rehearsal artifact: `____________________________`
- Final role audit artifact: `____________________________`
- Approved for mainnet deployment: `yes/no`
- Approval date: `YYYY-MM-DD`
