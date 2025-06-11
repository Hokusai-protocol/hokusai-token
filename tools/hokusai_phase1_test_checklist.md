# ✅ Hokusai Phase 1 Integration Testing Checklist

This checklist is for verifying the end-to-end functionality of the initial Hokusai token system, including HokusaiToken, TokenManager, ModelRegistry, and AuctionBurner.

---

## 1. 🏷️ Model Registration Tests

- [ ] Register a new model with token address, name, metric, and data format.
- [ ] Confirm metadata retrieval via `getModel(modelId)` returns correct values.
- [ ] Validate `getTokenAddress(modelId)` returns the correct token.
- [ ] Attempt to retrieve or register an invalid model (expect failure).

---

## 2. 🪙 TokenManager Minting Tests

- [ ] Deploy a HokusaiToken and set TokenManager as its controller.
- [ ] Register this token under a new `modelId` in ModelRegistry.
- [ ] Call `issueTokens(modelId, user, amount)` and confirm:
  - [ ] Correct amount is minted to `user`.
  - [ ] Events (`Transfer`, `Mint`) are emitted.
- [ ] Attempt to mint for an unregistered model (expect failure).
- [ ] Attempt minting from a non-admin account (expect failure).

---

## 3. 🔥 AuctionBurner Tests

- [ ] User approves AuctionBurner to spend their HokusaiToken.
- [ ] Call `placeBid(modelId, amount)` or equivalent:
  - [ ] Tokens are burned from user balance.
  - [ ] Burn event is emitted.
- [ ] Confirm access granted or winning slot recorded (if implemented).
- [ ] Attempt burn with insufficient allowance (expect revert).
- [ ] Attempt burn with insufficient balance (expect revert).

---

## 4. 🔗 Full Integration Flow

Simulate full lifecycle:

- [ ] Register a model with a performance metric.
- [ ] Deploy a token and assign TokenManager as controller.
- [ ] Mint test tokens using `TokenManager.issueTokens()`.
- [ ] Approve AuctionBurner to spend the user's tokens.
- [ ] Burn tokens using AuctionBurner for model access.
- [ ] Confirm all balances, states, and events match expected results.

---

## 5. 🧪 Edge Case and Negative Tests

- [ ] Attempt re-registration of the same model ID (expect revert).
- [ ] Test multiple models/tokens in parallel for isolation.
- [ ] Transition controller on token (e.g., DAO or upgrade path).
- [ ] Validate token can’t be minted/burned without TokenManager involvement.

---

## 🔚 Completion Criteria

| Component       | Goal Description                     | Status |
|----------------|---------------------------------------|--------|
| ModelRegistry  | Register and retrieve model metadata  | [ ]    |
| TokenManager   | Mint/burn with model resolution       | [ ]    |
| HokusaiToken   | Enforce controller access             | [ ]    |
| AuctionBurner  | Burn flow and access validation       | [ ]    |