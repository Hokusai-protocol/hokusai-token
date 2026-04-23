# HOK-1418: Frontend Handoff — Token Deploy Process Fixes

This document describes every change the `hokusai-site` team must make to align the frontend token deployment flow with the fixed contracts. It is the authoritative spec for Phases 3 and 4 of the HOK-1418 plan.

---

## Context

The original deploy flow called `deployToken(modelId, name, symbol, totalSupply)` (4-arg legacy function) and passed token quantities as raw integers (e.g. `2500000` instead of `2500000 * 10**18`). This caused:
- Tokens minted as `2,500,000` **wei** = effectively zero visible balance
- No allocation split (no model supplier amount, no investor cap)
- AMM could mint unlimited tokens — the "10M investor cap" was never enforced

The contracts have been fixed. The legacy `deployToken` function has been deleted. The only public deploy entry point is now `deployTokenWithAllocations`.

---

## 1. Prerequisite: Resolve merge conflict in `route.ts`

**File:** `packages/web/src/app/api/models/[modelId]/deploy-token/route.ts`  
**Lines:** 158–184

There are unresolved git conflict markers (`<<<<<<< HEAD` / `>>>>>>> origin/main`) in this file. Resolve them before extending this route. Keep the `origin/main` side, which matches the rest of the function.

---

## 2. New ABI Entry (`lib/contracts/TokenManager.ts`)

Replace the existing `deployToken` ABI entry with:

```ts
{
  name: "deployTokenWithAllocations",
  type: "function",
  stateMutability: "payable",
  inputs: [
    { name: "modelId",                 type: "string"  },
    { name: "name",                    type: "string"  },
    { name: "symbol",                  type: "string"  },
    { name: "modelSupplierAllocation", type: "uint256" },
    { name: "modelSupplierRecipient",  type: "address" },
    { name: "investorAllocation",      type: "uint256" },
    {
      name: "initialParams",
      type: "tuple",
      components: [
        { name: "tokensPerDeltaOne",           type: "uint256" },
        { name: "infrastructureAccrualBps",    type: "uint16"  },
        { name: "licenseHash",                 type: "bytes32" },
        { name: "licenseURI",                  type: "string"  },
        { name: "governor",                    type: "address" },
      ],
    },
  ],
  outputs: [{ name: "tokenAddress", type: "address" }],
}
```

Also add the post-deploy ABI entry:

```ts
{
  name: "distributeModelSupplierAllocation",
  type: "function",
  stateMutability: "nonpayable",
  inputs: [{ name: "modelId", type: "string" }],
  outputs: [],
}
```

---

## 3. Wei-Scaling Rule (critical)

**Every token quantity passed to the contract must be multiplied by `10**18`.**

The token uses standard 18-decimal ERC20 (`decimals() = 18`). Raw integers like `2500000` are treated as `2500000 wei` ≈ `0.0000000000000025` tokens — essentially zero on Etherscan.

**Correct conversion:**
```ts
// Use ethers v6:
const supplierWei = ethers.parseUnits(supplierAllocation.toString(), 18);
const investorWei = ethers.parseUnits(investorAllocation.toString(), 18);
const tokensPerDeltaOneWei = ethers.parseUnits(tokensPerDeltaOne.toString(), 18);

// Or plain BigInt:
const supplierWei = BigInt(supplierAllocation) * 10n ** 18n;
```

**Applies to:** `modelSupplierAllocation`, `investorAllocation`, `initialParams.tokensPerDeltaOne`.  
**Does NOT apply to:** `infrastructureAccrualBps` (basis points, unitless), `licenseHash`/`licenseURI`/`governor`.

---

## 4. Service Call: `TokenManagerService.deployTokenWithAllocations`

Replace the existing `deployToken` call with:

```ts
await contract.deployTokenWithAllocations(
  modelId,
  name,
  symbol,
  ethers.parseUnits(modelSupplierAllocation.toString(), 18),
  modelSupplierRecipient,   // connected wallet address — see §5
  ethers.parseUnits(investorAllocation.toString(), 18),
  {
    tokensPerDeltaOne:        ethers.parseUnits(tokensPerDeltaOne.toString(), 18),
    infrastructureAccrualBps: infrastructureAccrualBps,      // e.g. 8000 for 80%
    licenseHash:              licenseHashBytes32,
    licenseURI:               licenseURI,
    governor:                 connectedWalletAddress,
  }
);
```

---

## 5. `modelSupplierRecipient` = Connected Wallet

The contract requires a **non-zero** `modelSupplierRecipient`. Use the connected wallet's address:

```ts
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner();
const modelSupplierRecipient = await signer.getAddress();
```

No DB schema change is needed. Do not add a separate form field — just use the wallet address at deploy time.

---

## 6. `DeploymentConfigModal` Changes

- **Remove** the free-form `totalSupply` input.
- **Fetch** `modelSupplierAllocation`, `investorAllocation`, `tokensPerDeltaOne`, and `grossMarginBps` from `GET /api/models/{modelId}` and display them **read-only**.
- Show the computed max supply as `modelSupplierAllocation + investorAllocation` (in whole tokens).
- Show the supplier recipient as the connected wallet address (read-only).

---

## 7. `DeploymentProgressModal` Changes

1. Call `deployTokenWithAllocations(...)` (§4) instead of `deployToken(...)`.
2. After the on-chain deploy succeeds, call the new backend endpoint:

```ts
await fetch(`/api/models/${modelId}/deploy-token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ action: "distribute-supplier" }),
});
```

This triggers `TokenManager.distributeModelSupplierAllocation(modelId)` server-side using the owner wallet, minting the supplier tokens to the creator's address.

---

## 8. New Backend Endpoint: `distribute-supplier` Action

**Route:** `POST /api/models/[modelId]/deploy-token`  
**Body:** `{ "action": "distribute-supplier" }`

The server wallet (owner of `TokenManager`) calls:
```solidity
tokenManager.distributeModelSupplierAllocation(modelId);
```

This can only be called once per token (the token contract enforces this via `modelSupplierDistributed` flag).

**Response shape:**
```json
{
  "success": true,
  "txHash": "0x...",
  "recipient": "0x...",
  "amount": "2500000000000000000000000"
}
```

---

## 9. Validation Bounds (`api/models/create/route.ts`)

Update `tokensPerDeltaOne` validation (line ~204-211) to:
- **Minimum:** `100` whole tokens
- **Maximum:** `10,000,000` whole tokens

The DB stores whole-token values. The wei conversion happens only at the contract boundary (§3).

---

## 10. Expected On-Chain State After a Correct Deploy

| Field | Value |
|---|---|
| `token.totalSupply()` | `0` immediately post-deploy (supplier tokens not yet minted) |
| `token.maxSupply()` | `12,500,000 * 10**18` (= supplier 2.5M + investor 10M) |
| `token.modelSupplierAllocation()` | `2,500,000 * 10**18` |
| `token.modelSupplierDistributed()` | `false` until `distributeModelSupplierAllocation` is called |
| After distribution: `token.balanceOf(creator)` | `2,500,000 * 10**18` |
| After distribution: `formatUnits(token.totalSupply(), 18)` | `"2500000.0"` |
| `params.tokensPerDeltaOne()` | `500,000 * 10**18` |
| AMM can mint | Up to `10,000,000 * 10**18` more tokens before cap hits |

---

## 11. Contract Addresses (Sepolia)

After Phase 2 contracts are redeployed, update `CONTRACT_ADDRESSES.SEPOLIA.TOKEN_MANAGER` in `lib/contracts/TokenManager.ts` to the new `TokenManager` address. The address will be in `deployment-sepolia.json` in the contracts repo.

Re-authorization of existing AMMs against the new `TokenManager` is a manual ops step handled by the contracts team.

---

## 12. Checklist for Frontend Team

- [ ] Resolve merge conflict in `deploy-token/route.ts` (§1)
- [ ] Replace `deployToken` ABI entry with `deployTokenWithAllocations` (§2)
- [ ] Apply `10**18` scaling to all token quantities (§3)
- [ ] Update `TokenManagerService` to call new function (§4)
- [ ] Use connected wallet as `modelSupplierRecipient` (§5)
- [ ] Update `DeploymentConfigModal` to read allocations from DB (§6)
- [ ] Update `DeploymentProgressModal` to call new function + post-deploy endpoint (§7)
- [ ] Implement `distribute-supplier` backend action (§8)
- [ ] Update `tokensPerDeltaOne` validation bounds in create route (§9)
- [ ] Update `CONTRACT_ADDRESSES.SEPOLIA.TOKEN_MANAGER` after redeployment (§11)
