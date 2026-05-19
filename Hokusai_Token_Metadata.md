# Hokusai Token Metadata Architecture

This document outlines the core data model, storage strategy, smart contract architecture, and JSON schema specification for supporting the creation and management of Hokusai tokens. Each token corresponds to a machine learning model whose performance can be improved through data contributions.

---

## 🧱 Core Data Model: Token Metadata

All Hokusai tokens share a standardized metadata format to ensure consistency, discoverability, and ease of use across the ecosystem.

### Metadata Fields

- `token_id`: Unique identifier (e.g., `HOKUSAI-CHESTX`)
- `model_name`: Descriptive name for the associated ML model
- `category`: Domain (e.g., Imaging, Legal, Finance)
- `description`: Summary of the task performed by the model
- `data_format`: File and metadata requirements for contributions
- `licensing`: Legal terms for data submission and usage
- `performance_metric`: Metric used to validate model improvements
- `tokenomics`: Economic parameters (minting, burning, bonding)
- `status`: Token activity and contribution state

---

## 🧬 Storage Strategy: Hybrid On-Chain + Off-Chain

### On-Chain Components
- `token_id`
- `metadata_hash` (IPFS CID or Merkle root)
- `performance_score`
- `minted_supply`, `burned_supply`
- `auction_price`
- `last_verified_deltaone`

### Cap Semantics

Cap-based launch tokens track investor and reward issuance separately:

- `investorAllocation` is the cap for AMM-driven investor purchases.
- `investorMinted` tracks net investor issuance and is reduced when AMM sells burn tokens.
- DeltaOne rewards, including rewards minted into `RewardVestingVault`, use a separate reward-minting path and do not consume investor allocation headroom.
- `maxSupply` remains the supplier allocation plus investor allocation for compatibility with older tooling, but it no longer acts as a global ceiling across all mint categories.
- AMM curve pricing uses redeemable circulating supply, not raw ERC20 `totalSupply()`. Tokens held in `RewardVestingVault` are excluded until claimed, so locked emissions do not immediately reprice the market.

These values are stored in a smart contract registry for transparency and immutability.

### Off-Chain Components
- Full metadata stored in JSON format
- Uploaded to:
  - IPFS (for decentralized persistence)
  - Arweave (for archival redundancy)
  - Indexed via subgraph or GraphQL API

---

## 🔗 Smart Contract Architecture

### HokusaiTokenRegistry Contract

- Maps `token_id` to token metadata pointer
- Handles minting upon verified DeltaOne improvements
- Manages burning upon model access
- Integrates bonding curve logic for token pricing
- Supports continuous auctions for dynamic access pricing

Each token may use a minimal proxy pattern (ERC-1167) to instantiate a lightweight copy of a shared base contract.

---

## 🧾 JSON Schema: `hokusai_token.schema.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Hokusai Token Metadata",
  "type": "object",
  "required": [
    "token_id",
    "model_name",
    "category",
    "description",
    "data_format",
    "licensing",
    "performance_metric",
    "tokenomics",
    "status"
  ],
  "properties": {
    "token_id": { "type": "string" },
    "model_name": { "type": "string" },
    "category": { "type": "string" },
    "description": { "type": "string" },
    "data_format": {
      "type": "object",
      "properties": {
        "image_types": { "type": "array", "items": { "type": "string" } },
        "label_format": { "type": "string" },
        "required_metadata": { "type": "array", "items": { "type": "string" } }
      },
      "required": ["image_types", "label_format"]
    },
    "licensing": {
      "type": "object",
      "properties": {
        "submission": { "type": "string" },
        "usage": { "type": "string" }
      },
      "required": ["submission", "usage"]
    },
    "performance_metric": {
      "type": "object",
      "properties": {
        "metric_type": { "type": "string" },
        "baseline": { "type": "number" },
        "deltaone_threshold": { "type": "number" },
        "benchmark_provider": { "type": "string" }
      },
      "required": ["metric_type", "baseline", "deltaone_threshold"]
    },
    "tokenomics": {
      "type": "object",
      "properties": {
        "mint_per_deltaone": { "type": "integer" },
        "burn_required": { "type": "boolean" },
        "auction_model": {
          "type": "string",
          "enum": ["continuous", "vickrey", "none"]
        },
        "bonding_curve": {
          "type": "string",
          "enum": ["sqrt", "linear", "exponential"]
        },
        "usdc_backed": { "type": "boolean" }
      },
      "required": ["mint_per_deltaone", "burn_required"]
    },
    "status": {
      "type": "object",
      "properties": {
        "active": { "type": "boolean" },
        "contributors": {
          "type": "array",
          "items": { "type": "string" }
        },
        "usage_channels": {
          "type": "array",
          "items": { "type": "string" }
        }
      },
      "required": ["active"]
    }
  }
}
```

---

This architecture enables scalable, transparent, and programmable management of hundreds of Hokusai tokens across various domains.
