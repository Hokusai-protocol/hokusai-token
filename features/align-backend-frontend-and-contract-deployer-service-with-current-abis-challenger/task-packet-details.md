## 1. Objective

### What
Align the contract-deployer service, backend usage-fee depositor path, and frontend wallet flows with the current smart-contract ABIs, addresses, function signatures (notably `deployTokenWithAllocations`), the params tuple (oracle price + vesting config), the current `UsageFeeRouter` API, and current event names — verified against Sepolia.

### Why
The contracts have moved through a series of breaking changes (allocation-based token creation replacing legacy `deployToken` in #91, params-tuple changes adding oracle price in #81/#89 and vesting in #83, factory/constructor changes in #90, `UsageFeeRouter` model-active enforcement in #76). Off-chain consumers still carry stale ABIs/addresses and will revert or silently mis-decode events against the current stack. This task is a hard blocker for HOK-658 (Mainnet deployment): off-chain systems must read/write the deployed contracts correctly before launch.

### Scope In
- Regenerate and replace bundled ABI JSON files used by the contract-deployer service and reference tooling from freshly compiled artifacts.
- Update contract-deployer environment configuration/validation to point at current Sepolia addresses.
- Update the backend/API usage-fee depositor path to the current `UsageFeeRouter` API and add a test exercising it against Sepolia contracts.
- Update frontend wallet-flow logic and the integration docs the frontend consumes to handle approvals, buys, sells, IBR disabled-sell state, slippage/deadline errors, and network mismatch.
- Document production env-var and SSM/secret updates (names and purpose only).

### Scope Out
- No changes to Solidity contract source under `contracts/` (this task consumes current contracts; it does not modify them).
- No new on-chain deployments to mainnet (Sepolia verification only).
- No changes to the monitoring service (`hokusai-monitor-testnet`) beyond ABIs it shares, unless a shared ABI file is updated.
- No redesign of frontend UI visuals beyond the wallet-flow state/error handling required here.
- No rotation of actual secrets — documentation of which secrets exist/change only.

---

## 2. Technical Context

### Repository
Single repo: the `hokusai-token` smart-contracts monorepo (current working directory). The frontend referenced by the acceptance criteria is represented in this repo by the integration contract surface in `docs/integration/smart-contracts.md` and example code under `docs/examples/react`, `docs/examples/typescript`. If a separate frontend repo is the true target, treat the integration doc + example clients here as the authoritative source of truth to update; flag the separate-repo follow-up in the PR description rather than silently assuming it.

### Key Files
- `services/contract-deployer/contracts/DeltaVerifier.json` — service-bundled DeltaVerifier ABI (exists; updated #89).
- `services/contract-deployer/contracts/*.json` — any sibling bundled ABIs (TokenManager, UsageFeeRouter, ModelRegistry, factory) the service loads; enumerate and update each.
- `services/contract-deployer/src/config/env.validation.ts` — env/address validation (exists; updated #89).
- `services/contract-deployer/src/blockchain/delta-verifier-client.ts` — on-chain client (exists; updated #89).
- `services/contract-deployer/src/index.ts` — service entry/wiring (exists).
- `services/contract-deployer/tests/integration/mint-request-flow.test.ts` — existing integration test to extend/mirror (exists).
- `tools/deltaone-simulator/abis/DeltaVerifier.json`, `tools/deltaone-simulator/abis/TokenManager.json` — reference ABIs (exist; updated #88, #89).
- `docs/integration/smart-contracts.md` — integration surface doc consumed by frontend/backend (exists; updated #91, #89).
- `deployments/sepolia-latest.json`, `deployments/sepolia-v2-latest.json` — current Sepolia address artifacts to source addresses from (exist; updated #95, #90).
- `services/contract-deployer/docs/` — service env/SSM documentation location for secret-name documentation (planned doc update).
- `services/contract-deployer/.env.example` (planned, if not present) — documents required env var names without values.

### Relevant Subsystem Specs

> ⚠️ **Knowledge Gap**: No subsystem specs were provided in the codebase context for this area (`.wavemill/context/` not present in the supplied tree). After implementation, consider running `wavemill context init --force` to create subsystem documentation for the contract-deployer service and off-chain ABI alignment, enabling persistent downstream acceleration.

One persistent project memory applies: **Protocol vs instance separation** — contracts must be model-agnostic; model-specific choices belong in config (`memory/feedback_protocol_vs_instance.md`). Honor this when wiring addresses/params.

### Dependencies
- Compiled contract artifacts: requires `npx hardhat compile` to produce current `artifacts/` ABIs (depends on the contract stack at HEAD: #90–#94).
- Current Sepolia deployment addresses: `deployments/sepolia-latest.json` and/or `deployments/sepolia-v2-latest.json`.
- A funded Sepolia RPC endpoint and a depositor key (provided via env/SSM at runtime, never committed) for the Sepolia-targeted integration tests.
- `ethers`/provider stack already used by `services/contract-deployer/src/blockchain/`.

### Architecture Notes
- **Allocation-based token creation**: legacy `deployToken` was replaced by allocation-based creation (#91, `scripts/lib/launch-tokens.js`). Consumers must call/encode `deployTokenWithAllocations` with the current allocation array shape.
- **Params tuple**: now includes oracle price (#81, #89) and vesting config (#83, #51). The tuple field order/types must mirror `contracts/HokusaiParams.sol` / `contracts/interfaces/IHokusaiParams.sol` exactly.
- **UsageFeeRouter**: enforces model-active state (#76, `contracts/UsageFeeRouter.sol`). The depositor path must handle the active-state revert path explicitly.
- **Event names**: source of truth is the compiled ABI; the deltaone-simulator and service ABIs were last synced at #88/#89 — re-verify against HEAD artifacts.
- **ABI sync pattern**: established pattern is copying ABI from `artifacts/contracts/<Name>.sol/<Name>.json` into the service/tools ABI dirs (as done in #89). Follow it; do not hand-edit JSON.

---

## 3. Implementation Approach

1. **Compile current contracts** — run `npx hardhat compile` so `artifacts/` holds the authoritative current ABIs (signatures, params tuple, events). This is the source of truth for every downstream ABI copy.
2. **Inventory off-chain ABI consumers** — list every bundled ABI JSON under `services/contract-deployer/contracts/` and `tools/deltaone-simulator/abis/`, and every code path that hard-codes function signatures/event names (grep for `deployToken`, `UsageFeeRouter`, event names). Record current vs expected for each.
3. **Regenerate ABIs** — for each consumer ABI, copy the corresponding compiled artifact ABI (DeltaVerifier, TokenManager, UsageFeeRouter, ModelRegistry, TokenDeploymentFactory/DeployableTokenManager as applicable). Confirm `deployTokenWithAllocations`, the oracle-price+vesting params tuple, and current event names are present.
4. **Update contract-deployer env/addresses** — point `env.validation.ts` and any address config at current Sepolia addresses sourced from `deployments/sepolia-v2-latest.json` (or `sepolia-latest.json`, whichever the service consumes). Validate at startup with a clear error if any required address is missing/malformed.
5. **Update backend usage-fee depositor path** — align the deposit call with the current `UsageFeeRouter` API, including the model-active precondition and current event decoding. Surface a typed error when the router reverts for an inactive model.
6. **Update frontend wallet flows + integration doc** — implement/verify handling for: token approval, buy, sell, IBR disabled-sell state, slippage/deadline errors, and network mismatch. Update `docs/integration/smart-contracts.md` and the example clients to reflect the current ABI surface and error semantics.
7. **Add/extend Sepolia integration tests** — extend `services/contract-deployer/tests/integration/` to exercise the usage-fee depositor path against Sepolia contracts (skipped/guarded when RPC/key env is absent, run when present).
8. **Document env/SSM/secret updates** — record required env-var and SSM/secret-parameter names and purposes in service docs; never include values.
9. **Run validation** — service unit + integration suites, Hardhat compile, lint; manual wallet-flow checks against Sepolia.

---

## 4. Success Criteria

### Functional Requirements

- [ ] **[REQ-F1]** Every bundled ABI consumed by the contract-deployer service and `tools/deltaone-simulator/abis/` contains a `deployTokenWithAllocations` function entry (where applicable to that contract) and contains **no** legacy `deployToken` entry; each ABI's bytes match the corresponding compiled artifact in `artifacts/` (deep-equal of the `abi` array).
- [ ] **[REQ-F2]** The params tuple in the relevant ABI (e.g., DeltaVerifier/TokenManager init or HokusaiParams) includes the oracle-price field and the vesting-config field(s), with field names, order, and Solidity types identical to `contracts/interfaces/IHokusaiParams.sol` at HEAD.
- [ ] **[REQ-F3]** The bundled `UsageFeeRouter` ABI matches the current `contracts/UsageFeeRouter.sol` artifact, and the backend depositor code calls the current deposit function signature; a deposit for an inactive model produces a typed error (not an unhandled revert).
- [ ] **[REQ-F4]** All event names referenced in off-chain code/ABIs exist in the current compiled artifacts; no off-chain listener references a renamed/removed event (verified by cross-checking each referenced event name against the artifact event list).
- [ ] **[REQ-F5]** `services/contract-deployer/src/config/env.validation.ts` validates that required Sepolia contract addresses are present and well-formed (checksummed 20-byte hex); startup fails fast with a named error identifying the missing/invalid variable when one is absent.
- [ ] **[REQ-F6]** A Sepolia-targeted integration test exercises the usage-fee depositor path end-to-end (encode → send → decode emitted fee event) and asserts the deposit succeeds for an active model and reverts with the expected reason for an inactive model.
- [ ] **[REQ-F7]** Frontend wallet flows handle, with distinct user-visible outcomes: (a) needs-approval vs already-approved, (b) successful buy, (c) successful sell, (d) IBR disabled-sell state (sell blocked with explanatory message), (e) slippage/deadline revert, (f) wrong-network/network-mismatch.
- [ ] **[REQ-F8]** Production env-var and SSM/secret updates are documented by name and purpose in service docs, with zero secret values committed.

### Non-Functional Requirements
- [ ] ABI files remain valid JSON and load without error in the service at startup (no runtime ABI parse exceptions).
- [ ] Sepolia integration tests are guarded so they are skipped (not failed) when `SEPOLIA_RPC_URL`/depositor key env is absent, and execute when present.
- [ ] No secret value (private key, key-embedded RPC URL, token) appears in any committed file or doc.

### Code Quality
- [ ] Follows existing codebase patterns (ABI copied from artifacts per #89 pattern; client wiring mirrors `delta-verifier-client.ts`).
- [ ] TypeScript types are correct (no `any` for ABI-derived call params unless justified with a comment).
- [ ] No lint errors in `services/contract-deployer`.

---

## 5. Implementation Constraints

- **Code style**: Match existing TypeScript style in `services/contract-deployer/src/`; ABI JSON copied verbatim from `artifacts/` (no manual reformatting that changes content). Use existing `ethers` patterns already present in `src/blockchain/`.
- **Testing**: Sepolia integration tests must be env-guarded (skip when RPC/key missing). Unit tests must not require network. Mirror the structure of `services/contract-deployer/tests/integration/mint-request-flow.test.ts`.
- **Security**: Never commit secrets. Depositor key and RPC URL come from env/SSM at runtime only. Document secret **names** in `.env.example`/service docs, never values. Do not log full private keys or signed-tx payloads.
- **Performance**: Address/env validation runs once at startup; no per-request re-parse of ABIs (load once).
- **Backwards compatibility**: Removing legacy `deployToken` references is intended and acceptable (it is already removed from contracts in #91). Do not re-introduce legacy signatures for compatibility.
- **Protocol vs instance separation**: Contract addresses and model-specific values live in env/config only; never hard-code a model ID or instance address into a shared ABI or client module.

---

## 6. Validation Steps

### Functional Requirement Validation

**[REQ-F1] Bundled ABIs expose `deployTokenWithAllocations`, no legacy `deployToken`, and match artifacts**

Validation scenario:
1. Setup: Run `npx hardhat compile` to produce `artifacts/`.
2. Action: For each ABI under `services/contract-deployer/contracts/` and `tools/deltaone-simulator/abis/`, deep-compare its `abi` array against the matching `artifacts/contracts/<Name>.sol/<Name>.json` `abi`.
3. Expected result: Arrays are deep-equal; `deployTokenWithAllocations` is present in the relevant contract's ABI; grep for `"name": "deployToken"` (exact, non-allocations) returns zero matches across these ABI files.
4. Edge cases:
   - An ABI file exists in the service dir with no corresponding artifact → fail and flag as stale/orphan ABI to remove or justify.
   - Artifact present but no service ABI consuming it (e.g., a newly required contract) → add the ABI if the service references that contract; otherwise note as out of scope.

**[REQ-F2] Params tuple includes oracle price + vesting config matching the interface**

Validation scenario:
1. Setup: Open `contracts/interfaces/IHokusaiParams.sol` at HEAD and the regenerated params-bearing ABI.
2. Action: Compare the params struct/tuple field names, order, and types.
3. Expected result: Oracle-price field and vesting-config field(s) present; names/order/types identical to the interface.
4. Edge cases:
   - Vesting config is a nested struct → nested tuple components must match recursively.
   - Oracle price uint width differs between ABI and interface → fail.

**[REQ-F3] UsageFeeRouter API current; inactive-model deposit yields typed error**

Validation scenario:
1. Setup: Bundled `UsageFeeRouter` ABI synced from artifact; depositor code wired.
2. Action: Call the depositor path for (a) an active model and (b) an inactive model on Sepolia (or a local fork mock if Sepolia env absent).
3. Expected result: (a) succeeds and emits the current fee event; (b) throws a typed, caught error indicating model-not-active (mapped from the contract revert reason), not an unhandled promise rejection.
4. Edge cases:
   - Model that does not exist → typed "unknown/unregistered model" error.
   - Zero-amount deposit → reverts/handled per contract semantics with a specific message.

**[REQ-F4] All referenced event names exist in current artifacts**

Validation scenario:
1. Setup: Compiled artifacts available.
2. Action: Collect every event name referenced in off-chain code/ABIs (grep listeners + ABI event entries); cross-check each against the artifact event list for that contract.
3. Expected result: Every referenced event name exists in the current artifact; zero references to renamed/removed events.
4. Edge cases:
   - Event signature (indexed/params) changed but name kept → compare full event signature, not just name; mismatch fails.
   - Listener references an event from a contract no longer in the stack → fail and remove.

**[REQ-F5] Env validation fails fast on missing/invalid Sepolia addresses**

Validation scenario:
1. Setup: Set all required env vars to valid checksummed addresses; start the service.
2. Action: Start once with all valid; then unset one required address var and restart; then set one to `"0x123"` (malformed) and restart.
3. Expected result: Valid → starts cleanly. Missing → exits/throws naming the missing variable. Malformed → exits/throws naming the invalid variable and reason ("not a valid address").
4. Edge cases:
   - Lowercase (non-checksummed) but valid 20-byte hex → accepted (normalize) or rejected with clear message — document which; must be deterministic.
   - Extra unexpected address var → ignored, no crash.

**[REQ-F6] Sepolia integration test for usage-fee depositor path**

Validation scenario:
1. Setup: Provide `SEPOLIA_RPC_URL` + depositor key via env; current Sepolia addresses configured.
2. Action: Run the new integration test that encodes the deposit, sends it, waits for the receipt, and decodes the emitted fee event.
3. Expected result: Test passes; asserts deposit success + decoded event fields for an active model; asserts expected revert reason for an inactive model.
4. Edge cases:
   - Env absent → test is skipped (reported as skipped, suite still green), not failed.
   - RPC timeout → test fails with a clear timeout message (not a silent hang); a bounded timeout is configured.

**[REQ-F7] Frontend wallet flows handle all six states**

Validation scenario:
1. Setup: Connect a Sepolia wallet (e.g., MetaMask) to the frontend/example client pointed at current Sepolia addresses.
2. Action: Exercise approval, buy, sell, an IBR-disabled-sell token, a buy/sell with too-tight slippage/short deadline, and connect on the wrong network.
3. Expected result: Each produces its distinct outcome (see edge cases); no unhandled exception in any path.
4. Edge cases:
   - Token not yet approved → "Approve" step shown before buy; after approval, buy proceeds.
   - IBR disabled-sell token → sell button disabled/blocked with message explaining sells are disabled in the IBR phase.
   - Slippage exceeded / deadline passed → caught and shown as "Price moved / transaction expired — retry" rather than a raw revert string.
   - Wrong network → prompt to switch to Sepolia; actions blocked until switched.

**[REQ-F8] Env/SSM/secret docs without secret values**

Validation scenario:
1. Setup: Service docs / `.env.example` updated.
2. Action: Review docs; grep the diff for anything resembling a private key (`0x[0-9a-fA-F]{64}`), key-embedded RPC URL, or token.
3. Expected result: All required env-var/SSM names documented with purpose; zero secret values present in the diff.
4. Edge cases:
   - A required new SSM parameter → listed by name + which service reads it.
   - Example value needed → use an obvious placeholder (`<your-sepolia-rpc-url>`), never a real value.

---

### Input/Output Verification

**Valid Inputs:**
- Input: All required Sepolia address env vars set to valid checksummed addresses → Expected: service starts, validation passes.
- Input: Deposit call for an active model with non-zero amount → Expected: tx success + decoded current fee event.
- Input: Buy with reasonable slippage on a tradable token → Expected: tokens received, success state.

**Invalid Inputs:**
- Input: Missing `USAGE_FEE_ROUTER_ADDRESS` (or equivalent) env var → Expected: startup error naming that variable.
- Input: Deposit for an inactive model → Expected: typed "model not active" error, caught.
- Input: Sell on an IBR-disabled token → Expected: blocked with "sells disabled during IBR phase" message.
- Input: Buy with 0% slippage tolerance while price moves → Expected: "Price moved — retry" error, no unhandled revert.

---

### Standard Validation Commands

```bash
# 1. Compile contracts to produce authoritative ABIs
npx hardhat compile
# Expected: compiles cleanly; artifacts/ populated

# 2. Lint the service
cd services/contract-deployer && npm run lint
# Expected: no errors

# 3. Type check the service
cd services/contract-deployer && npm run typecheck   # or: npx tsc --noEmit
# Expected: no type errors

# 4. Service unit tests
cd services/contract-deployer && npm test
# Expected: all unit tests pass

# 5. Sepolia integration tests (env-guarded)
cd services/contract-deployer && SEPOLIA_RPC_URL=... DEPOSITOR_KEY=... npm run test:integration
# Expected: depositor-path test passes; skipped cleanly if env absent

# 6. Hardhat suite (sanity for contract source unchanged)
npm test
# Expected: existing suite still passes
```

*(If the service uses pnpm/yarn instead of npm, use the repo's actual package manager — confirm from `services/contract-deployer/package.json` scripts before running.)*

---

### Manual Verification Checklist

- [ ] Diff each regenerated ABI against its artifact and confirm `deployTokenWithAllocations` present / legacy `deployToken` absent.
- [ ] Confirm params tuple oracle-price + vesting fields match `IHokusaiParams.sol`.
- [ ] Walk all six frontend wallet flows against Sepolia and confirm each distinct outcome + clean browser console.
- [ ] Grep the full diff for secret-shaped strings; confirm none committed.

---

## 7. UI-Specific Validation (Conditional)

### Pages/Routes Affected
- Trading/swap view (frontend wallet flow surface) — buy/sell/approval UI and error states updated. Exact route lives in the frontend app; in this repo the behavior is represented by `docs/examples/react` and `docs/integration/smart-contracts.md`.
- `docs/integration/smart-contracts.md` — integration contract surface the frontend consumes (not a route, but the source of truth to update).

If the frontend lives in a separate repo not present here: "N/A in this repo for live routes — update the example client + integration doc and flag the frontend-repo follow-up in the PR."

### Visual Acceptance Criteria
- [ ] **Approval state**: An "Approve" action is shown when allowance is insufficient and hidden/replaced by "Buy" once approved.
- [ ] **Disabled sell (IBR)**: Sell control is visibly disabled with an explanatory tooltip/message ("Sells disabled during IBR phase").
- [ ] **Error surfaces**: Slippage/deadline and network-mismatch errors render as readable messages, not raw revert hex.
- [ ] **Network mismatch**: A clear "Switch to Sepolia" prompt appears; trading controls are disabled until switched.
- [ ] **Accessibility**: Disabled controls have `aria-disabled` and an accessible explanation; error messages are associated with their controls.

**Design Artifacts**: None provided. Follow existing example-client styling under `docs/examples/react`. Reference `tools/deltaone-simulator/FRONTEND_INTEGRATION.md` for current integration expectations.

### Console Expectations
**Expected State**: ✅ Clean console — no errors, no unhandled promise rejections during any of the six flows.
- ⚠️ Acceptable: wallet-extension informational logs (e.g., MetaMask provider notices) — third-party, no functional impact.

```bash
# Using frontend-testing skill:
# 1. Navigate to the swap/trading view on Sepolia
# 2. Exercise approval, buy, sell, IBR-disabled sell, slippage/deadline, wrong network
# 3. List console messages; confirm no unexpected errors/warnings
```

### Responsive Considerations
- **Mobile (`< 640px`)**: Trading controls stack single-column; buttons min 44px touch height; error messages wrap without overflow.
- **Tablet (`640–1024px`)**: Two-column where space allows; controls remain reachable.
- **Desktop (`> 1024px`)**: Full layout; network-mismatch prompt clearly visible above the fold.

**Testing**:
- [ ] Mobile viewport (375px)
- [ ] Tablet viewport (768px)
- [ ] Desktop viewport (1440px)
- [ ] Disabled/error states legible at all three widths

---

## 8. Definition of Done

- [ ] All success criteria (REQ-F1–F8) met.
- [ ] All validation steps pass with specific, measurable outcomes (or are cleanly skipped when env-guarded).
- [ ] Each functional requirement has at least one concrete validation scenario executed.
- [ ] Edge cases documented and exercised.
- [ ] No unrelated changes (no contract-source edits).
- [ ] Commit message references HOK-1697.
- [ ] PR created with a clear description, including any separate-frontend-repo follow-up note and the env/SSM doc summary.

---

## 9. Rollback Plan
- Revert commit: `git revert <sha>` — restores prior ABIs, env validation, and depositor wiring (pure off-chain change, no on-chain state to unwind).
- No database migration involved.
- Feature flag: not applicable; if the new depositor path proves unstable on Sepolia, redeploy the prior service image from ECR (previous tag) while keeping contracts untouched.
- Frontend: revert the wallet-flow/doc changes; prior example client remains functional against prior ABIs.

---

## 10. Release Readiness
- **database_change_risk**: none
- **env_changes**: SEPOLIA_RPC_URL, USAGE_FEE_ROUTER_ADDRESS, MODEL_REGISTRY_ADDRESS, TOKEN_MANAGER_ADDRESS, DEPLOY_FACTORY_ADDRESS, DEPOSITOR_PRIVATE_KEY (names indicative — reconcile exact names with `services/contract-deployer/src/config/env.validation.ts`; values via SSM/secrets only)
- **config_changes**: services/contract-deployer/contracts/*.json, services/contract-deployer/src/config/env.validation.ts, tools/deltaone-simulator/abis/*.json, docs/integration/smart-contracts.md
- **manual_steps**: Set/update SSM parameters and secrets for Sepolia addresses + depositor key before redeploy, rebuild and push the contract-deployer image (linux/amd64) and redeploy the ECS service per CLAUDE.md, verify env validation passes on startup

---

## 11. Proposed Labels

**Risk Level** (Required):

**Selected**: `Risk: High`

**Justification**: High — touches the production-facing contract-deployer service config and the usage-fee depositor (value-moving) path against live Sepolia, with mainnet (HOK-658) as the downstream consumer. ABI/address mismatches cause reverts or mis-decoded events; secret-handling is involved.

---

**Files to Modify** (Auto-detected):
- `services/contract-deployer/contracts/DeltaVerifier.json`
- `services/contract-deployer/src/config/env.validation.ts`
- `services/contract-deployer/src/blockchain/delta-verifier-client.ts`
- `tools/deltaone-simulator/abis/TokenManager.json`
- `docs/integration/smart-contracts.md`

**Label**: `Files: DeltaVerifier.json, env.validation.ts, delta-verifier-client.ts, TokenManager.json, smart-contracts.md`

**Purpose**: Prevents parallel tasks from modifying the same files.

---

**Architectural Layer** (Recommended):

**Selected**: `Layer: Service`, `Layer: UI`, `Layer: Infra`

**Purpose**: Spans the contract-deployer service, frontend wallet flows, and env/SSM/deploy config; flag so layer-overlapping tasks are not run concurrently.

---

**Area** (Recommended):

**Selected**: `Area: Auth` is not applicable; closest fit is a contract-integration area. Use `Area: Docs` for the integration-doc portion and treat the service/wallet portion as service/UI integration.

**Purpose**: Avoid running another task that touches contract-integration ABIs or the integration doc simultaneously.

---

**Test Coverage** (Auto-detected):

**Selected**: `Tests: Integration` (Sepolia depositor path) and `Tests: Unit` (env validation, ABI checks)

**Purpose**: Avoid running multiple network-dependent integration tasks in parallel.

---

**Component** (Optional):

**Selected**: `Component: contract-deployer`

**Purpose**: Prevents concurrent edits to the contract-deployer service.

---

### Label Summary

```
Suggested labels for this task:
- Risk: High
- Files: DeltaVerifier.json, env.validation.ts, delta-verifier-client.ts, TokenManager.json, smart-contracts.md
- Layer: Service
- Layer: UI
- Layer: Infra
- Area: Docs
- Tests: Integration
- Tests: Unit
- Component: contract-deployer
```

**How these labels help the autonomous workflow:**
- **Risk: High** — Limits parallelism; requires extra review for value-moving/config changes.
- **Files: ...** — Prevents file conflicts with concurrent tasks.
- **Layer: Service/UI/Infra** — Won't run alongside other tasks touching these layers.
- **Tests: Integration** — Avoids running multiple slow/network E2E-style tasks at once.
- **Component: contract-deployer** — Blocks concurrent edits to the same service.