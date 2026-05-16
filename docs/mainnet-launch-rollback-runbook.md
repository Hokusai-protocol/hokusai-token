# Mainnet Launch Day Rollback Runbook

This runbook is the launch-day rollback companion to [Mainnet Custody And Role Rehearsal Runbook](mainnet-custody-runbook.md). Use it when a mainnet deployment, pool launch, custody handoff, monitoring activation, or public launch step fails or shows unsafe state.

Ethereum deployments cannot be deleted or reverted after confirmation. In this document, "rollback" means stopping user impact, preserving evidence, returning operational control to a known safe state, and deciding whether to continue with the deployed addresses, pause them, replace them, or abandon them.

## Rollback Authority

Do not improvise during launch. Before mainnet deployment starts, assign these names and confirm they are reachable.

| Role | Person / address | Responsibility |
| --- | --- | --- |
| Incident commander | `____________________________` | Owns go/no-go, rollback, and resume decisions. |
| Deployment operator | `____________________________` | Executes deployment scripts and read-only verification. |
| Safe transaction drafter | `____________________________` | Drafts pause, revoke, transfer, or emergency transactions. |
| Safe reviewer | `____________________________` | Verifies calldata, target addresses, chain ID, and nonce. |
| Backend/frontend operator | `____________________________` | Disables UI/API flows and deploys config changes. |
| Communications owner | `____________________________` | Sends internal/external status updates. |

Rollback decisions require approval from:

- [ ] Incident commander
- [ ] Custody owner or Safe signer quorum representative
- [ ] Technical reviewer
- [ ] Backend/frontend operator, if user-facing flows are live

## Stop Conditions

Trigger this runbook immediately if any condition below is true.

- Wrong chain ID, wrong deployer, wrong treasury, wrong backend depositor, or wrong verifier address.
- Deployment artifact is missing, corrupt, inconsistent with chain state, or written from a dirty/unapproved git SHA.
- Any expected contract address is zero, undeployed, unverified, or wired to the wrong dependency.
- `TokenManager`, `ModelRegistry`, `HokusaiAMMFactory`, `InfrastructureReserve`, `UsageFeeRouter`, `DeltaVerifier`, or `InfrastructureCostOracle` ownership/roles do not match the approved custody matrix.
- Safe cannot execute required admin transactions.
- AMM pool owner does not have an executable emergency pause path.
- Monitoring is not live before pools are announced.
- Unexpected reserve movement, token mint, supplier allocation distribution, role change, pause event, or treasury transfer is detected.
- A launch smoke transaction produces wrong balances, reserves, fees, phase state, or events.
- Frontend/backend points users at unapproved addresses.
- Any private key, backend key, Safe signer, RPC credential, or deployment host is suspected compromised.

## Severity Levels

| Severity | Definition | Immediate action |
| --- | --- | --- |
| `P0` | User funds, custody, mint authority, reserves, or public trading are at risk | Freeze launch, pause affected contracts, disable frontend/backend writes, assemble Safe signers. |
| `P1` | Deployment state is wrong before public user exposure | Stop deployment sequence, do not announce, preserve artifacts, decide continue vs redeploy. |
| `P2` | Non-critical verification, docs, monitoring, or UX issue | Hold announcement until fixed or explicitly accepted. |

## First Five Minutes

1. Announce in the launch channel: `ROLLBACK RUNBOOK ACTIVE - no further deployment, pool, custody, frontend, or announcement actions without incident commander approval.`
2. Stop scripts and background jobs that can mutate mainnet state.
3. Save the current terminal output, deployment artifact path, git SHA, block number, and transaction hashes.
4. Disable user-facing writes:
   - frontend buy/sell controls
   - backend fee-deposit jobs
   - backend verifier/submitter jobs
   - public announcement queue
5. Identify the current launch stage using the matrix below.
6. Choose the lowest-risk rollback path for that stage.

## Rollback Matrix By Launch Stage

| Stage | Public/user exposure | Primary rollback action |
| --- | --- | --- |
| Before deployment transaction | None | Abort. Fix configuration or code. Restart only after preflight sign-off. |
| Core contracts deployed, no pools | None unless addresses shared | Stop. Do not use addresses until wiring, roles, artifacts, and verification pass. Redeploy if wiring or constructor inputs are wrong. |
| Pools/tokens created, not announced | Low/internal only | Pause pools if any trading path may be reachable. Disable frontend/backend. Decide whether to keep or abandon addresses. |
| Pools announced, IBR live | High | Pause affected pools, pause `DeltaVerifier`/`InfrastructureReserve` if relevant, disable frontend/API writes, communicate incident status. |
| Post-custody handoff | High | Use Safe-controlled emergency actions only. Do not use deployer key except for read-only checks or explicitly approved temporary-role remediation. |

## Stage 0: Abort Before Deployment

Use this path before any mainnet transaction is confirmed.

- [ ] Stop deployment script.
- [ ] Confirm no transaction is pending in the deployer wallet.
- [ ] Clear any queued Safe transaction that references stale addresses or calldata.
- [ ] Fix `.env`, launch config, gas policy, or branch state.
- [ ] Re-run:

```bash
npx hardhat compile
npm test
DRY_RUN=true npx hardhat run scripts/deploy-mainnet.js
```

- [ ] Get renewed go/no-go approval before starting mainnet transactions.

## Stage 1: Core Contracts Deployed, No Pools

Use this path if core contracts exist but no launch pool is user-facing.

1. Stop all further deployment and pool creation.
2. Compare `deployments/mainnet-latest.json` against on-chain reads.
3. If constructor inputs or dependency wiring are wrong, abandon these addresses and redeploy. Do not attempt to "fix forward" wrong immutable dependencies.
4. If ownership or roles are wrong but recoverable:
   - grant Safe admin/ownership before revoking any deployer access
   - revoke unsafe temporary roles
   - rerun role audit
5. If compromised or uncertain, grant no new roles and move to Safe-controlled containment if possible.

Containment checklist:

- [ ] No pools created from the affected factory.
- [ ] Backend/frontend not configured with affected addresses.
- [ ] No public announcement sent.
- [ ] Artifact marked `abandoned` in launch notes if redeploying.
- [ ] Replacement deployment uses a new artifact and fresh sign-off.

## Stage 2: Pools Created, Not Publicly Announced

Use this path if launch tokens/pools exist but public traffic has not started.

1. Disable frontend/backend references to the new pool addresses.
2. Pause every affected AMM pool if the pause path is executable:

```solidity
HokusaiAMM(<POOL>).pause()
```

3. Pause `DeltaVerifier` if contribution submissions could mint rewards against the affected model:

```solidity
DeltaVerifier(<DELTA_VERIFIER>).pause()
```

4. Pause `InfrastructureReserve` if fee deposits or infrastructure payments could hit the wrong model/accounting state:

```solidity
InfrastructureReserve(<INFRA_RESERVE>).pause()
```

5. If supplier allocations were distributed early, record the token, recipient, amount, and transaction hash. Treat this as a custody/accounting incident before deciding to reuse the token.
6. Decide:
   - continue after correcting off-chain config
   - keep contracts deployed but paused/unannounced
   - abandon and redeploy with new addresses

Minimum checks before resuming:

- [ ] Each pool `paused()` value matches the chosen state.
- [ ] `reserveBalance` equals expected reserve for every active pool.
- [ ] `reserveToken.balanceOf(pool) >= reserveBalance`.
- [ ] `totalSupply()` and supplier distribution state match launch plan.
- [ ] Monitoring sees every pool and pause event.
- [ ] Frontend/backend config references only approved addresses.

## Stage 3: Public Launch Or Trading Live

Use this path once any address has been announced or a user can trade.

1. Freeze public launch comms.
2. Disable frontend trading controls and backend write jobs.
3. Pause the smallest affected surface first:
   - affected AMM pool(s)
   - `DeltaVerifier`, if reward minting/submissions are implicated
   - `InfrastructureReserve`, if deposits/payments are implicated
4. Preserve current state:
   - deployment artifact
   - frontend/backend release identifiers
   - monitoring logs
   - alert IDs
   - suspicious tx hashes
   - Safe tx hashes
5. Run read-only verification for affected contracts.
6. Publish internal status with:
   - what is paused
   - whether funds/reserves are safe
   - whether user action is needed
   - next update time

Do not unpause or resume public launch until the incident commander and custody owner sign off.

## Backend And Frontend Rollback

The fastest safe user-impact rollback is usually off-chain first, then on-chain pause if needed.

Backend actions:

- [ ] Stop fee-deposit workers that call `UsageFeeRouter`.
- [ ] Stop verifier/submitter workers that call `DeltaVerifier`.
- [ ] Stop any automated supplier-allocation or pool-creation job.
- [ ] Rotate hot keys if compromise is suspected.
- [ ] Confirm no retry queue can resubmit failed mainnet writes.

Frontend actions:

- [ ] Remove or hide launch pool addresses.
- [ ] Disable buy/sell/write buttons.
- [ ] Show maintenance or paused state for affected pools.
- [ ] Confirm cached deployment config is invalidated.
- [ ] Confirm wallet network prompts do not route users into affected contracts.

## Safe Transaction Checklist

Every emergency Safe transaction must be reviewed before signing.

- [ ] Chain ID is `1`.
- [ ] Safe address is the approved mainnet treasury/admin Safe.
- [ ] Target address matches `deployments/mainnet-latest.json` and on-chain code exists.
- [ ] Function selector matches the intended action.
- [ ] Calldata decoded independently by the reviewer.
- [ ] Nonce is expected.
- [ ] No bundled transaction includes an unrelated role grant, ownership transfer, or payment.
- [ ] Etherscan simulation or Safe simulation passes, if available.
- [ ] Transaction hash recorded after execution.

## Read-Only Verification Commands

Use scripts where available. If a script does not exist, use Etherscan, Hardhat console, or a one-off read-only call. Do not add new write automation during rollback.

Required reads:

- [ ] `owner()` for `ModelRegistry`, `TokenManager`, `HokusaiAMMFactory`, and every AMM pool.
- [ ] Role holders or `hasRole(...)` checks for `TokenManager`, `DataContributionRegistry`, `InfrastructureReserve`, `UsageFeeRouter`, `DeltaVerifier`, and `InfrastructureCostOracle`.
- [ ] `paused()` for every AMM pool, `InfrastructureReserve`, and `DeltaVerifier`.
- [ ] `reserveBalance()`, `reserveToken.balanceOf(pool)`, `spotPrice()`, `getCurrentPhase()`, and `hasGraduated()` for every AMM pool.
- [ ] `totalSupply()`, `maxSupply()`, `modelSupplierDistributed()`, and `modelSupplierRecipient()` for every launch token.
- [ ] Artifact git SHA and script SHA match the approved release.

## Resume Criteria

Resume launch only after all items are true.

- [ ] Root cause is known and documented.
- [ ] Affected on-chain contracts are either confirmed safe or explicitly abandoned.
- [ ] Any required pause/revoke/transfer transaction has executed and been verified.
- [ ] Backend/frontend write paths are configured to the approved address set.
- [ ] Monitoring has caught up and alerts are green.
- [ ] A small smoke transaction is approved as economically safe, or explicitly skipped.
- [ ] Incident commander approves resume.
- [ ] Custody owner approves resume.
- [ ] Communications owner has the internal/external message ready.

## Abandon Criteria

Abandon deployed addresses and redeploy if any of these are true.

- Wrong immutable constructor dependency.
- Wrong reserve token on mainnet.
- Wrong treasury or backend address cannot be safely corrected.
- Pool pause path is not executable and trading can be reached.
- Mint/burn authority is held by an untrusted or compromised address.
- Supplier allocation was distributed to the wrong recipient.
- Artifact integrity cannot be trusted.
- Safe cannot obtain or exercise required admin control.

When abandoning:

- [ ] Pause what can be paused.
- [ ] Revoke what can be revoked without increasing risk.
- [ ] Do not transfer additional funds to abandoned contracts.
- [ ] Mark the artifact and launch notes as abandoned.
- [ ] Publish replacement addresses only after fresh verification.

## Rollback Log

| Time UTC | Event / decision | Tx hash / artifact / link | Owner | Status |
| --- | --- | --- | --- | --- |
| `YYYY-MM-DD HH:MM` | Rollback runbook activated | `____________________________` | `___` | `open` |
| `YYYY-MM-DD HH:MM` | Frontend/backend writes disabled | `____________________________` | `___` | `open` |
| `YYYY-MM-DD HH:MM` | Pool pause submitted/executed | `0x____________________________` | `___` | `open` |
| `YYYY-MM-DD HH:MM` | Role/custody remediation submitted/executed | `0x____________________________` | `___` | `open` |
| `YYYY-MM-DD HH:MM` | Resume/abandon decision | `____________________________` | `___` | `open` |

## Final Sign-Off

- Incident commander: `____________________________`
- Custody owner: `____________________________`
- Technical reviewer: `____________________________`
- Backend/frontend operator: `____________________________`
- Communications owner: `____________________________`
- Final state: `resumed / paused pending fix / abandoned / redeployed`
- Final artifact: `____________________________`
- Final transaction list: `____________________________`
- Date: `YYYY-MM-DD`
