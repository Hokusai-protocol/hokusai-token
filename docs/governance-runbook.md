# Governance Runbook

This runbook defines the production governance model for privileged Hokusai contract administration. High-impact owner and admin actions are controlled by an OpenZeppelin `TimelockController` governed by the designated Safe `0x158B985CC667b4E022AD05B99E89007790da66E2`. Emergency pause remains fast, but only through narrowly scoped emergency permissions.

Use this document together with [Mainnet Deployment Checklist](mainnet-deployment-checklist.md), [Mainnet Custody And Role Rehearsal Runbook](mainnet-custody-runbook.md), and [Mainnet Launch Day Rollback Runbook](mainnet-launch-rollback-runbook.md).

## Governance Addresses

Approved governance Safe:

- Address: `0x158B985CC667b4E022AD05B99E89007790da66E2`
- Type: Gnosis Safe
- Threshold: `2-of-3`
- Timelock proposer: Safe
- Timelock executor: Safe
- Timelock canceller: Safe

Default timelock delays:

- Sepolia rehearsal: `300` seconds
- Mainnet production: `172800` seconds (`48` hours)

Emergency Safe policy:

- `EMERGENCY_SAFE_ADDRESS` defaults to the same Safe unless a separate emergency Safe is approved.
- A separate emergency Safe is allowed only if it holds pause-only permissions and no broad admin or minting authority.

## Governance Model

The timelock is the long-lived owner or `DEFAULT_ADMIN_ROLE` holder for high-impact contracts. The Safe controls the timelock by holding `PROPOSER_ROLE`, `EXECUTOR_ROLE`, and `CANCELLER_ROLE`. The deployer EOA must not retain owner, `DEFAULT_ADMIN_ROLE`, `GOV_ROLE`, or `PAUSER_ROLE` after the transfer is complete and verified.

Emergency actions are intentionally split:

- `pause()` on `DeltaVerifier` and `InfrastructureReserve` is controlled by `PAUSER_ROLE`.
- AMM pool pause is controlled indirectly through `HokusaiAMMFactory.setPauser(...)` and factory pause wrappers.
- `unpause()` remains a timelocked governance action.

Operational service roles remain outside the timelock, but they stay narrowly scoped and must be documented with their service wallet owners.

## Control Matrix

| Contract | Timelocked control | Emergency-only control | Operational roles |
| --- | --- | --- | --- |
| `ModelRegistry` | Timelock owns `owner()` | None | Pool registrar wiring only as documented in deployment |
| `TokenManager` / `DeployableTokenManager` | Timelock owns `owner()` and `DEFAULT_ADMIN_ROLE` | None | `MINTER_ROLE`, `DEPLOYER_ROLE` service wallets |
| `HokusaiToken` | Timelock owns `owner()` | None | None |
| `HokusaiParams` | Timelock holds `DEFAULT_ADMIN_ROLE` and `GOV_ROLE` | None | None |
| `HokusaiAMMFactory` | Timelock owns `owner()` | Factory `pauser` set to emergency Safe | None |
| `HokusaiAMM` pools | Factory remains `owner()` | Emergency Safe pauses via factory pause functions | None |
| `DeltaVerifier` | Timelock holds `DEFAULT_ADMIN_ROLE` | Emergency Safe holds `PAUSER_ROLE` | `SUBMITTER_ROLE` service wallet |
| `InfrastructureReserve` | Timelock holds `DEFAULT_ADMIN_ROLE` | Emergency Safe holds `PAUSER_ROLE` | `DEPOSITOR_ROLE`, `PAYER_ROLE` service wallets |
| `InfrastructureCostOracle` | Timelock holds `DEFAULT_ADMIN_ROLE` and `GOV_ROLE` | None | None |
| `UsageFeeRouter` | Timelock holds `DEFAULT_ADMIN_ROLE` | None | `FEE_DEPOSITOR_ROLE` backend service |
| `DataContributionRegistry` | Timelock holds `DEFAULT_ADMIN_ROLE` | None | `RECORDER_ROLE`, `VERIFIER_ROLE` service wallets |
| `FundingVault` | Timelock holds `DEFAULT_ADMIN_ROLE` | None | `GRADUATOR_ROLE` service wallet |

Operational service wallet registry:

- `UsageFeeRouter.FEE_DEPOSITOR_ROLE`: `____________________________`
- `DeltaVerifier.SUBMITTER_ROLE`: `____________________________`
- `DataContributionRegistry.RECORDER_ROLE`: `____________________________`
- `DataContributionRegistry.VERIFIER_ROLE`: `____________________________`
- `InfrastructureReserve.DEPOSITOR_ROLE`: `____________________________`
- `InfrastructureReserve.PAYER_ROLE`: `____________________________`
- `TokenManager.MINTER_ROLE`: `____________________________`
- `TokenManager.DEPLOYER_ROLE`: `____________________________`
- `FundingVault.GRADUATOR_ROLE`: `____________________________`

## Deployment And Transfer Procedure

Run this sequence on Sepolia first, then on mainnet.

1. Deploy the application stack and save `deployments/<network>-latest.json`.
2. Deploy the timelock:

```bash
npm run governance:deploy:timelock:sepolia
```

3. Confirm the deployment artifact now includes:
   - `governance.timelock`
   - `governance.adminSafe`
   - `governance.emergencySafe`
   - `governance.minDelay`
4. Run the governance transfer script in dry-run mode first:

```bash
DRY_RUN=true npx hardhat run scripts/governance/transfer-governance.js --network sepolia
```

5. Execute the real transfer after reviewing the action plan:

```bash
npm run governance:transfer:sepolia
```

6. Verify the end state:

```bash
npm run verify:governance:sepolia
```

7. Archive the generated verification report:
   - `deployments/governance-verification-<network>-latest.json`
   - `deployments/governance-verification-<network>-<timestamp>.json`

Transfer rules:

- Never transfer ownership to the timelock until the timelock exists on-chain and the Safe holds its proposer, executor, and canceller roles.
- Grant timelock roles before revoking the deployer.
- Leave operational service roles in place unless a separate rotation is being performed.
- Re-run the transfer script if a partial failure occurs; it is designed to be idempotent.

## Timelocked Governance Actions

Use the Safe to call the timelock. The timelock then executes the target contract call after the delay elapses.

Standard flow:

1. Build the calldata for the privileged operation.
2. Schedule the operation through the timelock:

```solidity
schedule(target, value, data, predecessor, salt, delay)
```

3. Wait until the delay has elapsed.
4. Execute the operation:

```solidity
execute(target, value, data, predecessor, salt)
```

Notes:

- `predecessor` can be `bytes32(0)` for ordinary independent operations.
- `salt` can be `bytes32(0)`, but use a unique salt when scheduling similar calls to avoid ambiguity.
- The timelock Safe should review decoded calldata before signing, not just raw bytes.

Representative timelocked actions:

- `HokusaiToken.setController()`
- `TokenManager.setDeltaVerifier()`
- `TokenManager.setVestingVault()`
- `ModelRegistry` register/update/deactivate/reactivate paths
- `DeltaVerifier` reward parameter setters
- `HokusaiParams` governance setters
- `InfrastructureCostOracle` governance setters
- `HokusaiAMMFactory.setDefaults()` and treasury changes
- `UsageFeeRouter`, `DataContributionRegistry`, `FundingVault`, and other admin role grants or revocations

## Cancel Procedure

If a queued action should not execute, the Safe cancels it through the timelock:

```solidity
cancel(operationId)
```

Use cancellation when:

- calldata was encoded incorrectly
- the target address was wrong
- conditions changed during the delay window
- an incident requires superseding the queued action with a different proposal

Record the cancellation reason and transaction hash in the rehearsal or mainnet operations log.

## Emergency Pause Procedure

Emergency pause is for exploit response, reserve protection, submission containment, or disabling a broken pool path. It is not for ordinary policy changes.

Fast-path emergency actions:

- `DeltaVerifier.pause()` by emergency Safe `PAUSER_ROLE`
- `InfrastructureReserve.pause()` by emergency Safe `PAUSER_ROLE`
- `HokusaiAMMFactory.pausePool(...)` or batch pause functions by emergency Safe factory `pauser`

Required restrictions:

- The emergency Safe must not hold broad governance roles such as `DEFAULT_ADMIN_ROLE`, `GOV_ROLE`, or token ownership solely for pause convenience.
- Parameter changes, treasury changes, and all unpause actions stay on the timelock path.

Emergency checklist:

1. Identify affected contracts and latest suspicious transactions.
2. Draft pause transactions from the emergency Safe.
3. Validate chain ID, target addresses, and calldata.
4. Execute the pause transactions.
5. Confirm `paused() == true` and expected operations revert.
6. Disable frontend/backend write paths if user exposure exists.
7. Record transaction hashes and incident notes.

## Unpause Procedure

Unpause is a governance action and should be executed through the timelock after root cause and remediation are confirmed.

Standard unpause flow:

1. Confirm the incident is resolved.
2. Confirm no compensating parameter or role changes are still required.
3. Schedule the unpause through the timelock.
4. Wait for the delay.
5. Execute the unpause.
6. Run a small smoke test where safe to do so.

## Verification And Audit Procedure

Use the governance verification script after every Sepolia rehearsal and after every mainnet governance transfer or major role rotation.

```bash
npx hardhat run scripts/governance/verify-governance.js --network <network>
```

The script checks:

- timelock proposer, executor, and canceller roles
- revoked deployer access
- `owner()` on `Ownable` contracts
- `hasRole()` expectations on `AccessControl` contracts
- per-token `HokusaiToken` and `HokusaiParams` governance state

Treat any failed check as a launch blocker until fixed and re-verified.

## Rollback And Recovery

Governance recovery also goes through the timelock unless the immediate need is an emergency pause.

Representative recovery actions:

- re-transfer ownership from the timelock to a replacement governance address
- re-grant or revoke roles
- rotate the emergency Safe or service wallet addresses
- update factory pauser assignment

If the issue is urgent, pause first through the emergency path and then schedule the corrective governance action through the timelock.

## Future Upgradeability Policy

If any future upgradeability is introduced, all upgrade authority must be assigned to the timelock-controlled Safe path. This includes any `ProxyAdmin`, `upgradeTo`, `upgradeToAndCall`, beacon admin, or equivalent upgrade surface.

No deployer EOA or hot operational wallet should ever retain upgrade authority on mainnet.
