# ✅ Hokusai Phase 1 Integration Testing Checklist

This checklist is for verifying the end-to-end functionality of the initial Hokusai token system, including HokusaiToken, TokenManager, ModelRegistry, and AuctionBurner.

---

## 1. 🏷️ Model Registration Tests

- [x] Register a new model with token address, name, metric, and data format.
- [x] Confirm metadata retrieval via `getModel(modelId)` returns correct values.
- [x] Validate `getTokenAddress(modelId)` returns the correct token.
- [x] Attempt to retrieve or register an invalid model (expect failure).

---

## 2. 🪙 TokenManager Minting Tests

- [x] Deploy a HokusaiToken and set TokenManager as its controller.
- [x] Register this token under a new `modelId` in ModelRegistry.
- [x] Call `issueTokens(modelId, user, amount)` and confirm:
  - [x] Correct amount is minted to `user`.
  - [x] Events (`Transfer`, `Mint`) are emitted.
- [x] Attempt to mint for an unregistered model (expect failure).
- [x] Attempt minting from a non-admin account (expect failure).

---

## 3. 🔥 AuctionBurner Tests

- [x] User approves AuctionBurner to spend their HokusaiToken.
- [x] Call `placeBid(modelId, amount)` or equivalent:
  - [x] Tokens are burned from user balance.
  - [x] Burn event is emitted.
- [ ] Confirm access granted or winning slot recorded (if implemented).
- [x] Attempt burn with insufficient allowance (expect revert).
- [x] Attempt burn with insufficient balance (expect revert).

---

## 4. 🔗 Full Integration Flow

Simulate full lifecycle:

- [x] Register a model with a performance metric.
- [x] Deploy a token and assign TokenManager as controller.
- [x] Mint test tokens using `TokenManager.issueTokens()`.
- [x] Approve AuctionBurner to spend the user's tokens.
- [x] Burn tokens using AuctionBurner for model access.
- [x] Confirm all balances, states, and events match expected results.

---

## 5. 🧪 Edge Case and Negative Tests

- [x] Attempt re-registration of the same model ID (expect revert).
- [ ] Test multiple models/tokens in parallel for isolation.
- [ ] Transition controller on token (e.g., DAO or upgrade path).
- [x] Validate token can’t be minted/burned without TokenManager involvement.

---

## 🔚 Completion Criteria

| Component       | Goal Description                     | Status |
|----------------|---------------------------------------|--------|
| ModelRegistry  | Register and retrieve model metadata  | [x]    |
| TokenManager   | Mint/burn with model resolution       | [x]    |
| HokusaiToken   | Enforce controller access             | [x]    |
| AuctionBurner  | Burn flow and access validation       | [x]    |