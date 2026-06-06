# Implementation Plan: HOK-1697 — Align Backend, Frontend, and Contract-Deployer with Current ABIs

## Summary

The contract-deployer service, example clients, and integration docs are out of sync with the current contract stack. The service's `ContractDeployer` still deploys `HokusaiToken` directly (old pattern), doesn't call `deployTokenWithAllocations` on the `TokenManager`; the `model-registry.ts` client uses a stale function signature; the `tools/deltaone-simulator` DeltaVerifier ABI is missing `DeltaOneAccepted` and `submitMintRequest`; the `fee-collection.ts` example uses the wrong `depositFee` signature (missing `callCount`); and `TradingInterface.tsx` lacks network-mismatch and typed slippage/deadline error handling. No `UsageFeeRouter` ABI or client exists in the service. This plan fixes all of these.

---

## Phase 1: Compile Contracts and Regenerate ABIs

**Goal:** Produce authoritative ABI files from current source.

1. Run `npx hardhat compile` at repo root — populates `artifacts/`.
2. Copy ABI-only JSON from artifacts into service and tools:
   - `artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json` → `services/contract-deployer/contracts/DeltaVerifier.json` (update existing)
   - `artifacts/contracts/DeployableTokenManager.sol/DeployableTokenManager.json` → `services/contract-deployer/contracts/DeployableTokenManager.json` (new — needed for `deployTokenWithAllocations`)
   - `artifacts/contracts/UsageFeeRouter.sol/UsageFeeRouter.json` → `services/contract-deployer/contracts/UsageFeeRouter.json` (new — needed for depositor client)
   - `artifacts/contracts/DeltaVerifier.sol/DeltaVerifier.json` → `tools/deltaone-simulator/abis/DeltaVerifier.json` (update existing — currently missing `DeltaOneAccepted` event and `submitMintRequest`)
   - `artifacts/contracts/DeployableTokenManager.sol/DeployableTokenManager.json` → `tools/deltaone-simulator/abis/TokenManager.json` (update existing — verify it still matches)

**Key finding:** The tools DeltaVerifier ABI is missing `DeltaOneAccepted` event and `submitMintRequest` function vs the service ABI. The service ABI is more current.

---

## Phase 2: Update Contract-Deployer Blockchain Clients

**Files:** `services/contract-deployer/src/blockchain/`

### 2a. Replace `contract-deployer.ts` deployment logic

The current `deployToken()` method uses `ContractFactory` to deploy `HokusaiToken` directly — this is the pre-allocation legacy pattern.

**Changes:**
- Remove `HokusaiToken.json` import (direct deploy no longer needed)
- Import `DeployableTokenManager.json` ABI
- Rewrite `deployToken()` to:
  1. Connect to the `TokenManager` contract at `config.tokenManagerAddress`
  2. Call `deployTokenWithAllocations(modelId, name, symbol, modelSupplierAllocation, modelSupplierRecipient, investorAllocation, initialParams)` with values sourced from the message
  3. Parse the `TokenDeployed` event from the receipt to get `tokenAddress`
  4. Remove the stale `setContributor` post-deploy call (absorbed into allocation params)
- Update `ContractDeployerConfig` interface: rename `tokenManagerAddress` field if needed, no breaking change expected
- Update `ModelReadyToDeployMessage` schema (`schemas/message-schemas.ts`) to include `initialParams` (oracle price, vesting config, allocations, governor)

### 2b. Fix `model-registry.ts` stale ABI

Current inline ABI uses `registerModel(string, address, string, string)` with `mlflowRunId` — the contract has `registerStringModel(string, address, string)` (3 params, no mlflowRunId).

**Changes:**
- Update `MODEL_REGISTRY_ABI` in `model-registry.ts` to match `ModelRegistry.sol`:
  - `registerStringModel(string modelId, address token, string performanceMetric)`
  - `getTokenAddress(string modelId)` (already present)
  - Update event to `StringModelRegistered` (check artifacts for actual event name)
- Update `registerModel()` call to `registerStringModel()` and drop `mlflowRunId` param

### 2c. Create `usage-fee-router-client.ts`

New file: `services/contract-deployer/src/blockchain/usage-fee-router-client.ts`

**API:**
```typescript
depositFee(modelId: string, amount: bigint, callCount: bigint): Promise<DepositResult>
```

**Contract function:** `depositFee(string modelId, uint256 amount, uint256 callCount)` — requires `FEE_DEPOSITOR_ROLE`.

**Error handling:**
- Wrap `ethers` revert errors: if revert reason contains "Model not active" or similar, throw typed `ModelNotActiveError` (not unhandled rejection)
- Also handle "unknown model" case

---

## Phase 3: Update Environment Validation

**File:** `services/contract-deployer/src/config/env.validation.ts`

**Changes:**
1. Add `USAGE_FEE_ROUTER_ADDRESS` as `Joi.string().optional()` (optional since not all deployments use the depositor path, but required for integration tests)
2. Add `DEPLOY_FACTORY_ADDRESS` as optional (for future use; document in .env.example)
3. Add `DEPOSITOR_PRIVATE_KEY` as optional (separate from `DEPLOYER_PRIVATE_KEY`) OR document that `DEPLOYER_PRIVATE_KEY` doubles as depositor key in Sepolia testing
4. Update `CHAIN_ID` default from `137` (Polygon) to `11155111` (Sepolia) for the Sepolia-targeted service instance — OR keep it as-is and require explicit env override, but update `.env.example` to show Sepolia values
5. Add `USAGE_FEE_ROUTER_ADDRESS` to `Config` interface and SSM mapping in `aws-ssm.ts`

**Address validation helper:** Add a utility that validates a string is a checksummed 20-byte hex address (or normalizes with `ethers.getAddress()`), called at startup for all required address fields.

---

## Phase 4: Sepolia Integration Test

**File:** `services/contract-deployer/tests/integration/usage-fee-depositor.test.ts` (new)

**Pattern:** Mirror `mint-request-flow.test.ts` guard pattern (`RUN_INTEGRATION_TESTS` or `SEPOLIA_RPC_URL`).

**Test cases:**
1. Skip gracefully when `SEPOLIA_RPC_URL` is absent
2. Active model: `depositFee(modelId, amount, callCount)` → succeeds, receipt status 1, `FeeDeposited` event decoded correctly
3. Inactive/unknown model: typed error thrown (not unhandled), error message identifies model as inactive

**Config sources:** Current Sepolia addresses from `deployments/sepolia-v2-latest.json` (loaded at test runtime, not hard-coded).

---

## Phase 5: Update Frontend Example (TradingInterface.tsx)

**File:** `docs/examples/react/TradingInterface.tsx`

**Missing states to add:**

1. **Network mismatch:** Add `chainId` check vs expected (e.g., Sepolia = 11155111). Show "Switch to Sepolia" banner; disable trade controls until correct network.

2. **Typed slippage/deadline errors:** In the `catch` block of `executeTrade()`, parse the ethers error:
   - If revert reason contains "deadline" or "expired" → show "Transaction deadline passed — please retry"
   - If revert reason contains "slippage" or "insufficient output" → show "Price moved too much — adjust slippage or retry"
   - Generic fallback for other errors

3. **IBR disabled-sell state:** Already partially present (`sellsEnabled` check). Harden with explicit `aria-disabled` on sell button and a distinct message: "Sells disabled during Initial Bonding Reserve (IBR) phase."

4. **Approval flow:** Currently approves inline during buy/sell. Separate into a visible two-step UI: "Step 1: Approve" → "Step 2: Buy/Sell" so users understand the two-tx flow.

---

## Phase 6: Update Fee-Collection Example

**File:** `docs/examples/typescript/fee-collection.ts`

**Issues:**
- `FEE_ROUTER_ABI`: `depositFee(string, uint256)` is wrong — current contract is `depositFee(string, uint256, uint256)` (with `callCount`)
- `FeeDeposited` event in the ABI has wrong params: `(string, address, uint256, uint256, uint256, address)` — verify against compiled artifact
- `batchDepositFees` signature needs `callCounts` array

**Changes:**
- Update `FEE_ROUTER_ABI` to match current `UsageFeeRouter` (sourced from regenerated ABI)
- Update `depositFees()` method to pass `callCount` param
- Update `batchDeposit()` method similarly with `callCounts` array
- Update event parsing to match current event structure

---

## Phase 7: Environment and SSM Documentation

**Files:**
- `services/contract-deployer/.env.example` (create if absent)
- `services/contract-deployer/docs/env-vars.md` (create or update)

**Content (no secret values):**
```
# Blockchain
RPC_URL=<your-sepolia-rpc-url>         # Alchemy/Infura endpoint — stored in SSM
CHAIN_ID=11155111                       # Sepolia

# Contract addresses (from deployments/sepolia-v2-latest.json)
MODEL_REGISTRY_ADDRESS=<address>
TOKEN_MANAGER_ADDRESS=<address>
DELTA_VERIFIER_ADDRESS=<address>
USAGE_FEE_ROUTER_ADDRESS=<address>

# Keys (SSM only — never commit)
DEPLOYER_PRIVATE_KEY=<from-ssm:/hokusai/contract-deployer/deployer_key>
```

SSM parameter names documented by their path pattern, no values.

---

## Testing Strategy

- `npx hardhat compile` — verifies contract source compiles cleanly
- `cd services/contract-deployer && npm test` — unit tests pass
- `cd services/contract-deployer && SEPOLIA_RPC_URL=... npm run test:integration` — integration test passes (skipped when env absent)
- `npm test` at repo root — existing Hardhat suite unchanged
- Lint: `cd services/contract-deployer && npm run lint`

---

## Release Readiness

- **database_change_risk**: none
- **env_changes**: USAGE_FEE_ROUTER_ADDRESS (new), DEPLOY_FACTORY_ADDRESS (new optional); CHAIN_ID default clarified to Sepolia; existing MODEL_REGISTRY_ADDRESS, TOKEN_MANAGER_ADDRESS, RPC_URL, DEPLOYER_PRIVATE_KEY unchanged
- **config_changes**: services/contract-deployer/contracts/DeltaVerifier.json, services/contract-deployer/contracts/DeployableTokenManager.json (new), services/contract-deployer/contracts/UsageFeeRouter.json (new), tools/deltaone-simulator/abis/DeltaVerifier.json, tools/deltaone-simulator/abis/TokenManager.json, docs/examples/react/TradingInterface.tsx, docs/examples/typescript/fee-collection.ts
- **manual_steps**: Set USAGE_FEE_ROUTER_ADDRESS in SSM for Sepolia; rebuild and push contract-deployer image (linux/amd64); redeploy ECS service; verify startup env validation passes

---

## Files Modified

| File | Action |
|------|--------|
| `services/contract-deployer/contracts/DeltaVerifier.json` | Update from artifacts |
| `services/contract-deployer/contracts/DeployableTokenManager.json` | Create from artifacts |
| `services/contract-deployer/contracts/UsageFeeRouter.json` | Create from artifacts |
| `services/contract-deployer/src/blockchain/contract-deployer.ts` | Replace direct HokusaiToken deploy with `deployTokenWithAllocations` on TokenManager |
| `services/contract-deployer/src/blockchain/model-registry.ts` | Fix stale function signatures |
| `services/contract-deployer/src/blockchain/usage-fee-router-client.ts` | Create new depositor client |
| `services/contract-deployer/src/config/env.validation.ts` | Add USAGE_FEE_ROUTER_ADDRESS, address validation |
| `services/contract-deployer/src/config/aws-ssm.ts` | Add usage_fee_router_address SSM mapping |
| `services/contract-deployer/src/schemas/message-schemas.ts` | Extend with initialParams fields |
| `services/contract-deployer/tests/integration/usage-fee-depositor.test.ts` | Create Sepolia integration test |
| `services/contract-deployer/.env.example` | Create env docs |
| `tools/deltaone-simulator/abis/DeltaVerifier.json` | Update from artifacts |
| `tools/deltaone-simulator/abis/TokenManager.json` | Verify/update from artifacts |
| `docs/examples/react/TradingInterface.tsx` | Add network mismatch, typed errors, IBR improvements |
| `docs/examples/typescript/fee-collection.ts` | Fix depositFee signature + callCount |
