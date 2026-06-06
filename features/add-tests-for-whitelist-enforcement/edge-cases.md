# Off-Chain Whitelist Status Edge Cases

The purchaser whitelist has no on-chain expiry or revocation scheduler. Operational controls for eligibility changes are enforced by an authorized operator calling `removeFromWhitelist(wallet)`.

## 1. KYC/AML Expiry
- Trigger: An investor's KYC or AML accreditation period expires and is not renewed in time.
- On-chain response: Whitelist admin calls `removeFromWhitelist(wallet)`.
- User-visible outcome: Any subsequent `buy()` by that wallet reverts with `NotWhitelisted(wallet)`.

## 2. Sanctions Re-Screen Failure
- Trigger: Periodic sanctions screening flags the wallet or beneficial owner on OFAC/SDN or equivalent restricted lists.
- On-chain response: Whitelist admin calls `removeFromWhitelist(wallet)`.
- User-visible outcome: Any subsequent `buy()` by that wallet reverts with `NotWhitelisted(wallet)`.

## 3. Wallet Compromise or Rotation
- Trigger: Investor reports private key compromise or requests migration to a new controlled wallet.
- On-chain response: Whitelist admin calls `removeFromWhitelist(oldWallet)` and may later add a verified replacement wallet.
- User-visible outcome: Any subsequent `buy()` by the old wallet reverts with `NotWhitelisted(oldWallet)`.

## 4. Jurisdictional Change
- Trigger: Investor relocates to a jurisdiction where sales are restricted under updated compliance policy.
- On-chain response: Whitelist admin calls `removeFromWhitelist(wallet)`.
- User-visible outcome: Any subsequent `buy()` by that wallet reverts with `NotWhitelisted(wallet)`.

## 5. Operator Policy Revocation
- Trigger: Internal compliance or risk policy requires discretionary investor off-boarding.
- On-chain response: Whitelist admin calls `removeFromWhitelist(wallet)`.
- User-visible outcome: Any subsequent `buy()` by that wallet reverts with `NotWhitelisted(wallet)`.
