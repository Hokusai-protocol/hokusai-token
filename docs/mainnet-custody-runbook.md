# Mainnet Custody And Role Rehearsal Runbook

This runbook must be completed before any Hokusai mainnet deployment. It defines production custody, role ownership, signer separation, Sepolia rehearsal steps, the emergency pause procedure, and the launch-day rollback reference for the live-deployable stack.

Related governance procedure: [Governance Runbook](governance-runbook.md). Related launch-day rollback procedure: [Mainnet Launch Day Rollback Runbook](mainnet-launch-rollback-runbook.md). Treat this custody runbook as the single entry point for signer assignment and rehearsal, and use the governance runbook as the canonical source for timelock proposal, execution, and verification mechanics.

The current deployment guide records `DeployableTokenManager` under `contracts.TokenManager` in deployment artifacts. In this document, `TokenManager` means the deployed address recorded as `contracts.TokenManager`, regardless of whether the implementation is `TokenManager` or `DeployableTokenManager`.

## Deployment Gate

Do not deploy to mainnet until every item in this section is checked.

- [ ] Treasury/admin Safe exists on Ethereum mainnet.
- [ ] Treasury/admin Safe signer set and threshold are approved in writing.
- [ ] Sepolia rehearsal Safe exists with the same signer threshold, or an explicitly approved lower threshold for rehearsal only.
- [ ] Backend fee depositor address is documented.
- [ ] Deployer Ledger address is documented.
- [ ] Emergency operator and backup operator addresses are documented.
- [ ] Launch-day rollback authority and operators are documented in [Mainnet Launch Day Rollback Runbook](mainnet-launch-rollback-runbook.md).
- [ ] Role grant/revoke matrix below is completed with concrete addresses.
- [ ] Ownership transfer process is rehearsed on Sepolia.
- [ ] Temporary deployer role revocation process is rehearsed on Sepolia.
- [ ] Emergency pause/unpause process is rehearsed on Sepolia.
- [ ] Launch-day rollback tabletop is rehearsed on Sepolia or a mainnet fork.
- [ ] Rehearsal transaction hashes are recorded.
- [ ] Any Sepolia rehearsal blocker is fixed in code, scripts, or governance process before mainnet.

## Production Custody

Use a Safe plus timelock as the long-lived governance system. The initial single-user Ledger deployer can perform deployment transactions, but it must not remain the long-lived holder of admin ownership, `DEFAULT_ADMIN_ROLE`, `GOV_ROLE`, or `PAUSER_ROLE` after the post-deployment transfer and verification are complete.

Recommended initial custody:

| Purpose | Address | Required control | Notes |
| --- | --- | --- | --- |
| Governance Safe | `0x158B985CC667b4E022AD05B99E89007790da66E2` | `2-of-3` Safe | Controls the timelock as proposer, executor, and canceller. |
| Governance timelock | `0x____________________________` | OZ `TimelockController` | Holds long-lived owner and admin rights after transfer. |
| Deployer Ledger | `0x____________________________` | Single Ledger | Used only for deployment and temporary wiring. Revoke admin roles after rehearsal/mainnet handoff. |
| Backend fee depositor | `0x____________________________` | Backend hot/warm wallet | Receives only `FEE_DEPOSITOR_ROLE`. Must not hold admin roles. |
| Verifier/backend operator | `0x____________________________` | Backend hot/warm wallet | Receives `VERIFIER_ROLE` if automated contribution verification is used. |
| Emergency Safe | `0x____________________________` | Safe or approved signer set | Holds pause-only permissions if distinct from governance Safe. |
| Emergency operator | `0x____________________________` | Ledger or Safe module | First operator for incident response. Must be able to coordinate emergency Safe transactions. |
| Backup operator | `0x____________________________` | Ledger or Safe module | Backup for emergency operator absence. |

Approved governance configuration:

- Mainnet governance Safe address: `0x158B985CC667b4E022AD05B99E89007790da66E2`
- Sepolia rehearsal Safe address: `0x158B985CC667b4E022AD05B99E89007790da66E2`
- Threshold: `2` of `3`
- Mainnet timelock delay: `172800` seconds
- Sepolia timelock delay: `300` seconds
- Emergency Safe address if distinct: `0x____________________________`
- Signers:
  - `0x____________________________`
  - `0x____________________________`
  - `0x____________________________`
- Signer approval record: `____________________________`
- Date approved: `YYYY-MM-DD`

## Role Grant/Revoke Matrix

Complete this matrix before Sepolia rehearsal. The desired end state should leave the deployer Ledger with no long-lived admin role unless there is a written exception.

| Contract | Admin mechanism | Temporary deployer access | Mainnet desired grant | Mainnet desired revoke | Notes |
| --- | --- | --- | --- | --- | --- |
| `TokenManager` | `Ownable.owner()` and `DEFAULT_ADMIN_ROLE` through `AccessControlBase` | `owner`, `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, `DEPLOYER_ROLE` at deploy | Timelock as `owner` and `DEFAULT_ADMIN_ROLE`; only approved minters as `MINTER_ROLE`; deployer role only if launches require it | Revoke deployer `DEFAULT_ADMIN_ROLE`, `MINTER_ROLE`, and `DEPLOYER_ROLE` after wiring unless explicitly retained | `setDeltaVerifier`, `setVestingVault`, deployment fee settings, and role administration are sensitive. |
| `ModelRegistry` | `Ownable.owner()` | Deployer owner at deploy | Timelock as owner | Transfer ownership away from deployer | Owner can register/update/deactivate models and manage pool registrars. |
| `DataContributionRegistry` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE`, `RECORDER_ROLE`, `VERIFIER_ROLE` at deploy | Timelock as `DEFAULT_ADMIN_ROLE`; `DeltaVerifier` as `RECORDER_ROLE`; approved verifier/backend as `VERIFIER_ROLE` | Revoke deployer `DEFAULT_ADMIN_ROLE`, `RECORDER_ROLE`, and `VERIFIER_ROLE` after verification | `RECORDER_ROLE` should normally be contract-only (`DeltaVerifier`). |
| `InfrastructureReserve` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` at deploy | Timelock as `DEFAULT_ADMIN_ROLE`; emergency Safe as `PAUSER_ROLE`; `UsageFeeRouter` as `DEPOSITOR_ROLE`; approved treasury operator as `PAYER_ROLE` | Revoke deployer `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`; do not grant backend payer rights | `pause()` is emergency-safe only; `unpause()` and admin settings are timelocked. |
| `UsageFeeRouter` | `DEFAULT_ADMIN_ROLE` | Deployer `DEFAULT_ADMIN_ROLE` and `FEE_DEPOSITOR_ROLE` at deploy | Timelock as `DEFAULT_ADMIN_ROLE`; backend fee depositor as `FEE_DEPOSITOR_ROLE`; optional deployer depositor only during rehearsal | Revoke deployer `DEFAULT_ADMIN_ROLE`; revoke deployer `FEE_DEPOSITOR_ROLE` after backend smoke test | Backend depositor must be isolated from admin custody. |
| `HokusaiAMMFactory` | `Ownable.owner()` | Deployer owner at deploy | Timelock as owner; emergency Safe as factory `pauser` | Transfer ownership away from deployer after all immediate launch pools are created or after Safe-run pool creation is rehearsed | Factory owner creates pools and changes defaults/treasury. Factory `pauser` handles emergency pool pauses. |
| AMM pools | `Ownable.owner()` on each pool | Factory-created pools remain owned by the factory | Factory remains owner; timelock governs through factory ownership | No deployer ownership should remain | Emergency Safe pauses pools through the factory pause wrappers. Unpause remains a timelocked owner action via the factory. |
| `HokusaiParams` per token | `DEFAULT_ADMIN_ROLE` and `GOV_ROLE` | Constructor grants `DEFAULT_ADMIN_ROLE` to the contract that creates params and `GOV_ROLE` to the configured governor | Timelock as `DEFAULT_ADMIN_ROLE` and `GOV_ROLE` | Revoke any deployer/governor EOA `GOV_ROLE` and `DEFAULT_ADMIN_ROLE` after timelock transfer | `TokenDeploymentFactory` now hands both token ownership and params admin/governance to the configured governor so the subsequent timelock transfer remains operable. |

Optional but related contracts:

| Contract | Desired custody |
| --- | --- |
| `DeltaVerifier` | Timelock as `DEFAULT_ADMIN_ROLE`; emergency Safe as `PAUSER_ROLE`; approved backend submitter as `SUBMITTER_ROLE`; revoke deployer admin, pauser, and submitter rights after backend rehearsal unless intentionally retained. |
| `InfrastructureCostOracle` | Timelock as `DEFAULT_ADMIN_ROLE` and `GOV_ROLE`; revoke deployer admin/governance roles after rehearsal. |
| `RewardVestingVault` | Confirm `tokenManager()` is the deployed TokenManager; document any owner/admin surface if added later. |
| `TokenDeploymentFactory` | Confirm whether it has ownership or role state in the deployed implementation; document before mainnet. |

## Attester Registry Custody (DeltaVerifier, HOK-2126)

The attester registry authorizes mints independently of the `SUBMITTER` relayer (the signature verification that reads it lands in HOK-2132). It is an address **set** plus a **threshold** `m`, governed by `DEFAULT_ADMIN_ROLE`:

| Action | Function | Authority | Path |
| --- | --- | --- | --- |
| Add attester | `addAttester(address)` | `DEFAULT_ADMIN_ROLE` (admin Safe) | **Timelocked** (routine; via the governance timelock) |
| Set threshold `m` | `setAttesterThreshold(uint256)` | `DEFAULT_ADMIN_ROLE` (admin Safe) | **Timelocked** (routine) |
| Remove attester | `removeAttester(address)` | `DEFAULT_ADMIN_ROLE` (admin Safe) | Timelocked for routine rotation; for an incident use **pause first** (below) |
| Emergency halt | `pause()` | `PAUSER_ROLE` (emergency Safe) | **Immediate, no timelock** |

Custody rules:

- **The attester key is separate custody from the `SUBMITTER` relayer key** (hardware-wallet EOA at launch). This separation is the whole point — a compromise of the relayer/consumer host must not yield mint authority.
- **Launch sequence (1-of-1):** `addAttester(launchAttester)` then `setAttesterThreshold(1)`. Verify `attesterCount == 1`, `attesterThreshold == 1`, `isAttester(launchAttester) == true`.
- **Routine rotation (zero-downtime):** `addAttester(new)` (count → 2) then `removeAttester(old)` (count → 1, still meets threshold). Removing an attester that would drop the count below the threshold reverts (`AttesterThresholdWouldBeUnmet`).
- **Emergency (suspected attester compromise):** `pause()` from the emergency Safe halts all mints immediately (no timelock); then rotate (add replacement, remove compromised) and `unpause()`. Do not rely on `removeAttester` alone for an incident — it cannot drop below the threshold.
- **m-of-n later:** add attesters and raise the threshold; no contract/storage change is required. An invalid threshold (`0` or `> attesterCount`) reverts (`InvalidAttesterThreshold`).

Add these to the Sepolia rehearsal: add/rotate/threshold transactions and an attester-compromise pause+rotate drill; record tx hashes in the rehearsal log.

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

### 3. Deploy Timelock And Grant Timelock Admin Before Revoking Deployer

Submit these transactions from the current admin/owner. If the current admin is the deployer Ledger, execute them from the deployer during rehearsal. On mainnet, prefer batching through the Safe once the Safe has enough authority to continue the handoff. Use the exact procedure in [Governance Runbook](governance-runbook.md).

Required grant/transfer sequence:

- [ ] Deploy `HokusaiTimelockController` with Safe proposer/executor/canceller roles and the approved delay
- [ ] Confirm deployer does not retain `TIMELOCK_ADMIN_ROLE`
- [ ] `ModelRegistry.transferOwnership(<TIMELOCK>)`
- [ ] `TokenManager.transferOwnership(<TIMELOCK>)`
- [ ] `TokenManager.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`
- [ ] `DataContributionRegistry.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`
- [ ] `InfrastructureReserve.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`
- [ ] `InfrastructureReserve.grantRole(PAUSER_ROLE, <EMERGENCY_SAFE>)`
- [ ] `UsageFeeRouter.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`
- [ ] `HokusaiAMMFactory.transferOwnership(<TIMELOCK>)`
- [ ] `HokusaiAMMFactory.setPauser(<EMERGENCY_SAFE>)`
- [ ] `DeltaVerifier.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`, if deployed
- [ ] `DeltaVerifier.grantRole(PAUSER_ROLE, <EMERGENCY_SAFE>)`, if deployed
- [ ] `InfrastructureCostOracle.grantRole(DEFAULT_ADMIN_ROLE, <TIMELOCK>)`, if deployed
- [ ] `InfrastructureCostOracle.grantRole(GOV_ROLE, <TIMELOCK>)`, if deployed

Parameter contracts are deployed per token. For each launch token:

- [ ] Confirm configured governor has `GOV_ROLE`.
- [ ] If governor is still an EOA, grant `GOV_ROLE` to the timelock before revocation.
- [ ] Confirm `DEFAULT_ADMIN_ROLE` is also transferred to the timelock.
- [ ] Confirm the token owner is the timelock.
- [ ] Confirm the live `DeployableTokenManager` path transferred `HokusaiParams.DEFAULT_ADMIN_ROLE` and token ownership to the configured governor before the governance migration.
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
- [ ] Timelock-mediated governance can still grant/revoke an operational role in a controlled test.
- [ ] Backend fee depositor can still call `UsageFeeRouter.depositFee`.
- [ ] Unauthorized address cannot call `UsageFeeRouter.depositFee`.

## Emergency Pause/Unpause Rehearsal

Emergency controls cover at least:

- `InfrastructureReserve.pause()` by `PAUSER_ROLE` and `unpause()` by `DEFAULT_ADMIN_ROLE`.
- `DeltaVerifier.pause()` by `PAUSER_ROLE` and `unpause()` by `DEFAULT_ADMIN_ROLE`, if deployed and active.
- `HokusaiAMMFactory.pausePool(...)` and batch pool pauses by factory `pauser`; `unpausePool(...)` remains an owner action through the timelock-owned factory.

Hard gate for pools: after creating Sepolia rehearsal pools, check `pool.owner()` for every pool and confirm it is the factory. Confirm the factory pause wrappers are callable by the configured emergency Safe and that unpause requires the timelock-owned factory path.

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
   - `HokusaiAMMFactory.pausePool(<POOL>)` or the batch pause variant for affected pools.
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
3. Governance Safe schedules timelock transaction(s):
   - `HokusaiAMMFactory.unpausePool(<POOL>)` for affected pools.
   - `DeltaVerifier.unpause()` if submissions can resume.
   - `InfrastructureReserve.unpause()` if deposits/payments can resume.
4. Wait for the approved timelock delay.
5. Backup operator validates calldata, target addresses, and chain ID.
6. Safe signers execute once threshold is met.
7. Confirm on-chain:
   - `paused() == false`
   - `Unpaused(address)` event emitted
   - one small smoke transaction succeeds, where economically safe
8. Record transaction hashes and post-incident approval.

Rehearsal checks:

- [ ] Unauthorized EOA cannot unpause.
- [ ] Emergency Safe cannot unpause each affected contract directly.
- [ ] Timelock-mediated Safe action can unpause each affected contract.
- [ ] Trading resumes after pool unpause.
- [ ] Monitoring alerts fire for `Unpaused(address)`.
- [ ] Frontend/backend state refreshes correctly.

## Launch-Day Rollback Reference

Rollback is not a separate authority path from custody. The same Safe, signer threshold, emergency operator, backup operator, and technical reviewer defined above own rollback execution.

Use [Mainnet Launch Day Rollback Runbook](mainnet-launch-rollback-runbook.md) when any launch step fails or shows unsafe state. At minimum, rehearse these rollback paths before mainnet:

- [ ] Abort before deployment transaction after bad `.env` or gas config is detected.
- [ ] Stop after core contracts deploy but before pools when artifact or wiring verification fails.
- [ ] Pause created pools before public announcement.
- [ ] Disable frontend/backend write paths after a simulated public-launch issue.
- [ ] Draft and review a Safe pause transaction with decoded calldata.
- [ ] Decide continue vs abandon for a deployment with a wrong immutable constructor dependency.

Launch-day stop conditions include wrong chain, wrong custody address, wrong backend/verifier address, failed Safe execution, missing monitoring, unexecutable pool pause path, unexpected reserve movement, unexpected minting, unexpected supplier allocation distribution, or frontend/backend pointing at unapproved addresses.

Hard gate: do not announce pools publicly until the rollback runbook has named operators, the frontend/backend disable path is known, and Safe signers have confirmed availability.

## Mainnet Execution Order

1. Create and approve the mainnet governance Safe.
2. Fund the deployer Ledger with ETH only for deployment gas.
3. Fund the governance Safe with any treasury-owned USDC.
4. Configure `.env` with:
   - `TREASURY_ADDRESS=<MAINNET_SAFE>`
   - `ADMIN_SAFE_ADDRESS=<MAINNET_SAFE>`
   - `EMERGENCY_SAFE_ADDRESS=<EMERGENCY_SAFE_OR_MAINNET_SAFE>`
   - `TIMELOCK_MIN_DELAY=172800`
   - `BACKEND_SERVICE_ADDRESS=<BACKEND_FEE_DEPOSITOR>`
   - `VERIFIER_ADDRESS=<VERIFIER_OR_BACKEND_OPERATOR>`
5. Run compile/tests and mainnet dry-runs from `scripts/README-MAINNET-DEPLOYMENT.md`.
6. Deploy mainnet contracts.
7. Deploy the timelock.
8. Verify contracts on Etherscan.
9. Run governance transfer.
10. Create launch tokens/pools either before the transfer or from the timelock-owned path that has been rehearsed.
11. Verify each pool owner and pause path.
12. Revoke temporary deployer roles.
13. Run backend fee-deposit smoke test with the backend fee depositor.
14. Run governance verification and archive the output.
15. Confirm launch-day rollback operators and Safe signer availability.
16. Approve launch only after custody, monitoring, pause, and rollback checks are green.

## Rehearsal Log

| Step | Sepolia tx hash | Result | Operator initials | Date |
| --- | --- | --- | --- | --- |
| Deploy rehearsal stack | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Deploy rehearsal timelock | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Transfer `ModelRegistry` owner | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Transfer `TokenManager` owner | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Grant timelock admin roles | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Grant emergency Safe pause roles | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Create rehearsal pool | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Confirm pool owner/pause path | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause pool via factory pauser | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause pool via timelock | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause `InfrastructureReserve` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause `InfrastructureReserve` via timelock | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Pause `DeltaVerifier` | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Unpause `DeltaVerifier` via timelock | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Rollback tabletop | `____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Safe pause calldata review | `____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Frontend/backend write-disable drill | `____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Backend fee-deposit smoke test | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Revoke deployer roles | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |
| Final governance verification report | `0x____________________________` | `pass/fail` | `___` | `YYYY-MM-DD` |

## Mainnet Custody Sign-Off

- Custody owner: `____________________________`
- Technical reviewer: `____________________________`
- Emergency operator: `____________________________`
- Backup operator: `____________________________`
- Rollback incident commander: `____________________________`
- Sepolia rehearsal artifact: `____________________________`
- Final role audit artifact: `____________________________`
- Approved for mainnet deployment: `yes/no`
- Approval date: `YYYY-MM-DD`
